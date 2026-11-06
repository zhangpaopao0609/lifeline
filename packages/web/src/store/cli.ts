import type {
  ChatElement,
  CliAppend,
  CliApproval,
  CliApprovalEvent,
  CliApprovalOption,
  CliApprovalResolved,
  CliAvailability,
  CliFull,
  CliModelCatalog,
  CliSessionCreated,
  CliSessionRemoved,
  CliSessionStatus,
  CliSnapshot,
  CliSource,
  CliStatus,
  IdeKind,
} from '../net/protocol';
import { create } from 'zustand';
import { mergeById } from '../lib/session-page';
import { cliAppendSchema, cliSnapshotSchema, isCliPlatform, isCliSource, validateInbound } from '../net/protocol';

function isListedCliSource(source: unknown): source is CliSource {
  return isCliSource(source);
}

/** No matching full for this long triggers one automatic sync. The next miss is `sync-error`. */
export const CLI_FULL_TIMEOUT_MS = 120_000;

export const CLI_RESTART_NOTICE = '本机 agent 已重启，原 CLI 会话已失效';

export const CLI_ACTION_BAR_MAX_HEIGHT = 'min(32dvh, 220px)';

/** Short viewports fold the approval stack to one line. */
export const CLI_BAR_FOLD_VIEWPORT_PX = 480;

/** Soft keyboard: the visual viewport sits at least this far below `innerHeight`. */
export const CLI_BAR_KEYBOARD_INSET_PX = 100;

const CLI_AVAILABILITY = new Set<CliAvailability>(['unknown', 'ready', 'binary-missing', 'credential-required', 'error']);

const CLI_INTERFACE_STATES = ['already-resolved', 'unsupported-permission-option', 'busy', 'sync-error'] as const;

export type CliInterfaceName = (typeof CLI_INTERFACE_STATES)[number];

export const CLI_SOURCE_LABEL: Record<CliSource, string> = {
  'cursor-cli': 'Cursor 命令行',
  'codebuddy-cli': 'CodeBuddy 命令行',
  'codex-cli': 'Codex 命令行',
};

/** The person picks an agent. Which process runs it stays behind this name. */
export const CLI_AGENT_LABEL: Record<CliSource, string> = {
  'cursor-cli': 'Cursor',
  'codebuddy-cli': 'CodeBuddy',
  'codex-cli': 'Codex',
};

export type ActiveTarget
  = | { kind: 'ide'; ide: IdeKind }
    | { kind: 'cli-home'; agentId: string }
    | { kind: 'cli'; agentId: string; epoch: string; source: CliSource; sessionId: string };

export type CliSyncStatus = 'idle' | 'watching' | 'retrying' | 'sync-error';

export interface CliSessionState {
  key: string;
  agentId: string;
  epoch: string;
  source: CliSource;
  sessionId: string;
  cwd: string;
  title?: string;
  /** Label of the session's current model. */
  model?: string;
  catalog?: CliModelCatalog;
  /** Shell line that resumes this session in a local terminal. */
  resumeCommand?: string;
  status: CliSessionStatus;
  seq: number;
  expectedSeq: number;
  snapshotId: string | null;
  /** Inventory sessions only accept a full for their snapshot. `session-created` sessions do not. */
  boundToSnapshot: boolean;
  messages: ChatElement[];
  approvals: CliApproval[];
  awaitingFull: boolean;
  desynced: boolean;
  error?: string;
}

interface CliAgentState {
  epoch: string | null;
  syncStatus: CliSyncStatus;
  fullDeadlineAt: number | null;
  autoSyncUsed: boolean;
  syncInFlight: boolean;
  syncQueued: boolean;
  pendingEpoch: string | null;
  /** Epochs this agent has already left. A `session-created` for one of them is stale. */
  leftEpochs: string[];
  sessions: Record<string, CliSessionState>;
  order: string[];
}

export interface CliState {
  connected: boolean;
  /** Empty means the page has not chosen a machine, so every agent's timer may run. */
  selectedAgentId: string;
  agents: Record<string, CliAgentState>;
}

