import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { ACP_LINE_MAX_BYTES, ACP_STDERR_MAX_BYTES } from '../../../../protocol/src/index.js';

/** Alias of the protocol stdout line cap. This file must not publish a second number. */
export const MAX_LINE_BYTES = ACP_LINE_MAX_BYTES;

/**
 * Wait between process-group SIGTERM and SIGKILL.
 * The design requires both signals and does not give a duration.
 * 5000 is the controller-supplied default; tests inject a shorter `killGraceMs`.
 * The direct child exiting does not cancel this wait or skip SIGKILL: a grandchild
 * may have ignored SIGTERM and still be in the group.
 */
export const DEFAULT_KILL_GRACE_MS = 5_000;

/** Default JSON-RPC response deadline for methods that are allowed to time out. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INTERNAL_ERROR = -32603;

/**
 * `initialize` and `session/new` use the 15s default. `session/prompt` and any
 * permission method wait until the peer answers. An explicit `timeoutMs`, including
 * `null`, replaces that default.
 */
export function resolveTimeoutMs(
  method: string,
  timeoutMs?: number | null,
  defaultMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): number | null {
  if (timeoutMs !== undefined)
    return timeoutMs;
  if (method === 'session/prompt' || method.includes('permission'))
    return null;
  return defaultMs;
}

export class JsonlRpcError extends Error {
  readonly code: string;

  constructor(code: string, message = code, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'JsonlRpcError';
    this.code = code;
  }
}

export class JsonlRpcRemoteError extends JsonlRpcError {
  readonly rpcCode: number;

  constructor(rpcCode: number, message: string) {
    super('remote-error', message);
    this.name = 'JsonlRpcRemoteError';
    this.rpcCode = rpcCode;
  }
}

/** Thrown by `onRequest` when the inbound method is not implemented. */
export class JsonlRpcMethodNotFound extends Error {
  readonly code = JSONRPC_METHOD_NOT_FOUND;

  constructor(method: string) {
    super(`Method not found: ${method}`);
    this.name = 'JsonlRpcMethodNotFound';
  }
}

export interface JsonlRpcInboundRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonlRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonlRpcRequestOptions {
  timeoutMs?: number | null;
}

export interface JsonlRpcCall {
  written: Promise<void>;
  response: Promise<unknown>;
}

export interface JsonlRpcExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface JsonlRpcOptions {
  command: string;
  /** Codex app-server uses JSON-RPC messages without the jsonrpc member. */
  omitJsonrpc?: boolean;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Overrides `DEFAULT_KILL_GRACE_MS` so tests do not wait five seconds. */
  killGraceMs?: number;
  /**
   * Overrides `DEFAULT_REQUEST_TIMEOUT_MS` for the methods that are allowed to time out, so a test can prove
   * "initialize times out, prompt does not" without waiting fifteen real seconds. The default value itself is
   * pinned by the unit test on `resolveTimeoutMs`.
   */
  requestTimeoutMs?: number;
  onRequest?: (request: JsonlRpcInboundRequest) => Promise<unknown> | unknown;
  onNotification?: (notification: JsonlRpcNotification) => void;
  /**
   * Fires for every process exit, including exits that follow `close()`.
   * Pending outbound RPCs are still rejected only for an unexpected exit.
   */
  onExit?: (info: JsonlRpcExitInfo) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Bounded NDJSON JSON-RPC transport for one ACP child process.
 * One `sendRequest` writes one frame. `written` resolves when that frame is flushed;
 * `response` resolves when the matching id comes back.
 */
export class JsonlRpc {
  private readonly omitJsonrpc: boolean;
  readonly killGraceMs: number;

  private readonly requestTimeoutMs: number;
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly onRequest: JsonlRpcOptions['onRequest'];
  private readonly onNotification: JsonlRpcOptions['onNotification'];
  private readonly onExit: JsonlRpcOptions['onExit'];
  private readonly pending = new Map<number | string, Pending>();
  private readonly stderrChunks: Buffer[] = [];
  private child: ChildProcess | undefined;
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private nextId = 1;
  private lineChunks: Buffer[] = [];
  private lineBytes = 0;
  private stderrBytes = 0;
  private stopped = false;
  private failed = false;

