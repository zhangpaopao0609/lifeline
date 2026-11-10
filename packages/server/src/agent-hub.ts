import type { Namespace, Socket, Server as SocketServer } from 'socket.io';
import type {
  AgentPlatform,
  AgentRegisterPayload,
  CliAcpCapability,
  CliAvailability,
  CliSource,
  DuplicateAgent,
  IdeHost,
  PatchSeqBaseline,
  SessionBodyPayload,
  SessionGetPayload,
  SessionMeta,
  SessionMissingPayload,
  SessionPatchPayload,
  SessionSyncPayload,
} from '../../protocol/src/index.js';
import type { AgentIdesState, IdeKind } from './ide.js';
import type { ChatElement, ChatTab, CommandPayload, CommandResult, CursorState } from './types.js';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import {
  agentRegisterSchema,
  CLI_COMMAND_EVENTS,
  cliAppendSchema,
  cliApprovalEventSchema,
  cliApprovalResolvedSchema,
  cliFullSchema,
  cliSessionCreatedSchema,
  cliSessionRemovedSchema,
  cliSnapshotSchema,
  cliStatusSchema,
  COMMAND_ERROR_CODES,
  commandPayloadSchema,
  isCliPlatform,
  isCliSource,
  isIdeKind,
  MACHINE_NAME_MAX_LENGTH,
  SYNC_REASON_PATCH_GAP,
  toAgentPlatform,
  validateInbound,
} from '../../protocol/src/index.js';
import {

  applyIdePatch,
  emptyIdesState,
  IDE_KINDS,

  parseIde,
  wrapIncomingFull,
} from './ide.js';
import { IdentityStore } from './identity-store.js';
import { emptyCursorState } from './pages/empty-state.js';
import { tailPage } from './pages/session-page.js';
import { decideRegister } from './register-outcome.js';
import { SessionStore } from './session-store.js';
import { timingLastBubble, timingLog, timingPreview } from './timing-log.js';

export type { SessionBodyPayload, SessionMissingPayload, SessionPatchPayload, SessionSyncPayload };

export interface SessionsIndexPayload {
  sessions: SessionMeta[];
  reportedIdes?: IdeKind[];
  /**
   * 'delta': sessions are only adds/updates; removed lists IDs that disappeared (census reports take this path, tens of bytes).
   * Default: sessions is the full session list for this machine (old full semantics; anything not in the list is deleted).
   */
  mode?: 'full' | 'delta';
  removed?: Array<{ ide: IdeKind; sessionId: string }>;
}

export interface StatePatchPayload {
  ide: IdeKind;
  patch: Partial<CursorState>;
}

export interface MachineIdeStatus {
  connected: boolean;
  pendingApprovals: number;
  /** Standalone IDE vs the VSCode plugin host; absent = unknown (old agent, never connected). */
  host?: IdeHost;
}

export interface MachineInfo {
  agentId: string;
  hostname: string;
  /** Console alias ("Rename"); empty = show hostname. Display always uses `displayName ?? hostname` */
  displayName?: string;
  connected: boolean;
  lastSeenAt: number;
  /** Per-IDE one-line summary: the rail machine tree is fully expanded by default, so child-row status dots/badges can only come from the list itself */
  ides?: Partial<Record<IdeKind, MachineIdeStatus>>;
  /** Which IDEs this machine has reported a census for = it is a content source for those IDEs (remote dev machine) */
  contentIdes?: IdeKind[];
  /** No IDE has live state, but it provides content → the page folds it into the "content source" group, not a machine slot */
  contentOnly?: boolean;
  /** Version this machine's agent (CLI) self-reported; old agents omit it → the page shows "unknown", no new/old comparison */
  cliVersion?: string;
  /**
   * OS the machine self-reports. The page uses it to emit uninstall/upgrade commands for **this machine** —
   * the person looking at the page may be on a different OS. Default (old agent) = the page falls back to its own OS toggle.
   */
  platform?: AgentPlatform;
  /**
   * Coarse CLI availability. `unknown` is not `ready`. No credential, detail, or provider key.
   * Absent when the agent did not declare static `cliAcp`.
   */
  cliSources?: Array<{ source: CliSource; availability: CliAvailability }>;
  /** Machine ownership (userId of whoever enrolled); normally always present — an agent whose ownership cannot be resolved cannot connect (see resolveOwner) */
  owner?: string;
  /**
   * The displaced process when this slot was taken over: the code whose reports are being dropped.
   * In-memory only (a server restart clears it, like the rest of the live picture) — see
   * `MachineInfo.duplicateAgent` in the protocol.
   */
  duplicateAgent?: DuplicateAgent;
}

export interface AgentSocket {
  id: string;
  connected: boolean;
  emit: (event: string, ...args: unknown[]) => void;
}

interface AgentConn {
  agentId: string;
  hostname: string;
  /** Alias, persisted to `machines.display_name`; **not** cleared when the agent reconnects and self-reports hostname. */
  displayName?: string;
  socket: AgentSocket | null;
  latestState: AgentIdesState;
  lastSeenAt: number;
  /** Which IDEs this machine has reported a census for (content source). In-memory: re-reported after the agent reconnects. */
  contentIdes: Set<IdeKind>;
  /** CLI version the agent self-reported at register (persisted to machines; offline machines keep the last one). */
  cliVersion?: string;
  /**
   * OS the machine self-reports (persisted to machines). **A machine property, not a process property**:
   * if an old agent omits this field, keep the previous value; don't clear it (unlike cliVersion's
   * "downgrade means drop" — that is a statement about the current binary).
   */
  platform?: AgentPlatform;
  /** Machine ownership: userId resolved from the handshake token (persisted to machines; offline machines keep it). */
  owner?: string;
  /**
   * Manual rail position (drag sorting; persisted to `machines.sort_order`). undefined = never
   * reordered → registration order, appended at the end.
   */
  sortOrder?: number;
  /**
   * GUI-capable IDEs this agent detected. Undefined = old agent (fall back to
   * `!hasLive`). Not persisted — reconnect restores it.
   */
  liveIdes?: IdeKind[];
  /**
   * Routing capability declared at register: the slots this process can actually
   * serve (started disk adapters ∪ created CDP slots). `undefined` = old agent →
   * the pre-split set. Commands and `session:get` are gated on this, so a slot the
   * agent cannot answer is never asked about.
   */
  slots?: IdeKind[];
  /**
   * This machine is **content-source only** (Linux: the agent does not connect CDP, does not take over input).
   * `undefined` = old agent. The "content source" group only honors this — don't use "app not on the list"
   * as the criterion (review R1).
   */
  contentSource?: boolean;
  /**
   * Process identity from `agent:register` (`undefined` = an agent older than this field, which
   * therefore cannot displace a connected process that names itself).
   */
  instanceId?: string;
  /**
   * The displaced process when this slot was taken over: the code whose reports are being dropped.
   * In-memory only; cleared by its own socket's disconnect, `forget()`, the next takeover, or a
   * promotion that hands the row to **that same recorded socket**.
   */
  duplicateAgent?: DuplicateAgent;
  /**
   * Non-active sockets that are still connected, kept so one can be promoted when the active socket
   * goes away — an old process never re-registers on its own, so the machine would otherwise report
   * offline while a live agent is attached. Two kinds land here: a newcomer whose registration was
   * ignored (an old process trying to take a slot a current agent holds) and a displaced socket that
   * is still connected.
   */
  ignoredSockets?: Set<AgentSocket>;
  /**
   * `state:patch` sequence tracking (in-memory only). Seeded by the baseline on `state:full`; `undefined`
   * = no baseline yet (old agent, or no full since this socket registered).
   */
  patchTrack?: PatchTrack;
  /** Last time this server asked the agent to re-sync because of a patch gap (cooldown anchor). */
  lastGapSyncAt?: number;
  /**
   * Static CLI capability from `agent:register`. Cleared when a register omits it
   * (an old agent took the slot). Not persisted.
   */
  cliAcp?: CliAcpCapability;
  /** Latest dynamic availability. Not a gate, and not persisted. */
  cliReported?: Map<CliSource, CliAvailability>;
}

interface PatchTrack {
  epoch: string;
  last: Partial<Record<IdeKind, number>>;
  /** A gap was seen and no full state has arrived since — keep asking (rate-limited) on later patches. */
  desynced: boolean;
}

/**
 * Minimum spacing between gap-triggered `agent:sync` requests per machine. A full state answers within
 * milliseconds; this only stops a misbehaving agent from making the server ask on every ~1Hz patch.
 */
const PATCH_GAP_SYNC_COOLDOWN_MS = 10 * 1000;

/**
 * Controller fill. The design says repeated CLI syncs merge and cool down, and does not
 * give a duration. Default is 1000ms; tests inject a shorter window.
 */
export const CLI_SYNC_COOLDOWN_MS = 1000;

/**
 * Controller fill. A dropped inbound CLI/register record is at most this many characters.
 * The whole packet is not written to the log.
 */
export const CLI_INBOUND_LOG_MAX_CHARS = 200;

/** How long a browser command waits for `command:result` before the pending entry is dropped. */
const COMMAND_PENDING_TTL_MS = 30 * 60 * 1000;

const CLI_AVAILABILITY = new Set<CliAvailability>([
  'unknown',
  'ready',
  'binary-missing',
  'credential-required',
  'error',
]);

export const CLI_AGENT_EVENTS = [
  'cli:session-created',
  'cli:snapshot',
  'cli:full',
  'cli:append',
  'cli:status',
  'cli:approval',
  'cli:approval-resolved',
  'cli:session-removed',
  'cli:capabilities',
] as const;

/** Requester-registration TTL; once it expires without another look, content is no longer forwarded. */
const SESSION_WATCH_TTL_MS = 30 * 60 * 1000;

/**
 * Cooldown for a source refresh after a DB hit: the same session is only re-projected once a minute.
 * Full-session projection for a long session is not cheap; repeated opens must not become the normal path.
 */
const SESSION_REFRESH_COOLDOWN_MS = 60 * 1000;

/**
 * TTL of the "this machine does not have this session" cache: within the TTL, a frontend re-ask
 * returns unavailable directly and does not poke in vain. Expires naturally — if the session
 * reappears (a message is persisted) applySessionFull / applySessionsIndex revoke it early; both paths cover it.
 */
const SESSION_MISSING_TTL_MS = 5 * 60 * 1000;

export class AgentDirectory extends EventEmitter {
  private store: IdentityStore;
  private persistDebounceMs: number;
  private now: () => number;
  private agents = new Map<string, AgentConn>();
  private socketToAgent = new Map<string, string>();
  private pending = new Map<string, {
    replyTo: AgentSocket;
    agentId: string;
    commandId: string;
    expiresAt: number;
  }>();

  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private patchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sessionStore: SessionStore | null;
  private cliSyncCooldownMs: number;
  private pendingTtlMs: number;
  /** agentId → browsers whose machine-room join has committed. */
  private cliViewers = new Map<string, Set<AgentSocket>>();
  /** socket id → machine it is currently allowed to receive CLI events for. */
  private viewerMachine = new Map<string, string>();
  private cliSync = new Map<string, { inFlight: boolean; sentAt: number; queued: boolean }>();
  private cliSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Cross-machine content: (ide\0sessionId) → requester machine → expiry.
   * Session body/deltas are pushed by the "content machine", but browsing is the "requester machine"'s
   * viewers; this table forwards full/append over. Registering is requesting; expiry is natural.
   */
  private readonly sessionWatchers = new Map<string, Map<string, number>>();
  /** Last "source refresh after a DB hit" time: (ide\0sessionId) → timestamp. */
  private readonly refreshedAt = new Map<string, number>();
  /** "This machine does not have this session" cache: (agentId\0ide\0sessionId) → report time. */
  private readonly missingSessionsAt = new Map<string, number>();
  /** After dispose() do not persist: the SQLite connection is already closed; another write would throw. */
  private disposed = false;

  constructor(
    store: IdentityStore,
    options?: {
      persistDebounceMs?: number;
      now?: () => number;
      sessionStore?: SessionStore;
      cliSyncCooldownMs?: number;
      pendingTtlMs?: number;
    },
  ) {
    super();
    this.store = store;
    this.persistDebounceMs = options?.persistDebounceMs ?? 1500;
    this.now = options?.now ?? Date.now;
    this.sessionStore = options?.sessionStore ?? null;
    this.cliSyncCooldownMs = options?.cliSyncCooldownMs ?? CLI_SYNC_COOLDOWN_MS;
    this.pendingTtlMs = options?.pendingTtlMs ?? COMMAND_PENDING_TTL_MS;
    for (const row of store.loadMachines()) {
      const conn: AgentConn = {
        agentId: row.agentId,
        hostname: row.hostname,
        displayName: row.displayName,
        socket: null,
        latestState: row.snapshot
          ? stripIdesState(wrapIncomingFull(row.snapshot))
          : emptyIdesState(),
        lastSeenAt: row.lastSeenAt,
        contentIdes: new Set(),
        cliVersion: row.cliVersion,
        platform: row.platform,
        owner: row.owner,
        sortOrder: row.sortOrder,
      };
      this.restoreContentIdes(conn);
      this.agents.set(row.agentId, conn);
    }
  }

