import type { Socket } from 'socket.io-client';
import type { CliAcpCapability, IdeKind } from '../../protocol/src/index.js';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { io } from 'socket.io-client';
import { BUILD_VERSION } from '../../cli/src/build-version.js';
import { SOCKET_MAX_HTTP_BUFFER_SIZE, toAgentPlatform } from '../../protocol/src/index.js';
import { readServerCommand } from './server-inbound.js';
import { timingLastBubble, timingLog, timingPreview } from './timing-log.js';
import { UplinkWatchdog } from './uplink-watchdog.js';

/**
 * Outbound connection from the local agent to the remote server's /agent
 * namespace. Mirrors AgentHub on the server side:
 *
 *   upstream (agent -> server): agent:register, state:full, state:patch,
 *                               connection:status, command:result
 *   downstream (server -> agent): command:* (see COMMAND_EVENTS)
 *
 * Reconnection is handled by socket.io-client itself (1s -> 30s backoff).
 * When that is not enough — a reconnect-error loop that never recovers, or an
 * inert socket after a server-initiated disconnect where socket.io-client
 * stops reconnecting entirely — the UplinkWatchdog tears the whole stack down
 * and rebuilds it, which is what a process restart provides (issue #1).
 */
export interface UplinkOptions {
  /** Test seam: socket factory (default: socket.io-client `io`). */
  socketFactory?: (url: string, opts: Parameters<typeof io>[1]) => Socket;
  /** Test seams; production defaults live in uplink-watchdog.ts. */
  watchdogThresholdMs?: number;
  watchdogMaxThresholdMs?: number;
  /**
   * Process identity for `agent:register`. index.ts mints this once and also uses it as the CLI
   * epoch. When omitted, this Uplink mints its own so existing call sites stay valid.
   */
  instanceId?: string;
  /**
   * Static CLI capability for `agent:register`. Sent on darwin and linux
   * (`CLI_PLATFORMS`); omit on win32. An older server rejects a non-darwin
   * value, and this uplink then registers once without it.
   */
  cliAcp?: CliAcpCapability;
  /**
   * Routing capability for `agent:register`: the slots this process can actually
   * serve (started disk adapters ∪ created CDP slots), **not** `registeredDrivers()`
   * — that list is compiled in, so it would claim a `vscode` slot on a machine with
   * no plugin. The server gates commands and `session:get` on this; an old agent
   * that reports nothing is treated as `cursor + codebuddy`.
   */
  slots?: IdeKind[];
}

const ts = () => new Date().toISOString();

function invalidCommandResult(payload: unknown): { commandId: string; ok: false; errorCode: 'invalid-payload'; error: 'invalid-payload' } {
  const commandId = payload != null && typeof payload === 'object' && 'commandId' in payload && typeof payload.commandId === 'string'
    ? payload.commandId
    : '';
  return { commandId, ok: false, errorCode: 'invalid-payload', error: 'invalid-payload' };
}

export class Uplink extends EventEmitter {
  private socket: Socket;
  private socketFactory: (url: string, opts: Parameters<typeof io>[1]) => Socket;
  private agentId: string;
  private agentToken: string;
  private remoteUrl: string;
  private liveIdes: IdeKind[] | undefined;
  /** Routing capability (see `UplinkOptions.slots`); older servers ignore it. */
  private readonly slots: IdeKind[] | undefined;
  /** Whether this machine is content-source only (Linux). Older servers ignore it. */
  private contentSource: boolean | undefined;
  /**
   * Process identity sent with every `agent:register`. Stable across watchdog rebuilds so a
   * reconnect is not a new process. Older servers ignore it.
   */
  private readonly instanceId: string;
  /** Static CLI capability. Absent when this process does not speak CLI. */
  private readonly cliAcp: CliAcpCapability | undefined;
  /**
   * Set when a server rejected a register that carried a non-darwin `cliAcp`. Servers that predate
   * Linux CLI sessions validate `platform: 'darwin'` strictly and drop the whole register; the agent
   * then registers without `cliAcp` for the rest of this process, so it still comes online.
   */
  private cliAcpDropped = false;
  private watchdog: UplinkWatchdog;

