/**
 * Codex ACP bridge: an ACP agent on stdio (what Lifeline spawns for `codex-cli`, in place of a native
 * `--acp` binary) that drives a Codex app-server (JSON-RPC v2).
 *
 * - By default it connects to the user's shared app-server (shared.ts), which the terminal reaches with
 *   `lifeline codex`. Turns started in the terminal then show up live in the web session that follows the
 *   same thread, their approvals pop up on the phone too (first answer wins), and a web message sent
 *   while such a turn runs waits for it. `/attach` points a web session at a terminal thread.
 *   Without the shared server (sharing off, or an old Codex) it runs a private `codex app-server`.
 * - A session's thread starts on its first prompt (a catalog read or an unused session leaves nothing in
 *   `codex resume`), so the ACP session id is an alias; shared.ts keeps the mapping.
 * - stdout carries ACP JSON only; logs go to stderr (`LIFELINE_CODEX_BRIDGE_DEBUG=1` for more).
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CodexModel, Json, ToolStatus } from './items.js';
import type { MessageTransport } from './ws-unix.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import process from 'node:process';
import {
  describeTool,
  finalStatus,
  head,
  isRecord,
  oneLine,
  pickEffort,
  promptText,
  readModels,
  sessionModelsPayload,
  str,
  textBlock,
  toolContent,
  toolTitle,
  turnSummary,
  userText,
} from './items.js';
import { CODEX_CLI_ENV } from './launch.js';
import { codexSessionsPath, ensureCodexSharedServer, readCodexSessions, sharedServerEnv, writeCodexSession } from './shared.js';
import { connectUnixWebSocket } from './ws-unix.js';

const BRIDGE_VERSION = '2';
const REPLAY_TURNS_LOAD = 10;
const REPLAY_TURNS_ATTACH = 5;
/** Lifeline gives `session/load` 15s; history is best-effort inside this budget. */
const HISTORY_BUDGET_LOAD_MS = 8000;
const HISTORY_BUDGET_ATTACH_MS = 30_000;
const LIST_LIMIT = 10;
/**
 * A cancelled permission card is either the user's stop button (answer `cancel`) or Lifeline shutting
 * this process down, in which case a shared turn's request is left for the terminal or a later session.
 */
const CANCEL_GRACE_MS = 1200;
const DEBUG = process.env.LIFELINE_CODEX_BRIDGE_DEBUG === '1';
const TURN_STATUS_LABEL: Record<string, string> = { completed: '完成', interrupted: '已中断', failed: '失败' };

/** Returned by a request handler that must not answer (the request belongs to another client). */
export const NO_ANSWER = Symbol('no-answer');

function log(...parts: unknown[]): void {
  process.stderr.write(`[codex-acp] ${parts.join(' ')}\n`);
}

function debug(...parts: unknown[]): void {
  if (DEBUG)
    log(...parts);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

// ---------- JSON-RPC peer over a message transport ----------

type RequestHandler = (method: string, params: Json, id: unknown) => Promise<unknown>;
type NotifyHandler = (method: string, params: Json) => void;

/** Newline-delimited JSON over a pair of streams (ACP on stdio, a private app-server). */
export function lineTransport(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): MessageTransport {
  const listeners: Array<(text: string) => void> = [];
  const closers: Array<() => void> = [];
  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    buffer += chunk;
    let i = buffer.indexOf('\n');
    while (i >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) {
        for (const fn of listeners)
          fn(line);
      }
      i = buffer.indexOf('\n');
    }
  });
  input.on('end', () => {
    for (const fn of closers)
      fn();
  });
  return {
    send: text => output.write(`${text}\n`),
    onMessage: fn => listeners.push(fn),
    onClose: fn => closers.push(fn),
    close: () => output.end(),
  };
}

export class RpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  closed = false;
  onRequest: RequestHandler = async (method) => {
    throw new RpcError(-32601, `Method not found: ${method}`);
  };

  onNotify: NotifyHandler = () => {};

  constructor(private readonly name: string, private readonly transport: MessageTransport) {
    transport.onMessage(text => this.handle(text));
    transport.onClose(() => {
      this.closed = true;
      this.failAll(new RpcError(-32000, `${name} closed`));
    });
  }

  onClose(fn: () => void): void {
    this.transport.onClose(fn);
  }

  private handle(line: string): void {
    let msg: Json;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed))
        return;
      msg = parsed;
    }
    catch {
      log(`${this.name}: non-JSON message ignored`);
      return;
    }
    const hasId = msg.id !== undefined && msg.id !== null;
    const method = typeof msg.method === 'string' ? msg.method : '';
    const params = isRecord(msg.params) ? msg.params : {};
    if (method && hasId) {
      debug(`${this.name} <= ${method}`);
      this.onRequest(method, params, msg.id).then(
        (result) => {
          if (result !== NO_ANSWER)
            this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
        },
        (err: unknown) => this.send({ jsonrpc: '2.0', id: msg.id, error: toRpcError(err) }),
      );
      return;
    }
    if (method) {
      try {
        this.onNotify(method, params);
      }
      catch (err) {
        log(`${this.name}: ${method} handler failed: ${err instanceof Error ? err.stack : String(err)}`);
      }
      return;
    }
    if (hasId && typeof msg.id === 'number') {
      const waiter = this.pending.get(msg.id);
      if (!waiter)
        return;
      this.pending.delete(msg.id);
      if (isRecord(msg.error))
        waiter.reject(new RpcError(typeof msg.error.code === 'number' ? msg.error.code : -32000, str(msg.error.message) || 'rpc error'));
      else
        waiter.resolve(msg.result);
    }
  }

  send(obj: Json): void {
    if (!this.closed)
      this.transport.send(JSON.stringify(obj));
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed)
      return Promise.reject(new RpcError(-32000, `${this.name} closed`));
    const id = this.nextId++;
    debug(`${this.name} => ${method}`);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: v => resolve(v as T), reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  close(): void {
    this.closed = true;
    this.transport.close();
  }

  failAll(err: Error): void {
    for (const waiter of this.pending.values())
      waiter.reject(err);
    this.pending.clear();
  }
}