  /**
   * `contentIdes` lives only in memory and is gone when the server restarts; census is re-sent only
   * when the structure fingerprint changes, so "content source" would wait until that machine's next
   * session change — the list can sit empty for hours (observed 2026-09-16).
   * The ledger (SQLite) is still there; restore the flags from it on restart/reconnect.
   */
  private restoreContentIdes(conn: AgentConn): void {
    if (conn.contentIdes.size > 0 || !this.sessionStore)
      return;
    try {
      for (const meta of this.sessionStore.readIndex(conn.agentId)) {
        conn.contentIdes.add(parseIde(meta.ref?.ide));
      }
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[agent-hub] restoreContentIdes failed: ${message}`);
    }
  }

  /**
   * `userId` omitted = no isolation (local mode / internal callers such as probes); if passed, "only this person's machines".
   * Unowned rows (should not normally appear: machines only come from enroll) are shown to nobody —
   * better invisible than leaked to someone unrelated.
   */
  listMachines(userId?: string): MachineInfo[] {
    const conns = [...this.agents.values()].filter(conn => canSee(conn.owner, userId));
    // Manual rail order (drag sorting): rows with an explicit position first (ascending; ties keep
    // registration order — Array#sort is stable), never-reordered rows keep registration order at the end.
    const ordered = conns
      .filter(conn => conn.sortOrder != null)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const unordered = conns.filter(conn => conn.sortOrder == null);
    return [...ordered, ...unordered].map((conn) => {
      const ides = ideStatusOf(conn.latestState);
      const contentIdes = [...conn.contentIdes];
      return {
        agentId: conn.agentId,
        hostname: conn.hostname,
        ...(conn.displayName ? { displayName: conn.displayName } : {}),
        connected: !!conn.socket?.connected,
        lastSeenAt: conn.lastSeenAt,
        ides,
        ...(contentIdes.length > 0 ? { contentIdes, contentOnly: isContentOnlyConn(conn) } : {}),
        ...(conn.cliVersion ? { cliVersion: conn.cliVersion } : {}),
        ...(conn.platform ? { platform: conn.platform } : {}),
        ...cliSourcesField(conn),
        ...(conn.owner ? { owner: conn.owner } : {}),
        ...(conn.duplicateAgent ? { duplicateAgent: conn.duplicateAgent } : {}),
      };
    });
  }

  hasAgent(userId?: string): boolean {
    for (const conn of this.agents.values()) {
      if (canSee(conn.owner, userId) && conn.socket?.connected)
        return true;
    }
    return false;
  }

  /**
   * Connected agent sockets across all owners. Deploy health check only — a
   * bare count, no ids/owners, deliberately safe for the public /healthz.
   */
  connectedAgentCount(): number {
    let n = 0;
    for (const conn of this.agents.values()) {
      if (conn.socket?.connected)
        n += 1;
    }
    return n;
  }

  /**
   * Broadcast the list only when a per-IDE summary changed. state:patch is ~1Hz; we cannot refresh
   * machines:list on every one. But rail IDE child-rows are fully expanded by default, so their
   * dots/badges must keep up (IDE on/off, approvals coming and going).
   */
  private emitIfIdeStatusChanged(conn: AgentConn, before: string): void {
    if (ideStatusSignature(conn.latestState) !== before)
      this.emit('machines:changed');
  }

  getState(agentId: string): AgentIdesState | null {
    return this.agents.get(agentId)?.latestState ?? null;
  }

  getStateOrEmpty(agentId: string): AgentIdesState {
    const conn = this.agents.get(agentId);
    if (!conn)
      return emptyIdesState();
    return this.outwardState(conn);
  }

  /** No live state, only provides content (remote dev machine). Same formula as listMachines. */
  private isContentOnlyMachine(conn: AgentConn): boolean {
    return isContentOnlyConn(conn);
  }

  /**
   * A content-only machine has no IDE DOM/live state; its session list can only come from the ledger
   * it reported. Project that ledger into "read-only tabs": composerId is the real sessionId, so
   * opening still goes `session:get` → the body is pushed from this machine, and the page uses the
   * same list/body view — no separate render path for content sources. Machines with live state are returned as-is.
   */
  private outwardState(conn: AgentConn): AgentIdesState {
    if (!this.isContentOnlyMachine(conn))
      return conn.latestState;
    const sessions = this.readSessionIndex(conn.agentId);
    if (sessions.length === 0)
      return conn.latestState;
    const ides: AgentIdesState['ides'] = { ...conn.latestState.ides };
    for (const ide of conn.contentIdes) {
      const mine = sessions
        .filter(s => s.ref.ide === ide && !s.isSubagent)
        .sort((a, b) => (b.lastUpdatedAt ?? 0) - (a.lastUpdatedAt ?? 0));
      if (mine.length === 0)
        continue;
      const windowId = `content:${ide}`;
      const tabs: ChatTab[] = mine.map((s, i) => ({
        composerId: s.ref.sessionId,
        title: s.title || s.ref.sessionId,
        isActive: i === 0,
        status: 'content',
        selectorPath: '',
        windowId,
        composerIdSource: 'db',
      }));
      const live = conn.latestState.ides[ide];
      ides[ide] = {
        ...emptyCursorState(),
        // Read-only: inputAvailable=false and no approval/Live actions; the page only uses this to read the body.
        chatTabs: tabs,
        activeComposerId: tabs[0]?.composerId ?? '',
        windows: [{ id: windowId, title: '会话源·只读', url: '', chatTabs: tabs }],
        activeWindowId: windowId,
        cdpIssue: live?.cdpIssue ?? null,
        liveIssue: live?.liveIssue ?? null,
      };
    }
    return { ides };
  }

  getCursorState(agentId: string): CursorState {
    return this.getState(agentId)?.ides.cursor ?? emptyCursorState();
  }

  /**
   * Register / take over a machine. Returns the final agentId; **null = reject**: this id already has
   * an owner, and it is not the same person. Accepting would rename someone else's machine onto this
   * account, and is the only entry point for cross-person snapshot/session reads.
   */
  register(
    socket: AgentSocket,
    info: AgentRegisterPayload,
  ): string | null {
    const agentId = info.agentId || socket.id;
    const hostname = info.hostname || agentId;
    const owner = typeof info.owner === 'string' && info.owner ? info.owner : undefined;

    let existing = this.agents.get(agentId);
    // Ownership gate: id exists and ownership differs → reject (don't change ownership, don't replace, don't deliver any data).
    if (existing && existing.owner !== owner)
      return null;
    // Same machine changed agentId (old agent-<hostname> retired → new random id; see cli/config.ts):
    // re-sign the offline, same-name, same-owner old row onto the new id; snapshot and session mirror follow; the list always has one row.
    if (!existing)
      existing = this.adoptStaleSibling(agentId, hostname, owner);

    // Trimmed on both sides of the wire: the agent decides "can I name myself?" the same way
    // (superseded-outcome.ts). A blank id read as an identity here would let the server hand the slot
    // to a process the agent side then refuses to stand down for — the ping-pong this change removes.
    const rawInstanceId = typeof info.instanceId === 'string' ? info.instanceId.trim() : '';
    const incomingInstanceId = rawInstanceId === '' ? undefined : rawInstanceId;
    // Resolved up front: the takeover event describes the winner, and it is emitted before `conn` is
    // overwritten (design order: warn → tell the loser → record).
    const incomingVersion = typeof info.version === 'string' && info.version ? info.version : undefined;
    const outcome = decideRegister({
      hasRecordedConnection: existing?.socket != null,
      sameSocket: existing?.socket === socket,
      recordedSocketConnected: existing?.socket?.connected === true,
      incomingInstanceId,
      recordedInstanceId: existing?.instanceId,
    });

    // An old process (no `instanceId`) trying to take a slot a current agent still holds: leave the
    // active socket alone — the incumbent never learns about it, so it cannot be made to exit — and
    // remember the newcomer so it can be promoted if the incumbent goes away.
    if (outcome === 'ignore-duplicate' && existing?.socket) {
      const ignored = existing.ignoredSockets ?? new Set<AgentSocket>();
      ignored.add(socket);
      existing.ignoredSockets = ignored;
      console.warn(
        `[agent-hub] ignored duplicate registration agentId=${agentId} socket=${socket.id}`
        + ` version=${info.version ?? 'unknown'} — ${existing.socket.id}`
        + ` (v${existing.cliVersion ?? 'unknown'}, instance ${existing.instanceId ?? 'none'}) holds the slot`
        + `; at=${new Date(this.now()).toISOString()}`,
      );
      return agentId;
    }

    const replacedSocket = existing?.socket && existing.socket !== socket ? existing.socket : null;
    // The displaced process, captured **before** `conn` is overwritten below. A `reconnect` is the
    // same process coming back: it replaces the socket but displaces nobody.
    //
    // `takeover-after-drop` is defensive: socket.io flips `connected` to false *before* emitting
    // 'disconnect', and the disconnect handler nulls `conn.socket` — all in one synchronous tick, so
    // this row is reached only through the "same socket re-registered under another agentId" path, in
    // which that socket's disconnect has already run. The record it writes is then cleared by the next
    // takeover or by `forget()`, not by a disconnect.
    const displaced = (outcome === 'takeover' || outcome === 'takeover-after-drop') && replacedSocket
      ? { socket: replacedSocket, version: existing!.cliVersion, instanceId: existing!.instanceId }
      : null;

    if (displaced && existing) {
      const at = this.now();
      console.warn(
        `[agent-hub] agent takeover agentId=${agentId} host=${hostname}`
        + ` socket ${displaced.socket.id} → ${socket.id};`
        + ` version ${displaced.version ?? 'unknown'} → ${incomingVersion ?? 'unknown'};`
        + ` instance ${displaced.instanceId ?? 'none'} → ${incomingInstanceId ?? 'none'};`
        + ` at=${new Date(at).toISOString()}`,
      );
      // Order per spec: warn → tell the loser → record. Telling it is not disconnecting it: a
      // server-side disconnect makes socket.io-client stop reconnecting while its watchdog rebuilds
      // later, which would flap the slot (see design.md).
      if (displaced.socket.connected) {
        displaced.socket.emit('agent:superseded', {
          reason: 'duplicate-agent',
          by: {
            version: incomingVersion,
            socketId: socket.id,
            hostname,
            instanceId: incomingInstanceId,
          },
          at,
        });
        // An old-code loser stays connected and never re-registers on its own: keep it as a promotion
        // candidate so the machine still reports if the winner goes away.
        const ignored = existing.ignoredSockets ?? new Set<AgentSocket>();
        ignored.add(displaced.socket);
        existing.ignoredSockets = ignored;
      }
      // The record describes the **displaced** process: that is the code whose reports are now being
      // dropped. Cleared by that socket's own disconnect, by forget(), by the next takeover, or by a
      // promotion that hands the row to that same socket.
      existing.duplicateAgent = {
        at,
        ...(displaced.version ? { version: displaced.version } : {}),
        socketId: displaced.socket.id,
        ...(displaced.instanceId ? { instanceId: displaced.instanceId } : {}),
      };
    }

    if (replacedSocket) {
      this.failPending(agentId, 'Agent disconnected');
      this.socketToAgent.delete(replacedSocket.id);
    }

    const conn: AgentConn = existing ?? {
      agentId,
      hostname,
      socket: null,
      latestState: emptyIdesState(),
      lastSeenAt: this.now(),
      contentIdes: new Set(),
    };
    conn.hostname = hostname;
    conn.socket = socket;
    conn.instanceId = incomingInstanceId;
    // This socket is the active one now, so it is never a promotion candidate itself; candidates from
    // earlier registrations may still be connected and keep their place.
    conn.ignoredSockets?.delete(socket);
    conn.lastSeenAt = this.now();
    // A new socket means a new agent process or connection: the old seq line means nothing; the next full re-seeds it.
    conn.patchTrack = undefined;
    // Old agent omits version: write "unknown" rather than keeping the previous value — on a downgrade
    // back to an old CLI the stale version number would become a false signal (the page would think it is running the new one).
    conn.cliVersion = incomingVersion;
    // Ownership follows the handshake token; reaching here means either the same person, or this machine has no owner yet.
    // A registration with different ownership was already rejected at the gate; re-sign also does not cross people (see the ownership gate above).
    conn.owner = owner;
    conn.liveIdes = Array.isArray(info.liveIdes) ? info.liveIdes : undefined;
    // Routing capability. Keep only kinds this server understands: a newer agent's
    // unknown value must not become a routable slot (and must not be mistaken for
    // `cursor` either — the intersection is explicit).
    conn.slots = Array.isArray(info.slots) ? info.slots.filter(isIdeKind) : undefined;
    conn.contentSource = typeof info.contentSource === 'boolean' ? info.contentSource : undefined;
    // OS the machine self-reports. Overlay only when it reported one: old agents omit this field; don't clear
    // the value we have (platform is a machine property, independent of CLI version; unrecognized strings count as unreported).
    const platform = toAgentPlatform(info.platform);
    if (platform)
      conn.platform = platform;
    // Static capability is whatever this process declared. An old agent omits it; keep none of the previous process.
    conn.cliAcp = info.cliAcp;
    conn.cliReported = undefined;
    this.agents.set(agentId, conn);
    this.socketToAgent.set(socket.id, agentId);
    this.restoreContentIdes(conn);

    // Socket takeover needs a sync; a **new ledger** (first enroll / deleted then returning) does too: the server
    // has no books for this machine, so the agent must re-report state and census in full, or the page sees an empty shell.
    if (replacedSocket || !existing) {
      socket.emit('agent:sync');
    }

    this.persistNow(conn);
    this.emit('machines:changed');
    this.emit('uplink:changed', this.hasAgent());
    // A new active socket needs its own CLI snapshot. Browser syncs stay on the cooldown.
    this.requestCliSync(agentId, 'socket');
    return agentId;
  }

  /**
   * Machine re-sign: when the same machine changes agentId, migrate its old slot (offline, same owner,
   * same hostname) row-and-data onto the new id — snapshot stays in memory, the `machines` row is UPDATE'd,
   * the three session-mirror tables follow.
   *
   * Only called when "the new id appears for the first time"; once an id has registered it stays on the
   * list, so a machine claims an old row at most once and will not re-sign back and forth. **Ownership
   * is required**: unowned rows (local mode / probes) do not participate, to avoid guessing by hostname;
   * ownership must also match — same-named machines of different people stay distinct forever.
   */
  private adoptStaleSibling(
    newAgentId: string,
    hostname: string,
    owner: string | undefined,
  ): AgentConn | undefined {
    if (!owner)
      return undefined;
    const candidates = [...this.agents.values()].filter(
      conn =>
        conn.agentId !== newAgentId
        && conn.owner === owner
        && conn.hostname === hostname
        && !conn.socket?.connected,
    );
    // Several same-name same-owner machines (two containers both named dev) cannot be told apart:
    // rather re-sign none and leave a row for a manual delete than mix them up and move the other machine's snapshot and sessions over.
    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        console.warn(
          `[agent-hub] ${hostname}: ${candidates.length} offline machines share the hostname; skipping adoption for ${newAgentId}`,
        );
      }
      return undefined;
    }
    const candidate = candidates[0];

    const oldAgentId = candidate.agentId;
    const timer = this.patchTimers.get(oldAgentId);
    if (timer) {
      clearTimeout(timer);
      this.patchTimers.delete(oldAgentId);
    }
    this.failPending(oldAgentId, 'Agent disconnected');
    this.agents.delete(oldAgentId);
    candidate.agentId = newAgentId;
    this.agents.set(newAgentId, candidate);
    try {
      this.store.renameMachine(oldAgentId, newAgentId);
      this.sessionStore?.moveAgent(oldAgentId, newAgentId);
    }
    catch (err) {
      // A failed re-sign must not sink registration: memory is already updated, the machine still enrolls; old rows/mirrors are left for ops to clean.
      // This kind of write happens inside a socket event; an uncaught exception would take down the whole relay.
      console.error(
        `[agent-hub] Machine rename ${oldAgentId} -> ${newAgentId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    console.log(`[agent-hub] Machine renamed: ${oldAgentId} -> ${newAgentId} (${hostname}, ${owner})`);
    return candidate;
  }

  applyFull(socket: AgentSocket, payload: unknown): void {
    if (!this.isActiveSocket(socket))
      return;
    const conn = this.agents.get(this.socketToAgent.get(socket.id)!)!;
    const idesBefore = ideStatusSignature(conn.latestState);
    const next = stripIdesState(wrapIncomingFull(payload));
    conn.latestState = next;
    conn.patchTrack = readPatchBaseline(payload);
    conn.lastSeenAt = this.now();
    this.persistNow(conn);
    this.emit('state:full', conn.agentId, this.outwardState(conn));
    this.emitIfIdeStatusChanged(conn, idesBefore);
  }

  applyPatch(socket: AgentSocket, payload: unknown): void {
    if (!this.isActiveSocket(socket))
      return;
    const conn = this.agents.get(this.socketToAgent.get(socket.id)!)!;
    const read = readIdePatch(conn, payload);
    if (!read)
      return;
    const { ide, patch } = read;
    const { messages: _drop, ...rest } = patch;
    this.trackPatchSeq(conn, ide, payload);
    const idesBefore = ideStatusSignature(conn.latestState);
    conn.latestState = stripIdesState(applyIdePatch(conn.latestState, ide, rest));
    conn.lastSeenAt = this.now();
    this.schedulePersist(conn);
    this.emit('state:patch', conn.agentId, { ide, patch: rest } satisfies StatePatchPayload);
    this.emitIfIdeStatusChanged(conn, idesBefore);
  }

  /**
   * Gap detector for `state:patch` (2026-09-30). A patch is a diff, so a lost one leaves its field wrong
   * until the next reconnect; the per-IDE `seq` lets us see the hole and pull a full state to overwrite it.
   * The (possibly out-of-line) patch itself is still applied by the caller — it is harmless, and the full
   * state we ask for replaces everything anyway. Payloads without `seq` (old agents) are not checked.
   */
  private trackPatchSeq(conn: AgentConn, ide: IdeKind, payload: unknown): void {
    const rec = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const seq = readSeq(rec.seq);
    const epoch = typeof rec.epoch === 'string' ? rec.epoch : undefined;
    if (seq === undefined || epoch === undefined)
      return;

    let track = conn.patchTrack;
    const last = track && track.epoch === epoch ? track.last[ide] : undefined;
    if (track && last !== undefined && seq === last + 1) {
      track.last[ide] = seq;
    }
    else {
      const reason = !track
        ? 'no baseline'
        : track.epoch !== epoch
          ? 'agent epoch changed'
          : last === undefined
            ? 'no baseline for this IDE'
            : `expected seq ${last + 1}, got ${seq}`;
      console.warn(`[agent-hub] ${conn.agentId}/${ide}: state:patch gap (${reason}); requesting full state`);
      // Re-anchor on what we just saw so one hole warns once instead of on every later patch.
      if (!track || track.epoch !== epoch)
        track = conn.patchTrack = { epoch, last: {}, desynced: true };
      track.last[ide] = seq;
      track.desynced = true;
    }

    if (!track.desynced)
      return;
    const now = this.now();
    if (conn.lastGapSyncAt !== undefined && now - conn.lastGapSyncAt < PATCH_GAP_SYNC_COOLDOWN_MS)
      return; // Still desynced: a later patch retries after the cooldown, so no timer is needed.
    conn.lastGapSyncAt = now;
    conn.socket?.emit('agent:sync', { reason: SYNC_REASON_PATCH_GAP });
  }

  applySessionsIndex(socket: AgentSocket, payload: SessionsIndexPayload): void {
    if (!this.isActiveSocket(socket))
      return;
    const agentId = this.socketToAgent.get(socket.id)!;
    const conn = this.agents.get(agentId);
    const incoming = payload?.sessions;
    if (!Array.isArray(incoming))
      return;
    // Rows whose ide this server cannot name are dropped, never folded into cursor:
    // the ledger row and `contentIdes` would otherwise claim another product's
    // sessions belong to the cursor slot (this is exactly how a mixed-version window
    // corrupts the index). Sanitized **once** per row: the ledger, the census set and
    // the poke loop all reuse it (three passes used to re-parse and re-warn per row).
    const rows: Array<{ session: SessionMeta; ide: IdeKind }> = [];
    for (const session of incoming) {
      const ide = readInboundIde(conn, session?.ref?.ide, 'sessions:index');
      if (ide !== null)
        rows.push({ session, ide });
    }
    const sessions = rows.map(row => row.session);
    const reportedIdes = Array.isArray(payload.reportedIdes)
      ? payload.reportedIdes.filter(isIdeKind)
      : undefined;
    const delta = payload.mode === 'delta';
    let removed = Array.isArray(payload.removed)
      ? payload.removed.filter(row => isIdeKind(row?.ide))
      : [];
    // Delta defense: old-agent reporters can mis-report **another IDE**'s sessions as deletions
    // (observed 2026-09-21: a codebuddy report of +572 also sent -1007 and wiped the cursor mirror).
    // The producer declares in reportedIdes which IDEs this round covers — deletions outside that
    // declaration are ignored, so old machines need not upgrade; a server bump keeps the mirror.
    // Payloads without a declaration keep original behavior (neither widen nor shrink).
    if (delta && removed.length > 0 && reportedIdes) {
      const declared = new Set<IdeKind>(reportedIdes);
      if (declared.size > 0)
        removed = removed.filter(row => declared.has(row.ide));
    }
    // writeIndex may legitimately be handed an **empty** list: an authoritative round
    // from a slot that truly has no rows (a plugin-only machine has no `CodeBuddyIDE/`)
    // is exactly the payload that prunes the rows a pre-split agent mislabelled. The
    // reporter only sends such a round after checking its root is readable, which is
    // what keeps the "transient empty index" protection this guard was written for.
    // Mirror failure must not drop the live event or crash the process — browsers
    // still need the index.
    const authoritative = !delta && (reportedIdes?.length ?? 0) > 0;
    if (sessions.length > 0 || (delta && removed.length > 0) || authoritative) {
      try {
        if (delta)
          this.sessionStore?.mergeIndex(agentId, sessions, removed);
        else this.sessionStore?.writeIndex(agentId, sessions, reportedIdes);
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[agent-hub] writeIndex failed: ${message}`);
      }
    }
    this.emit('sessions:index', agentId, {
      sessions,
      ...(delta && removed.length > 0 ? { mode: 'delta' as const, removed } : {}),
      ...(reportedIdes && reportedIdes.length > 0
        ? { reportedIdes }
        : {}),
    });

    // Census reported = this machine is a content source for those IDEs; a first change affects the machine list (content-only machines fold into the group).
    if (conn) {
      const before = [...conn.contentIdes].sort().join(',');
      for (const row of rows)
        conn.contentIdes.add(row.ide);
      for (const ide of reportedIdes ?? []) conn.contentIdes.add(ide);
      if ([...conn.contentIdes].sort().join(',') !== before)
        this.emit('machines:changed');
      // Ledger changed → a content-only machine's read-only session list must refresh too (the page list is driven by state).
      if (this.isContentOnlyMachine(conn))
        this.emit('state:full', agentId, this.outwardState(conn));
    }

    // Someone is waiting on these sessions (content lives elsewhere): just reported, so poke it to project the body. Once, no broadcast.
    for (const { session, ide } of rows) {
      const sessionId = session?.ref?.sessionId;
      if (typeof sessionId !== 'string' || sessionId.length === 0)
        continue;
      // Session reappeared in the census → revoke the "this session does not exist" cache (auto-recovery path after a message is persisted).
      this.missingSessionsAt.delete(`${agentId}\0${ide}\0${sessionId}`);
      if (!this.hasWaitingWatcher(ide, sessionId, agentId))
        continue;
      if (this.sessionStore?.readSession(agentId, sessionId, ide)?.length)
        continue;
      this.emitSessionGet(this.agents.get(agentId), { sessionId, ide });
    }
  }

  applySessionFull(socket: AgentSocket, payload: SessionBodyPayload): void {
    if (!this.isActiveSocket(socket))
      return;
    const agentId = this.socketToAgent.get(socket.id)!;
    const sessionId = payload?.sessionId;
    const messages = payload?.messages;
    if (typeof sessionId !== 'string' || !Array.isArray(messages))
      return;
    const ide = readInboundIde(this.agents.get(agentId), payload.ide, 'session:full');
    if (ide === null)
      return;
    const seq = readSeq(payload.seq) ?? 0;
    // Empty bodies come in two kinds; don't drop them with a single rule (2026-09-20: an owner's empty session was killed and the page skeleton waited forever):
    //  - content is registered under **another machine**: this machine's empty packet is untrusted — in the cross-machine case the IDE machine,
    //    asked about a session it does not have locally, answers empty, and that packet would wipe a body the page already has (2026-09-16 production issue); drop it;
    //  - the owner itself (or nobody has reported a census yet) pushes an empty body: **don't persist** (same wipe-prevention) but **forward as-is** —
    //    the frontend then shows "session is empty" instead of hanging on a skeleton forever.
    if (messages.length === 0) {
      const owners = this.sessionStore?.findSessionOwners(sessionId, ide) ?? [];
      if (owners.length > 0 && !owners.includes(agentId)) {
        timingLog('hub:session-full-drop', { agentId, ide, sessionId, reason: 'empty-not-owner' });
        return;
      }
      const emptyPayload = { sessionId, messages: [] as ChatElement[], ide, seq };
      this.emit('session:full', agentId, emptyPayload);
      this.relayToWatchers(ide, sessionId, 'session:full', emptyPayload, agentId);
      timingLog('hub:session-full', { agentId, ide, sessionId, n: 0, total: 0, empty: true, seq });
      return;
    }
    try {
      this.sessionStore?.writeSession(agentId, sessionId, messages, ide, seq);
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[agent-hub] writeSession failed: ${message}`);
    }
    // There is a body now: revoke this machine's "this session does not exist" cache.
    this.missingSessionsAt.delete(`${agentId}\0${ide}\0${sessionId}`);
    // The DB holds the full body; only the tail page is sent out: a phone must not haul a whole history for one session.
    // (Don't annotate `: SessionBodyPayload` — it widens ide to optional, which fights relayToWatchers' required ide.)
    const page = tailPage(messages);
    const relayPayload = page.hasMore
      ? { sessionId, messages: page.messages, ide, seq, isPage: true, hasMore: true, nextBefore: page.nextBefore }
      : { sessionId, messages: page.messages, ide, seq };
    this.emit('session:full', agentId, relayPayload);
    this.relayToWatchers(ide, sessionId, 'session:full', relayPayload, agentId);
    timingLog('hub:session-full', {
      agentId,
      ide,
      sessionId,
      n: relayPayload.messages.length,
      total: messages.length,
      page: page.hasMore === true,
      last: timingLastBubble(relayPayload.messages) || undefined,
      seq,
    });
  }

  applySessionAppend(socket: AgentSocket, payload: SessionBodyPayload): void {
    if (!this.isActiveSocket(socket))
      return;
    const agentId = this.socketToAgent.get(socket.id)!;
    const sessionId = payload?.sessionId;
    const messages = payload?.messages;
    if (typeof sessionId !== 'string' || !Array.isArray(messages))
      return;
    const ide = readInboundIde(this.agents.get(agentId), payload.ide, 'session:append');
    if (ide === null)
      return;
    const seq = readSeq(payload.seq);
    // Forward what the mirror stored: its flatIndex may have been settled against rows already held.
    let stored = messages;
    try {
      stored = this.sessionStore?.appendMessages(agentId, sessionId, messages, ide, seq) ?? messages;
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[agent-hub] appendSession failed: ${message}`);
    }
    this.emit('session:append', agentId, { sessionId, messages: stored, ide, seq });
    this.relayToWatchers(ide, sessionId, 'session:append', { sessionId, messages: stored, ide, seq }, agentId);
    timingLog('hub:session-append', {
      agentId,
      ide,
      sessionId,
      n: messages.length,
      last: timingLastBubble(messages) || undefined,
      seq,
    });
  }

  /**
   * Incremental fill-in from the content machine (answering session:get's sinceSeq): merge into the DB by id;
   * don't delete old cards already in the mirror. Without a baseline (the DB has no rows) this delta cannot
   * assemble a full body — drop it and ask for a full instead.
   */
  applySessionPatch(socket: AgentSocket, payload: SessionPatchPayload): void {
    if (!this.isActiveSocket(socket))
      return;
    const agentId = this.socketToAgent.get(socket.id)!;
    const sessionId = payload?.sessionId;
    const messages = payload?.messages;
    const seq = readSeq(payload?.seq);
    if (typeof sessionId !== 'string' || !Array.isArray(messages) || seq === undefined)
      return;
    const ide = readInboundIde(this.agents.get(agentId), payload.ide, 'session:patch');
    if (ide === null)
      return;
    if (this.sessionStore?.readSessionSeq(agentId, sessionId, ide) === null) {
      timingLog('hub:session-patch-drop', { agentId, ide, sessionId, reason: 'no-baseline' });
      // No sinceSeq → the agent takes a forced full (Task 8). Sending sinceSeq would return a patch and loop with "the DB has no rows".
      this.emitSessionGet(this.agents.get(agentId), { sessionId, ide });
      return;
    }
    let stored = messages;
    try {
      stored = this.sessionStore?.appendMessages(agentId, sessionId, messages, ide, seq) ?? messages;
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[agent-hub] appendSession(patch) failed: ${message}`);
    }
    // The mirror eats the full body; the copy forwarded to watchers is tail-sliced like full — "phones never receive a full body" gets no back door.
    // patch-all (the seq-behind path) is a full projection, the easiest place to push the whole session to a phone again.
    const page = tailPage(stored);
    const relayPayload = page.hasMore
      ? { sessionId, messages: page.messages, ide, seq, isPage: true, hasMore: true, nextBefore: page.nextBefore }
      : { sessionId, messages: page.messages, ide, seq };
    this.emit('session:patch', agentId, relayPayload);
    this.relayToWatchers(ide, sessionId, 'session:patch', relayPayload, agentId);
    timingLog('hub:session-patch', {
      agentId,
      ide,
      sessionId,
      n: relayPayload.messages.length,
      total: messages.length,
      last: timingLastBubble(relayPayload.messages) || undefined,
      seq,
    });
  }

  applySessionSync(socket: AgentSocket, payload: SessionSyncPayload): void {
    if (!this.isActiveSocket(socket))
      return;
    const agentId = this.socketToAgent.get(socket.id)!;
    const sessionId = payload?.sessionId;
    const seq = readSeq(payload?.seq);
    if (typeof sessionId !== 'string' || seq === undefined)
      return;
    const ide = readInboundIde(this.agents.get(agentId), payload.ide, 'session:sync');
    if (ide === null)
      return;
    this.emit('session:sync', agentId, { sessionId, ide, seq });
    timingLog('hub:session-sync', { agentId, ide, sessionId, seq });
  }

  /**
   * Agent explicitly answers "this machine does not have this session" (not on disk). Record in cache:
   * within the TTL a frontend re-ask returns session:unavailable directly and does not poke in vain;
   * also tell watchers who are waiting for it.
   */
  applySessionMissing(socket: AgentSocket, payload: SessionMissingPayload): void {
    if (!this.isActiveSocket(socket))
      return;
    const agentId = this.socketToAgent.get(socket.id)!;
    const sessionId = payload?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0)
      return;
    const ide = readInboundIde(this.agents.get(agentId), payload?.ide, 'session:missing');
    if (ide === null)
      return;
    this.missingSessionsAt.set(`${agentId}\0${ide}\0${sessionId}`, this.now());
    timingLog('hub:session-missing', { agentId, ide, sessionId });
    this.relayMissingToWatchers(ide, sessionId, agentId);
  }

