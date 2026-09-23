import type {
  CommandResult,
  CursorState,
  IdeKind,
  MachinesListPayload,
  SessionBodyPayload,
  SessionMissingPayload,
  SessionPatchPayload,
  SessionSyncPayload,
  StateFullWire,
  StatePatchWire,
  UserInfo,
} from './protocol';
import { useConnectionStore } from '../store/connection';
import { isSyntheticComposerId, liveSessionKeyOf, pendingMatchesTab, useIdesStore } from '../store/ides';
import { useMachinesStore } from '../store/machines';
import { sessionBodyKey, useSessionsStore } from '../store/sessions';
import { useUiStore } from '../store/ui';
import { useUserStore } from '../store/user';
import { parseIde } from './protocol';
import { resolveAwaitedCommand, socket } from './socket';

function currentLiveKey(): string {
  const { ides, selectedIde } = useIdesStore.getState();
  return liveSessionKeyOf(selectedIde, ides[selectedIde]);
}

/**
 * Cooldown window for "fetch body" on the same session: when the content source is missing (content machine
 * offline / session deleted) the server never replies with full, but every state:patch still hits ensureLiveBody —
 * without a gate that's tens of retries per second (2026-09-20: one server core at 100%, whole site spinning).
 * The happy path is unaffected: hasBody short-circuits after the body arrives; switching sessions changes the key
 * and immediately allows; while suppressed, one natural retry after 5s — slow if content never comes, but not a busy-loop on the server.
 */
const LIVE_BODY_RETRY_MS = 5000;
let liveBodyReqKey = '';
let liveBodyReqAt = 0;
let liveBodyRetryTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * When the cooldown expires, fire one more fetch: don't count on the next state:patch happening to knock —
 * a quiet page (IDE idle) gets no state push, and the skeleton would hang forever (2026-09-20 feedback).
 * Recheck item by item before retrying: switched away / got the body / confirmed missing, don't send.
 */
function scheduleLiveBodyRetry(key: string): void {
  if (liveBodyRetryTimer !== undefined)
    return;
  liveBodyRetryTimer = setTimeout(() => {
    liveBodyRetryTimer = undefined;
    const sessions = useSessionsStore.getState();
    if (currentLiveKey() !== key)
      return;
    if (sessions.bodies[key] || sessions.unavailable[key])
      return;
    ensureLiveBody();
  }, LIVE_BODY_RETRY_MS);
}

/**
 * maybeFollowActiveSession equivalent: missing live body → session:get (full).
 * On `verify`, even with a cache, reconcile once: send only `sinceSeq`; if the server agrees it replies
 * `session:sync` (a few bytes, no body retransmit); only a real gap gets a full.
 */
function ensureLiveBody(opts?: { verify?: boolean }): void {
  const key = currentLiveKey();
  if (!key)
    return;
  const sessions = useSessionsStore.getState();
  const hasBody = Boolean(sessions.bodies[key]);
  if (hasBody && !opts?.verify)
    return;
  // Content source has said "this session doesn't exist": don't auto-retry. After the session is on disk the server
  // pushes session:full (the named path in applySessionsIndex) and local state lifts the flag.
  if (sessions.unavailable[key])
    return;
  if (!opts?.verify) {
    // Reconnect reconcile (verify) is rare and skips the gate; all other retries are suppressed by the window.
    const now = Date.now();
    if (key === liveBodyReqKey && now - liveBodyReqAt < LIVE_BODY_RETRY_MS) {
      scheduleLiveBodyRetry(key);
      return;
    }
    liveBodyReqKey = key;
    liveBodyReqAt = now;
    scheduleLiveBodyRetry(key);
  }
  const { selectedIde } = useIdesStore.getState();
  const sessionId = key.slice(key.indexOf(':') + 1);
  const seq = hasBody ? sessions.bodySeq[key] : undefined;
  socket.emit('session:get', {
    sessionId,
    ide: selectedIde,
    ...(seq !== undefined ? { sinceSeq: seq } : {}),
  });
}

/** Incremental gap (append skipped a seq): refill from the local reconcile point, starting at the first missing packet. */
function resyncBody(payload: SessionBodyPayload): void {
  const sessionId = payload?.sessionId;
  if (!sessionId)
    return;
  const ide: IdeKind = parseIde(payload.ide);
  const seq = useSessionsStore.getState().bodySeq[sessionBodyKey(sessionId, ide)];
  socket.emit('session:get', {
    sessionId,
    ide,
    ...(seq !== undefined ? { sinceSeq: seq } : {}),
  });
}

/** Landed id in the switch_tab reply: the real id the server read back from the composer bar after clicking. */
function landedComposerIdOf(result: CommandResult): string {
  const data = result.data as { landedComposerId?: unknown } | undefined;
  const id = data?.landedComposerId;
  return typeof id === 'string' ? id : '';
}