  constructor(options: JsonlRpcOptions) {
    this.omitJsonrpc = options.omitJsonrpc === true;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.command = options.command;
    this.args = [...(options.args ?? [])];
    this.cwd = options.cwd;
    this.env = options.env;
    this.onRequest = options.onRequest;
    this.onNotification = options.onNotification;
    this.onExit = options.onExit;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get hasExited(): boolean {
    const child = this.child;
    if (child == null)
      return false;
    return child.exitCode !== null || child.signalCode !== null;
  }

  /** Copy of the newest stderr bytes, capped at `ACP_STDERR_MAX_BYTES`. */
  get stderrTail(): Buffer {
    return Buffer.concat(this.stderrChunks, this.stderrBytes);
  }

  start(): Promise<void> {
    if (this.closePromise != null)
      return Promise.reject(new JsonlRpcError('closed', 'transport closed'));
    if (this.startPromise != null)
      return this.startPromise;
    this.startPromise = this.doStart();
    return this.startPromise;
  }

  sendRequest(method: string, params?: unknown, options?: JsonlRpcRequestOptions): JsonlRpcCall {
    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = resolveTimeoutMs(method, options?.timeoutMs, this.requestTimeoutMs);
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = timeoutMs == null
        ? undefined
        : setTimeout(() => {
            this.rejectPending(id, new JsonlRpcError('timeout', `timeout: ${method}`));
          }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    const body: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined)
      body.params = params;
    const written = this.writeMessage(body).then(() => undefined, (err: unknown) => {
      const failure = err instanceof Error ? err : new Error(String(err));
      this.rejectPending(id, failure);
      throw failure;
    });
    // AcpClient awaits `response` and drops `written`. The rethrow must stay so
    // callers that do await `written` still see the failure, but an unobserved
    // rejection exits the process (Node 15+). A dead CLI stdin then crash-loops
    // the whole agent under launchd.
    void written.then(() => undefined, () => undefined);
    return { written, response };
  }

  notify(method: string, params?: unknown): { written: Promise<void> } {
    const body: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined)
      body.params = params;
    return { written: this.writeMessage(body) };
  }

  close(): Promise<void> {
    if (this.closePromise != null)
      return this.closePromise;
    this.closePromise = this.doClose();
    return this.closePromise;
  }