  /** This machine recently (within TTL) explicitly said "this session does not exist". Querying also evicts expired entries. */
  private isMissing(agentId: string, ide: IdeKind, sessionId: string): boolean {
    const key = `${agentId}\0${ide}\0${sessionId}`;
    const at = this.missingSessionsAt.get(key);
    if (at === undefined)
      return false;
    if (this.now() - at > SESSION_MISSING_TTL_MS) {
      this.missingSessionsAt.delete(key);
      return false;
    }
    return true;
  }

  /** When the agent says "missing", sync that conclusion to requesters waiting on this session so they don't keep hanging. */
  private relayMissingToWatchers(ide: IdeKind, sessionId: string, ownerAgentId: string): void {
    const watchers = this.sessionWatchers.get(`${ide}\0${sessionId}`);
    if (!watchers || watchers.size === 0)
      return;
    const now = this.now();
    for (const [requester, expiresAt] of watchers) {
      if (expiresAt <= now) {
        watchers.delete(requester);
        continue;
      }
      if (requester === ownerAgentId)
        continue;
      this.emit('session:unavailable', requester, { sessionId, ide });
    }
  }

  /**
   * The only place `session:get` leaves this server.
   *
   * Gated on the **receiving** connection's declared `slots`, not on the requester:
   * `session:get` has no schema check on the agent side (`uplink` only validates
   * `command:*` / `cli:sync`), so an un-routed slot would be folded into `cursor` by
   * the agent's `parseIde` — it would project Cursor's body, or answer
   * `session:missing { ide: 'cursor' }` and the missing record would land in the
   * cursor slot. Five call sites go through here; do not add a sixth `emit` by hand.
   */
  private emitSessionGet(
    conn: AgentConn | undefined,
    payload: { sessionId?: string; tabTitle?: string; ide: IdeKind; sinceSeq?: number },
  ): boolean {
    if (!conn || !canRouteTo(conn, payload.ide))
      return false;
    conn.socket?.emit('session:get', payload);
    return true;
  }