export type CliEffect
  = | { type: 'sync' }
    | { type: 'restart-notice'; text: string }
    | { type: 'open-session'; agentId: string; epoch: string; source: CliSource; sessionId: string };

export type CliEvent
  = | { type: 'snapshot'; agentId: string; snapshot: CliSnapshot; now: number }
    | { type: 'full'; agentId: string; full: CliFull; now: number }
    | { type: 'append'; agentId: string; append: CliAppend; now: number }
    | { type: 'session-created'; agentId: string; created: CliSessionCreated }
    | { type: 'session-removed'; agentId: string; removed: CliSessionRemoved; now: number }
    | { type: 'status'; agentId: string; status: CliStatus }
    | { type: 'approval'; agentId: string; approval: CliApprovalEvent }
    | { type: 'approval-resolved'; agentId: string; resolved: CliApprovalResolved }
    | { type: 'disconnect' }
    | { type: 'reconnect'; now: number }
    | { type: 'tick'; now: number }
    | { type: 'manual-retry'; now: number }
    | { type: 'select-agent'; agentId: string };

export interface CliApprovalCardState {
  disabled: boolean;
  phase: 'pending' | 'resolving';
  notice: 'already-resolved' | 'unsupported-permission-option' | null;
}

export type CliPermissionUi
  = | { ok: true }
    | { ok: false; ui: CliInterfaceName | 'failed' };

export interface SendGate {
  draft: string;
  ideConnected: boolean;
  contentOnly: boolean;
  machineOffline: boolean;
  uplinkConnected: boolean;
  machineConnected: boolean;
  pendingSwitch: boolean;
  working: boolean;
  hasIdeTarget: boolean;
  cliStatus: CliSessionStatus | null;
}

export function cliSessionKey(agentId: string, epoch: string, source: string, sessionId: string): string {
  return `${agentId}\0${epoch}\0${source}\0${sessionId}`;
}

export function cliTargetKey(target: { agentId: string; epoch: string; source: string; sessionId: string }): string {
  return `${target.agentId}:${target.epoch}:${target.source}:${target.sessionId}`;
}

export function cliSourceLabel(source: CliSource): string {
  return CLI_SOURCE_LABEL[source];
}

export function cliAgentLabel(source: CliSource): string {
  return CLI_AGENT_LABEL[source];
}

export function cliAvailabilityLabel(availability: string): string {
  switch (availability) {
    case 'ready': return '可用';
    case 'unknown': return '未检测';
    case 'binary-missing': return '未安装';
    case 'credential-required': return '需要登录';
    case 'error': return '不可用';
    default: return '';
  }
}

export function cliStatusLabel(status: CliSessionStatus): string {
  switch (status) {
    case 'starting': return '启动中';
    case 'idle': return '空闲';
    case 'running': return '进行中';
    case 'waiting_approval': return '待审批';
    case 'error': return '出错';
    case 'exited': return '已退出';
    case 'closing': return '关闭中';
    default: return status;
  }
}

export function createCliState(): CliState {
  return { connected: true, selectedAgentId: '', agents: {} };
}

/**
 * Entry check for epoch, source, sessionId, seq, and snapshotId.
 * Ids stay opaque strings, reusing the snapshot cwd schema. Source and seq use the CLI schemas.
 * Envelope byte budgets stay on the server and are not repeated here.
 */
const storeId = cliSnapshotSchema.shape.sessions.element.shape.cwd;
const storeSource = cliAppendSchema.shape.source;
const storeSeq = cliAppendSchema.shape.seq;

function storeIdOk(value: unknown): boolean {
  return validateInbound(storeId, value, 'drop-and-log').ok;
}

function storeSourceOk(value: unknown): boolean {
  return validateInbound(storeSource, value, 'drop-and-log').ok;
}

function storeSeqOk(value: unknown): boolean {
  return validateInbound(storeSeq, value, 'drop-and-log').ok;
}

