/**
 * Readonly Cursor content source: state.vscdb (SQLite WAL).
 * Open with { readonly: true, fileMustExist: true } — never immutable=1
 * (that ignores WAL and serves a stale snapshot).
 */

import type Database from 'better-sqlite3';
import type { ChatElement, CodeBlockItem, ToolCallElement } from '../types.js';
import type { ContentSource } from './content-source.js';
import type {
  MessageHeader,
  SessionMeta,
  SessionRef,
  SourceProbe,
} from './types.js';
import { loadBetterSqlite3 } from '../load-sqlite.js';
import { diffLines } from './diff.js';
import { project } from './project.js';

export interface Bubble {
  bubbleId: string;
  type: number;
  createdAt: number;
  text: string;
  thinking?: string;
  thinkingDurationMs?: number;
  toolFormerData?: {
    toolCallId?: string;
    name?: string;
    status?: string;
    params?: unknown;
    result?: unknown;
    userDecision?: string;
  };
}

/** composerHeaders.value head (partial). */
interface ComposerHead {
  name?: string;
  unifiedMode?: string;
  forceMode?: string;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
}

export interface ComposerData {
  _v?: number;
  composerId?: string;
  name?: string;
  status?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  unifiedMode?: string;
  forceMode?: string;
  modelConfig?: { modelName?: string; selectedModels?: { modelId?: string }[] };
  contextTokensUsed?: number;
  contextTokenLimit?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  filesChangedCount?: number;
  subagentComposerIds?: string[];
  generatingBubbleIds?: string[];
  fullConversationHeadersOnly?: HeaderEntry[];
}

interface HeaderEntry {
  bubbleId: string;
  type: number;
  createdAt?: string;
  grouping?: {
    isRenderable?: boolean;
    textPreview?: string;
    thinkingDurationMs?: number;
  };
}

export class CursorAdapter implements ContentSource {
  readonly ide = 'cursor' as const;
  private db: Database.Database;
  readonly rootPath: string;
  private contentCache = new Map<string, string | null>();
  private readonly includeProcess: boolean;

  constructor(dbPath: string, opts?: { includeProcess?: boolean }) {
    this.includeProcess = opts?.includeProcess !== false;
    this.rootPath = dbPath;
    const Database = loadBetterSqlite3();
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    this.db.pragma('busy_timeout = 5000');
  }

  probe(): SourceProbe {
    try {
      const n = this.db
        .prepare('SELECT COUNT(*) AS c FROM composerHeaders')
        .get() as { c: number };
      const row = this.db
        .prepare(
          'SELECT value FROM cursorDiskKV WHERE key LIKE \'composerData:%\' LIMIT 1',
        )
        .get() as { value: string } | undefined;
      let schemaVersion: number | undefined;
      if (row?.value) {
        try {
          schemaVersion = (JSON.parse(row.value) as ComposerData)._v;
        }
        catch {
          /* ignore */
        }
      }
      return {
        ok: n.c > 0,
        schemaVersion,
        // Unknown-old only: recorded version strictly below 17. 17 and 18 are fine.
        versionMismatch:
          schemaVersion !== undefined && schemaVersion < 17,
        rootPath: this.rootPath,
      };
    }
    catch (err) {
      return { ok: false, rootPath: this.rootPath, error: String(err) };
    }
  }

  dataVersion(): number {
    return this.db.pragma('data_version', { simple: true }) as number;
  }

  changeSignal(): number {
    return this.dataVersion();
  }

  /** Structural fingerprint: any DB write changes it, but reading is one cheap pragma. */
  indexSignal(): number {
    return this.dataVersion();
  }

  /** Census: Cursor's list is already one SQL (composerHeaders); reuse it. */
  listSessionHeads(): SessionMeta[] {
    return this.listSessions();
  }