  /**
   * Content may not live on the selected machine (IDE on a Mac, session data on a remote dev machine):
   * 1) This machine's DB already has the body → answer directly (fastest);
   * 2) The ledger says another machine has it on disk → if that machine has pushed a body, answer directly; if it's online, poke it to project;
   * 3) The ledger has not caught up → only register "this machine is looking at this session" and poke on that machine's next report.
   * No broadcast, no retry; if it never arrives the page keeps the skeleton.
   * seq reconciliation is kept at every level: if the reported sinceSeq matches that level's store, only session:sync is returned.
   */
  handleSessionGet(
    agentId: string,
    payload: SessionGetPayload,
    replyTo: AgentSocket,
  ): void {
    const sessionId = payload?.sessionId;
    const tabTitle = payload?.tabTitle;
    // A request, not a report: absent still means cursor (the browser may omit it),
    // but an unknown value is dropped instead of being retargeted at Cursor.
    const ide = readInboundIde(undefined, payload?.ide, 'session:get');
    if (ide === null)
      return;
    const sinceSeq = readSeq(payload?.sinceSeq);
    const before
      = typeof payload?.before === 'number' && Number.isFinite(payload.before)
        ? payload.before
        : undefined;
    const limit
      = typeof payload?.limit === 'number' && Number.isFinite(payload.limit)
        ? payload.limit
        : undefined;
    const page = before === undefined && limit === undefined ? undefined : { before, limit };
    const force = payload?.force === true;

    if (typeof sessionId === 'string' && sessionId.length > 0) {
      this.watchSession(ide, sessionId, agentId);

      const own = this.replySessionFromStore(agentId, sessionId, ide, replyTo, sinceSeq, page);
      if (own) {
        this.refreshContent(agentId, agentId, sessionId, ide, own.seq ?? undefined);
        return;
      }

      // Only look at the same person's machines: the ledger is server-wide; a cross-person content source must not hitch a ride on this route.
      // (Local mode / both unowned: undefined === undefined, same behavior as before.)
      const requesterOwner = this.agents.get(agentId)?.owner;
      const owners = (this.sessionStore?.findSessionOwners(sessionId, ide) ?? [])
        .filter(owner => owner !== agentId)
        .filter(owner => this.agents.get(owner)?.owner === requesterOwner);
      for (const owner of owners) {
        const hit = this.replySessionFromStore(owner, sessionId, ide, replyTo, sinceSeq, page);
        if (hit) {
          this.refreshContent(agentId, owner, sessionId, ide, hit.seq ?? undefined);
          return;
        }
      }

      const owner = owners.find(id => this.agents.get(id)?.socket?.connected);
      if (owner) {
        timingLog('hub:session-get', { agentId, sessionId, ide, source: 'owner', owner });
        if (!this.emitSessionGet(this.agents.get(owner), { sessionId, ide })) {
          // The owner cannot serve this slot any more (plugin removed, older CLI):
          // answer terminally instead of leaving the page on a skeleton forever.
          timingLog('hub:session-get', { agentId, sessionId, ide, source: 'owner-gate-refused', owner });
          replyTo.emit('session:unavailable', { sessionId, ide });
        }
        return;
      }

      // This machine recently said explicitly "this session does not exist": tell the page directly; don't poke in vain.
      // force (user-initiated retry) skips the cache and asks again.
      if (!force && this.isMissing(agentId, ide, sessionId)) {
        timingLog('hub:session-get', { agentId, sessionId, ide, source: 'missing-cached' });
        replyTo.emit('session:unavailable', { sessionId, ide });
        return;
      }

      // The ledger has not caught up: also ask this machine's agent once (the usual same-machine content-source path); the rest waits for a report.
      // Shares one gate with refreshContent: when the content source is missing the frontend retries (the body never fills),
      // and infinite pokes are pure idle — observed 2026-09-20 at 30 pokes/s punching through the event loop, whole site down.
      if (!force && !this.allowPointAt(`${ide}\0${sessionId}`, this.now()))
        return;
      timingLog('hub:session-get', { agentId, sessionId, ide, source: 'wait-owner' });
      const conn = this.agents.get(agentId);
      if (!this.emitSessionGet(conn, { sessionId, ide }))
        replyTo.emit('session:unavailable', { sessionId, ide });
      return;
    }

    if (typeof tabTitle === 'string' && tabTitle.length > 0) {
      timingLog('hub:session-get', { agentId, tabTitle, ide, source: 'agent' });
      const conn = this.agents.get(agentId);
      // No sessionId to answer with: a refusal can only be logged.
      if (!this.emitSessionGet(conn, { tabTitle, ide }))
        timingLog('hub:session-get', { agentId, tabTitle, ide, source: 'agent-gate-refused' });
    }
  }