  constructor(
    remoteUrl: string,
    agentToken: string,
    agentId: string,
    liveIdes?: IdeKind[],
    contentSource?: boolean,
    options?: UplinkOptions,
  ) {
    super();
    this.agentId = agentId;
    this.agentToken = agentToken;
    this.liveIdes = liveIdes;
    this.slots = options?.slots;
    this.contentSource = contentSource;
    this.remoteUrl = remoteUrl.replace(/\/+$/, '');
    this.socketFactory = options?.socketFactory ?? io;
    this.instanceId = options?.instanceId ?? randomUUID();
    this.cliAcp = options?.cliAcp;
    this.socket = this.createSocket();

    this.watchdog = new UplinkWatchdog({
      thresholdMs: options?.watchdogThresholdMs,
      maxThresholdMs: options?.watchdogMaxThresholdMs,
      onStuck: () => this.rebuild(),
      log: msg => console.warn(`[uplink] ${ts()} watchdog: ${msg}`),
    });

    this.attachSocketHandlers(this.socket);
  }

  private createSocket(): Socket {
    return this.socketFactory(`${this.remoteUrl}/agent`, {
      path: '/agent-io',
      auth: { agentToken: this.agentToken },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      timeout: 60_000,
      // engine.io option; socket.io-client's ManagerOptions omits it.
      maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE,
      // `io()` caches managers by URL; a rebuild must never reuse a wedged
      // one. forceNew = a fresh Manager, which is what a process restart gets.
      forceNew: true,
    } as Parameters<typeof io>[1]);
  }

  private attachSocketHandlers(socket: Socket): void {
    socket.on('connect', () => {
      console.log(`[uplink] ${ts()} Connected to ${this.remoteUrl} (${socket.id})`);
      this.sendRegister(socket);
      this.emit('connected');
      this.watchdog.notifyConnected();
    });

    socket.on('disconnect', (reason) => {
      console.warn(`[uplink] ${ts()} Disconnected (${reason})`);
      // Any reason arms the watchdog — including "io server disconnect",
      // where socket.io-client stops reconnecting on its own and only a
      // rebuild recovers (see docs/plans/2026-10-04-uplink-watchdog-design.md).
      this.watchdog.notifyDisconnected();
      this.emit('disconnected');
    });

    socket.on('connect_error', (err) => {
      console.warn(`[uplink] ${ts()} Connection error: ${err.message}`);
      this.watchdog.notifyConnectError();
    });

    // Forward inbound command:*, session:get, and cli:sync so command handlers and the
    // CLI manager can subscribe to this object like they do to a browser socket.
    // Commands and cli:sync are checked here. A failed check is closed and is not emitted,
    // so it never reaches IDE routing.
    socket.onAny((event, ...args) => {
      if (typeof event !== 'string' || (!event.startsWith('command:') && event !== 'session:get' && event !== 'cli:sync'))
        return;
      if (event.startsWith('command:') || event === 'cli:sync') {
        const read = readServerCommand(event, args[0]);
        if (!read.ok) {
          if (event.startsWith('command:'))
            this.send('command:result', invalidCommandResult(args[0]));
          return;
        }
      }
      const payload = args[0] as { commandId?: string; ide?: string; text?: string; sessionId?: string } | undefined;
      timingLog('uplink:in', {
        event,
        commandId: payload?.commandId,
        ide: payload?.ide,
        sessionId: payload?.sessionId,
        chars: payload?.text?.length,
        preview: payload?.text ? timingPreview(payload.text) : undefined,
      });
      this.emit(event, ...args);
    });

    // Server asks for a fresh snapshot after this agent is promoted to active.
    socket.on('agent:sync', (payload?: { reason?: string }) => {
      console.log(`[uplink] ${ts()} Server requested state sync${payload?.reason ? ` (${payload.reason})` : ''}`);
      this.emit('sync', payload);
    });

    socket.on('agent:rejected', (payload?: unknown) => {
      // A server older than Linux CLI sessions rejects the linux `cliAcp` schema and with it the whole
      // register. Retry once without it on this socket (a reconnect re-registers the same way).
      const reason = (payload as { reason?: unknown } | undefined)?.reason;
      if (reason === 'reject-register' && !this.cliAcpDropped && this.cliAcp && this.cliAcp.platform !== 'darwin') {
        this.cliAcpDropped = true;
        console.warn(`[uplink] ${ts()} Server rejected the ${this.cliAcp.platform} CLI capability (older server?); registering without CLI sessions`);
        this.sendRegister(socket);
        return;
      }
      this.emit('rejected');
    });

    // The server gave this machine's slot to another process. Forwarded as its own event, not through
    // `onAny` (which carries `command:*`, `session:get`, and `cli:sync`): the decision — stand down, or keep the
    // lock and wait for the next registration to take the slot back — belongs to `index.ts`, which
    // owns the lock (see superseded-outcome.ts).
    socket.on('agent:superseded', (payload?: unknown) => {
      this.emit('superseded', payload);
    });
  }

