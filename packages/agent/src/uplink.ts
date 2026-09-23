import type { Socket } from 'socket.io-client';
import type { IdeKind } from '../../protocol/src/index.js';
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { io } from 'socket.io-client';
import { BUILD_VERSION } from '../../cli/src/build-version.js';
import { SOCKET_MAX_HTTP_BUFFER_SIZE, toAgentPlatform } from '../../protocol/src/index.js';
import { timingLastBubble, timingLog, timingPreview } from './timing-log.js';

/**
 * Outbound connection from the local agent to the remote server's /agent
 * namespace. Mirrors AgentHub on the server side:
 *
 *   upstream (agent -> server): agent:register, state:full, state:patch,
 *                               connection:status, command:result
 *   downstream (server -> agent): command:* (see COMMAND_EVENTS)
 *
 * Reconnection is handled by socket.io-client itself (1s -> 30s backoff).
 */
export class Uplink extends EventEmitter {
  private socket: Socket;
  private agentId: string;
  private remoteUrl: string;
  private liveIdes: IdeKind[] | undefined;
  /** Whether this machine is content-source only (Linux). Older servers ignore it. */
  private contentSource: boolean | undefined;

  constructor(
    remoteUrl: string,
    agentToken: string,
    agentId: string,
    liveIdes?: IdeKind[],
    contentSource?: boolean,
  ) {
    super();
    this.agentId = agentId;
    this.liveIdes = liveIdes;
    this.contentSource = contentSource;
    this.remoteUrl = remoteUrl.replace(/\/+$/, '');

    this.socket = io(`${this.remoteUrl}/agent`, {
      path: '/agent-io',
      auth: { agentToken },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      timeout: 60_000,
      // engine.io option; socket.io-client's ManagerOptions omits it.
      maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE,
    } as Parameters<typeof io>[1]);

    this.socket.on('connect', () => {
      console.log(`[uplink] Connected to ${this.remoteUrl} (${this.socket.id})`);
      // The console uses this to send uninstall/upgrade commands for **this
      // machine** — the person on the web may be on a different OS, so the
      // platform must be self-reported by the machine, not guessed from the
      // browser UA. Omit if unrecognized; the web falls back to OS toggles.
      const platform = toAgentPlatform(process.platform);
      this.socket.emit('agent:register', {
        agentId: this.agentId,
        hostname: hostname(),
        // Server stores this so the web can show "which version this box is"; older servers ignore it.
        version: BUILD_VERSION,
        ...(this.liveIdes !== undefined ? { liveIdes: this.liveIdes } : {}),
        ...(platform !== undefined ? { platform } : {}),
        // This machine is content-source only (Linux). The server uses this to
        // file it under "content sources".
        // The criterion is the **platform**, not "app not found in the
        // inventory" — that would misclassify a normal install as a content
        // source (review R1).
        ...(this.contentSource !== undefined ? { contentSource: this.contentSource } : {}),
      });
      this.emit('connected');
    });

    this.socket.on('disconnect', (reason) => {
      console.warn(`[uplink] Disconnected (${reason})`);
      this.emit('disconnected');
    });

    this.socket.on('connect_error', (err) => {
      console.warn(`[uplink] Connection error: ${err.message}`);
    });

    // Forward inbound command:* and session:get so attachCommandHandlers / runtime
    // can subscribe to this object like they do to a browser socket.
    this.socket.onAny((event, ...args) => {
      if (typeof event === 'string' && (event.startsWith('command:') || event === 'session:get')) {
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
      }
    });

    // Server asks for a fresh snapshot after this agent is promoted to active.
    this.socket.on('agent:sync', () => {
      console.log('[uplink] Server requested state sync');
      this.emit('sync');
    });

    this.socket.on('agent:rejected', () => {
      this.emit('rejected');
    });
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
    this.socket.disconnect();
  }
}