  listSessions(): SessionMeta[] {
    const rows = this.db
      .prepare(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt,
                isArchived, isSubagent, value
         FROM composerHeaders
         ORDER BY lastUpdatedAt DESC`,
      )
      .all() as {
      composerId: string;
      workspaceId: string;
      createdAt: number;
      lastUpdatedAt: number;
      isArchived: number;
      isSubagent: number;
      value: string | null;
    }[];

    return rows.map((r) => {
      let head: ComposerHead = {};
      try {
        head = r.value ? (JSON.parse(r.value) as ComposerHead) : {};
      }
      catch {
        /* ignore */
      }
      const ref: SessionRef = {
        ide: 'cursor',
        workspaceId: r.workspaceId,
        sessionId: r.composerId,
      };
      return {
        ref,
        title: head.name || '(untitled)',
        createdAt: r.createdAt ?? 0,
        lastUpdatedAt: r.lastUpdatedAt ?? r.createdAt ?? 0,
        isArchived: r.isArchived === 1,
        isSubagent: r.isSubagent === 1,
        status: 'idle' as const,
        linesAdded: head.totalLinesAdded,
        linesRemoved: head.totalLinesRemoved,
        mode: head.unifiedMode || head.forceMode,
        messageCount: 0,
      };
    });
  }

  readComposer(sessionId: string): ComposerData | null {
    const row = this.db
      .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      .get(`composerData:${sessionId}`) as { value: string } | undefined;
    if (!row?.value)
      return null;
    try {
      return JSON.parse(row.value) as ComposerData;
    }
    catch {
      return null;
    }
  }

  /**
   * Index-driven order. Drop grouping.isRenderable === false.
   * complete is false while bubbleId is in generatingBubbleIds.
   */
  readIndex(sessionId: string): MessageHeader[] {
    const cd = this.readComposer(sessionId);
    const entries = cd?.fullConversationHeadersOnly ?? [];
    const generating = cd?.generatingBubbleIds ?? [];
    return entries
      .filter(e => e.grouping?.isRenderable !== false)
      .map(e => ({
        messageId: e.bubbleId,
        role: e.type === 1 ? ('human' as const) : ('assistant' as const),
        createdAt: e.createdAt ? Date.parse(e.createdAt) : 0,
        preview: e.grouping?.textPreview,
        thinkingDurationMs: e.grouping?.thinkingDurationMs,
        complete: generating.includes(e.bubbleId) === false,
      }));
  }

  enrichMeta(meta: SessionMeta): SessionMeta {
    const cd = this.readComposer(meta.ref.sessionId);
    if (!cd)
      return meta;
    const statusMap: Record<string, SessionMeta['status']> = {
      none: 'idle',
      completed: 'completed',
      aborted: 'aborted',
    };
    return {
      ...meta,
      title: cd.name || meta.title,
      status:
        (cd.generatingBubbleIds?.length ?? 0) > 0
          ? 'generating'
          : statusMap[cd.status ?? 'none'] ?? 'idle',
      tokensUsed: cd.contextTokensUsed,
      tokenLimit: cd.contextTokenLimit,
      linesAdded: cd.totalLinesAdded ?? meta.linesAdded,
      linesRemoved: cd.totalLinesRemoved ?? meta.linesRemoved,
      filesChanged: cd.filesChangedCount,
      childSessionIds: cd.subagentComposerIds?.length
        ? cd.subagentComposerIds
        : undefined,
      messageCount: cd.fullConversationHeadersOnly?.length ?? 0,
      modelName:
        cd.modelConfig?.modelName
        ?? cd.modelConfig?.selectedModels?.[0]?.modelId,
      mode: cd.unifiedMode || cd.forceMode,
    };
  }

  /**
   * Read bubble bodies by primary key `bubbleId:<session>:<id>`.
   * When `ids` is omitted we still LIKE the prefix (tests / rare full dumps).
   */
  readBubbles(sessionId: string, ids?: string[]): Bubble[] {
    if (ids) {
      const stmt = this.db.prepare(
        'SELECT value FROM cursorDiskKV WHERE key = ?',
      );
      const out: Bubble[] = [];
      for (const bubbleId of ids) {
        const row = stmt.get(`bubbleId:${sessionId}:${bubbleId}`) as
          | { value: string | null }
          | undefined;
        const parsed = parseBubble(bubbleId, row?.value);
        if (parsed)
          out.push(parsed);
      }
      out.sort((a, b) => a.createdAt - b.createdAt);
      return out;
    }

    const prefix = `bubbleId:${sessionId}:`;
    const rows = this.db
      .prepare('SELECT key, value FROM cursorDiskKV WHERE key LIKE ?')
      .all(`${prefix}%`) as { key: string; value: string | null }[];
    const out: Bubble[] = [];
    for (const r of rows) {
      const parsed = parseBubble(r.key.slice(prefix.length), r.value);
      if (parsed)
        out.push(parsed);
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  bubbleSizes(sessionId: string): Map<string, number> {
    const index = this.readIndex(sessionId);
    const stmt = this.db.prepare(
      'SELECT length(value) AS n FROM cursorDiskKV WHERE key = ?',
    );
    const out = new Map<string, number>();
    for (const h of index) {
      const row = stmt.get(`bubbleId:${sessionId}:${h.messageId}`) as
        | { n: number | null }
        | undefined;
      out.set(h.messageId, row?.n ?? 0);
    }
    return out;
  }

  /**
   * Line-level diffs for edit_file_v2 only, via composer.content.* snapshots.
   * Do not consult codeBlockPartialInlineDiffFates.
   */
  readDiffs(bubbles: Bubble[]): Map<string, CodeBlockItem> {
    const out = new Map<string, CodeBlockItem>();
    const stmt = this.db.prepare(
      'SELECT value FROM cursorDiskKV WHERE key = ?',
    );

    for (const b of bubbles) {
      const t = b.toolFormerData;
      if (!t || t.name !== 'edit_file_v2')
        continue;

      const res
        = typeof t.result === 'string'
          ? safeParse(t.result)
          : (t.result as Record<string, unknown> | undefined);
      const beforeId = res?.beforeContentId as string | undefined;
      const afterId = res?.afterContentId as string | undefined;
      if (!beforeId || !afterId)
        continue;

      const before = this.readContentCached(stmt, beforeId);
      const after = this.readContentCached(stmt, afterId);
      if (before === null || after === null)
        continue;

      const params = parseParamsLoose(t.params);
      const filename
        = (params.relativeWorkspacePath as string)
          ?? (params.targetFile as string)
          ?? undefined;

      const ops = diffLines(before, after);
      if (ops.length === 0)
        continue;

      out.set(b.bubbleId, {
        blockKind: 'diff',
        filename,
        code: ops.map(o => o.text).join('\n'),
        diffLines: ops,
      });
    }
    return out;
  }

  /** Whether this session exists on disk (a composerData row counts; same source as listSessions). */
  hasSession(sessionId: string): boolean {
    return this.readComposer(sessionId) !== null;
  }

  projectSession(sessionId: string, ids?: string[]): ChatElement[] {
    const index = this.readIndex(sessionId);
    const useIndex = ids ? index.filter(h => ids.includes(h.messageId)) : index;
    const bubbles = this.readBubbles(
      sessionId,
      useIndex.map(h => h.messageId),
    );
    const diffs = this.includeProcess ? this.readDiffs(bubbles) : new Map();
    let { messages } = project(useIndex, bubbles, diffs, {
      includeProcess: this.includeProcess,
    });
    const cd = this.readComposer(sessionId);
    const generating = (cd?.generatingBubbleIds?.length ?? 0) > 0;
    if (this.includeProcess && !generating) {
      messages = completeStuckTools(messages);
    }
    return messages;
  }

  private readContentCached(
    stmt: Database.Statement,
    contentId: string,
  ): string | null {
    if (this.contentCache.has(contentId)) {
      return this.contentCache.get(contentId)!;
    }
    const row = stmt.get(contentId) as { value: string } | undefined;
    const v = row?.value ?? null;
    this.contentCache.set(contentId, v);
    return v;
  }

  close(): void {
    this.db.close();
  }
}

function parseBubble(bubbleId: string, value: string | null | undefined): Bubble | null {
  if (!value)
    return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(value) as Record<string, unknown>;
  }
  catch {
    return null;
  }
  const thinking = raw.thinking as { text?: string } | undefined;
  return {
    bubbleId,
    type: (raw.type as number) ?? 0,
    createdAt: parseTs(raw.createdAt),
    text: (raw.text as string) ?? '',
    thinking: thinking?.text,
    thinkingDurationMs: raw.thinkingDurationMs as number | undefined,
    toolFormerData: raw.toolFormerData as Bubble['toolFormerData'],
  };
}

function completeStuckTools(messages: ChatElement[]): ChatElement[] {
  let any = false;
  const next = messages.map((m) => {
    if (m.type === 'tool' && m.status === 'loading') {
      any = true;
      return { ...m, status: 'completed' } satisfies ToolCallElement;
    }
    return m;
  });
  return any ? next : messages;
}

function safeParse(s: string): Record<string, unknown> | undefined {
  try {
    const p = JSON.parse(s) as unknown;
    return p && typeof p === 'object'
      ? (p as Record<string, unknown>)
      : undefined;
  }
  catch {
    return undefined;
  }
}

function parseParamsLoose(raw: unknown): Record<string, unknown> {
  if (raw == null)
    return {};
  if (typeof raw === 'object')
    return raw as Record<string, unknown>;
  if (typeof raw === 'string')
    return safeParse(raw) ?? {};
  return {};
}

function parseTs(v: unknown): number {
  if (typeof v === 'number')
    return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}
