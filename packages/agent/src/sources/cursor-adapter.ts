/**
 * Readonly Cursor content source: state.vscdb (SQLite WAL).
 * Open with { readonly: true, fileMustExist: true } — never immutable=1
 * (that ignores WAL and serves a stale snapshot).
 */

import type Database from 'better-sqlite3';
import type { ChatElement, CodeBlockItem, ToolCallElement } from '../types.js';
import type { ContentSource } from './content-source.js';
import type { TurnBubble } from './cursor-transcript.js';
import type {
  MessageHeader,
  SessionMeta,
  SessionRef,
  SourceProbe,
} from './types.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadBetterSqlite3 } from '../load-sqlite.js';
import { fillFromTranscript, parseTranscript, TRANSCRIPT_TAIL_TURNS } from './cursor-transcript.js';
import { diffLines } from './diff.js';
import { project } from './project.js';

/** How long a "no transcript for this session" answer is trusted before the projects dir is scanned again. */
const TRANSCRIPT_MISS_TTL_MS = 30_000;

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
    isSimulatedMsg?: boolean;
    simulatedMsgReason?: number;
    simulatedMessageMetadataTitle?: string;
    simulatedMessageMetadataSuppressUIDisplay?: boolean;
    backgroundTaskCompletionKind?: string;
  };
}

/** agent.v1.SimulatedMsgReason.BACKGROUND_TASK_COMPLETION. Cursor renders these as "Finished" rows. */
const SIMULATED_REASON_BACKGROUND_TASK = 3;

function isBackgroundTaskNotification(grouping: HeaderEntry['grouping']): boolean {
  if (grouping?.isSimulatedMsg !== true)
    return false;
  if (grouping.simulatedMessageMetadataSuppressUIDisplay === true)
    return false;
  return grouping.backgroundTaskCompletionKind !== undefined
    || grouping.simulatedMsgReason === SIMULATED_REASON_BACKGROUND_TASK;
}

export class CursorAdapter implements ContentSource {
  readonly ide = 'cursor' as const;
  private db: Database.Database;
  readonly rootPath: string;
  private contentCache = new Map<string, string | null>();
  private readonly includeProcess: boolean;
  /** `~/.cursor/projects` (one `<workspace>/agent-transcripts/<id>/<id>.jsonl` per chat). Tests point it elsewhere. */
  private readonly transcriptsRoot: string;
  private readonly transcriptFiles = new Map<string, string>();
  private readonly transcriptMisses = new Map<string, number>();
  private readonly fillCache = new Map<string, { key: string; fill: Map<string, string> }>();