function toRpcError(err: unknown): Json {
  if (err instanceof RpcError)
    return { code: err.code, message: err.message };
  return { code: -32000, message: err instanceof Error ? err.message : String(err) };
}

// ---------- session state ----------

interface Turn {
  resolve: (result: { stopReason: string }) => void;
  turnId: string | null;
  /** turn/start was sent: the next turn/started on this thread is ours. */
  sent: boolean;
  cancelRequested: boolean;
  interruptSent: boolean;
}

interface ToolInfo {
  item: Json;
  done: boolean;
  turnId: string | null;
}

interface PendingRequest {
  elsewhere: boolean;
}

interface ThreadRow {
  id: string;
  cwd: string;
  title: string;
  updatedAt: number | null;
  active: boolean;
  loaded: boolean;
}

interface Session {
  id: string;
  threadId: string | null;
  cwd: string;
  model: string | undefined;
  effort: string | undefined;
  /** The web's own prompt (ACP `session/prompt`), queued or running. */
  turn: Turn | null;
  /** Any running turn on the thread, own or another client's. */
  activeTurnId: string | null;
  tools: Map<string, ToolInfo>;
  streamed: Set<string>;
  rendered: Set<string>;
  errorShown: Set<string>;
  thoughtItem: string | null;
  thoughtTurn: string | null;
  pendingRequests: Map<string, PendingRequest>;
  idleWaiters: Array<() => void>;
  lastList: ThreadRow[];
}

