import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdeKind } from '../../protocol/src/index.js';
import type { StatePatchPayload } from './agent-hub.js';
import type { AuthProvider } from './auth/provider.js';
import type { AgentIdesState } from './ide.js';
import type { CommandPayload, ServerConfig } from './types.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { Server as SocketServer } from 'socket.io';
import { COMMAND_EVENTS } from '../../protocol/src/index.js';
import { exchangeBodySchema } from '../../protocol/src/schema.js';
import { AgentHub, normalizeMachineName } from './agent-hub.js';
import { createAuthProvider } from './auth/factory.js';
import { CliSetupCodes, isAllowedRedirectUri } from './cli-setup.js';
import { bootstrapDataDir } from './db/open.js';
import { machineRoom, trySendFile, userRoom } from './http.js';
import { IdentityStore } from './identity-store.js';
import { isPublicPath } from './public-paths.js';
import { readServerVersion, clientDir as resolveClientDir } from './server-version.js';
import {
  SOCKET_MAX_HTTP_BUFFER_SIZE,
  SOCKET_PING_INTERVAL_MS,
  SOCKET_PING_TIMEOUT_MS,
} from './socket-limits.js';
import { timingLog, timingPreview } from './timing-log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SERVER_VERSION = readServerVersion();

const NON_PAGE_PREFIXES = ['/api', '/public', '/agent-io'] as const;

