/**
 * Codex ACP bridge: an ACP agent on stdio (what Lifeline spawns for `codex-cli`, in place of a
 * native `--acp` binary) that drives `codex app-server` (JSON-RPC v2) as a child process.
 *
 * - One bridge process per Lifeline CLI session (and per catalog read), one app-server per bridge.
 * - The ACP session id IS the Codex thread id, so `codex resume <id>` works from a terminal and
 *   `session/load` after an agent restart is `thread/resume`. A thread that never ran a turn has no
 *   rollout and cannot be loaded (Lifeline then drops the empty session).
 * - stdout carries ACP JSON only; logs go to stderr (`LIFELINE_CODEX_BRIDGE_DEBUG=1` for more).
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CodexModel, Json, ToolStatus } from './items.js';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import process from 'node:process';
import {
  describeTool,
  finalStatus,
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

const BRIDGE_VERSION = '1';
const REPLAY_TURNS = 10;
/** Lifeline gives `session/load` 15s; history is best-effort inside this budget. */
const HISTORY_BUDGET_MS = 8000;
const DEBUG = process.env.LIFELINE_CODEX_BRIDGE_DEBUG === '1';

function log(...parts: unknown[]): void {
  process.stderr.write(`[codex-acp] ${parts.join(' ')}\n`);
}

function debug(...parts: unknown[]): void {
  if (DEBUG)
    log(...parts);
}

export class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

// ---------- newline-delimited JSON-RPC peer ----------

type RequestHandler = (method: string, params: Json) => Promise<unknown>;
type NotifyHandler = (method: string, params: Json) => void;

export class LinePeer {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  closed = false;
  onRequest: RequestHandler = async (method) => {
    throw new RpcError(-32601, `Method not found: ${method}`);
  };

  onNotify: NotifyHandler = () => {};

  constructor(
    private readonly name: string,
    input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
  ) {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      this.buffer += chunk;
      let i = this.buffer.indexOf('\n');
      while (i >= 0) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (line)
          this.handle(line);
        i = this.buffer.indexOf('\n');
      }
    });
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
      log(`${this.name}: non-JSON line ignored`);
      return;
    }
    const hasId = msg.id !== undefined && msg.id !== null;
    const method = typeof msg.method === 'string' ? msg.method : '';
    const params = isRecord(msg.params) ? msg.params : {};
    if (method && hasId) {
      debug(`${this.name} <= ${method}`);
      this.onRequest(method, params).then(
        result => this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null }),
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
      this.output.write(`${JSON.stringify(obj)}\n`);
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
  cancelRequested: boolean;
  interruptSent: boolean;
}

interface ToolInfo {
  item: Json;
  done: boolean;
  turnId: string | null;
}

interface Session {
  id: string;
  cwd: string;
  model: string | undefined;
  effort: string | undefined;
  turn: Turn | null;
  tools: Map<string, ToolInfo>;
  streamed: Set<string>;
  errorShown: Set<string>;
  thoughtItem: string | null;
  thoughtTurn: string | null;
}

export interface CodexBridgeOptions {
  /** Codex CLI binary. Default: `LIFELINE_CODEX_CLI`, else `codex` on PATH. */
  codexCommand?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
}

const PLAN_STATUS: Record<string, string> = { pending: 'pending', inProgress: 'in_progress', completed: 'completed' };

const OPT_ALLOW = { optionId: 'accept', name: '允许', kind: 'allow_once' };
const OPT_ALWAYS = { optionId: 'acceptForSession', name: '本会话都允许', kind: 'allow_always' };
const OPT_REJECT = { optionId: 'decline', name: '拒绝', kind: 'reject_once' };