function storeEventOk(event: CliEvent): boolean {
  switch (event.type) {
    case 'snapshot': {
      const snapshot = event.snapshot;
      if (!storeIdOk(snapshot?.epoch) || !storeIdOk(snapshot?.snapshotId) || !Array.isArray(snapshot?.sessions))
        return false;
      return snapshot.sessions.every(row => storeSourceOk(row?.source) && storeIdOk(row?.sessionId) && storeSeqOk(row?.seq));
    }
    case 'full':
      return storeIdOk(event.full?.epoch)
        && storeIdOk(event.full?.snapshotId)
        && storeSourceOk(event.full?.source)
        && storeIdOk(event.full?.sessionId)
        && storeSeqOk(event.full?.seq);
    case 'append':
      return storeIdOk(event.append?.epoch)
        && storeSourceOk(event.append?.source)
        && storeIdOk(event.append?.sessionId)
        && storeSeqOk(event.append?.seq);
    case 'session-created':
      return storeIdOk(event.created?.epoch)
        && storeSourceOk(event.created?.source)
        && storeIdOk(event.created?.sessionId)
        && storeSeqOk(event.created?.seq);
    case 'session-removed':
      return storeIdOk(event.removed?.epoch)
        && storeSourceOk(event.removed?.source)
        && storeIdOk(event.removed?.sessionId);
    case 'status':
      return storeIdOk(event.status?.epoch)
        && storeSourceOk(event.status?.source)
        && storeIdOk(event.status?.sessionId);
    case 'approval':
      return storeIdOk(event.approval?.epoch)
        && storeSourceOk(event.approval?.source)
        && storeIdOk(event.approval?.sessionId);
    case 'approval-resolved':
      return storeIdOk(event.resolved?.epoch)
        && storeSourceOk(event.resolved?.source)
        && storeIdOk(event.resolved?.sessionId);
    default:
      return true;
  }
}

export function applyCliEvent(state: CliState, event: CliEvent): { state: CliState; effects: CliEffect[] } {
  if (!storeEventOk(event))
    return { state, effects: [] };
  const next = structuredClone(state);
  const effects: CliEffect[] = [];
  switch (event.type) {
    case 'snapshot':
      applySnapshot(next, event.agentId, event.snapshot, event.now, effects);
      break;
    case 'full':
      applyFull(next, event.agentId, event.full, event.now, effects);
      break;
    case 'append':
      applyAppend(next, event.agentId, event.append, effects);
      break;
    case 'session-created':
      applyCreated(next, event.agentId, event.created, effects);
      break;
    case 'session-removed':
      applyRemoved(next, event.agentId, event.removed, event.now);
      break;
    case 'status':
      applyStatus(next, event.agentId, event.status);
      break;
    case 'approval':
      applyApproval(next, event.agentId, event.approval);
      break;
    case 'approval-resolved':
      applyApprovalResolved(next, event.agentId, event.resolved);
      break;
    case 'disconnect':
      next.connected = false;
      for (const agent of Object.values(next.agents))
        agent.fullDeadlineAt = null;
      break;
    case 'reconnect':
      next.connected = true;
      effects.push({ type: 'sync' });
      for (const [agentId, agent] of Object.entries(next.agents)) {
        if (!agent.order.some(key => agent.sessions[key]?.awaitingFull))
          continue;
        if (!timerArmed(next, agentId) || agent.syncStatus === 'sync-error')
          continue;
        agent.fullDeadlineAt = event.now + CLI_FULL_TIMEOUT_MS;
      }
      break;
    case 'tick':
      applyTick(next, event.now, effects);
      break;
    case 'manual-retry':
      applyManualRetry(next, event.now, effects);
      break;
    case 'select-agent':
      next.selectedAgentId = event.agentId;
      for (const agent of Object.values(next.agents))
        agent.fullDeadlineAt = null;
      break;
  }
  return { state: next, effects };
}

export function sessionsOf(agent: CliAgentState | undefined): CliSessionState[] {
  if (!agent)
    return [];
  return agent.order.flatMap(key => agent.sessions[key] ? [agent.sessions[key]] : []);
}