  /**
   * Unified gate for "poke the content machine": the same session is allowed through once a minute
   * (shared by refreshContent and wait-owner). When the content source is missing the frontend retries;
   * without this gate that is infinite idle (2026-09-20 incident: 30 pokes/s + logging, main thread at 100%, whole site spinning).
   */
  private allowPointAt(key: string, now: number): boolean {
    const last = this.refreshedAt.get(key);
    if (last !== undefined && now - last < SESSION_REFRESH_COOLDOWN_MS)
      return false;
    this.refreshedAt.set(key, now);
    if (this.refreshedAt.size > 200) {
      for (const [k, ts] of this.refreshedAt) {
        if (now - ts > 10 * SESSION_REFRESH_COOLDOWN_MS)
          this.refreshedAt.delete(k);
      }
    }
    return true;
  }

  /**
   * The DB answers fast, but it may be a stale snapshot: the content machine only follows deltas on
   * "recently poked" sessions, and once the user looks at another session nobody follows this one —
   * answering from the DB alone would freeze the page on the old snapshot (observed 2026-09-16: the
   * session kept writing for 2 hours, the page stayed 2 hours behind, user saw "records don't match").
   * So on a DB hit, poke once more and send down **the seq of the DB copy**: if the content machine
   * matches it only returns sync; if not, only a patch — never force a full re-projection.
   * Same session is filled in at most once a minute.
   */
  private refreshContent(
    requesterAgentId: string,
    ownerAgentId: string,
    sessionId: string,
    ide: IdeKind,
    sinceSeq?: number,
  ): void {
    const conn = this.agents.get(ownerAgentId);
    if (!conn?.socket?.connected)
      return;
    const key = `${ide}\0${sessionId}`;
    if (!this.allowPointAt(key, this.now()))
      return;
    timingLog('hub:session-get', {
      agentId: requesterAgentId,
      sessionId,
      ide,
      source: 'store+refresh',
      owner: ownerAgentId,
    });
    // Sixth and last `session:get` exit — through the same gate as the rest. A refusal is
    // **silent** on purpose: the body was already answered from the store, so telling the
    // page "unavailable" here would hide content that did arrive.
    this.emitSessionGet(conn, sinceSeq === undefined ? { sessionId, ide } : { sessionId, ide, sinceSeq });
  }

  /**
   * Answer as soon as some store level hits: no before and it fits → authoritative full; everything else is a page
   * (a request with before is a page even if hasMore=false — the first page of a long session must not wipe the already-loaded tail).
   * When `sinceSeq` matches that level's seq, only `session:sync` is returned (lightweight reconnect reconcile, no body retransmit;
   * page-up requests don't send sinceSeq, so they are not short-circuited).
   * The return value hands the store's seq to the caller — it will poke the content machine (prefer a patch over a full).
   */
  private replySessionFromStore(
    storeAgentId: string,
    sessionId: string,
    ide: IdeKind,
    replyTo: AgentSocket,
    sinceSeq?: number,
    page?: { before?: number; limit?: number },
  ): { seq: number | null } | null {
    const storedSeq = this.sessionStore?.readSessionSeq(storeAgentId, sessionId, ide) ?? null;
    const hit = this.sessionStore?.readSessionPage(storeAgentId, sessionId, ide, page);
    if (!hit)
      return null;
    if (sinceSeq !== undefined && storedSeq === sinceSeq) {
      timingLog('hub:session-sync', { agentId: storeAgentId, sessionId, ide, seq: sinceSeq });
      replyTo.emit('session:sync', { sessionId, ide, seq: sinceSeq });
      return { seq: storedSeq };
    }
    const seq = Math.max(storedSeq ?? 0, 0);
    const isEarlier = page?.before !== undefined;
    if (isEarlier || hit.hasMore) {
      timingLog('hub:session-get', {
        agentId: storeAgentId,
        sessionId,
        ide,
        source: 'store-page',
        n: hit.messages.length,
        before: page?.before,
        nextBefore: hit.nextBefore,
        seq,
      });
      replyTo.emit('session:full', {
        sessionId,
        messages: hit.messages,
        ide,
        seq,
        isPage: true,
        hasMore: hit.hasMore,
        ...(hit.hasMore ? { nextBefore: hit.nextBefore } : {}),
        ...(isEarlier ? { before: page.before } : {}),
      });
      return { seq: storedSeq };
    }
    timingLog('hub:session-get', {
      agentId: storeAgentId,
      sessionId,
      ide,
      source: 'store',
      n: hit.messages.length,
      seq: storedSeq ?? undefined,
    });
    replyTo.emit('session:full', { sessionId, messages: hit.messages, ide, seq });
    return { seq: storedSeq };
  }

  /** Register "this machine is looking at this session": later the content machine's full/append is forwarded to its viewers. */
  private watchSession(ide: IdeKind, sessionId: string, requesterAgentId: string): void {
    const key = `${ide}\0${sessionId}`;
    let watchers = this.sessionWatchers.get(key);
    if (!watchers) {
      watchers = new Map();
      this.sessionWatchers.set(key, watchers);
    }
    const now = this.now();
    watchers.set(requesterAgentId, now + SESSION_WATCH_TTL_MS);
    for (const [id, expiresAt] of watchers) {
      if (expiresAt <= now)
        watchers.delete(id);
    }
  }

  /** A requester is waiting on this session, and the body is not in ownerAgentId's DB → poke it to project. */
  private hasWaitingWatcher(ide: IdeKind, sessionId: string, ownerAgentId: string): boolean {
    const watchers = this.sessionWatchers.get(`${ide}\0${sessionId}`);
    if (!watchers)
      return false;
    const now = this.now();
    for (const [requester, expiresAt] of watchers) {
      if (expiresAt <= now)
        continue;
      if (requester !== ownerAgentId)
        return true;
    }
    return false;
  }

  /** Body/delta pushed by the content machine: besides its own viewers, also forward to requester machines looking at it. */
  private relayToWatchers(
    ide: IdeKind,
    sessionId: string,
    event: 'session:full' | 'session:append' | 'session:patch',
    payload: {
      sessionId: string;
      messages: ChatElement[];
      ide: IdeKind;
      seq?: number;
      isPage?: boolean;
      hasMore?: boolean;
      nextBefore?: number;
    },
    ownerAgentId: string,
  ): void {
    const watchers = this.sessionWatchers.get(`${ide}\0${sessionId}`);
    if (!watchers || watchers.size === 0)
      return;
    const now = this.now();
    for (const [requester, expiresAt] of watchers) {
      if (expiresAt <= now) {
        watchers.delete(requester);
        continue;
      }
      if (requester === ownerAgentId)
        continue;
      this.emit(event, requester, payload);
    }
  }

  readSessionIndex(agentId: string): SessionMeta[] {
    return this.sessionStore?.readIndex(agentId) ?? [];
  }

  /**
   * connection:status (agent → server). payload carries optional `ide` (P4):
   * new agents report per-ide by driver; old machines (≤0.1.72) omit it → fall back to the cursor slot,
   * byte-for-byte with old production behavior (deploy is atomic on the same train; no mixed-run window before the agent updates).
   */
  applyConnection(socket: AgentSocket, payload: { ide?: IdeKind; connected: boolean }): void {
    if (!this.isActiveSocket(socket))
      return;
    const conn = this.agents.get(this.socketToAgent.get(socket.id)!)!;
    const ide = readInboundIde(conn, payload.ide, 'connection:status');
    if (ide === null)
      return;
    const idesBefore = ideStatusSignature(conn.latestState);
    conn.latestState = applyIdePatch(conn.latestState, ide, {
      connected: payload.connected,
    });
    conn.lastSeenAt = this.now();
    this.schedulePersist(conn);
    this.emit('connection:changed', conn.agentId, payload.connected);
    this.emitIfIdeStatusChanged(conn, idesBefore);
  }

  onSocketDisconnect(socket: AgentSocket): void {
    // A displaced socket has no `socketToAgent` entry (`register()` removed it at takeover), so the
    // record must be cleared by socket id **before** the lookup below — otherwise the notice
    // outlives the process it describes. The same scan drops it from any promotion set.
    for (const conn of this.agents.values()) {
      if (conn.duplicateAgent?.socketId === socket.id) {
        conn.duplicateAgent = undefined;
        this.emit('machines:changed');
      }
      conn.ignoredSockets?.delete(socket);
    }

    const agentId = this.socketToAgent.get(socket.id);
    this.socketToAgent.delete(socket.id);
    if (!agentId)
      return;
    const conn = this.agents.get(agentId);
    if (!conn || conn.socket !== socket)
      return;

    conn.socket = null;
    // Promotion: an ignored old process is still connected and never re-registers on its own, so
    // without this the machine would report offline while a live agent is attached.
    const promoted = [...(conn.ignoredSockets ?? [])].find(candidate => candidate.connected) ?? null;
    if (promoted) {
      conn.ignoredSockets?.delete(promoted);
      conn.socket = promoted;
      // The promoted process is an old one that cannot name itself: the recorded identity, version and
      // patch epoch all describe the process that just left. Keeping any of them would put a stale
      // version on a row that is fed by different code — the exact false signal this change removes.
      conn.instanceId = undefined;
      conn.cliVersion = undefined;
      conn.patchTrack = undefined;
      // …and if the record describes **this** socket, it must go: the promoted process is the one
      // reporting now, so "已顶替 vX" would name the very code feeding the row. When it describes a
      // *different* still-connected socket, that process is still being dropped — keep the notice,
      // and its own disconnect (matched by socket id) will clear it.
      if (conn.duplicateAgent?.socketId === promoted.id)
        conn.duplicateAgent = undefined;
      conn.lastSeenAt = this.now();
      this.socketToAgent.set(promoted.id, agentId);
      console.warn(
        `[agent-hub] promoted ignored socket ${promoted.id} for ${agentId} (the active socket ${socket.id} went away)`,
      );
      promoted.emit('agent:sync');
    }
    this.persistNow(conn);
    this.failPending(agentId, 'Agent disconnected');
    this.emit('machines:changed');
    this.emit('uplink:changed', this.hasAgent());
  }