  private doStart(): Promise<void> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.command, this.args, {
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          ...(this.cwd != null ? { cwd: this.cwd } : {}),
          ...(this.env != null ? { env: this.env } : {}),
        });
      }
      catch (err) {
        reject(mapSpawnError(err));
        return;
      }
      this.child = child;
      let onError: (err: Error) => void;
      const onSpawn = () => {
        child.off('error', onError);
        this.attach(child);
        resolve();
      };
      onError = (err: Error) => {
        child.off('spawn', onSpawn);
        reject(mapSpawnError(err));
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });
  }

  private attach(child: ChildProcess): void {
    child.on('error', (err) => {
      if (this.closePromise != null || this.failed)
        return;
      this.failTransport(err);
    });
    child.stdout?.on('data', (chunk: Buffer | string) => {
      this.onStdout(toBuffer(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.onStderr(toBuffer(chunk));
    });
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    child.stdin?.on('error', () => {});
    child.on('exit', (code, signal) => {
      this.onExit?.({ code, signal });
      if (this.failed || this.closePromise != null)
        return;
      this.rejectAll(new JsonlRpcError('closed', 'process exited'));
    });
  }

  private async doClose(): Promise<void> {
    this.stopped = true;
    this.rejectAll(new JsonlRpcError('closed', 'transport closed'));
    const child = this.child;
    if (child?.pid == null)
      return;
    const alreadyExited = child.exitCode !== null || child.signalCode !== null;
    this.signalGroup('SIGTERM');
    child.stdin?.destroy();
    // A direct child that dies inside the grace period must not skip the group
    // SIGKILL. Only a group that was already gone before close() skips the wait;
    // SIGKILL is still attempted, and ESRCH is swallowed.
    if (!alreadyExited)
      await this.delay(this.killGraceMs);
    this.signalGroup('SIGKILL');
    await this.waitForExit(1_000);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private waitForExit(ms: number): Promise<boolean> {
    const child = this.child;
    if (child == null || child.exitCode !== null || child.signalCode !== null)
      return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const onExit = () => {
        if (settled)
          return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      timer = setTimeout(() => {
        if (settled)
          return;
        settled = true;
        child.off('exit', onExit);
        resolve(false);
      }, ms);
      child.once('exit', onExit);
      if (child.exitCode !== null || child.signalCode !== null)
        onExit();
    });
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (pid == null || pid <= 0)
      return;
    try {
      process.kill(-pid, signal);
    }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH')
        return;
      throw err;
    }
  }

  private writeMessage(body: Record<string, unknown>): Promise<void> {
    if (this.omitJsonrpc)
      delete body.jsonrpc;
    return this.enqueueWrite(`${JSON.stringify(body)}\n`);
  }

  private enqueueWrite(line: string): Promise<void> {
    if (this.stopped || this.closePromise != null)
      return Promise.reject(new JsonlRpcError('closed', 'transport closed'));
    const run = this.writeQueue.then(() => this.writeRaw(line));
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private writeRaw(line: string): Promise<void> {
    const stdin = this.child?.stdin;
    if (this.stopped || this.closePromise != null || stdin == null || stdin.destroyed || stdin.writable === false)
      return Promise.reject(new JsonlRpcError('closed', 'stdin closed'));
    return new Promise((resolve, reject) => {
      let settled = false;
      let onError: (err: Error) => void;
      let onClose: () => void;
      let onDrain: () => void;
      const finish = (err?: Error) => {
        if (settled)
          return;
        settled = true;
        stdin.off('error', onError);
        stdin.off('close', onClose);
        stdin.off('drain', onDrain);
        if (err != null)
          reject(err);
        else
          resolve();
      };
      onError = (err: Error) => finish(err);
      onClose = () => finish(new JsonlRpcError('closed', 'stdin closed'));
      onDrain = () => finish();
      stdin.on('error', onError);
      stdin.on('close', onClose);
      try {
        const accepted = stdin.write(line);
        if (accepted)
          finish();
        else
          stdin.on('drain', onDrain);
      }
      catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Count bytes as they arrive. A legal line is retained until its newline;
   * crossing `ACP_LINE_MAX_BYTES` drops the partial line and kills the process
   * without waiting for the rest of the frame.
   */
  private onStdout(chunk: Buffer): void {
    if (this.stopped || this.failed)
      return;
    let offset = 0;
    while (offset < chunk.length) {
      if (this.stopped || this.failed)
        return;
      const newline = chunk.indexOf(0x0A, offset);
      const end = newline === -1 ? chunk.length : newline;
      const take = end - offset;
      if (take > 0 && this.lineBytes + take > MAX_LINE_BYTES) {
        this.lineChunks = [];
        this.lineBytes = 0;
        this.failTransport(new JsonlRpcError('line-too-large', 'stdout line exceeds ACP_LINE_MAX_BYTES'));
        return;
      }
      if (take > 0) {
        this.lineChunks.push(Buffer.from(chunk.subarray(offset, end)));
        this.lineBytes += take;
      }
      if (newline === -1)
        return;
      const line = this.lineBytes === 0 ? Buffer.alloc(0) : Buffer.concat(this.lineChunks, this.lineBytes);
      this.lineChunks = [];
      this.lineBytes = 0;
      offset = newline + 1;
      if (line.length === 0)
        continue;
      this.handleLine(line);
    }
  }

  private onStderr(chunk: Buffer): void {
    if (chunk.length === 0)
      return;
    if (chunk.length >= ACP_STDERR_MAX_BYTES) {
      this.stderrChunks.length = 0;
      this.stderrChunks.push(Buffer.from(chunk.subarray(chunk.length - ACP_STDERR_MAX_BYTES)));
      this.stderrBytes = ACP_STDERR_MAX_BYTES;
      return;
    }
    this.stderrChunks.push(Buffer.from(chunk));
    this.stderrBytes += chunk.length;
    while (this.stderrBytes > ACP_STDERR_MAX_BYTES && this.stderrChunks.length > 0) {
      const extra = this.stderrBytes - ACP_STDERR_MAX_BYTES;
      const head = this.stderrChunks[0];
      if (head == null)
        break;
      if (head.length <= extra) {
        this.stderrChunks.shift();
        this.stderrBytes -= head.length;
      }
      else {
        this.stderrChunks[0] = Buffer.from(head.subarray(extra));
        this.stderrBytes -= extra;
      }
    }
  }

  private handleLine(line: Buffer): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line.toString('utf8'));
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed))
        return;
      message = parsed as Record<string, unknown>;
    }
    catch {
      this.failTransport(new JsonlRpcError('invalid-json', 'invalid json'));
      return;
    }
    const method = typeof message.method === 'string' ? message.method : undefined;
    const id = isRpcId(message.id) ? message.id : undefined;
    if (method != null && id != null) {
      void this.dispatchInbound(id, method, message.params);
      return;
    }
    if (method != null) {
      this.onNotification?.({ method, params: message.params });
      return;
    }
    if (id != null)
      this.settle(id, message);
  }

  private async dispatchInbound(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      if (this.onRequest == null) {
        await this.writeMessage({
          jsonrpc: '2.0',
          id,
          error: { code: JSONRPC_METHOD_NOT_FOUND, message: 'Method not found' },
        });
        return;
      }
      const result = await this.onRequest({ id, method, params });
      await this.writeMessage({
        jsonrpc: '2.0',
        id,
        result: result === undefined ? null : result,
      });
    }
    catch (err) {
      const error = isMethodNotFound(err)
        ? { code: JSONRPC_METHOD_NOT_FOUND, message: 'Method not found' }
        : { code: JSONRPC_INTERNAL_ERROR, message: 'Internal error' };
      try {
        await this.writeMessage({ jsonrpc: '2.0', id, error });
      }
      catch {
        // The peer is already gone; the inbound request cannot be answered.
      }
    }
  }

  private settle(id: number | string, message: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (pending == null)
      return;
    this.pending.delete(id);
    if (pending.timer != null)
      clearTimeout(pending.timer);
    const error = message.error;
    if (typeof error === 'object' && error !== null) {
      const record = error as { code?: unknown; message?: unknown; data?: unknown };
      const rpcCode = typeof record.code === 'number' ? record.code : -32000;
      const top = typeof record.message === 'string' ? record.message : 'remote error';
      const data = record.data;
      const detail = data != null && typeof data === 'object' && !Array.isArray(data)
        && typeof (data as { message?: unknown }).message === 'string'
        ? (data as { message: string }).message
        : undefined;
      const text = detail && detail !== top ? `${top}: ${detail}` : top;
      pending.reject(new JsonlRpcRemoteError(rpcCode, text));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectPending(id: number | string, err: Error): void {
    const pending = this.pending.get(id);
    if (pending == null)
      return;
    this.pending.delete(id);
    if (pending.timer != null)
      clearTimeout(pending.timer);
    pending.reject(err);
  }

  private rejectAll(err: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const item of pending) {
      if (item.timer != null)
        clearTimeout(item.timer);
      item.reject(err);
    }
  }

  private failTransport(err: Error): void {
    if (this.failed)
      return;
    this.failed = true;
    this.stopped = true;
    this.lineChunks = [];
    this.lineBytes = 0;
    this.rejectAll(err);
    this.signalGroup('SIGKILL');
  }
}

function mapSpawnError(err: unknown): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT')
    return new JsonlRpcError('binary-missing', 'binary-missing', { cause: err });
  if (code === 'EACCES')
    return new JsonlRpcError('binary-not-executable', 'binary-not-executable', { cause: err });
  return err instanceof Error ? err : new Error(String(err));
}

function isRpcId(value: unknown): value is number | string {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function isMethodNotFound(err: unknown): boolean {
  return err instanceof JsonlRpcMethodNotFound
    || (typeof err === 'object' && err != null && (err as { code?: unknown }).code === JSONRPC_METHOD_NOT_FOUND);
}

function toBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
}