export function cliSession(state: CliState, agentId: string, sessionId: string): CliSessionState | undefined {
  const agent = state.agents[agentId];
  if (!agent)
    return undefined;
  return sessionsOf(agent).find(session => session.sessionId === sessionId);
}

export function cliApprovals(state: CliState, agentId: string): CliApproval[] {
  return sessionsOf(state.agents[agentId]).flatMap(session => session.approvals);
}

export function cliAwaitingFull(state: CliState, agentId: string): string[] {
  return sessionsOf(state.agents[agentId]).filter(session => session.awaitingFull).map(session => session.sessionId);
}

export function cliDeadline(state: CliState, agentId: string): number | null {
  return state.agents[agentId]?.fullDeadlineAt ?? null;
}

export function cliSyncStatus(state: CliState, agentId: string): CliSyncStatus {
  return state.agents[agentId]?.syncStatus ?? 'idle';
}

export function cliEpoch(state: CliState, agentId: string): string | null {
  return state.agents[agentId]?.epoch ?? null;
}

export function cliApprovalPending(state: CliState, agentId: string, approvalId: string): boolean {
  return cliApprovals(state, agentId).some(item => item.approvalId === approvalId && item.state === 'pending');
}

export function nextActiveTarget(target: ActiveTarget, agentId: string, epoch: string, fallbackIde: IdeKind): ActiveTarget {
  if (target.kind === 'cli' && target.agentId === agentId && target.epoch !== epoch)
    return { kind: 'ide', ide: fallbackIde };
  return target;
}

export function canSendForTarget(target: ActiveTarget, gate: SendGate): boolean {
  if (target.kind === 'cli') {
    return gate.draft.trim().length > 0
      && gate.uplinkConnected
      && gate.machineConnected
      && gate.cliStatus === 'idle';
  }
  return gate.draft.trim().length > 0
    && gate.hasIdeTarget
    && !gate.machineOffline
    && !gate.contentOnly
    && !gate.pendingSwitch
    && !gate.working
    && gate.ideConnected;
}

export function cliCanStop(gate: Pick<SendGate, 'uplinkConnected' | 'machineConnected' | 'cliStatus'>): boolean {
  return gate.uplinkConnected
    && gate.machineConnected
    && (gate.cliStatus === 'running' || gate.cliStatus === 'waiting_approval');
}

export function cliComposeBlock(status: CliSessionStatus | null): 'busy' | null {
  if (status === 'running' || status === 'waiting_approval')
    return 'busy';
  return null;
}

export function composerDraftBucket(target: ActiveTarget): string {
  if (target.kind === 'ide')
    return 'ide';
  if (target.kind === 'cli-home')
    return `cli-home:${target.agentId}`;
  return cliTargetKey(target);
}

export function writeComposerDraft(drafts: Record<string, string>, target: ActiveTarget, text: string): Record<string, string> {
  return { ...drafts, [composerDraftBucket(target)]: text };
}

export function readComposerDraft(drafts: Record<string, string>, target: ActiveTarget): string {
  return drafts[composerDraftBucket(target)] ?? '';
}

/**
 * Rail dot for the Agent CLI row.
 * `on` only while a CLI session is actually open. A leftover `ready` from a
 * session that already closed is not a live CLI. `hidden` when this machine
 * has not reported a list, or nothing is open and nothing has failed:
 * drawing gray there would look like a failure. `off` when the machine is
 * offline or every reported CLI failed.
 *
 * `liveSessionCount` is omitted until this page has a snapshot for the machine.
 * Until then, `ready` still means a session is open.
 */
export function cliRailDot(
  machineConnected: boolean,
  sources: ReadonlyArray<{ availability: string }>,
  liveSessionCount?: number,
): 'on' | 'off' | 'hidden' {
  if (sources.length === 0)
    return 'hidden';
  if (!machineConnected)
    return 'off';
  if (liveSessionCount != null) {
    if (liveSessionCount > 0)
      return 'on';
    if (sources.some(row => row.availability !== 'unknown' && row.availability !== 'ready'))
      return 'off';
    return 'hidden';
  }
  if (sources.some(row => row.availability === 'ready'))
    return 'on';
  if (sources.every(row => row.availability === 'unknown'))
    return 'hidden';
  return 'off';
}

