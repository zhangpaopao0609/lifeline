/**
 * Readonly WorkBuddy (CodeBuddy CN) content source: append-only JSONL sessions.
 *
 * CodeBuddy CN (WorkBuddy kernel) no longer writes the legacy
 * `CodeBuddyIDE/history/<bucket>/<session>/index.json + messages/*.json` tree that
 * {@link CodeBuddyAdapter} reads. Sessions live at
 * `~/.workbuddy/projects/<projectDir>/<sessionUuid>.jsonl`, one JSON object per line:
 *
 *   message/user      content: [{type:"input_text", text}]
 *   message/assistant content: [{type:"output_text", text}], status: "completed"|"incomplete"
 *   reasoning         rawContent: [{type:"reasoning_text", text}]
 *   function_call     {name, callId, arguments(JSON string)}
 *   function_call_result {name, callId, status, output:{type:"text", text}}
 *   ai-title          {aiTitle} (session title)
 *
 * Two cross-cutting notes:
 *
 * - The web console addresses sessions by webview tab id (data-session-tab-id,
 *   32-hex) which never lands on disk. `setTabAliases()` feeds tabId → tab title
 *   from the live DOM dump and titles are matched against jsonl ai-title lines
 *   (most recently updated wins on duplicate titles).
 *
 * - SSH-remote workspace sessions persist on the remote host; this machine's disk
 *   can never see them. `setLiveMessages()` accepts the active conversation's
 *   rendered messages scraped from the webview DOM (keyed by tab id) and synthesizes
 *   virtual "live-dom" sessions so the console still shows them.
 */

import type { ChatElement } from '../types.js';
import type { ContentSource, LiveChatMessage } from './content-source.js';
import type {
  MessageHeader,
  SessionMeta,
  SourceProbe,
} from './types.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { toTool, visibleCodeBuddyUserText } from './codebuddy-project.js';

export const WORKBUDDY_PROJECTS_ROOT = join(homedir(), '.workbuddy', 'projects');

/** Locator for one on-disk jsonl session, or one live DOM session. */
interface SessionLoc {
  sessionId: string;
  workspaceId: string;
  filePath: string;
  live?: LiveSession;
}

interface LiveSession {
  messages: LiveChatMessage[];
  sig: string;
  generating: boolean;
  updatedAt: number;
}

type EntryKind = 'human' | 'assistant' | 'reasoning' | 'tool';

interface ParsedEntry {
  id: string;
  role: 'human' | 'assistant' | 'tool';
  createdAt: number;
  complete: boolean;
  kind: EntryKind;
  text?: string;
  tool?: {
    toolCallId: string;
    toolName?: string;
    args?: unknown;
    extraStatus?: string;
    result?: string;
  };
}

interface ParsedSession {
  entries: ParsedEntry[];
  title: string;
  modelName?: string;
  createdAt: number;
  lastUpdatedAt: number;
  status: SessionMeta['status'];
  messageCount: number;
}

interface JsonlRow {
  type?: string;
  role?: string;
  id?: string;
  timestamp?: number;
  status?: string;
  aiTitle?: string;
  name?: string;
  callId?: string;
  arguments?: unknown;
  content?: { type?: string; text?: string }[];
  rawContent?: { type?: string; text?: string }[];
  output?: { type?: string; text?: string };
  providerData?: { model?: string };
}

function sig(filePath: string): string {
  try {
    const st = statSync(filePath);
    return `${Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0}:${st.size}`;
  }
  catch {
    return '0:0';
  }
}

function parseJsonLine(line: string): JsonlRow | null {
  try {
    return JSON.parse(line) as JsonlRow;
  }
  catch {
    return null;
  }
}