/** Resolves when stdin ends and the app-server child is gone. */
export function runCodexAcpBridge(options: CodexBridgeOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const codexCommand = options.codexCommand ?? (str(env[CODEX_CLI_ENV]) || 'codex');
  const acp = new LinePeer('acp', options.input ?? process.stdin, options.output ?? process.stdout);
  const sessions = new Map<string, Session>();
  let app: LinePeer | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  let starting: Promise<LinePeer> | null = null;
  let models: CodexModel[] | null = null;
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

  // One collapsed "Thought" row per turn instead of one per reasoning item.
  function thought(sess: Session, turnId: string, itemId: string, text: string): void {
    const sep = sess.thoughtItem && sess.thoughtItem !== itemId && sess.thoughtTurn === turnId ? '\n\n' : '';
    sess.thoughtItem = itemId;
    sess.thoughtTurn = turnId;
    update(sess, { sessionUpdate: 'agent_thought_chunk', messageId: `think:${turnId || itemId}`, content: { type: 'text', text: `${sep}${text}` } });
  }

  // ---------- app-server ----------

  function childEnv(): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = { ...env };
    delete out[CODEX_CLI_ENV];
    // npm's `codex` is `#!/usr/bin/env node`; keep its own directory (where that node usually lives) on PATH.
    const bin = isAbsolute(codexCommand) ? dirname(codexCommand) : '';
    const parts = str(out.PATH).split(':').filter(Boolean);
    if (bin && !parts.includes(bin))
      out.PATH = [bin, ...parts].join(':');
    return out;
  }

  function connect(): Promise<LinePeer> {
    if (app)
      return Promise.resolve(app);
    if (starting)
      return starting;
    starting = new Promise<LinePeer>((resolve, reject) => {
      // Not detached: Lifeline kills the bridge's process group, which then includes app-server.
      const proc = spawn(codexCommand, ['app-server'], { cwd: process.cwd(), env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk: string) => {
        if (DEBUG)
          process.stderr.write(chunk);
      });
      proc.once('error', (err: NodeJS.ErrnoException) => {
        reject(new RpcError(-32000, err.code === 'ENOENT' ? `Codex CLI not found: ${codexCommand}` : err.message));
      });
      proc.once('spawn', () => {
        const peer = new LinePeer('app', proc.stdout, proc.stdin);
        peer.onNotify = onAppNotification;
        peer.onRequest = onAppRequest;
        proc.once('exit', (code, signal) => onAppExit(peer, code, signal));
        peer.request('initialize', {
          clientInfo: { name: 'lifeline_codex_acp', title: 'Lifeline Codex ACP bridge', version: BRIDGE_VERSION },
          capabilities: { experimentalApi: true, requestAttestation: false },
        }).then(() => {
          peer.notify('initialized', {});
          app = peer;
          child = proc;
          resolve(peer);
        }, (err: unknown) => {
          proc.kill('SIGTERM');
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
    }).finally(() => {
      starting = null;
    });
    return starting;
  }

  function onAppExit(peer: LinePeer, code: number | null, signal: NodeJS.Signals | null): void {
    peer.closed = true;
    peer.failAll(new RpcError(-32000, 'codex app-server exited'));
    if (app === peer)
      app = null;
    if (finished)
      return;
    log(`codex app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`);
    for (const sess of sessions.values()) {
      if (sess.turn) {
        say(sess, '[Codex 进程退出，本回合中止]', `err:${Date.now()}`);
        finishTurn(sess, 'end_turn');
      }
    }
    // The ACP client treats our exit as a crashed session, which is what this is.
    shutdown(1);
  }

  async function ensureSignedIn(server: LinePeer): Promise<void> {
    const account = await server.request<Json>('account/read', { refreshToken: false }).catch(() => null);
    if (isRecord(account) && account.requiresOpenaiAuth === true && account.account == null)
      throw new RpcError(401, 'Codex is not signed in. Run `codex login` on this machine.');
  }

  async function loadModels(server: LinePeer): Promise<CodexModel[]> {
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
    return models;
  }

  function newSession(id: string, cwd: string, model: string | undefined, effort: string | undefined): Session {
    const list = models ?? [];
    const known = model && list.some(m => m.id === model) ? model : list[0]?.id;
    const sess: Session = {
      id,
      cwd,
      model: known,
      effort: pickEffort(list, known, effort),
      turn: null,
      tools: new Map(),
      streamed: new Set(),
      errorShown: new Set(),
      thoughtItem: null,
      thoughtTurn: null,
    };
    sessions.set(id, sess);
    return sess;
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
  }

  function finishTurn(sess: Session, stopReason: 'end_turn' | 'cancelled'): void {
    const turn = sess.turn;
    if (!turn)
      return;
    sess.turn = null;
    closeTools(sess, turn.turnId, stopReason === 'cancelled' ? 'cancelled' : 'completed');
    sess.streamed.clear();
    turn.resolve({ stopReason });
  }

  function onItem(sess: Session, item: Json, phase: 'started' | 'completed', turnId: string): void {
    const id = str(item.id);
    if (!id)
      return;
    switch (item.type) {
      case 'agentMessage':
        if (phase === 'completed' && !sess.streamed.has(id))
          say(sess, str(item.text), id);
        return;
      case 'reasoning': {
        if (phase !== 'completed' || sess.streamed.has(id))
          return;
        const parts = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])];
        const text = parts.map(p => str(p)).join('\n').trim();
        if (text)
          thought(sess, turnId, id, text);
        return;
      }
      case 'plan':
        if (phase === 'completed')
          say(sess, str(item.text), id);
        return;
      case 'userMessage':
        return;
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
      sess.tools.set(id, { item, done: phase === 'completed', turnId });
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
    if (!turn?.cancelRequested || !turn.turnId || turn.interruptSent || !app)
      return;
    turn.interruptSent = true;
    app.request('turn/interrupt', { threadId: sess.id, turnId: turn.turnId }).catch((err: unknown) => {
      log(`turn/interrupt failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  function onAppNotification(method: string, params: Json): void {
    const sess = sessions.get(str(params.threadId));
    if (!sess)
      return;
    const turnId = str(params.turnId);
    switch (method) {
      case 'turn/started': {
        const id = isRecord(params.turn) ? str(params.turn.id) : '';
        if (sess.turn && !sess.turn.turnId && id) {
          sess.turn.turnId = id;
          maybeInterrupt(sess);
        }
        break;
      }
      case 'item/started':
      case 'item/completed':
        if (isRecord(params.item))
          onItem(sess, params.item, method === 'item/started' ? 'started' : 'completed', turnId);
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
        if (turn.status === 'failed' && isRecord(turn.error) && !sess.errorShown.has(id || 'none')) {
          sess.errorShown.add(id || 'none');
          say(sess, `[Codex 错误] ${str(turn.error.message)}`, `err:${id}`);
        }
        if (sess.turn && (!sess.turn.turnId || sess.turn.turnId === id))
          finishTurn(sess, turn.status === 'interrupted' ? 'cancelled' : 'end_turn');
        else
          closeTools(sess, id, turn.status === 'interrupted' ? 'cancelled' : 'completed');
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
          toolCallId: toolCallId || `ask:${Date.now()}`,
          title: oneLine(title, 300),
          kind,
          status: 'pending',
          ...(detail ? { content: textBlock(detail.slice(0, 6000)) } : {}),
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

  async function onAppRequest(method: string, params: Json): Promise<unknown> {
    const sess = sessions.get(str(params.threadId) || str(params.conversationId));
    if (!sess)
      throw new RpcError(-32601, `not handled: ${method}`);
    const itemId = str(params.itemId) || str(params.callId);
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const title = params.command ? `运行命令: ${oneLine(params.command, 240)}` : `运行命令${params.reason ? `: ${oneLine(params.reason)}` : ''}`;
        const detail = [str(params.reason), params.cwd ? `cwd: ${str(params.cwd)}` : ''].filter(Boolean).join('\n');
        const choice = await askPermission(sess, itemId, title, 'execute', [OPT_ALLOW, OPT_ALWAYS, OPT_REJECT], detail);
        return { decision: choice ?? 'cancel' };
      }
      case 'item/fileChange/requestApproval': {
        const item = sess.tools.get(itemId)?.item;
        const title = item ? (describeTool(item, sess.cwd)?.title ?? '修改文件') : '修改文件';
        const content = item ? toolContent(item) : undefined;
        const diff = content && isRecord(content[0]) && isRecord(content[0].content) ? str(content[0].content.text) : '';
        const detail = [str(params.reason), params.grantRoot ? `授权目录: ${str(params.grantRoot)}` : '', diff].filter(Boolean).join('\n');
        const choice = await askPermission(sess, itemId, title, 'edit', [OPT_ALLOW, OPT_ALWAYS, OPT_REJECT], detail);
        return { decision: choice ?? 'cancel' };
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
        return { permissions: {}, scope: 'turn' };
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
            return { answers: {} };
          const picked = options[Number(choice.slice(3))];
          answers[str(q.id)] = { answers: picked ? [str(picked.label)] : [] };
        }
        return { answers };
      }
      case 'mcpServer/elicitation/request': {
        const choice = await askPermission(sess, itemId, `MCP 请求确认: ${oneLine(params.message ?? params.serverName ?? '')}`, 'other', [OPT_ALLOW, OPT_REJECT], JSON.stringify(params).slice(0, 2000));
        if (choice === 'accept')
          return { action: 'accept', content: {}, _meta: null };
        return { action: choice ? 'decline' : 'cancel', content: null, _meta: null };
      }
      default:
        throw new RpcError(-32601, `not supported by the Codex ACP bridge: ${method}`);
    }
  }

  // ---------- history ----------

  async function recentTurns(server: LinePeer, threadId: string): Promise<Json[] | null> {
    const read = async (): Promise<Json[]> => {
      try {
        const res = await server.request<Json>('thread/turns/list', { threadId, limit: REPLAY_TURNS, itemsView: 'summary' });
        return (Array.isArray(res?.data) ? res.data.filter(isRecord) : []).reverse();
      }
      catch {
        const res = await server.request<Json>('thread/read', { threadId, includeTurns: true });
        const turns = isRecord(res?.thread) && Array.isArray(res.thread.turns) ? res.thread.turns.filter(isRecord) : [];
        return turns.slice(-REPLAY_TURNS);
      }
    };
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(resolve, HISTORY_BUDGET_MS, null);
    });
    try {
      return await Promise.race([read().catch(() => null), expired]);
    }
    finally {
      clearTimeout(timer);
    }
  }

  // A finished turn replays as: the prompt, one summary row (when tool items are present), the final reply.
  function replay(sess: Session, turns: readonly Json[]): void {
    for (const turn of turns) {
      const items = Array.isArray(turn.items) ? turn.items.filter(isRecord) : [];
      for (const item of items) {
        if (item.type !== 'userMessage')
          continue;
        const text = userText(item);
        if (text)
          update(sess, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
      }
      const summary = turnSummary(items, sess.cwd);
      if (summary)
        say(sess, summary, `sum:${str(turn.id)}`);
      const reply = [...items].reverse().find(item => item.type === 'agentMessage' && str(item.text));
      if (reply)
        say(sess, str(reply.text), str(reply.id) || `reply:${str(turn.id)}`);
      if (turn.status === 'failed' && isRecord(turn.error))
        say(sess, `[Codex 错误] ${str(turn.error.message)}`, `err:${str(turn.id)}`);
    }
  }

  // ---------- prompts ----------

  async function runPrompt(sess: Session, turn: Turn, text: string): Promise<void> {
    try {
      const server = await connect();
      const res = await server.request<Json>('turn/start', {
        threadId: sess.id,
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
      say(sess, `[Codex 启动回合失败] ${err instanceof Error ? err.message : String(err)}`, `err:${Date.now()}`);
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
        await loadModels(server);
        const res = await server.request<Json>('thread/start', { cwd });
        const threadId = isRecord(res?.thread) ? str(res.thread.id) : '';
        if (!threadId)
          throw new RpcError(-32000, 'thread/start returned no thread id');
        const sess = newSession(threadId, cwd, str(res.model) || undefined, str(res.reasoningEffort) || undefined);
        return { sessionId: sess.id, ...payload(sess) };
      }

      case 'session/load': {
        const id = str(params.sessionId);
        const existing = sessions.get(id);
        if (existing)
          return payload(existing);
        const cwd = str(params.cwd) || process.cwd();
        const server = await connect();
        await ensureSignedIn(server);
        await loadModels(server);
        let res: Json;
        try {
          res = await server.request<Json>('thread/resume', { threadId: id, excludeTurns: true });
        }
        catch (err) {
          throw new RpcError(-32002, `session not found: ${err instanceof Error ? err.message : String(err)}`);
        }
        const sess = newSession(id, cwd, str(res?.model) || undefined, str(res?.reasoningEffort) || undefined);
        const turns = await recentTurns(server, id);
        if (turns)
          replay(sess, turns);
        else
          say(sess, '（历史太大没有加载完，只显示之后的新内容）', `note:history:${id}`);
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
          turn = { resolve, turnId: null, cancelRequested: false, interruptSent: false };
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
    if (!sess?.turn)
      return;
    sess.turn.cancelRequested = true;
    maybeInterrupt(sess);
  };

  function shutdown(code: number): void {
    if (finished)
      return;
    finished = true;
    acp.closed = true;
    const proc = child;
    const exit = () => {
      done();
      if (!options.input)
        process.exit(code);
    };
    if (!proc || proc.exitCode !== null) {
      exit();
      return;
    }
    proc.once('exit', exit);
    proc.kill('SIGTERM');
    setTimeout(() => proc.kill('SIGKILL'), 1500).unref();
    setTimeout(exit, 2000).unref();
  }

  const input = options.input ?? process.stdin;
  input.on('end', () => shutdown(0));
  if (!options.input) {
    process.on('SIGTERM', () => shutdown(0));
    process.on('SIGINT', () => shutdown(0));
  }
  return exited;
}