export function visibleCliSources(machine: { platform?: string; cliSources?: unknown } | null | undefined): Array<{ source: CliSource; availability: CliAvailability }> {
  if (!machine || !isCliPlatform(machine.platform) || !Array.isArray(machine.cliSources))
    return [];
  const out: Array<{ source: CliSource; availability: CliAvailability }> = [];
  for (const row of machine.cliSources) {
    if (!row || typeof row !== 'object')
      continue;
    const source = (row as { source?: unknown }).source;
    const availability = (row as { availability?: unknown }).availability;
    if (!isListedCliSource(source) || typeof availability !== 'string' || !CLI_AVAILABILITY.has(availability as CliAvailability))
      continue;
    out.push({ source, availability: availability as CliAvailability });
  }
  return out;
}

export function paletteCliEntries(machine: { platform?: string; cliSources?: unknown } | null | undefined): Array<{ id: string; label: string; source: CliSource; availability: CliAvailability }> {
  return visibleCliSources(machine).map(row => ({
    id: `cli:${row.source}`,
    label: CLI_SOURCE_LABEL[row.source],
    source: row.source,
    availability: row.availability,
  }));
}

export function isCliActionBarFolded(viewportHeight: number, keyboardInset: number): boolean {
  return viewportHeight <= CLI_BAR_FOLD_VIEWPORT_PX || keyboardInset >= CLI_BAR_KEYBOARD_INSET_PX;
}

export function visibleCliApprovals(approvals: readonly CliApproval[], folded: boolean): { expanded: CliApproval | null; foldedLine: string | null; extraCount: number } {
  const pending = approvals.filter(item => item.state === 'pending');
  if (pending.length === 0)
    return { expanded: null, foldedLine: null, extraCount: 0 };
  if (folded)
    return { expanded: null, foldedLine: `有 ${pending.length} 个待审批`, extraCount: 0 };
  return { expanded: pending[0] ?? null, foldedLine: null, extraCount: pending.length - 1 };
}

export function cliApprovalCardOnClick(card: CliApprovalCardState): CliApprovalCardState {
  return { ...card, disabled: true, phase: 'resolving' };
}

export function cliApprovalCardOnResult(card: CliApprovalCardState, result: CliPermissionUi, snapshotStillPending: boolean): CliApprovalCardState {
  if (result.ok)
    return { ...card, disabled: true, phase: 'resolving', notice: null };
  if (result.ui === 'already-resolved' || result.ui === 'unsupported-permission-option')
    return { disabled: true, phase: 'resolving', notice: result.ui };
  if (snapshotStillPending)
    return { disabled: false, phase: 'pending', notice: null };
  return { disabled: true, phase: 'resolving', notice: card.notice };
}

export function cliPermissionChoice(option: CliApprovalOption): { kind: 'selected'; optionId: string } | { kind: 'unsupported-permission-option' } {
  if (option.kind === 'unknown')
    return { kind: 'unsupported-permission-option' };
  return { kind: 'selected', optionId: option.optionId };
}

export function cliInterfaceState(result: { ok: boolean; error?: string; errorCode?: string; data?: unknown }): CliPermissionUi {
  if (result.ok)
    return { ok: true };
  const data = result.data;
  const fromData = data && typeof data === 'object' && 'state' in data && typeof data.state === 'string'
    ? data.state
    : undefined;
  const raw = fromData ?? result.error;
  if (typeof raw === 'string' && (CLI_INTERFACE_STATES as readonly string[]).includes(raw))
    return { ok: false, ui: raw as CliInterfaceName };
  return { ok: false, ui: 'failed' };
}