/** Server state has landed on the target session → optimistic "switching" has reconciled. */
function reconcilePendingSwitch(ide: IdeKind, state: CursorState | undefined): void {
  const ui = useUiStore.getState();
  const pending = ui.pendingSwitch;
  if (!pending || pending.ide !== ide || !state)
    return;
  const activeWindowId = state.activeWindowId;
  const landed = (state.chatTabs ?? []).some(
    t => t.isActive && pendingMatchesTab(pending, t, t.windowId || activeWindowId),
  );
  if (landed)
    ui.clearPendingSwitch(pending.commandId);
}

/** socket events → store write entry. Called once from main.tsx at startup. */
export function bindSocket(): void {
  const connection = () => useConnectionStore.getState();
  const machines = () => useMachinesStore.getState();
  const sessions = () => useSessionsStore.getState();

  socket.on('connect', () => {
    connection().setStatus('online');
    machines().reselect();
    // Appends during the disconnect are not replayed — after reconnect, reconcile once (zero body transfer if consistent).
    ensureLiveBody({ verify: true });
  });
  socket.on('disconnect', (reason) => {
    connection().setStatus('offline');
    // Server-initiated disconnect (deploy restart, disconnectSockets): socket.io sets active=false and
    // **stops auto-reconnect** (official semantics: you must connect() yourself). Without this, every server
    // deploy would pin already-open pages on the reconnect screen forever until refresh (reproduced 2026-09-15).
    // Network disconnects (transport close / ping timeout) are retried by socket.io; don't fire twice.
    if (reason === 'io server disconnect')
      socket.connect();
  });

  socket.on('user:info', (data: UserInfo) => useUserStore.getState().setUser(data ?? { userId: '', avatar: '' }));

  socket.on('machines:list', (data: MachinesListPayload) => {
    machines().applyMachinesList(data?.machines ?? [], data?.cliLatest);
  });
  socket.on('agent:uplink', (data: { connected?: boolean }) => machines().applyUplink(!!data?.connected));

  socket.on('state:full', (wire: StateFullWire) => {
    useIdesStore.getState().applyStateFull(wire);
    ensureLiveBody();
    const { ides } = useIdesStore.getState();
    reconcilePendingSwitch('cursor', ides.cursor);
    reconcilePendingSwitch('codebuddy', ides.codebuddy);
  });
  socket.on('state:patch', (wire: StatePatchWire) => {
    useIdesStore.getState().applyStatePatch(wire);
    ensureLiveBody();
    const { ides } = useIdesStore.getState();
    reconcilePendingSwitch('cursor', ides.cursor);
    reconcilePendingSwitch('codebuddy', ides.codebuddy);
  });

  socket.on('session:full', (payload: SessionBodyPayload) => sessions().applySessionFull(payload, currentLiveKey()));
  socket.on('session:unavailable', (payload: SessionMissingPayload) => sessions().applySessionUnavailable(payload));
  socket.on('session:append', (payload: SessionBodyPayload) => {
    const outcome = sessions().applySessionAppend(payload, currentLiveKey());
    if (outcome === 'gap')
      resyncBody(payload);
  });
  socket.on('session:patch', (payload: SessionPatchPayload) => {
    sessions().applySessionPatch(payload, currentLiveKey());
  });
  socket.on('session:sync', (payload: SessionSyncPayload) => sessions().applySessionSync(payload));

  socket.on('command:result', (result: CommandResult) => {
    // Await-result first (get_plan_full etc.); otherwise pendingSend reconcile.
    if (resolveAwaitedCommand(result))
      return;
    sessions().resolveCommandResult(result);
    // Optimistic "switching" reconcile: the server clicked and read back the composer bar; the result is whether the switch landed.
    //   - failure (including "clicked but landed on another session") → drop + explain;
    //   - success → become "confirmed", highlight stays on the target row, drop once state catches up.
    //     The reply arrives before state: dropping now would flash highlight back to the old active row.
    const ui = useUiStore.getState();
    const pending = ui.pendingSwitch;
    if (!pending || pending.commandId !== result.commandId)
      return;
    if (!result.ok) {
      ui.clearPendingSwitch(pending.commandId);
      ui.pushToast(`切换到「${pending.title || '未命名'}」失败：${result.error ?? '未知错误'}`, 'error');
      return;
    }
    const landed = landedComposerIdOf(result);
    if (landed && !isSyntheticComposerId(pending.composerId) && landed !== pending.composerId) {
      ui.clearPendingSwitch(pending.commandId);
      ui.pushToast(`「${pending.title || '未命名'}」切到了别的会话（${landed.slice(0, 8)}…）`, 'error');
      return;
    }
    ui.confirmPendingSwitch(pending.commandId, landed || undefined);
  });

  // IDE CDP connection state: phase 2 lands UI (P8c); here we only consume as a placeholder.
  socket.on('connection:status', () => {});
}

export { sessionBodyKey };
