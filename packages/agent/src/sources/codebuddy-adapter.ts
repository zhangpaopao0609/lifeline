/**
 * Readonly CodeBuddy content source: JSON files under
 * ~/Library/Application Support/CodeBuddyExtension/Data.
 *
 * Layout:
 *   <root>/<uid>/CodeBuddyIDE/<workspaceId>/history/<bucket>/
 *     index.json                 { conversations: [...] }
 *     <sessionId>/index.json     { messages, requests }
 *     <sessionId>/messages/<id>.json
 */

import type { ChatElement } from '../types.js';
import type { CodeBuddyIndexEntry, CodeBuddyMessageFile } from './codebuddy-project.js';
import type { ContentSource } from './content-source.js';
import type {
  MessageHeader,
  SessionMeta,
  SessionRef,
  SourceProbe,
} from './types.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {

  parseJsonObject,
  parseTs,
  projectCodeBuddy,
} from './codebuddy-project.js';

interface ConversationHead {
  id: string;
  name?: string;
  lastMessageAt?: string;
  createdAt?: string;
  chatMode?: string;
  selectedModelId?: string;
}

interface BucketIndex {
  conversations?: ConversationHead[];
}

interface SessionIndex {
  messages?: CodeBuddyIndexEntry[];
  requests?: { id?: string; state?: string; messages?: string[] }[];
}

interface LocatedSession {
  sessionId: string;
  workspaceId: string;
  dir: string;
  conv: ConversationHead;
}

const SCHEMA_FP = 'index.messages+requests;file.message+extra';

export class CodeBuddyAdapter implements ContentSource {
  readonly ide = 'codebuddy' as const;
  readonly rootPath: string;
  private readonly includeProcess: boolean;
  private watchedSessionId: string | null = null;
  private locById = new Map<string, LocatedSession>();
  private bucketsSig = Number.NaN;

  constructor(rootPath: string, opts?: { includeProcess?: boolean }) {
    this.rootPath = rootPath;
    this.includeProcess = opts?.includeProcess !== false;
  }

  close(): void {
    /* JSON files; nothing to release */
  }

  setWatchedSession(sessionId: string | null): void {
    this.watchedSessionId = sessionId;
  }

  probe(): SourceProbe {
    try {
      if (!existsSync(this.rootPath) || !statSync(this.rootPath).isDirectory()) {
        return { ok: false, rootPath: this.rootPath, error: 'missing root' };
      }
      const historyDirs = this.listHistoryDirs();
      if (historyDirs.length === 0) {
        return { ok: false, rootPath: this.rootPath, error: 'no history/' };
      }
      const sessions = this.scan();
      let versionMismatch = false;
      for (const loc of sessions) {
        const idx = readJson<SessionIndex>(join(loc.dir, 'index.json'));
        if (!idx || !Array.isArray(idx.messages) || !Array.isArray(idx.requests)) {
          versionMismatch = true;
          break;
        }
        const first = idx.messages[0];
        if (first) {
          const file = readMessageFile(join(loc.dir, 'messages', `${first.id}.json`));
          if (file && file.message == null && file.extra == null) {
            versionMismatch = true;
            break;
          }
        }
      }
      return {
        ok: true,
        schemaVersion: SCHEMA_FP,
        versionMismatch,
        rootPath: this.rootPath,
      };
    }
    catch (err) {
      return { ok: false, rootPath: this.rootPath, error: String(err) };
    }
  }

  changeSignal(): number {
    let max = this.bucketSignal();
    if (this.watchedSessionId) {
      this.refreshLocsIfNeeded();
      const loc = this.locById.get(this.watchedSessionId);
      if (loc) {
        max = Math.max(max, mtimeMs(join(loc.dir, 'index.json')), mtimeMs(join(loc.dir, 'messages')));
      }
    }
    return max;
  }

  sessionBodySignal(sessionId: string): string {
    this.refreshLocsIfNeeded();
    const loc = this.locById.get(sessionId);
    if (!loc)
      return '';
    return `${mtimeMs(join(loc.dir, 'index.json'))}:${mtimeMs(join(loc.dir, 'messages'))}`;
  }

  /** Structural fingerprint: bucket-index mtime only, not current session body (census; a few stats). */
  indexSignal(): number {
    return this.bucketSignal();
  }