  /**
   * Delete an **offline** machine from the server: memory conn, the `machines` row, and its session mirror are all cleared.
   * Online machines are refused (delete and the daemon would re-register immediately; pointless). If the daemon is still
   * around it will come back on the next connect with the same agentId (that's "re-enroll", see register's sync),
   * but the mirror will not come back — "delete this computer" means the server keeps none of its data.
   */
  forget(agentId: string): boolean {
    const conn = this.agents.get(agentId);
    if (!conn)
      return true;
    if (conn.socket?.connected)
      return false;

    const timer = this.patchTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.patchTimers.delete(agentId);
    }
    this.failPending(agentId, 'Agent disconnected');
    if (conn.socket)
      this.socketToAgent.delete(conn.socket.id);
    this.agents.delete(agentId);
    try {
      this.store.removeMachine(agentId);
      this.sessionStore?.dropAgent(agentId);
    }
    catch (err) {
      // A DB delete failure must not leave the page stuck on "delete failed": memory is already gone; only a restart rebuilding from the DB would bring it back.
      console.error(
        `[agent-hub] Failed to drop ${agentId} from the store: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.emit('machines:changed');
    this.emit('uplink:changed', this.hasAgent());
    return true;
  }

  /**
   * Console "Rename": the alias only decides how the page names it, independent of agentId / hostname / ownership;
   * works online or offline (it is the list itself). `null` = clear the alias, fall back to hostname.
   */
  setDisplayName(agentId: string, displayName: string | null): boolean {
    const conn = this.agents.get(agentId);
    if (!conn)
      return false;
    conn.displayName = displayName ?? undefined;
    try {
      this.store.setDisplayName(agentId, displayName);
    }
    catch (err) {
      // A persist failure does not undo this rename: memory is already updated, the page sees it immediately; after restart it reverts to the old name (can be renamed again).
      console.error(
        `[agent-hub] Failed to persist displayName for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.emit('machines:changed');
    return true;
  }

  /**
   * Console drag sorting: apply the given rail order (position = array index). Refuses the whole
   * call if any id is unknown (no partial writes). The caller (relay) checks that the list is
   * exactly the viewer's machines — here it must only verify each id exists, because in
   * multi-owner deployments this directory holds several people's machines.
   */
  reorderMachines(agentIds: string[]): boolean {
    // Duplicate ids would write one row twice — refuse whole (relay also checks, this is the directory's own gate).
    if (new Set(agentIds).size !== agentIds.length)
      return false;
    for (const agentId of agentIds) {
      if (!this.agents.has(agentId))
        return false;
    }
    const entries: Array<{ agentId: string; sortOrder: number }> = [];
    agentIds.forEach((agentId, index) => {
      this.agents.get(agentId)!.sortOrder = index;
      entries.push({ agentId, sortOrder: index });
    });
    try {
      this.store.setMachineOrder(entries);
    }
    catch (err) {
      // Same stance as setDisplayName: memory is already updated, the page sees it immediately;
      // a persist failure only reverts the order after a restart.
      console.error(
        `[agent-hub] Failed to persist machine order: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.emit('machines:changed');
    return true;
  }

  sendCommand(agentId: string, event: string, payload: CommandPayload, replyTo: AgentSocket): void {
    timingLog('hub:command', {
      agentId,
      event,
      commandId: payload.commandId,
      ide: payload.ide,
      chars: payload.text?.length,
      preview: payload.text ? timingPreview(payload.text) : undefined,
    });
    this.sweepPending();
    const conn = this.agents.get(agentId);
    if (!conn || !conn.socket?.connected) {
      timingLog('hub:offline', { agentId, event, commandId: payload.commandId });
      replyTo.emit('command:result', {
        commandId: payload.commandId,
        ok: false,
        error: 'Machine offline',
      } satisfies CommandResult);
      return;
    }
    const cliSource = cliCommandSource(event, payload);
    if (cliSource !== null && !cliStaticAllowed(conn, cliSource)) {
      replyTo.emit('command:result', {
        commandId: payload.commandId,
        ok: false,
        errorCode: 'cli-agent-incompatible',
        error: 'CLI agent incompatible',
      } satisfies CommandResult);
      return;
    }
    // IDE command: the target slot must be one this agent declared, and the forwarded
    // payload must name it **explicitly**. An absent `ide` means cursor on the wire, and
    // an agent folds an unknown value into cursor — so an ide-less command that was
    // meant for another slot would be typed into Cursor. Filling it here keeps the
    // agent's `parseIde` default from ever deciding the target.
    let forwarded = payload;
    if (cliSource === null) {
      const ide: IdeKind = isIdeKind(payload.ide) ? payload.ide : 'cursor';
      if (!canRouteTo(conn, ide)) {
        timingLog('hub:ide-agent-incompatible', { agentId, event, ide, commandId: payload.commandId });
        replyTo.emit('command:result', {
          commandId: payload.commandId,
          ok: false,
          errorCode: 'ide-agent-incompatible',
          error: `Agent does not report the ${ide} slot`,
        } satisfies CommandResult);
        return;
      }
      forwarded = { ...payload, ide };
    }
    if (payload.commandId) {
      const key = pendingKey(agentId, payload.commandId);
      if (this.pending.has(key)) {
        replyTo.emit('command:result', {
          commandId: payload.commandId,
          ok: false,
          error: 'Duplicate command',
        } satisfies CommandResult);
        return;
      }
      const expiresAt = this.now() + this.pendingTtlMs;
      this.pending.set(key, { replyTo, agentId, commandId: payload.commandId, expiresAt });
      this.armPending(key);
    }
    conn.socket.emit(event, forwarded);
  }

  /**
   * Browser command boundary. Illegal payloads are answered and not forwarded.
   * IDE commands that pass the schema keep the existing `sendCommand` path.
   */
  ingestBrowserCommand(agentId: string, event: string, payload: unknown, replyTo: AgentSocket): void {
    const parsed = validateInbound(commandPayloadSchema, payload, 'invalid-payload');
    if (!parsed.ok) {
      replyTo.emit('command:result', {
        commandId: readCommandId(payload),
        ok: false,
        errorCode: 'invalid-payload',
        error: 'Invalid payload',
      } satisfies CommandResult);
      return;
    }
    this.sendCommand(agentId, event, parsed.data, replyTo);
  }

  /** Wire `agent:register`. A schema failure admits nothing. */
  registerInbound(socket: AgentSocket, raw: unknown): string | null {
    const parsed = validateInbound(agentRegisterSchema, raw, 'reject-register');
    if (!parsed.ok) {
      logDroppedInbound('agent:register', raw);
      return null;
    }
    return this.register(socket, parsed.data);
  }

  /**
   * Agent → viewers. Old sockets and agents without `cliAcp` are dropped.
   * The outbound `agentId` is the connection's, never the payload's.
   */
  ingestAgentCli(socket: AgentSocket, event: string, payload: unknown): void {
    if (!this.isActiveSocket(socket)) {
      logDroppedInbound(event, payload);
      return;
    }
    const agentId = this.socketToAgent.get(socket.id);
    const conn = agentId ? this.agents.get(agentId) : undefined;
    if (!conn?.cliAcp) {
      logDroppedInbound(event, payload);
      return;
    }
    if (event === 'cli:capabilities') {
      this.applyCliCapabilities(conn, payload);
      return;
    }
    const parsed = parseCliEvent(event, payload);
    if (!parsed?.ok) {
      logDroppedInbound(event, payload);
      if (event === 'cli:snapshot')
        this.finishCliSync(conn.agentId);
      return;
    }
    this.deliverCli(conn.agentId, event, { ...parsed.data, agentId: conn.agentId });
    if (event === 'cli:snapshot')
      this.finishCliSync(conn.agentId);
  }

  attachCliViewer(viewer: AgentSocket, agentId: string): void {
    this.detachCliViewer(viewer);
    if (!this.agents.has(agentId))
      return;
    let viewers = this.cliViewers.get(agentId);
    if (!viewers) {
      viewers = new Set();
      this.cliViewers.set(agentId, viewers);
    }
    viewers.add(viewer);
    this.viewerMachine.set(viewer.id, agentId);
  }

  detachCliViewer(viewer: AgentSocket): void {
    const agentId = this.viewerMachine.get(viewer.id);
    if (!agentId)
      return;
    this.viewerMachine.delete(viewer.id);
    const viewers = this.cliViewers.get(agentId);
    viewers?.delete(viewer);
    if (viewers && viewers.size === 0)
      this.cliViewers.delete(agentId);
  }

  /** Browser disconnect: drop its pending commands and its CLI subscription. */
  releaseRequester(socket: AgentSocket): void {
    this.detachCliViewer(socket);
    for (const [key, pending] of this.pending) {
      if (pending.replyTo.id === socket.id)
        this.deletePending(key);
    }
  }

  /**
   * Ask the agent for one CLI snapshot.
   * `socket` skips the cooldown because the previous flight went to a socket that no longer owns the slot.
   * Browser and select requests merge while one is in flight, and again inside the cooldown.
   */
  requestCliSync(agentId: string, reason: 'request' | 'socket' = 'request'): void {
    const conn = this.agents.get(agentId);
    if (!conn?.cliAcp || !conn.socket?.connected)
      return;
    const now = this.now();
    const state = this.cliSync.get(agentId);
    if (reason !== 'socket') {
      if (state?.inFlight) {
        state.queued = true;
        return;
      }
      if (state && now - state.sentAt < this.cliSyncCooldownMs) {
        state.queued = true;
        this.armCliSyncFlush(agentId, this.cliSyncCooldownMs - (now - state.sentAt));
        return;
      }
    }
    this.emitCliSync(conn, now);
  }

  /** The machine currently registered for this socket; unregistered (rejected / not yet registered) → undefined. */
  agentIdOfSocket(socket: AgentSocket): string | undefined {
    return this.socketToAgent.get(socket.id);
  }

  /**
   * Command receipts find the orderer by commandId. `sourceAgentId` = which machine the receipt came from,
   * and must match the one recorded at order time: commandId is a UUID and cannot be guessed, but
   * "unguessable" is not auth — one forged answer and the orderer never gets the real result.
   * Forged receipts are dropped; pending is left for the real machine to answer.
   */
  routeResult(result: CommandResult, sourceAgentId?: string): void {
    this.sweepPending();
    if (!result?.commandId)
      return;
    if (result.errorCode !== undefined && !isCommandErrorCode(result.errorCode)) {
      logDroppedInbound('command:result', result);
      return;
    }
    const key = sourceAgentId !== undefined ? pendingKey(sourceAgentId, result.commandId) : undefined;
    const target = key ? this.pending.get(key) : this.pendingByCommand(result.commandId);
    if (!target) {
      if (sourceAgentId !== undefined)
        this.warnForeignResult(result.commandId, sourceAgentId);
      return;
    }
    if (sourceAgentId !== undefined && target.agentId !== sourceAgentId) {
      console.warn(
        `[agent-hub] Ignored command:result from ${sourceAgentId} for ${target.agentId} (${result.commandId})`,
      );
      return;
    }
    timingLog('hub:result', {
      commandId: result.commandId,
      ok: result.ok,
      error: result.error,
    });
    this.deletePending(key ?? pendingKey(target.agentId, result.commandId));
    target.replyTo.emit('command:result', result);
  }

  isActiveSocket(socket: AgentSocket): boolean {
    const agentId = this.socketToAgent.get(socket.id);
    if (!agentId)
      return false;
    return this.agents.get(agentId)?.socket === socket;
  }

  private failPending(agentId: string, error: string): void {
    for (const [key, pending] of this.pending) {
      if (pending.agentId !== agentId)
        continue;
      this.deletePending(key);
      pending.replyTo.emit('command:result', {
        commandId: pending.commandId,
        ok: false,
        error,
      } satisfies CommandResult);
    }
  }

  /**
   * Shutdown: clear persist timers still waiting on debounce, and from here on write no more to the DB.
   * If an agent had just sent a patch when the service stopped, that 1.5s timer would fire after the DB
   * is already closed — a no-op write for a JSON file, a "database connection is not open" throw for SQLite.
   */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.patchTimers.values()) clearTimeout(timer);
    this.patchTimers.clear();
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    this.pendingTimers.clear();
    for (const timer of this.cliSyncTimers.values()) clearTimeout(timer);
    this.cliSyncTimers.clear();
  }

  private deliverCli(agentId: string, event: string, payload: Record<string, unknown>): void {
    const viewers = this.cliViewers.get(agentId);
    if (!viewers)
      return;
    for (const viewer of viewers) {
      if (this.viewerMachine.get(viewer.id) !== agentId || !viewer.connected)
        continue;
      viewer.emit(event, payload);
    }
  }

  private applyCliCapabilities(conn: AgentConn, payload: unknown): void {
    const reported = readCliAvailability(payload);
    if (!reported) {
      logDroppedInbound('cli:capabilities', payload);
      return;
    }
    conn.cliReported = reported;
    this.emit('machines:changed');
  }

  private emitCliSync(conn: AgentConn, now: number): void {
    this.cliSync.set(conn.agentId, { inFlight: true, sentAt: now, queued: false });
    conn.socket?.emit('cli:sync');
  }

  private finishCliSync(agentId: string): void {
    const state = this.cliSync.get(agentId);
    if (!state)
      return;
    state.inFlight = false;
    if (!state.queued)
      return;
    const wait = this.cliSyncCooldownMs - (this.now() - state.sentAt);
    if (wait <= 0) {
      state.queued = false;
      const conn = this.agents.get(agentId);
      if (conn?.cliAcp && conn.socket?.connected)
        this.emitCliSync(conn, this.now());
      return;
    }
    this.armCliSyncFlush(agentId, wait);
  }

  private armCliSyncFlush(agentId: string, wait: number): void {
    const existing = this.cliSyncTimers.get(agentId);
    if (existing)
      clearTimeout(existing);
    const timer = setTimeout(() => {
      this.cliSyncTimers.delete(agentId);
      const state = this.cliSync.get(agentId);
      if (!state?.queued || state.inFlight)
        return;
      if (this.now() - state.sentAt < this.cliSyncCooldownMs)
        return;
      state.queued = false;
      const conn = this.agents.get(agentId);
      if (conn?.cliAcp && conn.socket?.connected)
        this.emitCliSync(conn, this.now());
    }, Math.max(0, wait));
    timer.unref();
    this.cliSyncTimers.set(agentId, timer);
  }

  private sweepPending(): void {
    const now = this.now();
    for (const [key, pending] of this.pending) {
      if (now < pending.expiresAt)
        continue;
      this.deletePending(key);
      pending.replyTo.emit('command:result', {
        commandId: pending.commandId,
        ok: false,
        error: 'Command expired',
      } satisfies CommandResult);
    }
  }

  private armPending(key: string): void {
    const timer = setTimeout(() => {
      this.pendingTimers.delete(key);
      const pending = this.pending.get(key);
      if (!pending || this.now() < pending.expiresAt)
        return;
      this.pending.delete(key);
      pending.replyTo.emit('command:result', {
        commandId: pending.commandId,
        ok: false,
        error: 'Command expired',
      } satisfies CommandResult);
    }, this.pendingTtlMs);
    timer.unref();
    this.pendingTimers.set(key, timer);
  }

  private deletePending(key: string): void {
    this.pending.delete(key);
    const timer = this.pendingTimers.get(key);
    if (!timer)
      return;
    clearTimeout(timer);
    this.pendingTimers.delete(key);
  }

  private pendingByCommand(commandId: string): { replyTo: AgentSocket; agentId: string; commandId: string } | undefined {
    for (const pending of this.pending.values()) {
      if (pending.commandId === commandId)
        return pending;
    }
    return undefined;
  }

  private warnForeignResult(commandId: string, sourceAgentId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.commandId !== commandId || pending.agentId === sourceAgentId)
        continue;
      console.warn(
        `[agent-hub] Ignored command:result from ${sourceAgentId} for ${pending.agentId} (${commandId})`,
      );
      return;
    }
  }

  private persistNow(conn: AgentConn): void {
    if (this.disposed)
      return;
    const timer = this.patchTimers.get(conn.agentId);
    if (timer) {
      clearTimeout(timer);
      this.patchTimers.delete(conn.agentId);
    }
    this.store.upsertMachine({
      agentId: conn.agentId,
      hostname: conn.hostname,
      lastSeenAt: conn.lastSeenAt,
      snapshot: conn.latestState,
      cliVersion: conn.cliVersion,
      platform: conn.platform,
      owner: conn.owner,
    });
  }

  private schedulePersist(conn: AgentConn): void {
    if (this.persistDebounceMs <= 0) {
      this.persistNow(conn);
      return;
    }
    const existing = this.patchTimers.get(conn.agentId);
    if (existing)
      clearTimeout(existing);
    const timer = setTimeout(() => {
      this.patchTimers.delete(conn.agentId);
      this.persistNow(conn);
    }, this.persistDebounceMs);
    this.patchTimers.set(conn.agentId, timer);
  }
}

/**
 * Server-side endpoint for agent uplinks (MODE=agent on a local machine).
 *
 * Credentials are a per-machine token (hash stored in machine_tokens). Handshake resolves `(owner, agentId)`;
 * the self-reported id must match the one bound to the token. Register then passes an agentId ownership
 * gate (see AgentDirectory.register).
 *
 * Shared `AGENT_TOKEN` is no longer accepted: it cannot resolve ownership, and accepting it would only
 * yield a grey "connected but shown to nobody" state. After upgrading an old bundle, re-run `lifeline setup`.
 *
 * Socket.io wiring only: registration, snapshots and command routing live in
 * AgentDirectory (one slot per agentId, last snapshot in SQLite).
 */
export class AgentHub extends EventEmitter {
  private nsp: Namespace;
  private identity: IdentityStore;
  private directory: AgentDirectory;
  private sessionStore: SessionStore;

  /**
   * `identity` = identity and ownership store (users / machine_tokens / machines); relay passes the same instance,
   *  enroll-code issue and handshake identity must see the same data.
   */
  constructor(io: SocketServer, dataDir: string, options?: { identity?: IdentityStore; sessionDbPath?: string }) {
    super();
    const dbPath = options?.sessionDbPath ?? join(dataDir, 'lifeline.sqlite');
    this.identity = options?.identity ?? new IdentityStore(dbPath);
    this.sessionStore = new SessionStore(dbPath);
    this.directory = new AgentDirectory(this.identity, {
      sessionStore: this.sessionStore,
    });
    this.nsp = io.of('/agent');
    this.forwardDirectoryEvents();

    this.nsp.use((socket, next) => {
      const identity = this.resolveHandshake(socket.handshake.auth?.agentToken);
      if (!identity) {
        console.warn(
          `[agent-hub] Rejected agent connection (${socket.id}) - unknown token; run \`lifeline setup\` on that machine`,
        );
        next(new Error('Unauthorized'));
        return;
      }
      socket.data.agentOwner = identity.owner;
      socket.data.tokenAgentId = identity.agentId;
      next();
    });