  constructor(dbPath: string, opts?: { includeProcess?: boolean; transcriptsRoot?: string }) {
    this.includeProcess = opts?.includeProcess !== false;
    this.transcriptsRoot = opts?.transcriptsRoot ?? join(homedir(), '.cursor', 'projects');
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

  /**
   * A DB write moves it, and so does a write to any transcript we have already located: the database can sit idle
   * for an hour while Cursor keeps appending finished replies to the transcript (see cursor-transcript.ts).
   * With no transcript known the value is exactly `data_version`.
   */
  changeSignal(): number {
    let stamp = 0;
    for (const file of this.transcriptFiles.values()) {
      try {
        stamp += Math.floor(statSync(file).mtimeMs);
      }
      catch {
        /* file gone: contributes nothing, which is itself a change */
      }
    }
    return this.dataVersion() + (stamp % 1_000_000_007);
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
   * Message-header entries for one chat. Newer Cursor builds (mid Oct 2026) moved
   * the index out of `composerData.fullConversationHeadersOnly` into paged KV rows
   * `composerConvHeaders:<sessionId>:<page>` — the legacy field stays empty for new
   * chats. Fall back to merging the pages in key order; page entries keep the
   * legacy shape (bubbleId / type / grouping / createdAt).
   */
  private readHeaderEntries(sessionId: string, cd = this.readComposer(sessionId)): HeaderEntry[] {
    const legacy = cd?.fullConversationHeadersOnly ?? [];
    if (legacy.length > 0)
      return legacy;
    try {
      const rows = this.db
        .prepare('SELECT value FROM cursorDiskKV WHERE key LIKE ? ORDER BY key')
        .all(`composerConvHeaders:${sessionId}:%`) as { value: string }[];
      return rows.flatMap((r) => {
        try {
          const parsed = JSON.parse(r.value) as unknown;
          return Array.isArray(parsed) ? (parsed as HeaderEntry[]) : [];
        }
        catch {
          return [];
        }
      });
    }
    catch {
      return [];
    }
  }

  /**
   * Index-driven order. Drop grouping.isRenderable === false.
   * complete is false while bubbleId is in generatingBubbleIds.
   */
  readIndex(sessionId: string): MessageHeader[] {
    const cd = this.readComposer(sessionId);
    const entries = this.readHeaderEntries(sessionId, cd);
    const generating = cd?.generatingBubbleIds ?? [];
    return entries
      .filter(e => e.grouping?.isRenderable !== false)
      .filter(e => !(
        e.type === 1
        && e.grouping?.isSimulatedMsg === true
        && e.grouping.simulatedMsgReason === SIMULATED_REASON_BACKGROUND_TASK
        && e.grouping.simulatedMessageMetadataSuppressUIDisplay === true
      ))
      .map((e) => {
        const notification = e.type === 1 && isBackgroundTaskNotification(e.grouping);
        return {
          messageId: e.bubbleId,
          role: e.type === 1 ? ('human' as const) : ('assistant' as const),
          createdAt: e.createdAt ? Date.parse(e.createdAt) : 0,
          preview: e.grouping?.textPreview,
          thinkingDurationMs: e.grouping?.thinkingDurationMs,
          ...(notification
            ? { notificationTitle: e.grouping?.simulatedMessageMetadataTitle?.trim() || 'Background task' }
            : {}),
          complete: generating.includes(e.bubbleId) === false,
        };
      });
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
      messageCount: this.readHeaderEntries(meta.ref.sessionId, cd).length,
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
    // A stub's stored size never changes when its text arrives via the transcript; fold the text in so the
    // change is seen (and the bubble is re-read) the moment the fill first appears or grows.
    for (const [id, text] of this.transcriptFill(sessionId))
      out.set(id, (out.get(id) ?? 0) + text.length);
    return out;
  }

  /** Path of this chat's transcript, or null. Found once by scanning the projects dir, then remembered. */
  private transcriptFile(sessionId: string): string | null {
    const known = this.transcriptFiles.get(sessionId);
    if (known && existsSync(known))
      return known;
    this.transcriptFiles.delete(sessionId);
    const missedAt = this.transcriptMisses.get(sessionId);
    if (missedAt !== undefined && Date.now() - missedAt < TRANSCRIPT_MISS_TTL_MS)
      return null;
    try {
      for (const project of readdirSync(this.transcriptsRoot)) {
        const file = join(this.transcriptsRoot, project, 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
        if (existsSync(file)) {
          this.transcriptFiles.set(sessionId, file);
          this.transcriptMisses.delete(sessionId);
          return file;
        }
      }
    }
    catch {
      /* no projects dir (Linux content source, fresh machine): nothing to fill from */
    }
    this.transcriptMisses.set(sessionId, Date.now());
    return null;
  }

  /**
   * bubbleId → text for this chat's stub bubbles, taken from its transcript (see cursor-transcript.ts).
   * Cached on (transcript mtime+size, data_version): the fill can only change when one of them does.
   */
  private transcriptFill(sessionId: string): Map<string, string> {
    const empty = new Map<string, string>();
    const file = this.transcriptFile(sessionId);
    if (!file)
      return empty;
    try {
      const st = statSync(file);
      const key = `${st.mtimeMs}:${st.size}:${this.dataVersion()}`;
      const cached = this.fillCache.get(sessionId);
      if (cached?.key === key)
        return cached.fill;

      // Align against **every** header, hidden ones included: Cursor hides some human bubbles from the UI
      // (`isRenderable: false`) but the transcript still counts their turn, so the filtered `readIndex` would
      // never match the transcript's user-message count.
      const index = this.readHeaderEntries(sessionId).map(e => ({
        messageId: e.bubbleId,
        role: e.type === 1 ? ('human' as const) : ('assistant' as const),
        preview: e.grouping?.textPreview,
      }));
      const humanAt = index.flatMap((h, i) => (h.role === 'human' ? [i] : []));
      const from = humanAt[Math.max(0, humanAt.length - TRANSCRIPT_TAIL_TURNS)] ?? 0;
      const stmt = this.db.prepare(
        `SELECT json_extract(value, '$.text') AS text,
                json_extract(value, '$.thinking.text') AS thinking,
                json_extract(value, '$.toolFormerData.name') AS tool
         FROM cursorDiskKV WHERE key = ?`,
      );
      const bubbles: TurnBubble[] = index.map((h, i) => {
        const bubble: TurnBubble = { id: h.messageId, role: h.role, preview: h.preview };
        if (i >= from) {
          const row = stmt.get(`bubbleId:${sessionId}:${h.messageId}`) as
            | { text: string | null; thinking: string | null; tool: string | null }
            | undefined;
          if (row)
            bubble.body = { text: row.text ?? '', thinking: row.thinking ?? '', tool: row.tool != null };
        }
        return bubble;
      });
      const fill = fillFromTranscript(bubbles, parseTranscript(readFileSync(file, 'utf-8')));
      this.fillCache.set(sessionId, { key, fill });
      return fill;
    }
    catch {
      return empty;
    }
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
    const fill = this.transcriptFill(sessionId);
    for (const b of bubbles) {
      const text = fill.get(b.bubbleId);
      if (text !== undefined && b.text.trim() === '')
        b.text = text;
    }
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