function emptyAgent(): CliAgentState {
  return {
    epoch: null,
    syncStatus: 'idle',
    fullDeadlineAt: null,
    autoSyncUsed: false,
    syncInFlight: false,
    syncQueued: false,
    pendingEpoch: null,
    leftEpochs: [],
    sessions: {},
    order: [],
  };
}

function ensureAgent(state: CliState, agentId: string): CliAgentState {
  const existing = state.agents[agentId];
  if (existing)
    return existing;
  const created = emptyAgent();
  state.agents[agentId] = created;
  return created;
}

function timerArmed(state: CliState, agentId: string): boolean {
  return state.connected && (state.selectedAgentId === '' || state.selectedAgentId === agentId);
}

function requestSync(agent: CliAgentState, effects: CliEffect[]): void {
  if (agent.syncInFlight) {
    agent.syncQueued = true;
    return;
  }
  agent.syncInFlight = true;
  effects.push({ type: 'sync' });
}

function findSession(agent: CliAgentState, source: string, sessionId: string): CliSessionState | undefined {
  return sessionsOf(agent).find(session => session.source === source && session.sessionId === sessionId);
}

function refreshWait(state: CliState, agentId: string, agent: CliAgentState, now: number): void {
  const waiting = agent.order.some(key => agent.sessions[key]?.awaitingFull);
  if (!waiting) {
    agent.fullDeadlineAt = null;
    agent.autoSyncUsed = false;
    agent.syncStatus = 'idle';
    return;
  }
  agent.syncStatus = agent.autoSyncUsed ? 'retrying' : 'watching';
  agent.fullDeadlineAt = timerArmed(state, agentId) ? now + CLI_FULL_TIMEOUT_MS : null;
}

function applySnapshot(state: CliState, agentId: string, snapshot: CliSnapshot, now: number, effects: CliEffect[]): void {
  if (!snapshot || typeof snapshot.epoch !== 'string' || snapshot.epoch.length === 0 || !Array.isArray(snapshot.sessions))
    return;
  const agent = ensureAgent(state, agentId);
  const prevEpoch = agent.epoch;
  const prevSessions = agent.sessions;
  if (prevEpoch && prevEpoch !== snapshot.epoch) {
    effects.push({ type: 'restart-notice', text: CLI_RESTART_NOTICE });
    if (!agent.leftEpochs.includes(prevEpoch))
      agent.leftEpochs.push(prevEpoch);
    agent.autoSyncUsed = false;
  }
  const pending = agent.pendingEpoch;
  agent.epoch = snapshot.epoch;
  agent.pendingEpoch = null;
  agent.syncInFlight = false;
  agent.syncQueued = false;
  agent.sessions = {};
  agent.order = [];
  for (const row of snapshot.sessions) {
    const key = cliSessionKey(agentId, snapshot.epoch, row.source, row.sessionId);
    const prev = prevEpoch === snapshot.epoch ? prevSessions[key] : undefined;
    const session: CliSessionState = {
      key,
      agentId,
      epoch: snapshot.epoch,
      source: row.source,
      sessionId: row.sessionId,
      cwd: row.cwd,
      status: row.status,
      seq: row.seq,
      expectedSeq: row.seq,
      snapshotId: snapshot.snapshotId,
      boundToSnapshot: true,
      messages: prev ? [...prev.messages] : [],
      approvals: row.approvals.map(item => ({ ...item, options: item.options.map(option => ({ ...option })) })),
      awaitingFull: true,
      desynced: false,
    };
    if (row.title !== undefined)
      session.title = row.title;
    if (row.model !== undefined)
      session.model = row.model;
    if (row.catalog !== undefined)
      session.catalog = copyCatalog(row.catalog);
    if (row.resumeCommand !== undefined)
      session.resumeCommand = row.resumeCommand;
    agent.sessions[key] = session;
    agent.order.push(key);
  }
  refreshWait(state, agentId, agent, now);
  if (pending && pending !== snapshot.epoch)
    requestSync(agent, effects);
}