    this.nsp.on('connection', (socket) => {
      console.log(`[agent-hub] Agent socket connected: ${socket.id}`);

      socket.on('agent:register', (info: unknown) => {
        const parsed = validateInbound(agentRegisterSchema, info, 'reject-register');
        if (!parsed.ok) {
          logDroppedInbound('agent:register', info);
          socket.emit('agent:rejected', { reason: 'reject-register' });
          setTimeout(() => {
            if (!this.directory.isActiveSocket(socket))
              socket.disconnect(true);
          }, 200);
          return;
        }
        const boundId = typeof socket.data.tokenAgentId === 'string' ? socket.data.tokenAgentId : '';
        const reportedId = typeof parsed.data.agentId === 'string' && parsed.data.agentId
          ? parsed.data.agentId
          : boundId;
        if (!boundId || reportedId !== boundId) {
          console.warn(
            `[agent-hub] Rejected agent registration (${socket.id}) - token bound to ${boundId || '(none)'}, reported ${reportedId || '(none)'}`,
          );
          socket.emit('agent:rejected', { reason: 'agent-mismatch' });
          setTimeout(() => {
            if (!this.directory.isActiveSocket(socket))
              socket.disconnect(true);
          }, 200);
          return;
        }
        const agentId = this.directory.register(socket, {
          ...parsed.data,
          agentId: boundId,
          owner: typeof socket.data.agentOwner === 'string' ? socket.data.agentOwner : undefined,
        });
        if (!agentId) {
          console.warn(
            `[agent-hub] Rejected agent registration (${socket.id}) - machine id is enrolled to another account`,
          );
          // Tell the peer the reason first, then disconnect shortly after. A server-initiated disconnect does not auto-reconnect.
          socket.emit('agent:rejected', { reason: 'owner-mismatch' });
          setTimeout(() => {
            if (!this.directory.isActiveSocket(socket))
              socket.disconnect(true);
          }, 200);
          return;
        }
        // Only the socket that actually holds the slot says "registered": an ignored duplicate is not a
        // registration, and printing both lines would make one attempt read like two machines.
        if (this.directory.isActiveSocket(socket)) {
          console.log(
            `[agent-hub] Agent registered: ${agentId} (${parsed.data.hostname ?? agentId})`,
          );
        }
      });

      for (const event of CLI_AGENT_EVENTS) {
        socket.on(event, (payload: unknown) => {
          this.directory.ingestAgentCli(socket, event, payload);
        });
      }

      socket.on('state:full', (state: unknown) => {
        if (!this.directory.isActiveSocket(socket))
          return;
        this.directory.applyFull(socket, state);
      });

      socket.on('state:patch', (patch: unknown) => {
        if (!this.directory.isActiveSocket(socket))
          return;
        this.directory.applyPatch(socket, patch);
      });

      socket.on('connection:status', (payload: { ide?: IdeKind; connected: boolean }) => {
        if (!this.directory.isActiveSocket(socket))
          return;
        // The raw value goes in: `applyConnection` drops an unknown ide and only falls
        // back to cursor for a connection that never declared its slots (see readInboundIde).
        this.directory.applyConnection(socket, {
          ide: payload?.ide,
          connected: payload.connected === true,
        });
      });

      socket.on('command:result', (result: CommandResult) => {
        if (!this.directory.isActiveSocket(socket))
          return;
        this.directory.routeResult(result, this.directory.agentIdOfSocket(socket));
      });

      socket.on('sessions:index', (payload: SessionsIndexPayload) => {
        if (!this.directory.isActiveSocket(socket))
          return;
        this.directory.applySessionsIndex(socket, payload);
      });

      socket.on('session:full', (payload: SessionBodyPayload) => {
        if (!this.directory.isActiveSocket(socket))
          return;
        this.directory.applySessionFull(socket, payload);
      });

      socket.on('session:append', (payload: SessionBodyPayload) => {
        if (!this.directory.isActiveSocket(socket))
          return;
        this.directory.applySessionAppend(socket, payload);
      });

      socket.on('session:patch', (payload: SessionPatchPayload) => {
        if (!this.directory.isActiveSocket(socket))
          return;
        this.directory.applySessionPatch(socket, payload);
      });

      // Agent-side reconciliation passed (requester's seq matches local): no body, confirmation only.
      socket.on('session:sync', (payload: SessionSyncPayload) => {
        if (!this.directory.isActiveSocket(socket))
          return;
        this.directory.applySessionSync(socket, payload);
      });

      // Agent explicitly answers "this machine does not have this session" (not on disk): don't poke in vain; answer the page directly.
      socket.on('session:missing', (payload: SessionMissingPayload) => {
        if (!this.directory.isActiveSocket(socket))
          return;
        this.directory.applySessionMissing(socket, payload);
      });

      socket.on('disconnect', (reason) => {
        if (!this.directory.isActiveSocket(socket)) {
          console.log(`[agent-hub] Idle agent socket disconnected (${reason})`);
          this.directory.onSocketDisconnect(socket);
          return;
        }
        console.log(`[agent-hub] Active agent disconnected (${reason})`);
        this.directory.onSocketDisconnect(socket);
      });
    });
  }

  /**
   * Handshake token → ownership (+ per-machine id). Unresolvable → null, refuse the connection immediately.
   */
  private resolveHandshake(raw: unknown): { owner: string; agentId: string } | null {
    if (typeof raw !== 'string' || raw.length === 0)
      return null;
    const identity = this.identity.resolveHandshake(raw);
    if (!identity)
      return null;
    return identity;
  }

  listMachines(userId?: string): MachineInfo[] {
    return this.directory.listMachines(userId);
  }

  hasAgent(userId?: string): boolean {
    return this.directory.hasAgent(userId);
  }

  connectedAgentCount(): number {
    return this.directory.connectedAgentCount();
  }

  getState(agentId: string): AgentIdesState | null {
    return this.directory.getState(agentId);
  }

  getStateOrEmpty(agentId: string): AgentIdesState {
    return this.directory.getStateOrEmpty(agentId);
  }

  getCursorState(agentId: string): CursorState {
    return this.directory.getCursorState(agentId);
  }

  sendCommand(agentId: string, event: string, payload: CommandPayload, replyTo: Socket): void {
    this.directory.sendCommand(agentId, event, payload, replyTo);
  }

  ingestBrowserCommand(agentId: string, event: string, payload: unknown, replyTo: Socket): void {
    this.directory.ingestBrowserCommand(agentId, event, payload, replyTo);
  }

  requestCliSync(agentId: string): void {
    this.directory.requestCliSync(agentId);
  }

  attachCliViewer(viewer: AgentSocket, agentId: string): void {
    this.directory.attachCliViewer(viewer, agentId);
  }

  detachCliViewer(viewer: AgentSocket): void {
    this.directory.detachCliViewer(viewer);
  }

  releaseBrowser(socket: AgentSocket): void {
    this.directory.releaseRequester(socket);
  }

  forget(agentId: string): boolean {
    return this.directory.forget(agentId);
  }

  /** Console "Rename": `null` = clear the alias. false = this machine is not on the list. */
  setDisplayName(agentId: string, displayName: string | null): boolean {
    return this.directory.setDisplayName(agentId, displayName);
  }

  /** Console drag sorting: apply the given rail order. false = an id in the list is unknown. */
  reorderMachines(agentIds: string[]): boolean {
    return this.directory.reorderMachines(agentIds);
  }

  handleSessionGet(
    agentId: string,
    payload: SessionGetPayload,
    replyTo: AgentSocket,
  ): void {
    this.directory.handleSessionGet(agentId, payload, replyTo);
  }

  readSessionIndex(agentId: string): SessionMeta[] {
    return this.directory.readSessionIndex(agentId);
  }

  close(): void {
    this.directory.dispose();
    this.sessionStore.close();
  }

  private forwardDirectoryEvents(): void {
    this.directory.on('machines:changed', () => this.emit('machines:changed'));
    this.directory.on('state:full', (agentId: string, state: AgentIdesState) => {
      this.emit('state:full', agentId, state);
    });
    this.directory.on('state:patch', (agentId: string, patch: StatePatchPayload) => {
      this.emit('state:patch', agentId, patch);
    });
    this.directory.on('connection:changed', (agentId: string, connected: boolean) => {
      this.emit('connection:changed', agentId, connected);
    });
    this.directory.on('uplink:changed', (connected: boolean) => {
      this.emit('uplink:changed', connected);
    });
    this.directory.on('sessions:index', (agentId: string, payload: SessionsIndexPayload) => {
      this.emit('sessions:index', agentId, payload);
    });
    this.directory.on('session:full', (agentId: string, payload: SessionBodyPayload) => {
      this.emit('session:full', agentId, payload);
    });
    this.directory.on('session:append', (agentId: string, payload: SessionBodyPayload) => {
      this.emit('session:append', agentId, payload);
    });
    this.directory.on('session:patch', (agentId: string, payload: SessionPatchPayload) => {
      this.emit('session:patch', agentId, payload);
    });
    this.directory.on('session:sync', (agentId: string, payload: SessionSyncPayload) => {
      this.emit('session:sync', agentId, payload);
    });
    this.directory.on('session:unavailable', (agentId: string, payload: SessionMissingPayload) => {
      this.emit('session:unavailable', agentId, payload);
    });
  }
}

