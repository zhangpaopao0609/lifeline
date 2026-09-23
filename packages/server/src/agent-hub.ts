import type { Namespace, Socket, Server as SocketServer } from 'socket.io';
import type {
  AgentPlatform,
  AgentRegisterPayload,
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
import { isIdeKind, MACHINE_NAME_MAX_LENGTH, toAgentPlatform } from '../../protocol/src/index.js';
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
  /** Machine ownership (userId of whoever enrolled); normally always present — an agent whose ownership cannot be resolved cannot connect (see resolveOwner) */
  owner?: string;
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
   * GUI-capable IDEs this agent detected. Undefined = old agent (fall back to
   * `!hasLive`). Not persisted — reconnect restores it.
   */
  liveIdes?: IdeKind[];
  /**
   * This machine is **content-source only** (Linux: the agent does not connect CDP, does not take over input).
   * `undefined` = old agent. The "content source" group only honors this — don't use "app not on the list"
   * as the criterion (review R1).
   */
  contentSource?: boolean;
}

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
  private pending = new Map<string, { replyTo: AgentSocket; agentId: string }>();
  private patchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sessionStore: SessionStore | null;
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
    },
  ) {
    super();
    this.store = store;
    this.persistDebounceMs = options?.persistDebounceMs ?? 1500;
    this.now = options?.now ?? Date.now;
    this.sessionStore = options?.sessionStore ?? null;
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
    return [...this.agents.values()]
      .filter(conn => canSee(conn.owner, userId))
      .map((conn) => {
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
          ...(conn.owner ? { owner: conn.owner } : {}),
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
        windows: [{ id: windowId, title: '内容源', url: '', chatTabs: tabs }],
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

    const replacing = !!(existing?.socket && existing.socket !== socket);

    if (existing?.socket && existing.socket !== socket) {
      this.failPending(agentId, 'Agent disconnected');
      this.socketToAgent.delete(existing.socket.id);
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
    conn.lastSeenAt = this.now();
    // Old agent omits version: write "unknown" rather than keeping the previous value — on a downgrade
    // back to an old CLI the stale version number would become a false signal (the page would think it is running the new one).
    conn.cliVersion = typeof info.version === 'string' && info.version ? info.version : undefined;
    // Ownership follows the handshake token; reaching here means either the same person, or this machine has no owner yet.
    // A registration with different ownership was already rejected at the gate; re-sign also does not cross people (see the ownership gate above).
    conn.owner = owner;
    conn.liveIdes = Array.isArray(info.liveIdes) ? info.liveIdes : undefined;
    conn.contentSource = typeof info.contentSource === 'boolean' ? info.contentSource : undefined;
    // OS the machine self-reports. Overlay only when it reported one: old agents omit this field; don't clear
    // the value we have (platform is a machine property, independent of CLI version; unrecognized strings count as unreported).
    const platform = toAgentPlatform(info.platform);
    if (platform)
      conn.platform = platform;
    this.agents.set(agentId, conn);
    this.socketToAgent.set(socket.id, agentId);
    this.restoreContentIdes(conn);

    // Socket takeover needs a sync; a **new ledger** (first enroll / deleted then returning) does too: the server
    // has no books for this machine, so the agent must re-report state and census in full, or the page sees an empty shell.
    if (replacing || !existing) {
      socket.emit('agent:sync');
    }

    this.persistNow(conn);
    this.emit('machines:changed');
    this.emit('uplink:changed', this.hasAgent());
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
    conn.lastSeenAt = this.now();
    this.persistNow(conn);
    this.emit('state:full', conn.agentId, this.outwardState(conn));
    this.emitIfIdeStatusChanged(conn, idesBefore);
  }

  applyPatch(socket: AgentSocket, payload: unknown): void {
    if (!this.isActiveSocket(socket))
      return;
    const conn = this.agents.get(this.socketToAgent.get(socket.id)!)!;
    const { ide, patch } = readIdePatch(payload);
    const { messages: _drop, ...rest } = patch;
    const idesBefore = ideStatusSignature(conn.latestState);
    conn.latestState = stripIdesState(applyIdePatch(conn.latestState, ide, rest));
    conn.lastSeenAt = this.now();
    this.schedulePersist(conn);
    this.emit('state:patch', conn.agentId, { ide, patch: rest } satisfies StatePatchPayload);
    this.emitIfIdeStatusChanged(conn, idesBefore);
  }

  applySessionsIndex(socket: AgentSocket, payload: SessionsIndexPayload): void {
    if (!this.isActiveSocket(socket))
      return;
    const agentId = this.socketToAgent.get(socket.id)!;
    const sessions = payload?.sessions;
    if (!Array.isArray(sessions))
      return;
    const delta = payload.mode === 'delta';
    let removed = Array.isArray(payload.removed) ? payload.removed : [];
    // Delta defense: old-agent reporters can mis-report **another IDE**'s sessions as deletions
    // (observed 2026-09-21: a codebuddy report of +572 also sent -1007 and wiped the cursor mirror).
    // The producer declares in reportedIdes which IDEs this round covers — deletions outside that
    // declaration are ignored, so old machines need not upgrade; a server bump keeps the mirror.
    // Payloads without a declaration keep original behavior (neither widen nor shrink).
    if (delta && removed.length > 0 && Array.isArray(payload.reportedIdes)) {
      const declared = new Set<IdeKind>(payload.reportedIdes.filter(isIdeKind));
      if (declared.size > 0)
        removed = removed.filter(row => declared.has(row.ide));
    }
    // writeIndex([],) deletes every row for this agent — never persist a
    // transient empty index. Mirror failure must not drop the live event or
    // crash the process — browsers still need the index.
    if (sessions.length > 0 || (delta && removed.length > 0)) {
      try {
        if (delta)
          this.sessionStore?.mergeIndex(agentId, sessions, removed);
        else this.sessionStore?.writeIndex(agentId, sessions, payload.reportedIdes);
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[agent-hub] writeIndex failed: ${message}`);
      }
    }
    this.emit('sessions:index', agentId, {
      sessions,
      ...(delta && removed.length > 0 ? { mode: 'delta' as const, removed } : {}),
      ...(payload.reportedIdes && payload.reportedIdes.length > 0
        ? { reportedIdes: payload.reportedIdes }
        : {}),
    });

    // Census reported = this machine is a content source for those IDEs; a first change affects the machine list (content-only machines fold into the group).
    const conn = this.agents.get(agentId);
    if (conn) {
      const before = [...conn.contentIdes].sort().join(',');
      for (const session of sessions) {
        conn.contentIdes.add(parseIde(session?.ref?.ide));
      }
      for (const ide of payload.reportedIdes ?? []) conn.contentIdes.add(parseIde(ide));
      if ([...conn.contentIdes].sort().join(',') !== before)
        this.emit('machines:changed');
      // Ledger changed → a content-only machine's read-only session list must refresh too (the page list is driven by state).
      if (this.isContentOnlyMachine(conn))
        this.emit('state:full', agentId, this.outwardState(conn));
    }

    // Someone is waiting on these sessions (content lives elsewhere): just reported, so poke it to project the body. Once, no broadcast.
    for (const session of sessions) {
      const sessionId = session?.ref?.sessionId;
      if (typeof sessionId !== 'string' || sessionId.length === 0)
        continue;
      const ide: IdeKind = parseIde(session.ref?.ide);
      // Session reappeared in the census → revoke the "this session does not exist" cache (auto-recovery path after a message is persisted).
      this.missingSessionsAt.delete(`${agentId}\0${ide}\0${sessionId}`);
      if (!this.hasWaitingWatcher(ide, sessionId, agentId))
        continue;
      if (this.sessionStore?.readSession(agentId, sessionId, ide)?.length)
        continue;
      socket.emit('session:get', { sessionId, ide });
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
    const ide = parseIde(payload.ide);
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
    const ide = parseIde(payload.ide);
    const seq = readSeq(payload.seq);
    try {
      this.sessionStore?.appendSession(agentId, sessionId, messages, ide, seq);
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[agent-hub] appendSession failed: ${message}`);
    }
    this.emit('session:append', agentId, { sessionId, messages, ide, seq });
    this.relayToWatchers(ide, sessionId, 'session:append', { sessionId, messages, ide, seq }, agentId);
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
    const ide = parseIde(payload.ide);
    if (this.sessionStore?.readSessionSeq(agentId, sessionId, ide) === null) {
      timingLog('hub:session-patch-drop', { agentId, ide, sessionId, reason: 'no-baseline' });
      // No sinceSeq → the agent takes a forced full (Task 8). Sending sinceSeq would return a patch and loop with "the DB has no rows".
      this.agents.get(agentId)?.socket?.emit('session:get', { sessionId, ide });
      return;
    }
    try {
      this.sessionStore?.appendSession(agentId, sessionId, messages, ide, seq);
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[agent-hub] appendSession(patch) failed: ${message}`);
    }
    // The mirror eats the full body; the copy forwarded to watchers is tail-sliced like full — "phones never receive a full body" gets no back door.
    // patch-all (the seq-behind path) is a full projection, the easiest place to push the whole session to a phone again.
    const page = tailPage(messages);
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
    const ide = parseIde(payload.ide);
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
    const ide = parseIde(payload?.ide);
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
    const ide = parseIde(payload?.ide);
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
        this.agents.get(owner)?.socket?.emit('session:get', { sessionId, ide });
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
      conn?.socket?.emit('session:get', { sessionId, ide });
      return;
    }

    if (typeof tabTitle === 'string' && tabTitle.length > 0) {
      timingLog('hub:session-get', { agentId, tabTitle, ide, source: 'agent' });
      const conn = this.agents.get(agentId);
      conn?.socket?.emit('session:get', { tabTitle, ide });
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
    conn.socket.emit(
      'session:get',
      sinceSeq === undefined ? { sessionId, ide } : { sessionId, ide, sinceSeq },
    );
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
    const idesBefore = ideStatusSignature(conn.latestState);
    conn.latestState = applyIdePatch(conn.latestState, payload.ide ?? 'cursor', {
      connected: payload.connected,
    });
    conn.lastSeenAt = this.now();
    this.schedulePersist(conn);
    this.emit('connection:changed', conn.agentId, payload.connected);
    this.emitIfIdeStatusChanged(conn, idesBefore);
  }

  onSocketDisconnect(socket: AgentSocket): void {
    const agentId = this.socketToAgent.get(socket.id);
    this.socketToAgent.delete(socket.id);
    if (!agentId)
      return;
    const conn = this.agents.get(agentId);
    if (!conn || conn.socket !== socket)
      return;

    conn.socket = null;
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

  sendCommand(agentId: string, event: string, payload: CommandPayload, replyTo: AgentSocket): void {
    timingLog('hub:command', {
      agentId,
      event,
      commandId: payload.commandId,
      ide: payload.ide,
      chars: payload.text?.length,
      preview: payload.text ? timingPreview(payload.text) : undefined,
    });
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
    if (payload.commandId) {
      this.pending.set(payload.commandId, { replyTo, agentId });
    }
    conn.socket.emit(event, payload);
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
    if (!result?.commandId)
      return;
    const target = this.pending.get(result.commandId);
    if (!target)
      return;
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
    this.pending.delete(result.commandId);
    target.replyTo.emit('command:result', result);
  }

  isActiveSocket(socket: AgentSocket): boolean {
    const agentId = this.socketToAgent.get(socket.id);
    if (!agentId)
      return false;
    return this.agents.get(agentId)?.socket === socket;
  }

  private failPending(agentId: string, error: string): void {
    for (const [commandId, pending] of this.pending) {
      if (pending.agentId !== agentId)
        continue;
      this.pending.delete(commandId);
      pending.replyTo.emit('command:result', {
        commandId,
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

      socket.on('agent:register', (info: AgentRegisterPayload) => {
        const boundId = typeof socket.data.tokenAgentId === 'string' ? socket.data.tokenAgentId : '';
        const reportedId = typeof info?.agentId === 'string' && info.agentId ? info.agentId : boundId;
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
          ...(info ?? {}),
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
        console.log(
          `[agent-hub] Agent registered: ${agentId} (${info?.hostname ?? agentId})`,
        );
      });

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
        // On the wire this is a bare assertion: a garbage-string ide is ignored and falls back to cursor
        // (same parseIde contract as state:patch — unknown kinds are not written into latestState / snapshot_json)
        this.directory.applyConnection(socket, {
          ide: isIdeKind(payload?.ide) ? payload.ide : undefined,
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

  forget(agentId: string): boolean {
    return this.directory.forget(agentId);
  }

  /** Console "Rename": `null` = clear the alias. false = this machine is not on the list. */
  setDisplayName(agentId: string, displayName: string | null): boolean {
    return this.directory.setDisplayName(agentId, displayName);
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

/** Rail child-row summary: only the two numbers the status dot and badge need */
function ideStatusOf(state: AgentIdesState): Partial<Record<IdeKind, MachineIdeStatus>> {
  const out: Partial<Record<IdeKind, MachineIdeStatus>> = {};
  for (const ide of IDE_KINDS) {
    const s = state.ides[ide];
    if (!s)
      continue;
    out[ide] = { connected: s.connected === true, pendingApprovals: s.pendingApprovals?.length ?? 0 };
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

/** Summary fingerprint: only broadcast machines:list when it changes */
function ideStatusSignature(state: AgentIdesState): string {
  const status = ideStatusOf(state);
  return IDE_KINDS.map((ide) => {
    const s = status[ide];
    return s ? `${s.connected ? '1' : '0'}:${s.pendingApprovals}` : '-';
  }).join('|');
}

function readIdePatch(payload: unknown): { ide: IdeKind; patch: Partial<CursorState> } {
  if (payload && typeof payload === 'object') {
    const rec = payload as Record<string, unknown>;
    if ('ide' in rec && rec.patch && typeof rec.patch === 'object') {
      return { ide: parseIde(rec.ide), patch: rec.patch as Partial<CursorState> };
    }
    return { ide: 'cursor', patch: rec as Partial<CursorState> };
  }
  return { ide: 'cursor', patch: {} };
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