function joinTexts(content: JsonlRow['content'], type: string): string {
  if (!Array.isArray(content))
    return '';
  return content
    .map(b => (b && b.type === type && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
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

/** Parse one session jsonl. Two passes: tool results first (order-free join), then the timeline. */
export function parseWorkBuddyJsonl(filePath: string): ParsedSession | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  }
  catch {
    return null;
  }
  const lines = raw.split('\n');

  const resultByCallId = new Map<string, { status?: string; output: string }>();
  for (const line of lines) {
    if (!line.includes('"function_call_result"'))
      continue;
    const d = parseJsonLine(line);
    if (d && d.type === 'function_call_result' && d.callId) {
      resultByCallId.set(d.callId, {
        status: d.status,
        output: d.output && typeof d.output.text === 'string' ? d.output.text : '',
      });
    }
  }

  const entries: ParsedEntry[] = [];
  let title = '';
  let modelName: string | undefined;
  let createdAt = 0;
  let lastUpdatedAt = 0;
  let generating = false;

  for (const line of lines) {
    if (!line.trim())
      continue;
    const d = parseJsonLine(line);
    if (!d || typeof d !== 'object')
      continue;
    const ts = typeof d.timestamp === 'number' ? d.timestamp : 0;
    if (ts) {
      if (!createdAt)
        createdAt = ts;
      lastUpdatedAt = ts;
    }
    if (d.type === 'ai-title' && typeof d.aiTitle === 'string' && d.aiTitle.trim()) {
      title = d.aiTitle.trim();
      continue;
    }
    if (d.type === 'message' && d.role === 'user') {
      const text = visibleCodeBuddyUserText(joinTexts(d.content, 'input_text'));
      entries.push({ id: d.id ?? '', role: 'human', createdAt: ts, complete: true, kind: 'human', text });
      continue;
    }
    if (d.type === 'message' && d.role === 'assistant') {
      const text = joinTexts(d.content, 'output_text');
      const complete = d.status !== 'incomplete';
      if (!complete)
        generating = true;
      const model = d.providerData && typeof d.providerData.model === 'string' ? d.providerData.model : undefined;
      if (model)
        modelName = model;
      entries.push({ id: d.id ?? '', role: 'assistant', createdAt: ts, complete, kind: 'assistant', text });
      continue;
    }
    if (d.type === 'reasoning') {
      const text = joinTexts(d.rawContent, 'reasoning_text') || joinTexts(d.content, 'reasoning_text');
      if (text.trim())
        entries.push({ id: d.id ?? '', role: 'assistant', createdAt: ts, complete: true, kind: 'reasoning', text });
      continue;
    }
    if (d.type === 'function_call') {
      let args: unknown;
      if (typeof d.arguments === 'string')
        args = parseJsonLine(d.arguments) ?? undefined;
      else if (d.arguments && typeof d.arguments === 'object')
        args = d.arguments;
      const callId = d.callId || d.id || '';
      const res = d.callId ? resultByCallId.get(d.callId) : undefined;
      entries.push({
        id: callId,
        role: 'tool',
        createdAt: ts,
        complete: res !== undefined,
        kind: 'tool',
        tool: {
          toolCallId: callId,
          toolName: d.name,
          args,
          extraStatus: res?.status,
          result: res ? res.output.slice(0, 4000) : undefined,
        },
      });
      continue;
    }
    // function_call_result: folded into its function_call above.
    // file-history-snapshot / session-meta / resend-fork-notice: not displayable.
  }

  if (!title) {
    const firstUser = entries.find(e => e.kind === 'human' && e.text);
    title = ((firstUser && firstUser.text) || '').slice(0, 60) || '(untitled)';
  }
  const status: SessionMeta['status'] = generating ? 'generating' : entries.length > 0 ? 'completed' : 'idle';
  return { entries, title, modelName, createdAt, lastUpdatedAt, status, messageCount: entries.length };
}

export class WorkBuddyJsonlAdapter implements ContentSource {
  readonly ide = 'codebuddy' as const;
  private readonly includeProcess: boolean;
  /** Live DOM tab aliases: webview tab id (32-hex) -> tab title. */
  private tabTitleById = new Map<string, string>();
  private readonly parseCache = new Map<string, { sig: string; parsed: ParsedSession | null }>();
  private locById = new Map<string, SessionLoc>();
  private censusSig = '';
  /** DOM-scraped virtual sessions (remote workspaces), keyed by tab id. */
  private readonly liveById = new Map<string, LiveSession>();
  private liveSig = '';

  constructor(
    private readonly projectsRoot: string = WORKBUDDY_PROJECTS_ROOT,
    opts?: { includeProcess?: boolean },
  ) {
    this.includeProcess = opts?.includeProcess !== false;
  }

  close(): void {
  }

  setTabAliases(tabs: { composerId?: string; id?: string; title?: string }[]): void {
    const next = new Map<string, string>();
    for (const t of tabs || []) {
      const id = String(t?.composerId || t?.id || '').trim();
      const titleText = String(t?.title || '').trim();
      if (id && titleText)
        next.set(id, titleText);
    }
    this.tabTitleById = next;
  }

  setLiveMessages(tabId: string, messages: LiveChatMessage[], agentStatus?: string): void {
    const id = String(tabId || '').trim();
    if (!id)
      return;
    const list = (Array.isArray(messages) ? messages : [])
      .filter(m => m && typeof m.text === 'string' && m.text.trim())
      .map((m, i) => ({
        role: (m && m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        id: m && typeof m.id === 'string' && m.id ? m.id : `dom-${i}`,
        text: m.text,
      }));
    let h = 0;
    for (const m of list) {
      const s = m.role + m.id + m.text;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    const sig = `${list.length}:${h}`;
    const prev = this.liveById.get(id);
    if (prev && prev.sig === sig)
      return;
    this.liveById.set(id, {
      messages: list,
      sig,
      generating: agentStatus !== 'idle' && agentStatus !== 'error',
      updatedAt: Date.now(),
    });
    this.liveSig = [...this.liveById.values()].map(l => l.sig).join('|');
  }

  probe(): SourceProbe {
    try {
      if (!existsSync(this.projectsRoot))
        return { ok: false, rootPath: this.projectsRoot, error: 'missing root' };
      this.refreshLocs(true);
      if (this.locById.size === 0)
        return { ok: false, rootPath: this.projectsRoot, error: 'no jsonl sessions' };
      return { ok: true, schemaVersion: 'workbuddy-jsonl-v1', versionMismatch: false, rootPath: this.projectsRoot };
    }
    catch (err) {
      return { ok: false, rootPath: this.projectsRoot, error: String(err) };
    }
  }

  changeSignal(): number {
    this.refreshLocs();
    // maxMtime dominates; liveSig makes DOM-only edits visible. Hash into a number.
    const mixed = `${this.maxMtime()}|${this.liveSig}`;
    let h = 0;
    for (let i = 0; i < mixed.length; i++) h = (h * 31 + mixed.charCodeAt(i)) | 0;
    return h;
  }

  sessionBodySignal(sessionId: string): string {
    const loc = this.findSession(sessionId);
    if (!loc)
      return '';
    if (loc.live)
      return `live:${loc.live.sig}`;
    return sig(loc.filePath);
  }

  indexSignal(): number {
    this.refreshLocs();
    return this.maxMtime();
  }

  listSessionHeads(): SessionMeta[] {
    return this.listSessions();
  }

  listSessions(): SessionMeta[] {
    this.refreshLocs();
    const rows: SessionMeta[] = [];
    for (const loc of this.locById.values()) {
      const p = this.parseLoc(loc);
      if (!p)
        continue;
      rows.push({
        ref: { ide: 'codebuddy', workspaceId: loc.workspaceId, sessionId: loc.sessionId },
        title: p.title,
        createdAt: p.createdAt,
        lastUpdatedAt: p.lastUpdatedAt,
        isArchived: false,
        isSubagent: false,
        status: p.status,
        messageCount: p.messageCount,
        mode: undefined,
        modelName: p.modelName,
      });
    }
    // Virtual live-DOM sessions (remote workspaces) that no disk session claims.
    for (const [tabId, live] of this.liveById) {
      if (this.locById.has(tabId))
        continue;
      const tabTitle = (this.tabTitleById.get(tabId) || '').trim();
      let dup = false;
      if (tabTitle) {
        for (const loc2 of this.locById.values()) {
          const p2 = this.parseLoc(loc2);
          if (p2 && p2.title.trim() === tabTitle) {
            dup = true;
            break;
          }
        }
      }
      if (dup)
        continue;
      rows.push({
        ref: { ide: 'codebuddy', workspaceId: 'live-dom', sessionId: tabId },
        title: tabTitle || '(live session)',
        createdAt: live.updatedAt,
        lastUpdatedAt: live.updatedAt,
        isArchived: false,
        isSubagent: false,
        status: live.generating ? 'generating' : 'idle',
        messageCount: live.messages.length,
        mode: undefined,
        modelName: undefined,
      });
    }
    rows.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
    return rows;
  }

  readIndex(sessionId: string): MessageHeader[] {
    const loc = this.findSession(sessionId);
    if (!loc)
      return [];
    if (loc.live) {
      const msgs = loc.live.messages;
      const now = Date.now();
      return msgs.map((m, i) => ({
        messageId: m.id,
        role: m.role === 'user' ? ('human' as const) : ('assistant' as const),
        createdAt: now,
        complete: !(loc.live!.generating && i === msgs.length - 1 && m.role === 'assistant'),
      }));
    }
    const p = this.parseLoc(loc);
    if (!p)
      return [];
    return p.entries.map(e => ({ messageId: e.id, role: e.role, createdAt: e.createdAt, complete: e.complete }));
  }

  enrichMeta(meta: SessionMeta): SessionMeta {
    const loc = this.findSession(meta.ref.sessionId);
    if (!loc)
      return meta;
    if (loc.live) {
      return {
        ...meta,
        status: loc.live.generating ? 'generating' : 'idle',
        isSubagent: false,
        messageCount: loc.live.messages.length,
      };
    }
    const p = this.parseLoc(loc);
    if (!p)
      return meta;
    return {
      ...meta,
      status: p.status,
      isSubagent: false,
      modelName: p.modelName ?? meta.modelName,
      messageCount: p.messageCount,
    };
  }

  hasSession(sessionId: string): boolean {
    return this.findSession(sessionId) !== undefined;
  }

  bubbleSizes(sessionId: string): Map<string, number> | undefined {
    const loc = this.findSession(sessionId);
    if (!loc || !loc.live)
      return undefined;
    return new Map(loc.live.messages.map(m => [m.id, m.text.length]));
  }

  projectSession(sessionId: string, ids?: string[]): ChatElement[] {
    const loc = this.findSession(sessionId);
    if (!loc)
      return [];
    if (loc.live) {
      const wantLive = ids ? new Set(ids) : null;
      const outLive: ChatElement[] = [];
      let flat = 0;
      for (const m of loc.live.messages) {
        if (wantLive && !wantLive.has(m.id))
          continue;
        if (m.role === 'user')
          outLive.push({ type: 'human', id: m.id, flatIndex: flat++, text: m.text, mentions: [] });
        else
          outLive.push({ type: 'assistant', id: m.id, flatIndex: flat++, text: m.text });
      }
      return outLive;
    }
    const p = this.parseLoc(loc);
    if (!p)
      return [];
    const want = ids ? new Set(ids) : null;
    const use = want ? p.entries.filter(e => want.has(e.id)) : p.entries;
    const messages: ChatElement[] = [];
    let flatIndex = 0;
    for (const e of use) {
      if (e.kind === 'human') {
        if (!e.text)
          continue;
        messages.push({ type: 'human', id: e.id, flatIndex: flatIndex++, text: e.text, mentions: [] });
      }
      else if (e.kind === 'assistant') {
        if (!e.text || !e.text.trim())
          continue;
        messages.push({ type: 'assistant', id: e.id, flatIndex: flatIndex++, text: e.text });
      }
      else if (e.kind === 'reasoning') {
        if (!this.includeProcess)
          continue;
        messages.push({ type: 'thought', id: `${e.id}:think`, flatIndex: flatIndex++, duration: '', detail: e.text, thoughtKind: 'thinking_step' });
      }
      else if (e.kind === 'tool') {
        if (!this.includeProcess || !e.tool)
          continue;
        messages.push(toTool(e.tool, flatIndex++));
      }
    }
    return messages;
  }

  /** Resolve a session id (uuid or webview tab id) to a disk jsonl or a live DOM session. */
  private findSession(sessionId: string): SessionLoc | undefined {
    this.refreshLocs();
    let id = sessionId;
    if (!this.locById.has(id)) {
      const tabTitle = this.tabTitleById.get(sessionId);
      if (tabTitle) {
        let best: { loc: SessionLoc; lastUpdatedAt: number } | null = null;
        for (const loc of this.locById.values()) {
          const p = this.parseLoc(loc);
          if (p && p.title.trim() === tabTitle) {
            if (!best || p.lastUpdatedAt > best.lastUpdatedAt)
              best = { loc, lastUpdatedAt: p.lastUpdatedAt };
          }
        }
        if (best)
          id = best.loc.sessionId;
      }
    }
    const diskHit = this.locById.get(id);
    if (diskHit)
      return diskHit;
    const live = this.liveById.get(id) ?? this.liveById.get(sessionId);
    if (live)
      return { sessionId, workspaceId: 'live-dom', filePath: '', live };
    return undefined;
  }

  private parseLoc(loc: SessionLoc): ParsedSession | null {
    const s = sig(loc.filePath);
    const hit = this.parseCache.get(loc.filePath);
    if (hit && hit.sig === s)
      return hit.parsed;
    const parsed = parseWorkBuddyJsonl(loc.filePath);
    this.parseCache.set(loc.filePath, { sig: s, parsed });
    return parsed;
  }

  /** Re-scan the projects root only when the census signature changed (cheap stats). */
  private refreshLocs(force = false): void {
    let census = '';
    const locs = new Map<string, SessionLoc>();
    if (existsSync(this.projectsRoot)) {
      for (const proj of listDirs(this.projectsRoot)) {
        const dir = join(this.projectsRoot, proj);
        let files: string[] = [];
        try {
          files = readdirSync(dir);
        }
        catch {
          continue;
        }
        for (const f of files) {
          if (!f.endsWith('.jsonl'))
            continue;
          const sessionId = f.slice(0, -'.jsonl'.length);
          const filePath = join(dir, f);
          census += `${filePath}:${sig(filePath)};`;
          locs.set(sessionId, { sessionId, workspaceId: proj, filePath });
        }
      }
    }
    if (force || census !== this.censusSig) {
      this.censusSig = census;
      this.locById = locs;
    }
  }

  private maxMtime(): number {
    let max = 0;
    for (const loc of this.locById.values()) {
      const m = Number(sig(loc.filePath).split(':')[0]);
      if (m > max)
        max = m;
    }
    return max;
  }
}