export interface CodexBridgeOptions {
  /** Codex CLI binary. Default: `LIFELINE_CODEX_CLI`, else `codex` on PATH. */
  codexCommand?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const PLAN_STATUS: Record<string, string> = { pending: 'pending', inProgress: 'in_progress', completed: 'completed' };

const OPT_ALLOW = { optionId: 'accept', name: '允许', kind: 'allow_once' };
const OPT_ALWAYS = { optionId: 'acceptForSession', name: '本会话都允许', kind: 'allow_always' };
const OPT_REJECT = { optionId: 'decline', name: '拒绝', kind: 'reject_once' };

function fmtTime(ts: number | null): string {
  if (!ts)
    return '';
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Resolves when stdin ends and the app-server connection is gone. */
export function runCodexAcpBridge(options: CodexBridgeOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const codexCommand = options.codexCommand ?? (str(env[CODEX_CLI_ENV]) || 'codex');
  const sessionsFile = codexSessionsPath(home);
  const acp = new RpcPeer('acp', lineTransport(options.input ?? process.stdin, options.output ?? process.stdout));
  const sessions = new Map<string, Session>();
  const byThread = new Map<string, Session>();
  let app: RpcPeer | null = null;
  let shared = false;
  let child: ChildProcessWithoutNullStreams | null = null;
  let starting: Promise<RpcPeer> | null = null;
  let models: CodexModel[] | null = null;
  let defaults: { model?: string; effort?: string } = {};
  let shuttingDown = false;
  let finished = false;
  let done!: () => void;
  const exited = new Promise<void>((resolve) => {
    done = resolve;
  });

  function update(sess: Session, payload: Json): void {
    acp.notify('session/update', { sessionId: sess.id, update: payload });
  }

  function say(sess: Session, text: string, messageId: string): void {
    if (text)
      update(sess, { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } });
  }

  // Each note is its own timeline row: no padding newlines.
  function note(sess: Session, text: string): void {
    say(sess, text, `note:${randomUUID()}`);
  }

  // One collapsed "Thought" row per turn instead of one per reasoning item.
  function thought(sess: Session, turnId: string, itemId: string, text: string): void {
    const sep = sess.thoughtItem && sess.thoughtItem !== itemId && sess.thoughtTurn === turnId ? '\n\n' : '';
    sess.thoughtItem = itemId;
    sess.thoughtTurn = turnId;
    update(sess, { sessionUpdate: 'agent_thought_chunk', messageId: `think:${turnId || itemId}`, content: { type: 'text', text: `${sep}${text}` } });
  }

  // ---------- app-server ----------

  async function initPeer(peer: RpcPeer): Promise<RpcPeer> {
    peer.onNotify = onAppNotification;
    peer.onRequest = onAppRequest;
    await peer.request('initialize', {
      clientInfo: { name: 'lifeline_codex_acp', title: 'Lifeline Codex ACP bridge', version: BRIDGE_VERSION },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    peer.notify('initialized', {});
    peer.onClose(() => onAppClosed(peer));
    return peer;
  }

  async function openShared(): Promise<RpcPeer | null> {
    const sock = await ensureCodexSharedServer({ codex: codexCommand, env, home, log });
    if (!sock)
      return null;
    try {
      const peer = await initPeer(new RpcPeer('app', await connectUnixWebSocket(sock)));
      shared = true;
      return peer;
    }
    catch (err) {
      log(`shared Codex server unusable (${err instanceof Error ? err.message : String(err)}); using a private one`);
      return null;
    }
  }

  function openPrivate(): Promise<RpcPeer> {
    return new Promise<RpcPeer>((resolve, reject) => {
      // Not detached: Lifeline kills the bridge's process group, which then includes app-server.
      const proc = spawn(codexCommand, ['app-server'], { cwd: process.cwd(), env: sharedServerEnv(env, codexCommand), stdio: ['pipe', 'pipe', 'pipe'] });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk: string) => {
        if (DEBUG)
          process.stderr.write(chunk);
      });
      proc.once('error', (err: NodeJS.ErrnoException) => {
        reject(new RpcError(-32000, err.code === 'ENOENT' ? `Codex CLI not found: ${codexCommand}` : err.message));
      });
      proc.once('spawn', () => {
        const peer = new RpcPeer('app', lineTransport(proc.stdout, proc.stdin));
        child = proc;
        initPeer(peer).then(resolve, (err: unknown) => {
          proc.kill('SIGTERM');
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
    });
  }

  function connect(): Promise<RpcPeer> {
    if (app && !app.closed)
      return Promise.resolve(app);
    if (starting)
      return starting;
    starting = (async () => {
      const peer = (await openShared()) ?? (await openPrivate());
      app = peer;
      return peer;
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  function onAppClosed(peer: RpcPeer): void {
    if (app === peer)
      app = null;
    if (finished)
      return;
    log(`codex app-server connection closed`);
    for (const sess of sessions.values()) {
      if (sess.turn) {
        say(sess, '[和 Codex 服务的连接断开，本回合中止]', `err:${randomUUID()}`);
        finishTurn(sess, 'end_turn');
      }
    }
    // The ACP client treats our exit as a crashed session; reopening it reconnects.
    shutdown(1);
  }

  async function ensureSignedIn(server: RpcPeer): Promise<void> {
    const account = await server.request<Json>('account/read', { refreshToken: false }).catch(() => null);
    if (isRecord(account) && account.requiresOpenaiAuth === true && account.account == null)
      throw new RpcError(401, 'Codex is not signed in. Run `codex login` on this machine.');
  }

  async function loadCatalog(server: RpcPeer, cwd: string): Promise<CodexModel[]> {
    if (models)
      return models;
    const rows: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res: Json = await server.request<Json>('model/list', { cursor, limit: 100, includeHidden: false });
      if (Array.isArray(res?.data))
        rows.push(...res.data);
      cursor = typeof res?.nextCursor === 'string' ? res.nextCursor : null;
      if (!cursor)
        break;
    }
    models = readModels(rows);
    const config = await server.request<Json>('config/read', { cwd }).then(r => (isRecord(r?.config) ? r.config : {}), () => ({} as Json));
    const configured = str(config.model);
    defaults = {
      model: (models.find(m => m.id === configured) ?? models.find(m => m.isDefault) ?? models[0])?.id,
      ...(str(config.model_reasoning_effort) ? { effort: str(config.model_reasoning_effort) } : {}),
    };
    return models;
  }

  function newSession(id: string, cwd: string, threadId: string | null, model: string | undefined, effort: string | undefined): Session {
    const list = models ?? [];
    const known = model && list.some(m => m.id === model) ? model : defaults.model;
    const sess: Session = {
      id,
      threadId: null,
      cwd,
      model: known,
      effort: pickEffort(list, known, effort ?? defaults.effort),
      turn: null,
      activeTurnId: null,
      tools: new Map(),
      streamed: new Set(),
      rendered: new Set(),
      errorShown: new Set(),
      thoughtItem: null,
      thoughtTurn: null,
      pendingRequests: new Map(),
      idleWaiters: [],
      lastList: [],
    };
    sessions.set(id, sess);
    if (threadId)
      bindThread(sess, threadId);
    return sess;
  }

  function bindThread(sess: Session, threadId: string): void {
    if (sess.threadId && byThread.get(sess.threadId) === sess)
      byThread.delete(sess.threadId);
    sess.threadId = threadId;
    byThread.set(threadId, sess);
  }

  function remember(sess: Session): void {
    if (!sess.threadId)
      return;
    try {
      writeCodexSession(sess.id, { threadId: sess.threadId, cwd: sess.cwd }, sessionsFile);
    }
    catch (err) {
      log(`cannot record session ${sess.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function ensureThread(sess: Session, server: RpcPeer): Promise<string> {
    if (sess.threadId)
      return sess.threadId;
    const res = await server.request<Json>('thread/start', { cwd: sess.cwd, ...(sess.model ? { model: sess.model } : {}) });
    const threadId = isRecord(res?.thread) ? str(res.thread.id) : '';
    if (!threadId)
      throw new RpcError(-32000, 'thread/start returned no thread id');
    bindThread(sess, threadId);
    remember(sess);
    return threadId;
  }

  function payload(sess: Session): Json {
    return sessionModelsPayload(models ?? [], sess.model, sess.effort);
  }

  // ---------- items ----------

  function closeTools(sess: Session, turnId: string | null, status: ToolStatus): void {
    for (const [id, info] of sess.tools) {
      if (turnId && info.turnId && info.turnId !== turnId)
        continue;
      if (!info.done) {
        info.done = true;
        update(sess, { sessionUpdate: 'tool_call_update', toolCallId: id, status, title: toolTitle(info.item, status, sess.cwd) });
      }
      sess.tools.delete(id);
    }
    if (!sess.turn && !sess.activeTurnId) {
      sess.streamed.clear();
      sess.rendered.clear();
    }
  }

  function wakeIdle(sess: Session): void {
    for (const fn of sess.idleWaiters.splice(0))
      fn();
  }

  function finishTurn(sess: Session, stopReason: 'end_turn' | 'cancelled'): void {
    const turn = sess.turn;
    if (!turn)
      return;
    sess.turn = null;
    closeTools(sess, turn.turnId, stopReason === 'cancelled' ? 'cancelled' : 'completed');
    turn.resolve({ stopReason });
    wakeIdle(sess);
  }

  function isOwn(sess: Session, turnId: string): boolean {
    return Boolean(sess.turn?.turnId && sess.turn.turnId === turnId);
  }

  /** mode `live`: a notification; `load` / `attach`: a history replay. */
  function onItem(sess: Session, item: Json, phase: 'started' | 'completed', ctx: { mode: 'live' | 'load' | 'attach'; turnId: string; own: boolean }): void {
    const id = str(item.id);
    if (!id)
      return;
    switch (item.type) {
      case 'agentMessage':
        if (phase === 'completed' && !sess.streamed.has(id))
          say(sess, str(item.text), id);
        return;
      case 'reasoning': {
        if (phase !== 'completed' || ctx.mode !== 'live' || sess.streamed.has(id))
          return;
        const parts = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])];
        const text = parts.map(p => str(p)).join('\n').trim();
        if (text)
          thought(sess, ctx.turnId, id, text);
        return;
      }
      case 'plan':
        if (phase === 'completed')
          say(sess, str(item.text), id);
        return;
      case 'userMessage': {
        // The web already shows what it sent; another client's prompt is shown once.
        if (ctx.own || sess.rendered.has(id))
          return;
        const text = userText(item);
        if (!text)
          return;
        sess.rendered.add(id);
        if (ctx.mode === 'load')
          update(sess, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
        else
          say(sess, `▶ ${ctx.mode === 'live' ? '终端：' : ''}${text}`, `user:${id}`);
        return;
      }
      default:
        break;
    }
    const desc = describeTool(item, sess.cwd);
    if (!desc)
      return;
    const content = toolContent(item);
    const info = sess.tools.get(id);
    if (!info) {
      const status = phase === 'completed' ? finalStatus(item) : 'in_progress';
      sess.tools.set(id, { item, done: phase === 'completed', turnId: ctx.turnId || null });
      update(sess, {
        sessionUpdate: 'tool_call',
        toolCallId: id,
        title: toolTitle(item, status, sess.cwd),
        kind: desc.kind,
        status,
        ...(desc.locations?.length ? { locations: desc.locations } : {}),
        ...(content ? { content } : {}),
      });
      return;
    }
    info.item = item;
    if (phase === 'completed' && !info.done) {
      info.done = true;
      const status = finalStatus(item);
      update(sess, {
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status,
        title: toolTitle(item, status, sess.cwd),
        ...(content ? { content } : {}),
      });
    }
  }

  function maybeInterrupt(sess: Session): void {
    const turn = sess.turn;
    if (!turn?.cancelRequested || !turn.turnId || turn.interruptSent || !app || !sess.threadId)
      return;
    turn.interruptSent = true;
    app.request('turn/interrupt', { threadId: sess.threadId, turnId: turn.turnId }).catch((err: unknown) => {
      log(`turn/interrupt failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  function onAppNotification(method: string, params: Json): void {
    const sess = byThread.get(str(params.threadId));
    if (!sess)
      return;
    const turnId = str(params.turnId);
    switch (method) {
      case 'turn/started': {
        const id = isRecord(params.turn) ? str(params.turn.id) : '';
        if (!id)
          break;
        sess.activeTurnId = id;
        if (sess.turn?.sent && !sess.turn.turnId) {
          sess.turn.turnId = id;
          maybeInterrupt(sess);
        }
        break;
      }
      case 'item/started':
      case 'item/completed':
        if (isRecord(params.item))
          onItem(sess, params.item, method === 'item/started' ? 'started' : 'completed', { mode: 'live', turnId, own: isOwn(sess, turnId) });
        break;
      case 'item/agentMessage/delta':
        if (str(params.delta)) {
          sess.streamed.add(str(params.itemId));
          say(sess, str(params.delta), str(params.itemId));
        }
        break;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        if (str(params.delta)) {
          sess.streamed.add(str(params.itemId));
          thought(sess, turnId, str(params.itemId), str(params.delta));
        }
        break;
      case 'turn/plan/updated': {
        const plan = Array.isArray(params.plan) ? params.plan : [];
        update(sess, {
          sessionUpdate: 'plan',
          entries: plan.filter(isRecord).map(step => ({ content: str(step.step), status: PLAN_STATUS[str(step.status)] ?? 'pending', priority: 'medium' })),
        });
        break;
      }
      case 'error': {
        if (params.willRetry === true)
          break;
        const key = turnId || 'none';
        if (sess.errorShown.has(key))
          break;
        sess.errorShown.add(key);
        say(sess, `[Codex 错误] ${isRecord(params.error) ? str(params.error.message) : '未知错误'}`, `err:${key}`);
        break;
      }
      case 'turn/completed': {
        const turn = isRecord(params.turn) ? params.turn : {};
        const id = str(turn.id);
        const status = str(turn.status);
        if (status === 'failed' && isRecord(turn.error) && !sess.errorShown.has(id || 'none')) {
          sess.errorShown.add(id || 'none');
          say(sess, `[Codex 错误] ${str(turn.error.message)}`, `err:${id}`);
        }
        if (sess.activeTurnId === id)
          sess.activeTurnId = null;
        if (sess.turn && (sess.turn.turnId === id || (sess.turn.sent && !sess.turn.turnId))) {
          finishTurn(sess, status === 'interrupted' ? 'cancelled' : 'end_turn');
        }
        else {
          closeTools(sess, id, status === 'interrupted' ? 'cancelled' : 'completed');
          note(sess, `■ 终端回合结束（${TURN_STATUS_LABEL[status] ?? status}）`);
        }
        wakeIdle(sess);
        break;
      }
      case 'serverRequest/resolved': {
        const pending = sess.pendingRequests.get(String(params.requestId));
        if (pending && !pending.elsewhere) {
          pending.elsewhere = true;
          note(sess, '（这条审批已在终端处理，卡片点任意选项即可关闭，不会再生效）');
        }
        break;
      }
      default:
        break;
    }
  }

  // ---------- approvals: app-server → ACP session/request_permission ----------

  async function askPermission(sess: Session, toolCallId: string, title: string, kind: string, opts: Json[], detail: string): Promise<string | null> {
    try {
      const res = await acp.request<Json>('session/request_permission', {
        sessionId: sess.id,
        toolCall: {
          toolCallId: toolCallId || `ask:${randomUUID()}`,
          title: oneLine(title, 300),
          kind,
          status: 'pending',
          ...(detail ? { content: textBlock(head(detail, 6000)) } : {}),
        },
        options: opts,
      });
      const outcome = isRecord(res) && isRecord(res.outcome) ? res.outcome : {};
      return outcome.outcome === 'selected' ? str(outcome.optionId) || null : null;
    }
    catch {
      return null;
    }
  }

  async function cancelled<T>(pending: PendingRequest, value: T): Promise<T | typeof NO_ANSWER> {
    if (!shared)
      return value;
    await sleep(CANCEL_GRACE_MS);
    return shuttingDown || pending.elsewhere ? NO_ANSWER : value;
  }

  async function onAppRequest(method: string, params: Json, requestId: unknown): Promise<unknown> {
    const sess = byThread.get(str(params.threadId) || str(params.conversationId));
    if (!sess) {
      // On a shared server the request may belong to another client's thread: leave it to them.
      if (shared)
        return NO_ANSWER;
      throw new RpcError(-32601, `not handled: ${method}`);
    }
    const key = String(requestId);
    const pending: PendingRequest = { elsewhere: false };
    sess.pendingRequests.set(key, pending);
    try {
      const answer = await serverRequest(sess, method, params, pending);
      return pending.elsewhere ? NO_ANSWER : answer;
    }
    finally {
      sess.pendingRequests.delete(key);
    }
  }

  async function serverRequest(sess: Session, method: string, params: Json, pending: PendingRequest): Promise<unknown> {
    const itemId = str(params.itemId) || str(params.callId);
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const title = params.command ? `运行命令: ${oneLine(params.command, 240)}` : `运行命令${params.reason ? `: ${oneLine(params.reason)}` : ''}`;
        const detail = [str(params.reason), params.cwd ? `cwd: ${str(params.cwd)}` : ''].filter(Boolean).join('\n');
        const choice = await askPermission(sess, itemId, title, 'execute', [OPT_ALLOW, OPT_ALWAYS, OPT_REJECT], detail);
        return choice ? { decision: choice } : cancelled(pending, { decision: 'cancel' });
      }
      case 'item/fileChange/requestApproval': {
        const item = sess.tools.get(itemId)?.item;
        const title = item ? (describeTool(item, sess.cwd)?.title ?? '修改文件') : '修改文件';
        const content = item ? toolContent(item) : undefined;
        const diff = content && isRecord(content[0]) && isRecord(content[0].content) ? str(content[0].content.text) : '';
        const detail = [str(params.reason), params.grantRoot ? `授权目录: ${str(params.grantRoot)}` : '', diff].filter(Boolean).join('\n');
        const choice = await askPermission(sess, itemId, title, 'edit', [OPT_ALLOW, OPT_ALWAYS, OPT_REJECT], detail);
        return choice ? { decision: choice } : cancelled(pending, { decision: 'cancel' });
      }
      case 'item/permissions/requestApproval': {
        const choice = await askPermission(sess, itemId, `申请额外权限${params.reason ? `: ${oneLine(params.reason)}` : ''}`, 'other', [
          { optionId: 'turn', name: '本回合允许', kind: 'allow_once' },
          { optionId: 'session', name: '本会话都允许', kind: 'allow_always' },
          { optionId: 'deny', name: '拒绝', kind: 'reject_once' },
        ], [str(params.reason), JSON.stringify(params.permissions ?? {})].filter(Boolean).join('\n'));
        if (choice === 'turn' || choice === 'session') {
          const asked = isRecord(params.permissions) ? params.permissions : {};
          return {
            permissions: { ...(asked.network ? { network: asked.network } : {}), ...(asked.fileSystem ? { fileSystem: asked.fileSystem } : {}) },
            scope: choice,
          };
        }
        const denied = { permissions: {}, scope: 'turn' };
        return choice ? denied : cancelled(pending, denied);
      }
      case 'item/tool/requestUserInput': {
        const answers: Json = {};
        for (const q of Array.isArray(params.questions) ? params.questions.filter(isRecord) : []) {
          const options = Array.isArray(q.options) ? q.options.filter(isRecord) : [];
          if (options.length === 0) {
            answers[str(q.id)] = { answers: [] };
            continue;
          }
          const choice = await askPermission(sess, itemId, `${q.header ? `${str(q.header)}: ` : ''}${str(q.question)}`, 'other', options.slice(0, 15).map((o, i) => ({ optionId: `opt${i}`, name: oneLine(o.label, 80), kind: 'allow_once' })), options.map(o => `- ${str(o.label)}${o.description ? `: ${str(o.description)}` : ''}`).join('\n'));
          if (!choice)
            return cancelled(pending, { answers: {} });
          const picked = options[Number(choice.slice(3))];
          answers[str(q.id)] = { answers: picked ? [str(picked.label)] : [] };
        }
        return { answers };
      }
      case 'mcpServer/elicitation/request': {
        const choice = await askPermission(sess, itemId, `MCP 请求确认: ${oneLine(params.message ?? params.serverName ?? '')}`, 'other', [OPT_ALLOW, OPT_REJECT], JSON.stringify(params).slice(0, 2000));
        if (choice === 'accept')
          return { action: 'accept', content: {}, _meta: null };
        return choice ? { action: 'decline', content: null, _meta: null } : cancelled(pending, { action: 'cancel', content: null, _meta: null });
      }
      default:
        if (shared)
          return NO_ANSWER;
        throw new RpcError(-32601, `not supported by the Codex ACP bridge: ${method}`);
    }
  }

  // ---------- history ----------

  async function withBudget<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(resolve, ms, null);
    });
    try {
      return await Promise.race([promise.catch(() => null), expired]);
    }
    finally {
      clearTimeout(timer);
    }
  }

  /**
   * Last `limit` turns, oldest first, or null when they cannot be read within `budgetMs`. Finished turns
   * come as summaries (prompt + final reply, all the compact replay shows); a running turn in full, so
   * its tool calls keep updating live.
   */
  function recentTurns(server: RpcPeer, threadId: string, limit: number, budgetMs: number): Promise<Json[] | null> {
    const read = async (): Promise<Json[]> => {
      let turns: Json[];
      try {
        const res = await server.request<Json>('thread/turns/list', { threadId, limit, itemsView: 'summary' });
        turns = (Array.isArray(res?.data) ? res.data.filter(isRecord) : []).reverse();
      }
      catch {
        const res = await server.request<Json>('thread/read', { threadId, includeTurns: true });
        const all = isRecord(res?.thread) && Array.isArray(res.thread.turns) ? res.thread.turns.filter(isRecord) : [];
        return all.slice(-limit);
      }
      const last = turns.at(-1);
      if (last?.status === 'inProgress') {
        const full = await server.request<Json>('thread/turns/list', { threadId, limit: 1, itemsView: 'full' }).catch(() => null);
        const current = Array.isArray(full?.data) && isRecord(full.data[0]) ? full.data[0] : null;
        if (current && current.id === last.id)
          turns[turns.length - 1] = current;
      }
      return turns;
    };
    return withBudget(read(), budgetMs);
  }

  function replay(sess: Session, turns: readonly Json[], mode: 'load' | 'attach'): void {
    for (const turn of turns) {
      const turnId = str(turn.id);
      const items = Array.isArray(turn.items) ? turn.items.filter(isRecord) : [];
      if (turn.status === 'inProgress') {
        for (const item of items) {
          if (item.type === 'agentMessage' && str(item.text)) {
            say(sess, str(item.text), str(item.id));
            sess.streamed.add(str(item.id));
            continue;
          }
          onItem(sess, item, item.status === 'inProgress' ? 'started' : 'completed', { mode, turnId, own: false });
        }
        sess.activeTurnId = turnId;
        continue;
      }
      // A finished turn collapses to: the prompt, one summary row (when tool items are present), the reply.
      for (const item of items) {
        if (item.type === 'userMessage')
          onItem(sess, item, 'completed', { mode, turnId, own: false });
      }
      const summary = turnSummary(items, sess.cwd);
      if (summary)
        say(sess, summary, `sum:${turnId}`);
      const reply = [...items].reverse().find(item => item.type === 'agentMessage' && str(item.text));
      if (reply)
        say(sess, str(reply.text), str(reply.id) || `reply:${turnId}`);
      if (turn.status === 'failed' && isRecord(turn.error))
        say(sess, `[Codex 错误] ${str(turn.error.message)}`, `err:${turnId}`);
    }
    sess.rendered.clear();
  }

  // ---------- /attach ----------

  async function listThreads(sess: Session, server: RpcPeer, print: boolean): Promise<ThreadRow[]> {
    const loadedRes = await server.request<Json>('thread/loaded/list', {}).catch(() => ({ data: [] }) as Json);
    const loaded = new Set((Array.isArray(loadedRes?.data) ? loadedRes.data : []).map(String));
    const list = (params: Json) => server.request<Json>('thread/list', { sortKey: 'updated_at', limit: LIST_LIMIT, ...params }).catch(() => ({ data: [] }) as Json);
    let listed = await list({ cwd: sess.cwd });
    let scope = sess.cwd;
    if (!Array.isArray(listed?.data) || listed.data.length === 0) {
      listed = await list({});
      scope = '所有目录';
    }
    const rows: ThreadRow[] = (Array.isArray(listed?.data) ? listed.data.filter(isRecord) : []).map(t => ({
      id: str(t.id),
      cwd: str(t.cwd),
      title: str(t.name) || str(t.preview),
      updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : null,
      active: isRecord(t.status) && t.status.type === 'active',
      loaded: loaded.has(str(t.id)),
    })).filter(r => r.id);
    sess.lastList = rows;
    if (print) {
      if (rows.length === 0) {
        note(sess, '没有找到 Codex 会话。先在终端用 `lifeline codex` 开一个。');
      }
      else {
        const lines = rows.map((r, i) => {
          const flag = r.active ? ' [运行中]' : (r.loaded ? ' [已打开]' : '');
          const where = scope === sess.cwd ? '' : `  (${r.cwd})`;
          return `${i + 1}. ${fmtTime(r.updatedAt)}${flag} ${oneLine(r.title, 60)}${where}\n   ${r.id}`;
        });
        note(sess, `最近的 Codex 会话（${scope}）：\n${lines.join('\n')}\n\n发 /attach <序号> 接管其中一个。`);
      }
    }
    return rows;
  }

  async function attachThread(sess: Session, server: RpcPeer, threadId: string): Promise<void> {
    if (threadId === sess.threadId) {
      note(sess, `已经接在这个会话上了：${threadId}`);
      return;
    }
    let res: Json;
    try {
      res = await server.request<Json>('thread/resume', { threadId, excludeTurns: true });
    }
    catch (err) {
      note(sess, `接管失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const previous = sess.threadId;
    bindThread(sess, threadId);
    if (previous)
      server.request('thread/unsubscribe', { threadId: previous }).catch(() => {});
    sess.activeTurnId = null;
    const list = models ?? [];
    if (str(res?.model) && list.some(m => m.id === str(res.model)))
      sess.model = str(res.model);
    if (str(res?.reasoningEffort))
      sess.effort = pickEffort(list, sess.model, str(res.reasoningEffort));
    remember(sess);
    const turns = await recentTurns(server, threadId, REPLAY_TURNS_ATTACH, HISTORY_BUDGET_ATTACH_MS);
    if (turns) {
      note(sess, `已接管 ${threadId}（${sess.model ?? '默认模型'}），最近 ${turns.length} 个回合：`);
      replay(sess, turns, 'attach');
    }
    else {
      note(sess, `已接管 ${threadId}（${sess.model ?? '默认模型'}）；历史太大没有加载完，只显示之后的新内容`);
    }
    note(sess, sess.activeTurnId
      ? '— 正在运行，后续进展和审批实时显示；接管前已弹出的审批请在终端处理 —'
      : '— 以上为历史；之后终端的进展和审批实时同步到这里 —');
  }

  async function runAttach(sess: Session, arg: string): Promise<void> {
    const server = await connect();
    if (!shared) {
      note(sess, '共享 Codex 服务不可用（LIFELINE_CODEX_SHARED=0，或这个 Codex 版本不支持 `app-server --listen`），看不到终端里的会话。');
      return;
    }
    if (arg === 'list' || arg === 'ls') {
      await listThreads(sess, server, true);
      return;
    }
    let target = arg;
    if (/^\d+$/.test(arg)) {
      if (sess.lastList.length === 0)
        await listThreads(sess, server, false);
      const row = sess.lastList[Number(arg) - 1];
      if (!row) {
        note(sess, `没有第 ${arg} 个，先发 /attach list 看看。`);
        return;
      }
      target = row.id;
    }
    else if (!arg) {
      const rows = (await listThreads(sess, server, false)).filter(r => r.id !== sess.threadId);
      const pick = rows.find(r => r.active) ?? rows.find(r => r.loaded) ?? rows[0];
      if (!pick) {
        note(sess, `没有找到可以接管的 Codex 会话（目录 ${sess.cwd}）。先在终端用 \`lifeline codex\` 开一个，或发 /attach list。`);
        return;
      }
      target = pick.id;
    }
    await attachThread(sess, server, target);
  }

  // ---------- prompts ----------

  async function runPrompt(sess: Session, turn: Turn, text: string): Promise<void> {
    try {
      const command = text.trim();
      if (command === '/attach' || /^\/attach\s/.test(command)) {
        await runAttach(sess, command.slice('/attach'.length).trim());
        finishTurn(sess, 'end_turn');
        return;
      }
      const server = await connect();
      const threadId = await ensureThread(sess, server);
      if (sess.activeTurnId) {
        note(sess, '（终端回合进行中，这条消息等它结束后执行）');
        while (sess.activeTurnId && sess.turn === turn && !turn.cancelRequested)
          await new Promise<void>(resolve => sess.idleWaiters.push(resolve));
        if (sess.turn !== turn)
          return;
        if (turn.cancelRequested) {
          finishTurn(sess, 'cancelled');
          return;
        }
      }
      turn.sent = true;
      const res = await server.request<Json>('turn/start', {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        ...(sess.model ? { model: sess.model } : {}),
        ...(sess.effort ? { effort: sess.effort } : {}),
      });
      if (sess.turn !== turn)
        return;
      const started = isRecord(res?.turn) ? res.turn : {};
      if (!turn.turnId && str(started.id))
        turn.turnId = str(started.id);
      if (started.status && started.status !== 'inProgress') {
        finishTurn(sess, started.status === 'interrupted' ? 'cancelled' : 'end_turn');
        return;
      }
      maybeInterrupt(sess);
    }
    catch (err) {
      if (sess.turn !== turn)
        return;
      say(sess, `[Codex 启动回合失败] ${err instanceof Error ? err.message : String(err)}`, `err:${randomUUID()}`);
      finishTurn(sess, 'end_turn');
    }
  }

  function requireSession(params: Json): Session {
    const sess = sessions.get(str(params.sessionId));
    if (!sess)
      throw new RpcError(-32602, `unknown session: ${str(params.sessionId)}`);
    return sess;
  }

  acp.onRequest = async (method, params) => {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
          },
          authMethods: [],
          agentInfo: { name: 'lifeline-codex-acp', title: 'Codex (Lifeline ACP bridge)', version: BRIDGE_VERSION },
        };

      case 'authenticate':
        return {};

      case 'session/new': {
        const cwd = str(params.cwd) || process.cwd();
        const server = await connect();
        await ensureSignedIn(server);
        await loadCatalog(server, cwd);
        const sess = newSession(randomUUID(), cwd, null, undefined, undefined);
        return { sessionId: sess.id, ...payload(sess) };
      }

      case 'session/load': {
        const id = str(params.sessionId);
        const existing = sessions.get(id);
        if (existing)
          return payload(existing);
        const record = readCodexSessions(sessionsFile)[id];
        const threadId = record?.threadId ?? id;
        const cwd = str(params.cwd) || record?.cwd || process.cwd();
        const server = await connect();
        await ensureSignedIn(server);
        await loadCatalog(server, cwd);
        let res: Json;
        try {
          res = await server.request<Json>('thread/resume', { threadId, excludeTurns: true });
        }
        catch (err) {
          throw new RpcError(-32002, `session not found: ${err instanceof Error ? err.message : String(err)}`);
        }
        const sess = newSession(id, cwd, threadId, str(res?.model) || undefined, str(res?.reasoningEffort) || undefined);
        const turns = await recentTurns(server, threadId, REPLAY_TURNS_LOAD, HISTORY_BUDGET_LOAD_MS);
        if (turns)
          replay(sess, turns, 'load');
        else
          note(sess, '（历史太大没有加载完，只显示之后的新内容）');
        remember(sess);
        return payload(sess);
      }

      case 'session/set_config_option':
      case 'session/set_model': {
        const sess = requireSession(params);
        const configId = method === 'session/set_model' ? 'model' : str(params.configId);
        const value = method === 'session/set_model' ? str(params.modelId) : str(params.value);
        const list = models ?? [];
        if (configId === 'model') {
          if (!list.some(m => m.id === value))
            throw new RpcError(-32602, `unknown model: ${value}`);
          sess.model = value;
          sess.effort = pickEffort(list, value, sess.effort);
        }
        else if (configId === 'thought_level') {
          sess.effort = pickEffort(list, sess.model, value);
        }
        else {
          throw new RpcError(-32602, `unknown config option: ${configId}`);
        }
        return method === 'session/set_model' ? {} : { configOptions: payload(sess).configOptions };
      }

      case 'session/set_mode':
        return {};

      case 'session/prompt': {
        const sess = requireSession(params);
        if (sess.turn)
          throw new RpcError(-32000, 'busy: a turn is already running');
        let turn!: Turn;
        const result = new Promise<{ stopReason: string }>((resolve) => {
          turn = { resolve, turnId: null, sent: false, cancelRequested: false, interruptSent: false };
        });
        sess.turn = turn;
        void runPrompt(sess, turn, promptText(params.prompt));
        return result;
      }

      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  };

  acp.onNotify = (method, params) => {
    if (method !== 'session/cancel')
      return;
    const sess = sessions.get(str(params.sessionId));
    const turn = sess?.turn;
    if (!sess || !turn)
      return;
    turn.cancelRequested = true;
    if (!turn.sent)
      wakeIdle(sess);
    maybeInterrupt(sess);
  };

  function shutdown(code: number): void {
    if (finished)
      return;
    finished = true;
    shuttingDown = true;
    acp.closed = true;
    const exit = () => {
      done();
      if (!options.input)
        process.exit(code);
    };
    // A shared server keeps running (and keeps any running turn going); only drop the connection.
    if (shared || !child) {
      app?.close();
      setTimeout(exit, 100).unref();
      return;
    }
    const proc = child;
    if (proc.exitCode !== null) {
      exit();
      return;
    }
    proc.once('exit', exit);
    proc.kill('SIGTERM');
    setTimeout(() => proc.kill('SIGKILL'), 1500).unref();
    setTimeout(exit, 2000).unref();
  }

  acp.onClose(() => {
    shuttingDown = true;
    // Let in-flight cancelled permission cards see `shuttingDown` before the connection goes.
    setTimeout(shutdown, 50, 0);
  });
  if (!options.input) {
    process.on('SIGTERM', () => {
      shuttingDown = true;
      shutdown(0);
    });
    process.on('SIGINT', () => {
      shuttingDown = true;
      shutdown(0);
    });
  }
  return exited;
}