function stripTranscript(state: CursorState): CursorState {
  const next: CursorState = { ...state, messages: [] };
  delete next.lastAssistantText;
  if (!next.liveActions)
    next.liveActions = {};
  return next;
}

function stripIdesState(state: AgentIdesState): AgentIdesState {
  const ides: AgentIdesState['ides'] = {};
  for (const ide of IDE_KINDS) {
    const slot = state.ides[ide];
    if (slot)
      ides[ide] = stripTranscript(slot);
  }
  return { ides };
}

/** Rail child-row summary: the status dot, the badge, and the row label (host) */
function ideStatusOf(state: AgentIdesState): Partial<Record<IdeKind, MachineIdeStatus>> {
  const out: Partial<Record<IdeKind, MachineIdeStatus>> = {};
  for (const ide of IDE_KINDS) {
    const s = state.ides[ide];
    if (!s)
      continue;
    out[ide] = {
      connected: s.connected === true,
      pendingApprovals: s.pendingApprovals?.length ?? 0,
      // Omit the key when unknown: an `undefined` value would survive JSON in
      // theory but is one less thing to explain in a payload diff.
      ...(s.host ? { host: s.host } : {}),
    };
  }
  return out;
}

/**
 * Content-source group: has a census, no live state, **and this machine itself declares "I am content-source only"**.
 *
 * The criterion is the agent-reported `contentSource` (decided by **platform**: Linux = true), **not** `liveIdes`:
 * "app not on the list" (Setapp / Homebrew custom dirs / enterprise distro) is not "no GUI";
 * using that as the criterion would fold a normal install into "content source" and drop it from the machine list (review R1).
 *
 * Only old agents without `contentSource` fall back to the previous-version criterion.
 */
function isContentOnlyConn(conn: AgentConn): boolean {
  if (conn.contentIdes.size === 0)
    return false;
  const hasLive = Object.values(ideStatusOf(conn.latestState)).some(row => row?.connected === true);
  if (hasLive)
    return false;
  if (conn.contentSource !== undefined)
    return conn.contentSource;
  const liveCapable = conn.liveIdes;
  return liveCapable === undefined || liveCapable.length === 0;
}

/**
 * Summary fingerprint: only broadcast machines:list when it changes.
 *
 * `host` belongs in here even though it is "just a label": the rail row of a
 * **non-selected** machine reads `m.ides[ide].host` from this list, and host is
 * learned on connect — a `state:patch` carrying nothing else this signature
 * looks at. Without it, that row keeps the previous host suffix until the
 * connection bit or the approval count happens to move.
 */
/**
 * Slots an agent that predates the capability declaration can route to: the
 * pre-split set. Never derived from `liveIdes` — that field means "installed"
 * (and a content-only machine need not populate it), while this means "answerable".
 */
const LEGACY_ROUTABLE_SLOTS: readonly IdeKind[] = ['cursor', 'codebuddy'];

/** Can this connection answer for `ide`? Gate for commands and every `session:get` emit. */
function canRouteTo(conn: AgentConn | undefined, ide: IdeKind): boolean {
  return (conn?.slots ?? LEGACY_ROUTABLE_SLOTS).includes(ide);
}

function ideStatusSignature(state: AgentIdesState): string {
  const status = ideStatusOf(state);
  return IDE_KINDS.map((ide) => {
    const s = status[ide];
    return s ? `${s.connected ? '1' : '0'}:${s.pendingApprovals}:${s.host ?? '-'}` : '-';
  }).join('|');
}

/**
 * Inbound `ide` parsing for agent → server events. Stricter than `parseIde`, which
 * stays as-is on purpose: its "absent → cursor" is the old-agent compatibility
 * contract used elsewhere (the browser URL parser has its own strict version).
 *
 * Two rules:
 *  - **present but unknown** (a newer agent's kind this server does not know) → drop.
 *    Folding it into cursor would write another product's state and ledger into the
 *    cursor slot, silently.
 *  - **absent** → cursor **only for a connection that declared no `slots`**. An agent
 *    that reported its slots always knows which slot it is reporting for, so a
 *    missing `ide` there is a bug: drop it rather than guess.
 */
export function readInboundIde(
  conn: Pick<AgentConn, 'slots'> | undefined,
  raw: unknown,
  what: string,
): IdeKind | null {
  if (raw === undefined || raw === null || raw === '') {
    if ((conn?.slots?.length ?? 0) > 1) {
      warnOnce(`${what}\0(absent)`, `[agent-hub] Dropping ${what} without an ide from a multi-slot agent`);
      return null;
    }
    return 'cursor';
  }
  if (!isIdeKind(raw)) {
    warnOnce(`${what}\0${String(raw)}`, `[agent-hub] Dropping ${what} with unknown ide "${String(raw)}" (agent newer than server?)`);
    return null;
  }
  return raw;
}

/**
 * Log an inbound-drop **once** per (event, value).
 *
 * A census round repeats every ~2s for as long as the mismatch lasts, so an
 * unconditional warn is a log amplifier — the 2026-09-20 incident was exactly this
 * shape (30 pokes/s + logging pinned the main thread). Bounded on purpose: a
 * pathological stream of distinct values must not grow the set without limit.
 */
const warnedInbound = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warnedInbound.has(key))
    return;
  if (warnedInbound.size > 200)
    warnedInbound.clear();
  warnedInbound.add(key);
  console.warn(message);
}

function readIdePatch(conn: AgentConn, payload: unknown): { ide: IdeKind; patch: Partial<CursorState> } | null {
  if (payload && typeof payload === 'object') {
    const rec = payload as Record<string, unknown>;
    if ('ide' in rec && rec.patch && typeof rec.patch === 'object') {
      const ide = readInboundIde(conn, rec.ide, 'state:patch');
      return ide === null ? null : { ide, patch: rec.patch as Partial<CursorState> };
    }
    // Legacy shape: a bare `CursorState` with no `ide` at all (pre-per-ide wire).
    const ide = readInboundIde(conn, undefined, 'state:patch');
    return ide === null ? null : { ide, patch: rec as Partial<CursorState> };
  }
  return null;
}

/** Baseline shipped with `state:full` (see `PatchSeqBaseline`). Anything malformed = no baseline (old behavior). */
function readPatchBaseline(payload: unknown): PatchTrack | undefined {
  if (!payload || typeof payload !== 'object')
    return undefined;
  const raw = (payload as { patchSeq?: Partial<PatchSeqBaseline> }).patchSeq;
  if (!raw || typeof raw.epoch !== 'string' || !raw.seqs || typeof raw.seqs !== 'object')
    return undefined;
  const last: PatchTrack['last'] = {};
  for (const ide of IDE_KINDS) {
    // An IDE the agent has not patched yet has no entry: its first patch must be seq 1, i.e. baseline 0.
    last[ide] = readSeq(raw.seqs[ide]) ?? 0;
  }
  return { epoch: raw.epoch, last, desynced: false };
}

/** A seq is accepted only when it is a finite number; old agents omit it → undefined (old behavior). */
function readSeq(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/**
 * Alias cleanup: control chars to spaces, collapse consecutive whitespace, trim; **empty string = clear the alias** (fall back to hostname).
 * Length is truncated by code points — cutting by UTF-16 length would split emoji / rare characters in half. Caller guarantees raw is a string.
 */
export function normalizeMachineName(raw: string): string | null {
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0)
    return null;
  return Array.from(cleaned).slice(0, MACHINE_NAME_MAX_LENGTH).join('');
}

/** Whether this machine should be visible to this userId. userId omitted = no isolation (local mode / internal callers). */
function canSee(owner: string | undefined, userId?: string): boolean {
  if (userId === undefined)
    return true;
  return !!owner && owner === userId;
}

function pendingKey(agentId: string, commandId: string): string {
  return `${agentId}\0${commandId}`;
}

/**
 * `null` means this command is not CLI-targeted. A string (or `undefined` when the
 * source was omitted) means it is. `payload.ide` is never consulted.
 */
function cliCommandSource(event: string, payload: CommandPayload): string | undefined | null {
  const target = payload.target;
  const cliEvent = (CLI_COMMAND_EVENTS as readonly string[]).includes(event);
  if (!cliEvent && !(target && target.kind === 'cli'))
    return null;
  if (target && target.kind === 'cli')
    return target.source;
  return typeof payload.source === 'string' ? payload.source : undefined;
}

function cliStaticAllowed(conn: AgentConn, source: string | undefined): boolean {
  const cap = conn.cliAcp;
  if (!cap || !isCliPlatform(cap.platform) || !source)
    return false;
  return cap.sources.some(row => row.source === source);
}

function cliSourcesField(conn: AgentConn): { cliSources: NonNullable<MachineInfo['cliSources']> } | Record<string, never> {
  if (!conn.cliAcp)
    return {};
  return {
    cliSources: conn.cliAcp.sources.map(row => ({
      source: row.source,
      availability: conn.cliReported?.get(row.source) ?? 'unknown',
    })),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCommandId(payload: unknown): string {
  if (!isPlainObject(payload) || typeof payload.commandId !== 'string')
    return '';
  return payload.commandId;
}

function readCliAvailability(payload: unknown): Map<CliSource, CliAvailability> | null {
  if (!isPlainObject(payload) || !isCliPlatform(payload.platform) || !Array.isArray(payload.sources))
    return null;
  const reported = new Map<CliSource, CliAvailability>();
  for (const row of payload.sources) {
    if (!isPlainObject(row) || !isCliSource(row.source))
      return null;
    if (typeof row.availability !== 'string' || !CLI_AVAILABILITY.has(row.availability as CliAvailability))
      return null;
    reported.set(row.source, row.availability as CliAvailability);
  }
  return reported;
}

function parseCliEvent(
  event: string,
  payload: unknown,
): { ok: true; data: Record<string, unknown> } | { ok: false } | null {
  if (event === 'cli:snapshot')
    return widenCli(validateInbound(cliSnapshotSchema, payload, 'drop-and-log'));
  if (event === 'cli:append')
    return widenCli(validateInbound(cliAppendSchema, payload, 'drop-and-log'));
  if (event === 'cli:full')
    return widenCli(validateInbound(cliFullSchema, payload, 'drop-and-log'));
  if (event === 'cli:session-created')
    return widenCli(validateInbound(cliSessionCreatedSchema, payload, 'drop-and-log'));
  if (event === 'cli:status')
    return widenCli(validateInbound(cliStatusSchema, payload, 'drop-and-log'));
  if (event === 'cli:approval')
    return widenCli(validateInbound(cliApprovalEventSchema, payload, 'drop-and-log'));
  if (event === 'cli:approval-resolved')
    return widenCli(validateInbound(cliApprovalResolvedSchema, payload, 'drop-and-log'));
  if (event === 'cli:session-removed')
    return widenCli(validateInbound(cliSessionRemovedSchema, payload, 'drop-and-log'));
  return null;
}

function isCommandErrorCode(value: unknown): boolean {
  return typeof value === 'string' && (COMMAND_ERROR_CODES as readonly string[]).includes(value);
}

function widenCli(
  parsed: { ok: true; data: object } | { ok: false; code: string },
): { ok: true; data: Record<string, unknown> } | { ok: false } {
  if (!parsed.ok)
    return { ok: false };
  return { ok: true, data: { ...parsed.data } };
}

function logDroppedInbound(event: string, payload: unknown): void {
  let text: string;
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload) ?? '';
  }
  catch {
    text = '[unserializable]';
  }
  console.warn(`[agent-hub] dropped ${event}: ${text}`.slice(0, CLI_INBOUND_LOG_MAX_CHARS));
}