  private sendRegister(socket: Socket): void {
    // The console uses this to send uninstall/upgrade commands for **this
    // machine** — the person on the web may be on a different OS, so the
    // platform must be self-reported by the machine, not guessed from the
    // browser UA. Omit if unrecognized; the web falls back to OS toggles.
    const platform = toAgentPlatform(process.platform);
    const cliAcp = this.cliAcpDropped ? undefined : this.cliAcp;
    socket.emit('agent:register', {
      agentId: this.agentId,
      hostname: hostname(),
      // Server stores this so the web can show "which version this box is"; older servers ignore it.
      version: BUILD_VERSION,
      // Stable across this process's rebuilds: a reconnect must not look like a takeover, and an
      // old-code newcomer must not displace a process that can name itself (register-outcome.ts).
      instanceId: this.instanceId,
      ...(this.liveIdes !== undefined ? { liveIdes: this.liveIdes } : {}),
      // Routing capability. In practice always present (every machine has cursor +
      // codebuddy), which is why the **server must ship first**: an old `.strict()`
      // register schema rejects the whole packet on the unknown key. The spread only
      // guards the "constructed without slots" case (tests).
      ...(this.slots !== undefined ? { slots: this.slots } : {}),
      ...(platform !== undefined ? { platform } : {}),
      // This machine is content-source only (Linux). The server uses this to
      // file it under "content sources".
      // The criterion is the **platform**, not "app not found in the
      // inventory" — that would misclassify a normal install as a content
      // source (review R1).
      ...(this.contentSource !== undefined ? { contentSource: this.contentSource } : {}),
      ...(cliAcp !== undefined ? { cliAcp } : {}),
    });
  }

  /**
   * Watchdog fire: the socket has been continuously disconnected longer than
   * the current threshold. Tear the whole stack down and start over — equal to
   * what a process restart provides. Never throws: a failure here leaves
   * recovery to the next watchdog cycle.
   */
  private rebuild(): void {
    const old = this.socket;
    try {
      old.removeAllListeners();
      // Socket.disconnect() → Manager._destroy → (last active socket) _close():
      // sets skipReconnect, clears the reconnect timer, closes the engine. No
      // zombie reconnection loop is left behind.
      old.disconnect();
    }
    catch (err) {
      console.warn(`[uplink] ${ts()} watchdog: old socket teardown failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.socket = this.createSocket();
    this.attachSocketHandlers(this.socket);
    console.warn(`[uplink] ${ts()} watchdog: rebuilt connection (fresh manager)`);
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  send(event: string, payload: unknown): void {
    if (
      event === 'command:result'
      || event === 'session:full'
      || event === 'session:append'
      || event === 'session:patch'
      || event === 'session:missing'
    ) {
      const body = payload as {
        commandId?: string;
        ok?: boolean;
        error?: string;
        sessionId?: string;
        ide?: string;
        seq?: number;
        messages?: unknown[];
      };
      timingLog('uplink:out', {
        event,
        commandId: body.commandId,
        ok: body.ok,
        error: body.error,
        sessionId: body.sessionId,
        ide: body.ide,
        n: body.messages?.length,
        seq: body.seq,
        last: body.messages ? timingLastBubble(body.messages as Array<{ type?: string; text?: string }>) || undefined : undefined,
      });
    }
    this.socket.emit(event, payload);
  }

  disconnect(): void {
    this.watchdog.stop();
    this.socket.disconnect();
  }
}