function looksLikePagePath(pathname: string): boolean {
  const last = pathname.split('/').pop() ?? '';
  if (last.includes('.'))
    return false;
  return !NON_PAGE_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`));
}

function requestPath(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** Origin placeholder in install.sh / install.ps1: rewritten at distribute time to the request's own origin. */
const ORIGIN_PLACEHOLDER = '__SERVER_ORIGIN__';
const INSTALLER_FILES = new Set(['install.sh', 'install.ps1']);

function requestProto(headers: FastifyRequest['headers']): string {
  const raw = headers['x-forwarded-proto'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.toLowerCase() === 'https' ? 'https' : 'http';
}

/**
 * Host allowlist: the rewritten origin lands directly in the shell script (`BASE="http://<host>"`
 * — `$( )`/backticks execute inside those double quotes) and the PowerShell script (single quotes
 * can be escaped with `'`) — the Host / X-Forwarded-Host injection surface. Node's header parser
 * rejects CR/LF (newline injection cannot get in) but allows quotes/semicolons/backticks/`$()`, so
 * we only accept hostname-safe characters. No match → no rewrite (the script's own guard exits);
 * never ship suspicious content into the script.
 */
export function isSafeInstallerHost(host: string): boolean {
  return /^[A-Z0-9.\-[\]:]+$/i.test(host) && host.length <= 253;
}

function requestOrigin(headers: FastifyRequest['headers']): string | null {
  const raw = headers.host;
  const host = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  if (!host || !isSafeInstallerHost(host))
    return null;
  return `${requestProto(headers)}://${host}`;
}

/**
 * Whichever domain the user curls to download the install script, the script's default origin should
 * point at that domain — so the repo only holds a placeholder, and the server rewrites it at distribute
 * time with the request's own origin (x-forwarded-proto preferred). Any self-hosted origin's
 * `curl .../public/install.sh | sh` works out of the box;
 * explicit LIFELINE_SERVER in the script always has highest priority. If the placeholder is absent
 * (a local un-rewritten copy run directly), return as-is; the script's own guard will give instructions.
 * Replacement is global: the script's guard comparison string is therefore deliberately split and
 * concatenated (don't "helpfully" glue it back) or the whole literal would be rewritten with it and
 * the guard would false-positive.
 */
function trySendInstaller(
  reply: FastifyReply,
  publicDir: string,
  urlPath: string,
  req: FastifyRequest,
): boolean {
  const rel = urlPath.replace(/^\/+/, '');
  if (!INSTALLER_FILES.has(rel))
    return false;
  const full = join(publicDir, rel);
  if (!existsSync(full))
    return false;
  let content: string;
  try {
    content = readFileSync(full, 'utf-8');
  }
  catch {
    return false;
  }
  if (!content.includes(ORIGIN_PLACEHOLDER))
    return false;
  const origin = requestOrigin(req.headers);
  if (!origin)
    return false; // Host looks suspicious (injection attempt): don't rewrite, send as-is → script guard exits
  reply.header('Content-Type', 'text/plain; charset=utf-8');
  reply.header('Cache-Control', 'no-store');
  reply.send(content.split(ORIGIN_PLACEHOLDER).join(origin));
  return true;
}

export class Relay {
  private config: ServerConfig;
  private app: FastifyInstance;
  private io: SocketServer;
  private agentHub: AgentHub;
  private agentIo: SocketServer;
  private identity: IdentityStore;
  private auth: AuthProvider;
  private cliSetupCodes = new CliSetupCodes();
  private stopped = false;

  private getFullState(agentId?: string, userId?: string): import('./types.js').CursorState | null {
    const visible = this.agentHub.listMachines(userId);
    const id = agentId ?? visible[0]?.agentId;
    if (!id || !visible.some(m => m.agentId === id))
      return null;
    if (!this.agentHub.getState(id))
      return null;
    return this.agentHub.getCursorState(id);
  }

  constructor(config: ServerConfig) {
    this.config = config;
    // Test fixtures may omit authProvider (derived from the other fields); if loadConfig already assembled one, use it.
    this.auth = config.authProvider ?? createAuthProvider(config);

    this.app = Fastify({ logger: false });
    this.app.decorateRequest('userId', '');
    this.io = new SocketServer(this.app.server, {
      serveClient: false,
      maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE,
      cors: {
        origin: true,
        methods: ['GET', 'POST'],
        credentials: true,
      },
    });
    this.agentIo = new SocketServer(this.app.server, {
      path: '/agent-io',
      serveClient: false,
      maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE,
      pingInterval: SOCKET_PING_INTERVAL_MS,
      pingTimeout: SOCKET_PING_TIMEOUT_MS,
      cors: {
        origin: true,
        methods: ['GET', 'POST'],
        credentials: true,
      },
    });

    const dbPath = bootstrapDataDir(this.config.dataDir);
    this.identity = new IdentityStore(dbPath);
    this.agentHub = new AgentHub(this.agentIo, this.config.dataDir, {
      identity: this.identity,
      sessionDbPath: dbPath,
    });
    console.log('[relay] waiting for agent uplink on /agent-io');

    this.setupRoutes();
    this.setupSocketHandlers();
    this.setupStateForwarding();
  }

  start(): Promise<void> {
    return this.app.listen({
      port: this.config.serverPort,
      host: this.config.serverHost,
    }).then(() => {
      console.log(
        `[relay] Server listening on http://${this.config.serverHost}:${this.config.serverPort}`,
      );
    });
  }

  async stop(): Promise<void> {
    if (this.stopped)
      return;
    this.stopped = true;
    this.io.disconnectSockets(true);
    this.agentIo.disconnectSockets(true);
    this.io.engine.close();
    this.agentIo.engine.close();
    this.agentHub.close();
    try {
      this.identity.close();
    }
    catch (err) {
      console.warn(`[relay] identity store close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      this.auth.close?.();
    }
    catch {
      /* best effort */
    }
    const httpServer = this.app.server;
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.warn('[relay] HTTP close timed out');
        resolve();
      }, 4000);
      void this.app.close().then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        },
      );
    });
  }

  private async gateHttp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const path = requestPath(req.url);
    if (isPublicPath(path) || this.auth.isPublicPath?.(path))
      return;
    const id = await this.auth.verify(req.headers);
    if (!id) {
      // Provider-custom deny shape (password: page GET → 302 /login); return true = already replied
      if (this.auth.onHttpDenied?.(req, reply))
        return;
      if (path === '/' || path === '/api/health' || path === '/cli-setup') {
        console.warn(`[relay] auth deny path=${path} host=${req.headers.host ?? ''}`);
      }
      return reply
        .code(403)
        .header('Cache-Control', 'no-store')
        .type('text/html')
        .send(this.auth.forbiddenHtml);
    }
    req.userId = id.userId;
    this.identity.touchUser(id.userId);
  }

  private setupRoutes(): void {
    const clientDir = resolveClientDir(__dirname);
    const publicDir = join(clientDir, 'public');

    this.app.addHook('onRequest', async (req, reply) => {
      await this.gateHttp(req, reply);
    });

    this.app.get('/healthz', async () => ({ ok: true }));

    this.app.get('/cli-setup', async (req, reply) => {
      const q = req.query as { redirect_uri?: string };
      const redirectUri = typeof q.redirect_uri === 'string' ? q.redirect_uri : '';
      if (!isAllowedRedirectUri(redirectUri)) {
        return reply.code(400).type('text/plain').send('Invalid redirect_uri');
      }
      const code = this.cliSetupCodes.issue(req.userId ?? '');
      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      return reply.redirect(target.toString());
    });

    this.app.post('/public/cli-setup/exchange', async (req, reply) => {
      const parsed = exchangeBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid or expired code' });
      }
      const owner = this.cliSetupCodes.exchange(parsed.data.code);
      if (owner === null) {
        return reply.code(400).send({ error: 'Invalid or expired code' });
      }
      if (!owner) {
        return reply.code(400).send({ error: 'Invalid or expired code' });
      }
      const agentToken = this.identity.mintMachineToken(owner, parsed.data.agentId);
      return { agentToken };
    });

    this.app.get('/api/health', async (req) => {
      const userId = this.viewerUserId(req.userId);
      const state = this.getFullState(undefined, userId);
      return {
        ok: true,
        serverMode: 'server',
        agentConnected: this.agentHub.hasAgent(userId),
        machines: this.agentHub.listMachines(userId),
        connected: state?.connected ?? false,
        extractorStatus: state?.extractorStatus ?? 'idle',
        lastExtractionAt: state?.lastExtractionAt ?? null,
        consecutiveExtractionFailures: state?.consecutiveExtractionFailures ?? 0,
        lastExtractionError: state?.lastExtractionError ?? null,
        agentStatus: state?.agentStatus ?? 'idle',
        clients: this.io.engine.clientsCount,
        uptime: process.uptime(),
        windows: state?.windows ?? [],
        activeWindowId: state?.activeWindowId ?? '',
        mode: state?.mode?.current ?? null,
        model: state?.model?.current ?? null,
        chatTabCount: state?.chatTabs?.length ?? 0,
        pendingApprovalCount: state?.pendingApprovals?.length ?? 0,
      };
    });

    this.app.get('/api/debug/state', async (req) => {
      const q = req.query as { agentId?: string };
      const agentId = typeof q.agentId === 'string' ? q.agentId : undefined;
      const state = this.getFullState(agentId, this.viewerUserId(req.userId));
      if (!state) {
        return { error: 'no state yet - agent not connected' };
      }
      return {
        activeWindowId: state.activeWindowId,
        agentStatus: state.agentStatus,
        agentActivityText: state.agentActivityText,
        agentActivityLive: state.agentActivityLive,
        pendingApprovals: state.pendingApprovals,
        chatTabs: state.chatTabs.map(t => ({
          isActive: t.isActive,
          title: t.title,
          composerId: t.composerId.substring(0, 16),
        })),
        windows: state.windows.map(w => ({ id: w.id.substring(0, 8), title: w.title })),
        messageCount: state.messages.length,
        lastMessages: state.messages.slice(-3).map(m => ({
          type: m.type,
          flatIndex: m.flatIndex,
          ...(m.type === 'tool' || m.type === 'run_command'
            ? { actions: 'actions' in m ? m.actions?.length ?? 0 : 0 }
            : {}),
        })),
      };
    });

    const cacheBust = Date.now().toString(36);
    const serveIndex = (reply: FastifyReply): FastifyReply => {
      const htmlPath = join(clientDir, 'index.html');
      try {
        let html = readFileSync(htmlPath, 'utf-8');
        html = html.replace(/(src|href)="([^"]+)\.(js|css)"/g, `$1="$2.$3?v=${cacheBust}"`);
        return reply.header('Cache-Control', 'no-store').type('text/html').send(html);
      }
      catch (err) {
        console.error(`[relay] Failed to serve index.html: ${err}`);
        return reply.code(500).send('Client files not found');
      }
    };

    this.app.get('/', async (_req, reply) => serveIndex(reply));

    this.app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return reply.code(404).send({ error: 'Not found' });
      }
      const path = requestPath(req.url);
      if (path.startsWith('/public/')) {
        const rel = path.slice('/public'.length);
        if (trySendInstaller(reply, publicDir, rel, req))
          return;
        if (trySendFile(reply, publicDir, rel))
          return;
        return reply.code(404).send('Not found');
      }
      if (trySendFile(reply, clientDir, path))
        return;
      if (looksLikePagePath(path))
        return serveIndex(reply);
      return reply.code(404).send('Not found');
    });

    // Provider's own login routes (password: /claim /login /api/*). Mounted here, still after the
    // onRequest gate — exemption relies on provider.isPublicPath (exact paths).
    this.auth.setupRoutes?.(this.app);
  }

  private setupSocketHandlers(): void {
    this.io.use((socket, next) => {
      void this.auth
        .verify(socket.handshake.headers)
        .then((id) => {
          if (!id) {
            next(new Error('Unauthorized'));
            return;
          }
          // Extra handshake check (password / none: Origin against cross-site hijacking); null = pass
          const denied = this.auth.checkHandshake?.(socket.handshake.headers) ?? null;
          if (denied) {
            next(new Error(denied));
            return;
          }
          socket.data.userId = id.userId;
          this.identity.touchUser(id.userId);
          next();
        })
        // Provider verify contract is "does not throw"; if it does throw (e.g. sqlite won't open) we still
        // must not hang the handshake + unhandledRejection — pass the error to next so the connection fails immediately.
        .catch((err: unknown) => {
          next(err instanceof Error ? err : new Error(String(err)));
        });
    });

    this.io.on('connection', (socket) => {
      console.log(`[relay] Client connected: ${socket.id}`);
      const userId = typeof socket.data.userId === 'string' ? socket.data.userId : '';
      void socket.join(userRoom(userId));
      socket.emit('user:info', {
        userId,
        avatar: this.auth.avatarUrlFor(userId),
        authKind: this.auth.kind,
      });

      const viewer = this.viewerUserId(socket.data.userId);
      socket.emit('machines:list', this.machinesPayload(viewer));
      socket.emit('agent:uplink', { connected: this.agentHub.hasAgent(viewer) });

      socket.on('machine:select', (payload: { agentId?: string }) => {
        const agentId = payload?.agentId;
        if (typeof agentId !== 'string')
          return;
        const known = this.agentHub.listMachines(viewer).some(m => m.agentId === agentId);
        if (!known)
          return;
        const prev = typeof socket.data.machineRoom === 'string' ? socket.data.machineRoom : '';
        if (prev)
          void socket.leave(prev);
        const room = machineRoom(agentId);
        void socket.join(room);
        socket.data.machineRoom = room;
        socket.data.agentId = agentId;
        socket.emit('state:full', this.agentHub.getStateOrEmpty(agentId));
        const sessions = this.agentHub.readSessionIndex(agentId);
        if (sessions.length > 0) {
          socket.emit('sessions:index', { sessions });
        }
      });

      socket.on('machine:forget', (payload: { agentId?: string }, ack?: (r: { ok: boolean }) => void) => {
        const reply = (ok: boolean) => {
          if (typeof ack === 'function')
            ack({ ok });
        };
        const agentId = payload?.agentId;
        if (typeof agentId !== 'string' || agentId.length === 0) {
          reply(false);
          return;
        }
        if (!this.agentHub.listMachines(viewer).some(m => m.agentId === agentId)) {
          reply(false);
          return;
        }
        const ok = this.agentHub.forget(agentId);
        if (ok) {
          this.io.in(machineRoom(agentId)).socketsLeave(machineRoom(agentId));
        }
        reply(ok);
      });

      // Rename (machine-row ⋯ menu): changes **how the page names it**, does not touch agentId / hostname / ownership.
      // Ownership filter is the same as machine:forget: a rename for a machine not on the list is not accepted.
      socket.on(
        'machine:rename',
        (
          payload: { agentId?: string; displayName?: unknown },
          ack?: (r: { ok: boolean }) => void,
        ) => {
          const reply = (ok: boolean) => {
            if (typeof ack === 'function')
              ack({ ok });
          };
          const agentId = payload?.agentId;
          if (typeof agentId !== 'string' || agentId.length === 0) {
            reply(false);
            return;
          }
          const rawName = payload?.displayName;
          // Only string (set) or null (clear alias) are legal; numbers/objects are illegal — don't silently clear the name.
          if (rawName !== null && typeof rawName !== 'string') {
            reply(false);
            return;
          }
          if (!this.agentHub.listMachines(viewer).some(m => m.agentId === agentId)) {
            reply(false);
            return;
          }
          reply(this.agentHub.setDisplayName(agentId, normalizeMachineName(rawName ?? '')));
        },
      );

      for (const event of COMMAND_EVENTS) {
        socket.on(event, (payload: CommandPayload) => {
          timingLog('relay:command', {
            event,
            agentId: socket.data.agentId,
            commandId: payload.commandId,
            ide: payload.ide,
            chars: payload.text?.length,
            preview: payload.text ? timingPreview(payload.text) : undefined,
          });
          this.agentHub.sendCommand(socket.data.agentId ?? '', event, payload, socket);
        });
      }

      socket.on(
        'session:get',
        (
          payload: {
            sessionId?: string;
            tabTitle?: string;
            ide?: IdeKind;
            sinceSeq?: number;
            before?: number;
            limit?: number;
          },
        ) => {
          this.agentHub.handleSessionGet(socket.data.agentId ?? '', payload ?? {}, socket);
        },
      );

      socket.on('disconnect', (reason) => {
        console.log(`[relay] Client disconnected: ${socket.id} (${reason})`);
      });
    });
  }

  private emitToAgentViewers(agentId: string, event: string, payload: unknown): void {
    this.io.to(machineRoom(agentId)).emit(event, payload);
  }

  private machinesPayload(
    userId?: string,
  ): { machines: ReturnType<AgentHub['listMachines']>; cliLatest: string } {
    return { machines: this.agentHub.listMachines(userId) ?? [], cliLatest: SERVER_VERSION };
  }

  private broadcastMachines(): void {
    for (const name of this.io.sockets.adapter.rooms.keys()) {
      if (!name.startsWith('user:'))
        continue;
      const userId = name.slice('user:'.length);
      this.io.to(name).emit('machines:list', this.machinesPayload(userId));
      this.io.to(name).emit('agent:uplink', { connected: this.agentHub.hasAgent(userId) });
    }
  }

  private viewerUserId(raw: unknown): string {
    return typeof raw === 'string' && raw ? raw : '';
  }

  private setupStateForwarding(): void {
    this.agentHub.on('machines:changed', () => this.broadcastMachines());
    this.agentHub.on('state:patch', (agentId: string, patch: StatePatchPayload) => {
      this.emitToAgentViewers(agentId, 'state:patch', patch);
    });
    this.agentHub.on('state:full', (agentId: string, state: AgentIdesState) => {
      this.emitToAgentViewers(agentId, 'state:full', state);
    });
    this.agentHub.on('connection:changed', (agentId: string, connected: boolean) => {
      this.emitToAgentViewers(agentId, 'connection:status', { connected });
    });
    this.agentHub.on('sessions:index', (agentId: string, payload: unknown) => {
      this.emitToAgentViewers(agentId, 'sessions:index', payload);
    });
    this.agentHub.on('session:full', (agentId: string, payload: unknown) => {
      this.emitToAgentViewers(agentId, 'session:full', payload);
    });
    this.agentHub.on('session:append', (agentId: string, payload: unknown) => {
      this.emitToAgentViewers(agentId, 'session:append', payload);
    });
    this.agentHub.on('session:patch', (agentId: string, payload: unknown) => {
      this.emitToAgentViewers(agentId, 'session:patch', payload);
    });
    this.agentHub.on('session:sync', (agentId: string, payload: unknown) => {
      this.emitToAgentViewers(agentId, 'session:sync', payload);
    });
    this.agentHub.on('session:unavailable', (agentId: string, payload: unknown) => {
      this.emitToAgentViewers(agentId, 'session:unavailable', payload);
    });
  }
}

declare module 'socket.io' {
  interface SocketData {
    userId?: string;
    agentId?: string;
    machineRoom?: string;
    agentOwner?: string;
    tokenAgentId?: string;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}