function applyFull(state: CliState, agentId: string, full: CliFull, now: number, effects: CliEffect[]): void {
  const agent = state.agents[agentId];
  if (!agent?.epoch || full.epoch !== agent.epoch)
    return;
  const session = findSession(agent, full.source, full.sessionId);
  if (!session) {
    requestSync(agent, effects);
    return;
  }
  if (session.boundToSnapshot && full.snapshotId !== session.snapshotId)
    return;
  if (!session.awaitingFull || full.seq !== session.expectedSeq) {
    if (session.awaitingFull && full.seq > session.expectedSeq)
      requestSync(agent, effects);
    return;
  }
  session.messages = Array.isArray(full.messages) ? [...full.messages] : [];
  session.seq = full.seq;
  session.awaitingFull = false;
  session.desynced = false;
  refreshWait(state, agentId, agent, now);
}

function applyAppend(state: CliState, agentId: string, append: CliAppend, effects: CliEffect[]): void {
  const agent = state.agents[agentId];
  if (!agent?.epoch || append.epoch !== agent.epoch)
    return;
  const session = findSession(agent, append.source, append.sessionId);
  if (!session) {
    requestSync(agent, effects);
    return;
  }
  if (session.awaitingFull) {
    session.desynced = true;
    requestSync(agent, effects);
    return;
  }
  if (append.seq <= session.seq)
    return;
  if (append.seq === session.seq + 1) {
    session.messages = mergeById(session.messages, Array.isArray(append.messages) ? append.messages : []);
    session.seq = append.seq;
    session.desynced = false;
    return;
  }
  session.desynced = true;
  requestSync(agent, effects);
}

function applyCreated(state: CliState, agentId: string, created: CliSessionCreated, effects: CliEffect[]): void {
  const agent = ensureAgent(state, agentId);
  if (!agent.epoch) {
    requestSync(agent, effects);
    return;
  }
  if (agent.leftEpochs.includes(created.epoch))
    return;
  if (created.epoch !== agent.epoch) {
    agent.pendingEpoch = created.epoch;
    requestSync(agent, effects);
    return;
  }
  const existing = findSession(agent, created.source, created.sessionId);
  if (existing) {
    existing.status = created.status;
    existing.cwd = created.cwd;
    return;
  }
  const key = cliSessionKey(agentId, created.epoch, created.source, created.sessionId);
  const session: CliSessionState = {
    key,
    agentId,
    epoch: created.epoch,
    source: created.source,
    sessionId: created.sessionId,
    cwd: created.cwd,
    status: created.status,
    seq: created.seq,
    expectedSeq: created.seq,
    snapshotId: null,
    boundToSnapshot: false,
    messages: [],
    approvals: [],
    awaitingFull: true,
    desynced: false,
  };
  agent.sessions[key] = session;
  agent.order.push(key);
  refreshWait(state, agentId, agent, Date.now());
  if (created.status === 'starting') {
    effects.push({
      type: 'open-session',
      agentId,
      epoch: created.epoch,
      source: created.source,
      sessionId: created.sessionId,
    });
  }
}

function applyRemoved(state: CliState, agentId: string, removed: CliSessionRemoved, now: number): void {
  const agent = state.agents[agentId];
  if (!agent?.epoch || removed.epoch !== agent.epoch)
    return;
  const session = findSession(agent, removed.source, removed.sessionId);
  if (!session)
    return;
  delete agent.sessions[session.key];
  agent.order = agent.order.filter(key => key !== session.key);
  refreshWait(state, agentId, agent, now);
}

function applyStatus(state: CliState, agentId: string, status: CliStatus): void {
  const agent = state.agents[agentId];
  if (!agent?.epoch || status.epoch !== agent.epoch)
    return;
  const session = findSession(agent, status.source, status.sessionId);
  if (!session)
    return;
  session.status = status.status;
  if (status.model !== undefined)
    session.model = status.model;
  if (status.catalog !== undefined)
    session.catalog = copyCatalog(status.catalog);
  if (status.resumeCommand !== undefined)
    session.resumeCommand = status.resumeCommand;
  session.error = status.error;
}