  /**
   * Census only: session heads (id/title/time), no message files.
   * `listSessions()` calls `peekSessionFlags` per session (reads message files);
   * 1000 sessions must not enter a 2s poll.
   */
  listSessionHeads(): SessionMeta[] {
    this.refreshLocsIfNeeded();
    const rows = [...this.locById.values()].map(loc => ({
      ref: {
        ide: 'codebuddy',
        workspaceId: loc.workspaceId,
        sessionId: loc.sessionId,
      } satisfies SessionRef,
      title: loc.conv.name || '(untitled)',
      createdAt: parseTs(loc.conv.createdAt),
      lastUpdatedAt: parseTs(loc.conv.lastMessageAt),
      isArchived: false,
      isSubagent: false,
      status: 'idle' as const,
      messageCount: 0,
      mode: loc.conv.chatMode,
      modelName: loc.conv.selectedModelId,
    } satisfies SessionMeta));
    rows.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
    return rows;
  }

  listSessions(): SessionMeta[] {
    this.refreshLocsIfNeeded(true);
    const rows = [...this.locById.values()].map((loc) => {
      const lastUpdatedAt = parseTs(loc.conv.lastMessageAt);
      const createdAt = parseTs(loc.conv.createdAt);
      const flags = peekSessionFlags(loc.dir);
      const ref: SessionRef = {
        ide: 'codebuddy',
        workspaceId: loc.workspaceId,
        sessionId: loc.sessionId,
      };
      return {
        ref,
        title: loc.conv.name || '(untitled)',
        createdAt,
        lastUpdatedAt,
        isArchived: false,
        isSubagent: flags.isSubagent,
        status: flags.status,
        messageCount: flags.messageCount,
        mode: loc.conv.chatMode,
        modelName: loc.conv.selectedModelId,
      } satisfies SessionMeta;
    });
    rows.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
    return rows;
  }

  readIndex(sessionId: string): MessageHeader[] {
    const loc = this.findSession(sessionId);
    if (!loc)
      return [];
    const idx = readJson<SessionIndex>(join(loc.dir, 'index.json'));
    const entries = idx?.messages ?? [];
    return entries.map(e => ({
      messageId: e.id,
      role: indexRole(e.role),
      createdAt: 0,
      complete: e.isComplete !== false,
    }));
  }

  enrichMeta(meta: SessionMeta): SessionMeta {
    const loc = this.findSession(meta.ref.sessionId);
    if (!loc)
      return meta;
    const flags = peekSessionFlags(loc.dir);
    const idx = readJson<SessionIndex>(join(loc.dir, 'index.json'));
    if (!idx)
      return { ...meta, ...flags };

    let modelName = meta.modelName;
    let tokensUsed: number | undefined;
    let tokenLimit: number | undefined;
    for (const e of idx.messages ?? []) {
      const file = readMessageFile(join(loc.dir, 'messages', `${e.id}.json`));
      if (!file)
        continue;
      const extra = parseJsonObject(file.extra);
      if (typeof extra.modelName === 'string' && extra.modelName) {
        modelName = extra.modelName;
      }
      if (typeof extra.lastStepInputTokens === 'number') {
        tokensUsed = extra.lastStepInputTokens;
      }
      if (typeof extra.lastStepOutputTokens === 'number' && tokensUsed != null) {
        tokensUsed += extra.lastStepOutputTokens;
      }
    }

    return {
      ...meta,
      status: flags.status,
      isSubagent: flags.isSubagent,
      modelName,
      tokensUsed,
      tokenLimit,
      messageCount: flags.messageCount,
    };
  }

  /** Whether this session exists on disk (decides whether to answer session:get across machines). */
  hasSession(sessionId: string): boolean {
    return this.findSession(sessionId) !== undefined;
  }

  projectSession(sessionId: string, ids?: string[]): ChatElement[] {
    const loc = this.findSession(sessionId);
    if (!loc)
      return [];
    const idx = readJson<SessionIndex>(join(loc.dir, 'index.json'));
    const entries = idx?.messages ?? [];
    const want = ids ? new Set(ids) : null;
    const files = new Map<string, CodeBuddyMessageFile>();
    for (const e of entries) {
      if (want && !want.has(e.id))
        continue;
      if (!this.includeProcess && e.role === 'tool')
        continue;
      const file = readMessageFile(join(loc.dir, 'messages', `${e.id}.json`));
      if (file)
        files.set(e.id, file);
    }
    const useEntries = want ? entries.filter(e => want.has(e.id)) : entries;
    return projectCodeBuddy(useEntries, files, {
      includeProcess: this.includeProcess,
    });
  }