function copyCatalog(catalog: CliModelCatalog): CliModelCatalog {
  return {
    models: catalog.models.map(model => ({
      id: model.id,
      label: model.label,
      ...(model.thinking
        ? {
            thinking: {
              levels: model.thinking.levels.map(level => ({ value: level.value, label: level.label })),
              ...(model.thinking.current !== undefined ? { current: model.thinking.current } : {}),
            },
          }
        : {}),
    })),
    ...(catalog.currentModelId !== undefined ? { currentModelId: catalog.currentModelId } : {}),
    ...(catalog.thinking
      ? {
          thinking: {
            levels: catalog.thinking.levels.map(level => ({ value: level.value, label: level.label })),
            ...(catalog.thinking.current !== undefined ? { current: catalog.thinking.current } : {}),
          },
        }
      : {}),
  };
}

function applyApproval(state: CliState, agentId: string, event: CliApprovalEvent): void {
  const agent = state.agents[agentId];
  if (!agent?.epoch || event.epoch !== agent.epoch)
    return;
  const session = findSession(agent, event.source, event.sessionId);
  if (!session)
    return;
  const index = session.approvals.findIndex(item => item.approvalId === event.approval.approvalId);
  if (index === -1)
    session.approvals = [...session.approvals, event.approval];
  else
    session.approvals = session.approvals.map((item, i) => i === index ? event.approval : item);
}

function applyApprovalResolved(state: CliState, agentId: string, event: CliApprovalResolved): void {
  const agent = state.agents[agentId];
  if (!agent?.epoch || event.epoch !== agent.epoch)
    return;
  const session = findSession(agent, event.source, event.sessionId);
  if (!session)
    return;
  session.approvals = session.approvals.map(item => item.approvalId === event.approvalId
    ? { ...item, state: 'resolved' }
    : item);
}

function applyTick(state: CliState, now: number, effects: CliEffect[]): void {
  if (!state.connected)
    return;
  for (const [agentId, agent] of Object.entries(state.agents)) {
    if (agent.fullDeadlineAt == null || now < agent.fullDeadlineAt)
      continue;
    if (!timerArmed(state, agentId))
      continue;
    if (!agent.autoSyncUsed) {
      agent.autoSyncUsed = true;
      agent.syncStatus = 'retrying';
      agent.fullDeadlineAt = now + CLI_FULL_TIMEOUT_MS;
      requestSync(agent, effects);
      continue;
    }
    agent.syncStatus = 'sync-error';
    agent.fullDeadlineAt = null;
    agent.syncInFlight = false;
    agent.syncQueued = false;
  }
}

function applyManualRetry(state: CliState, now: number, effects: CliEffect[]): void {
  for (const [agentId, agent] of Object.entries(state.agents)) {
    if (agent.syncStatus !== 'sync-error')
      continue;
    if (state.selectedAgentId && state.selectedAgentId !== agentId)
      continue;
    agent.syncStatus = 'retrying';
    agent.autoSyncUsed = true;
    agent.fullDeadlineAt = timerArmed(state, agentId) ? now + CLI_FULL_TIMEOUT_MS : null;
    agent.syncInFlight = false;
    requestSync(agent, effects);
    break;
  }
}

type CliEffectHandler = (before: CliState, after: CliState, effects: CliEffect[]) => void;

let effectHandler: CliEffectHandler = () => {};

export function setCliEffectHandler(handler: CliEffectHandler): void {
  effectHandler = handler;
}

interface CliStore {
  cli: CliState;
  apply: (event: CliEvent) => CliEffect[];
}

export const useCliStore = create<CliStore>()((set, get) => ({
  cli: createCliState(),
  apply: (event) => {
    const { state, effects } = applyCliEvent(get().cli, event);
    set({ cli: state });
    return effects;
  },
}));

export function dispatchCli(event: CliEvent): CliEffect[] {
  const before = useCliStore.getState().cli;
  const effects = useCliStore.getState().apply(event);
  effectHandler(before, useCliStore.getState().cli, effects);
  return effects;
}