  private findSession(sessionId: string): LocatedSession | undefined {
    this.refreshLocsIfNeeded();
    return this.locById.get(sessionId);
  }

  private bucketSignal(): number {
    let max = 0;
    for (const hist of this.listHistoryDirs()) {
      for (const bucket of listDirs(hist)) {
        const m = mtimeMs(join(hist, bucket, 'index.json'));
        if (m > max)
          max = m;
      }
    }
    return max;
  }

  private refreshLocsIfNeeded(force = false): void {
    const sig = this.bucketSignal();
    if (!force && sig === this.bucketsSig && this.locById.size > 0)
      return;
    this.bucketsSig = sig;
    this.locById = new Map();
    for (const loc of this.scan()) this.locById.set(loc.sessionId, loc);
  }

  private listHistoryDirs(): string[] {
    const out: string[] = [];
    if (!existsSync(this.rootPath))
      return out;
    for (const uid of listDirs(this.rootPath)) {
      const ideRoot = join(this.rootPath, uid, 'CodeBuddyIDE');
      if (!existsSync(ideRoot))
        continue;
      for (const workspaceId of listDirs(ideRoot)) {
        const hist = join(ideRoot, workspaceId, 'history');
        if (existsSync(hist) && statSync(hist).isDirectory())
          out.push(hist);
      }
    }
    return out;
  }

  private scan(): LocatedSession[] {
    const out: LocatedSession[] = [];
    if (!existsSync(this.rootPath))
      return out;
    for (const uid of listDirs(this.rootPath)) {
      const ideRoot = join(this.rootPath, uid, 'CodeBuddyIDE');
      if (!existsSync(ideRoot))
        continue;
      for (const workspaceId of listDirs(ideRoot)) {
        const histRoot = join(ideRoot, workspaceId, 'history');
        if (!existsSync(histRoot))
          continue;
        for (const bucket of listDirs(histRoot)) {
          const bucketDir = join(histRoot, bucket);
          const head = readJson<BucketIndex>(join(bucketDir, 'index.json'));
          const convs = head?.conversations ?? [];
          for (const conv of convs) {
            if (!conv?.id)
              continue;
            out.push({
              sessionId: conv.id,
              workspaceId,
              dir: join(bucketDir, conv.id),
              conv,
            });
          }
        }
      }
    }
    return out;
  }
}

/** Cheap list flags for adapter.listSessions (not pushed to the web). */
function peekSessionFlags(dir: string): {
  isSubagent: boolean;
  status: SessionMeta['status'];
  messageCount: number;
} {
  const idx = readJson<SessionIndex>(join(dir, 'index.json'));
  if (!idx)
    return { isSubagent: false, status: 'idle', messageCount: 0 };

  const incomplete = (idx.messages ?? []).some(m => m.isComplete === false);
  const running = (idx.requests ?? []).some(r =>
    (r.state ?? '').toLowerCase().includes('running'),
  );
  const status: SessionMeta['status']
    = incomplete || running
      ? 'generating'
      : (idx.requests ?? []).length > 0
          ? 'completed'
          : 'idle';

  let isSubagent = false;
  for (const e of idx.messages ?? []) {
    const file = readMessageFile(join(dir, 'messages', `${e.id}.json`));
    if (!file)
      continue;
    const extra = parseJsonObject(file.extra);
    if (extra.isHelperMessage === true) {
      isSubagent = true;
      break;
    }
  }

  return {
    isSubagent,
    status,
    messageCount: (idx.messages ?? []).length,
  };
}

function mtimeMs(path: string): number {
  try {
    const m = statSync(path).mtimeMs;
    return Number.isFinite(m) ? m : 0;
  }
  catch {
    return 0;
  }
}

function indexRole(role: string | undefined): MessageHeader['role'] {
  if (role === 'user' || role === 'human')
    return 'human';
  if (role === 'tool')
    return 'tool';
  return 'assistant';
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  }
  catch {
    return [];
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  }
  catch {
    return null;
  }
}

function readMessageFile(path: string): CodeBuddyMessageFile | null {
  return readJson<CodeBuddyMessageFile>(path);
}
