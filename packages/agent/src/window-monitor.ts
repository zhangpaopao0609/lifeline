import type { CDPBridge } from './cdp/bridge.js';
import type { CodingCopilotTargetFields } from './drivers/codebuddy/extractor.js';
import type { CodeBuddyLiveDump } from './drivers/codebuddy/live.js';
import type { AgentsWindowDump } from './drivers/cursor/agents-window.js';
import type { StateManager } from './state-manager.js';
import type {
  AgentConfig,
  AgentStatus,
  Approval,
  ChatElement,
  ChatTab,
  ComposerQueueState,
  CursorState,
  CursorWindow,
  IdeKind,
  ModeInfo,
  ModelInfo,
  Questionnaire,
  SelectorConfig,
} from './types.js';
import { EventEmitter } from 'node:events';
import { extractWorkspaceName } from './cdp/bridge.js';
import { CdpClient } from './cdp/client.js';
import {

  dumpCodeBuddyLive,
  pickCodingCopilotTarget,
} from './drivers/codebuddy/extractor.js';
import { mapCodeBuddyLive } from './drivers/codebuddy/live.js';
import {
  AGENTS_DUMP_TIMEOUT_MS,

  dumpAgentsWindow,
  mapAgentsWindowDump,
} from './drivers/cursor/agents-window.js';
import { EVALUATE_TIMEOUT_MS } from './drivers/cursor/extractor.js';
import { postProcessCursorState } from './drivers/cursor/tab-identity.js';
import { emptyCursorState } from './types.js';

/**
 * Both IDEs poll other windows without switching the home CDP target.
 *  Cursor evaluates the workbench page; CodeBuddy evaluates that window's
 *  coding-copilot webview (Mini 2026-09-14: tabs survive hide).
 */
export function shouldParallelExtractLive(_kind: IdeKind): boolean {
  return true;
}

export interface WindowMonitorOptions {
  kind?: IdeKind;
  /**
   * Whether a non-home window must have a wsUrl to join parallel polling
   * (driver declaration: cursor true — only workbench windows have wsUrl;
   * codebuddy false — coding-copilot webview windows have no wsUrl and poll
   * their own webview). Default true.
   */
  otherWindowsRequireWsUrl?: boolean;
  extractFromClient?: (client: CdpClient, windowTitle: string) => Promise<CursorState | null>;
  listTargets?: () => Promise<CodingCopilotTargetFields[]>;
  extractCodeBuddyLive?: (wsUrl: string) => Promise<CursorState | null>;
}

export interface WindowSnapshot {
  windowId: string;
  windowTitle: string;
  messages: ChatElement[];
  chatTabs: ChatTab[];
  pendingApprovals: Approval[];
  agentStatus: AgentStatus;
  agentActivityText: string | null;
  agentActivityLive: boolean;
  agentActivitySource: CursorState['agentActivitySource'];
  composerQueue: ComposerQueueState;
  mode: ModeInfo;
  model: ModelInfo;
  /**
   * Agent multiple-choice questionnaire widget for this window, if present.
   *  Extracted per window so its card can be routed to the correct topic even
   *  when the window is not the active CDP home window. Null when absent.
   */
  questionnaire: Questionnaire | null;
  lastUpdated: number;
  /**
   * data-composer-id of the active composer in this window. Same agent shown
   *  via Cursor's global rail in another window will share this id; two
   *  different agents that happen to share a tab title will not. Used by
   *  topic-manager to disambiguate. Empty string if not extractable.
   */
  activeComposerId: string;
}

const CYCLE_INTERVAL_MS = 10000;
/** Tighten polling when a background window is running: let "finished" land soon, do not leave a fake loading. */
const CYCLE_ACTIVE_INTERVAL_MS = 2500;

/**
 * Type-specific content key for a single element.
 * Returns a string that changes whenever the element's visible content changes.
 */
function elementContentKey(el: ChatElement): string {
  switch (el.type) {
    case 'assistant': return String(el.text?.length ?? 0);
    case 'human': return String(el.text.length);
    case 'tool': return `${el.status}:${el.action}:${el.filename ?? ''}`;
    case 'run_command': return `${el.command.length}:${el.actions.length}`;
    case 'thought':
      return `${el.thoughtKind ?? ''}:${el.action ?? ''}:${el.detail ?? ''}:${el.duration ?? ''}`;
    case 'plan':
      return `${el.todosCompleted}/${el.todosTotal}:${(el.description || '').length}:${el.model ?? ''}`;
    case 'todo_list': return `${el.todosCompleted}/${el.todosTotal}`;
    case 'loading': return el.text ?? '';
  }
}

/**
 * Fingerprint of the last message including its type and content.
 * Detects streaming content changes and element type transitions
 * (e.g. tool -> run_command at the same data-message-id).
 */
function messageFingerprint(messages: ChatElement[]): string {
  if (messages.length === 0)
    return '';
  const last = messages[messages.length - 1];
  return `${messages.length}:${last.type}:${last.id}:${elementContentKey(last)}`;
}

/**
 * Stable signature over pendingApprovals contents — id + action labels.
 * Bare length comparison misses the case where one approval clears at the
 * same time another appears (count stays 1 but the underlying tool-call
 * changed), so the snapshot wouldn't emit and the banner would go stale.
 */
function approvalsFingerprint(approvals: { id: string; actions: { label: string; type: string }[] }[]): string {
  if (approvals.length === 0)
    return '';
  return approvals
    .map(a => `${a.id}|${a.actions.map(act => `${act.type}:${act.label}`).join(',')}`)
    .join(';');
}

/**
 * Do these tabs come from `windowId`?
 *
 * StateManager stamps every side-bar tab with the window it was extracted in
 * (`activeWindowId` at poll time), so the stamp is the extraction's window.
 * Tabs without a stamp are a pre-stamp extraction — trust them on the window
 * the CDP bridge is looking at.
 */
export function tabsBelongTo(windowId: string, tabs: ChatTab[] | undefined): boolean {
  if (!tabs || tabs.length === 0)
    return true;
  return tabs.every(tab => !tab.windowId || tab.windowId === windowId);
}

/**
 * Stable signature over the questionnaire widget. A questionnaire appearing,
 * changing its active question, or clearing must trigger a snapshot emit so
 * the per-window path can send/edit/delete the questions card. The
 * home-window fast path already handles this via state patches, but non-home
 * windows are only surfaced through window-monitor snapshots.
 */
export function questionnaireFingerprint(questionnaire: Questionnaire | null): string {
  if (!questionnaire || questionnaire.questions.length === 0)
    return '';
  const q = questionnaire.questions[questionnaire.activeIndex] ?? questionnaire.questions[0];
  const optionLabels = q?.options.map(option => option.label).join(',') ?? '';
  return `${questionnaire.totalLabel}|${questionnaire.activeIndex}|${questionnaire.continueDisabled ? 1 : 0}|${q?.number ?? ''}|${q?.options.length ?? 0}|${optionLabels}`;
}

/**
 * Lightweight signature over ALL elements' types, ids, and key state.
 * Catches mid-list changes (tool status transitions, plan progress, type
 * changes at non-tail positions) that the last-element fingerprint misses.
 */
function elementsSignature(messages: ChatElement[]): string {
  let sig = '';
  for (const m of messages) {
    sig += m.type[0] + m.id;
    if (m.type === 'tool') {
      sig += m.status[0];
    }
    else if (m.type === 'plan') {
      sig += m.todosCompleted + (m.description?.length ?? 0) + (m.title?.length ?? 0);
    }
    else if (m.type === 'todo_list') {
      sig += m.todosCompleted;
    }
    else if (m.type === 'thought') {
      sig += (m.duration || '') + (m.thoughtKind || '');
    }
    else if (m.type === 'loading' && m.text) {
      sig += m.text.length;
    }
  }
  return sig;
}

/**
 * Monitors all Cursor windows using parallel CDP connections.
 * The "home" window is the one connected via the main CDPBridge (polled continuously).
 * Other windows get their own temporary CDP connections every CYCLE_INTERVAL_MS.
 * No window switching — the UI stays on the home window.
 */
export class WindowMonitor extends EventEmitter {
  readonly kind: IdeKind;
  private cdpBridge: CDPBridge;
  private stateManager: StateManager;
  private selectors: SelectorConfig;
  private config: AgentConfig;
  private readonly otherWindowsRequireWsUrl: boolean;
  private readonly extractFromClientImpl: (client: CdpClient, windowTitle: string) => Promise<CursorState | null>;
  private readonly listTargetsImpl: () => Promise<CodingCopilotTargetFields[]>;
  private readonly extractCodeBuddyLiveImpl: (wsUrl: string) => Promise<CursorState | null>;

  private snapshots = new Map<string, WindowSnapshot>();
  /** Last parallel-poll timestamp per non-home window: each window keeps its own cadence (see cycle) */
  private lastPolledAt = new Map<string, number>();
  private homeWindowId: string | null = null;
  private cycleTimer: ReturnType<typeof setInterval> | null = null;
  private firstCycleTimer: ReturnType<typeof setTimeout> | null = null;
  private _cycling = false;
  private _firstCycleLogged = false;
  private switchGeneration = -1;

  get isCycling(): boolean {
    return this._cycling;
  }

  constructor(
    cdpBridge: CDPBridge,
    stateManager: StateManager,
    _extractor: { start: (...args: never[]) => void; stop: () => void },
    config: AgentConfig,
    selectors?: SelectorConfig,
    options?: WindowMonitorOptions,
  ) {
    super();
    this.cdpBridge = cdpBridge;
    this.stateManager = stateManager;
    this.config = config;
    this.selectors = selectors ?? {} as SelectorConfig;
    this.otherWindowsRequireWsUrl = options?.otherWindowsRequireWsUrl ?? true;
    this.kind = options?.kind ?? 'cursor';
    this.extractFromClientImpl = options?.extractFromClient
      ?? ((client, windowTitle) => this.extractFromClient(client, windowTitle));
    this.listTargetsImpl = options?.listTargets
      ?? (() => fetchCdpJsonTargets(this.config.cdpUrl));
    this.extractCodeBuddyLiveImpl = options?.extractCodeBuddyLive
      ?? (wsUrl => this.extractCodeBuddyLive(wsUrl));
  }

  /** Test hook: one parallel-window cycle. */
  async runCycle(): Promise<void> {
    await this.cycle();
  }

  start(): void {
    this.stateManager.on('state:patch', this.onPatch);
    this.cdpBridge.on('connected', this.onConnected);

    this.scheduleNextCycle();
    console.log(`[window-monitor] Started (parallel mode, cycle ${CYCLE_INTERVAL_MS / 1000}s idle / ${CYCLE_ACTIVE_INTERVAL_MS / 1000}s while a window is working)`);
  }

  /**
   * Adaptive cadence: idle 10s per round; tighten to 2.5s when a background
   * window is running — "finished" must land within seconds, the session list
   * must not hang a fake loading.
   */
  private scheduleNextCycle(): void {
    if (this.cycleTimer)
      clearTimeout(this.cycleTimer);
    const homeId = this.getHomeWindowId();
    const anyBackgroundWorking = Array.from(this.snapshots.entries())
      .some(([id, snap]) => id !== homeId && snap.agentActivityLive);
    this.cycleTimer = setTimeout(() => {
      void this.cycle().finally(() => this.scheduleNextCycle());
    }, anyBackgroundWorking ? CYCLE_ACTIVE_INTERVAL_MS : CYCLE_INTERVAL_MS);
  }

  stop(): void {
    this.stateManager.off('state:patch', this.onPatch);
    this.cdpBridge.off('connected', this.onConnected);
    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = null;
    }
    if (this.firstCycleTimer) {
      clearTimeout(this.firstCycleTimer);
      this.firstCycleTimer = null;
    }
  }

  setHomeWindow(windowId: string): void {
    if (this.homeWindowId !== windowId) {
      this.homeWindowId = windowId;
      this.switchGeneration = this.stateManager.generation;
    }
  }

  getHomeWindowId(): string {
    return this.homeWindowId ?? this.cdpBridge.activeTargetId;
  }

  getSnapshot(windowId: string): WindowSnapshot | undefined {
    return this.snapshots.get(windowId);
  }

  getAllSnapshots(): Map<string, WindowSnapshot> {
    return this.snapshots;
  }

  private onConnected = (): void => {
    const targetId = this.cdpBridge.activeTargetId;
    if (targetId)
      this.setHomeWindow(targetId);
    // If we have a cached snapshot for this window, push its mode/model immediately
    // so the web client doesn't show stale values while waiting for extraction.
    const cached = targetId ? this.snapshots.get(targetId) : undefined;
    if (cached) {
      this.stateManager.updateModeModel(cached.mode, cached.model);
    }
    this.captureHomeWindow();
    // Run first cycle immediately so other windows are available for /sync
    if (this.firstCycleTimer)
      clearTimeout(this.firstCycleTimer);
    this.firstCycleTimer = setTimeout(() => {
      this.firstCycleTimer = null;
      void this.cycle();
    }, 2000);
  };

  private onPatch = (): void => {
    this.captureHomeWindow();
  };

  private captureHomeWindow(): void {
    const state = this.stateManager.getCurrentState();
    if (!state.connected)
      return;

    // After a window switch, wait for at least one fresh DOM extraction
    // before emitting snapshots. This prevents stale state from the old
    // window being attributed to the new window's title.
    if (this.stateManager.generation <= this.switchGeneration)
      return;

    const windowId = this.cdpBridge.activeTargetId;
    if (!windowId)
      return;

    const win = state.windows.find(w => w.id === windowId);
    if (!win)
      return;

    // In the instant of a window switch, activeTargetId is already the new
    // window while chatTabs are still the previous window's (the new window
    // waits for the next extract). Attributing those tabs to the new window
    // name makes that group vanish on the web until the next extract — the
    // session list "flashes" (2026-09-15 report).
    // switchGeneration only covers "after connect"; the first patch is earlier
    // than setHomeWindow and cannot catch this.
    if (!tabsBelongTo(windowId, state.chatTabs))
      return;

    const snapshot: WindowSnapshot = {
      windowId,
      windowTitle: win.title,
      messages: state.messages,
      chatTabs: state.chatTabs,
      pendingApprovals: state.pendingApprovals,
      agentStatus: state.agentStatus,
      agentActivityText: state.agentActivityText,
      agentActivityLive: state.agentActivityLive,
      agentActivitySource: state.agentActivitySource,
      composerQueue: state.composerQueue,
      mode: state.mode,
      model: state.model,
      questionnaire: state.questionnaire,
      lastUpdated: Date.now(),
      activeComposerId: state.activeComposerId ?? '',
    };

    const prev = this.snapshots.get(windowId);
    const queueSig = JSON.stringify(snapshot.composerQueue);
    const prevQueueSig = prev ? JSON.stringify(prev.composerQueue) : '';
    const approvalSig = approvalsFingerprint(snapshot.pendingApprovals);
    const prevApprovalSig = prev ? approvalsFingerprint(prev.pendingApprovals) : '';
    const questionnaireSig = questionnaireFingerprint(snapshot.questionnaire);
    const prevQuestionnaireSig = prev ? questionnaireFingerprint(prev.questionnaire) : '';
    const changed = !prev
      || prev.messages.length !== snapshot.messages.length
      || (prev.messages.length > 0 && prev.messages[prev.messages.length - 1]?.id !== snapshot.messages[snapshot.messages.length - 1]?.id)
      || prev.agentStatus !== snapshot.agentStatus
      || prev.agentActivityText !== snapshot.agentActivityText
      || prev.agentActivityLive !== snapshot.agentActivityLive
      || prev.agentActivitySource !== snapshot.agentActivitySource
      || approvalSig !== prevApprovalSig
      || questionnaireSig !== prevQuestionnaireSig
      || queueSig !== prevQueueSig
      || prev.mode?.current !== snapshot.mode?.current
      || prev.model?.current !== snapshot.model?.current
      || prev.model?.currentId !== snapshot.model?.currentId
      || messageFingerprint(prev.messages) !== messageFingerprint(snapshot.messages)
      || elementsSignature(prev.messages) !== elementsSignature(snapshot.messages);

    this.snapshots.set(windowId, snapshot);
    this.stateManager.updateWindowChatTabs(windowId, snapshot.chatTabs);

    if (changed) {
      this.emit('window:update', windowId, snapshot);
    }
  }

  /**
   * Poll non-home windows by opening temporary parallel CDP connections.
   * Does NOT switch the main CDPBridge — the UI stays on the home window.
   */
  private async cycle(): Promise<void> {
    if (this._cycling)
      return;
    if (!this.cdpBridge.isConnected())
      return;

    try {
      await this.cdpBridge.refreshWindows();
    }
    catch {
      return;
    }

    const windows = this.cdpBridge.windows;

    // Log full window inventory on first cycle
    if (!this._firstCycleLogged) {
      this._firstCycleLogged = true;
      const homeId = this.getHomeWindowId();
      console.log(`[window-monitor] First cycle — ${windows.length} window(s), home=${homeId?.substring(0, 8) ?? 'none'}:`);
      for (const w of windows) {
        const isHome = w.id === homeId;
        console.log(`  [${w.id.substring(0, 8)}] "${w.title}" ws=${w.wsUrl ? 'yes' : 'NO'}${isHome ? ' (home)' : ''}`);
      }
    }

    if (windows.length <= 1)
      return;
    if (!shouldParallelExtractLive(this.kind)) {
      this.stateManager.updateWindows(windows, this.cdpBridge.activeTargetId);
      return;
    }

    const homeId = this.getHomeWindowId();
    const otherWindows = this.otherWindowsRequireWsUrl
      ? windows.filter(w => w.id !== homeId && w.wsUrl)
      : windows.filter(w => w.id !== homeId);
    if (otherWindows.length === 0) {
      const noWs = windows.filter(w => w.id !== homeId && !w.wsUrl);
      if (noWs.length > 0) {
        console.warn(`[window-monitor] ${noWs.length} non-home window(s) have no wsUrl (already debugged?): ${noWs.map(w => w.title).join(', ')}`);
      }
      return;
    }

    // Each window schedules itself: a running window every 2.5s (drop loading
    // promptly when it finishes), an idle window every 10s.
    // Do not let "one window is running" speed up every window — five windows
    // accelerating together is wasted CPU.
    const now = Date.now();
    const liveIds = new Set(windows.map(w => w.id));
    for (const id of Array.from(this.lastPolledAt.keys())) {
      if (!liveIds.has(id))
        this.lastPolledAt.delete(id);
    }
    const dueWindows = otherWindows.filter((w) => {
      const working = this.snapshots.get(w.id)?.agentActivityLive === true;
      const every = working ? CYCLE_ACTIVE_INTERVAL_MS : CYCLE_INTERVAL_MS;
      return now - (this.lastPolledAt.get(w.id) ?? 0) >= every;
    });

    this._cycling = true;

    try {
      this.stateManager.updateWindows(windows, this.cdpBridge.activeTargetId);

      for (const win of dueWindows) {
        await this.pollWindowParallel(win);
        this.lastPolledAt.set(win.id, Date.now());
      }
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[window-monitor] Cycle error: ${msg}`);
    }
    finally {
      this._cycling = false;
    }
  }

  private async pollWindowParallel(win: CursorWindow): Promise<void> {
    if (this.kind === 'codebuddy') {
      await this.pollCodeBuddyWindow(win);
      return;
    }
    if (win.kind === 'agents') {
      await this.pollAgentsWindow(win);
      return;
    }
    if (!win.wsUrl)
      return;

    const client = new CdpClient();
    try {
      await client.connect(win.wsUrl);

      const workspaceName = await extractWorkspaceName(client, this.config.windowTitleQualifier);
      const windowTitle = workspaceName ?? win.title;
      if (workspaceName && workspaceName !== win.title) {
        win.title = workspaceName;
      }

      const state = await this.extractFromClientImpl(client, windowTitle);
      if (!state) {
        console.warn(`[window-monitor] Poll "${windowTitle}": extraction returned null`);
      }
      if (state) {
        const snapshot: WindowSnapshot = {
          windowId: win.id,
          windowTitle,
          messages: state.messages,
          chatTabs: state.chatTabs.map(tab => (tab.windowId ? tab : { ...tab, windowId: win.id })),
          pendingApprovals: state.pendingApprovals,
          agentStatus: state.agentStatus,
          agentActivityText: state.agentActivityText,
          agentActivityLive: state.agentActivityLive,
          agentActivitySource: state.agentActivitySource,
          composerQueue: state.composerQueue,
          mode: state.mode,
          model: state.model,
          questionnaire: state.questionnaire,
          lastUpdated: Date.now(),
          activeComposerId: state.activeComposerId ?? '',
        };

        const prev = this.snapshots.get(win.id);
        const qSig = JSON.stringify(snapshot.composerQueue);
        const pqSig = prev ? JSON.stringify(prev.composerQueue) : '';
        const aSig = approvalsFingerprint(snapshot.pendingApprovals);
        const paSig = prev ? approvalsFingerprint(prev.pendingApprovals) : '';
        const qnSig = questionnaireFingerprint(snapshot.questionnaire);
        const pqnSig = prev ? questionnaireFingerprint(prev.questionnaire) : '';
        const changed = !prev
          || prev.messages.length !== snapshot.messages.length
          || (prev.messages.length > 0 && prev.messages[prev.messages.length - 1]?.id !== snapshot.messages[snapshot.messages.length - 1]?.id)
          || prev.agentStatus !== snapshot.agentStatus
          || prev.agentActivityText !== snapshot.agentActivityText
          || prev.agentActivityLive !== snapshot.agentActivityLive
          || prev.agentActivitySource !== snapshot.agentActivitySource
          || aSig !== paSig
          || qnSig !== pqnSig
          || qSig !== pqSig
          || prev.mode?.current !== snapshot.mode?.current
          || prev.model?.current !== snapshot.model?.current
          || prev.model?.currentId !== snapshot.model?.currentId
          || messageFingerprint(prev.messages) !== messageFingerprint(snapshot.messages)
          || elementsSignature(prev.messages) !== elementsSignature(snapshot.messages);

        this.snapshots.set(win.id, snapshot);
        this.stateManager.updateWindowChatTabs(win.id, snapshot.chatTabs);

        if (changed) {
          this.emit('window:update', win.id, snapshot);
        }
      }
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('WebSocket') && !msg.includes('closed')) {
        console.warn(`[window-monitor] Poll "${win.title}" failed: ${msg}`);
      }
    }
    finally {
      client.disconnect();
    }
  }

  /**
   * Cursor's Agents overview window: global agent list + the current agent's
   * sessions. Read-only parallel poll (it is not home); row ids are aligned by
   * group and pushed out (see agents-window.ts).
   */
  private async pollAgentsWindow(win: CursorWindow): Promise<void> {
    if (!win.wsUrl)
      return;
    const client = new CdpClient();
    try {
      await client.connect(win.wsUrl);
      const dump = await client.callFunctionWithTimeout(
        dumpAgentsWindow as (...args: never[]) => unknown,
        [],
        AGENTS_DUMP_TIMEOUT_MS,
      ) as AgentsWindowDump | null;
      if (!dump) {
        console.warn(`[window-monitor] Agents poll "${win.title}": dump returned null`);
        return;
      }
      const mapped = mapAgentsWindowDump(dump, { windowId: win.id });
      const chatTabs = mapped.chatTabs ?? [];
      const current = this.stateManager.getCurrentState();
      const snapshot: WindowSnapshot = {
        windowId: win.id,
        windowTitle: win.title,
        messages: [],
        chatTabs,
        pendingApprovals: mapped.pendingApprovals ?? [],
        agentStatus: mapped.agentStatus ?? 'idle',
        agentActivityText: null,
        agentActivityLive: false,
        agentActivitySource: 'none',
        composerQueue: mapped.composerQueue ?? { items: [] },
        // Agents window has no project-level mode/model: keep current values, do not wipe the web's selection
        mode: current.mode,
        model: current.model,
        questionnaire: mapped.questionnaire ?? null,
        lastUpdated: Date.now(),
        activeComposerId: mapped.activeComposerId ?? '',
      };

      const prev = this.snapshots.get(win.id);
      const changed = !prev
        || JSON.stringify(prev.chatTabs) !== JSON.stringify(snapshot.chatTabs)
        || prev.activeComposerId !== snapshot.activeComposerId
        // Questionnaire appear / change / clear must emit a snapshot, or the web questionnaire card stays on the old state
        || questionnaireFingerprint(prev.questionnaire) !== questionnaireFingerprint(snapshot.questionnaire);

      this.snapshots.set(win.id, snapshot);
      this.stateManager.updateWindowChatTabs(win.id, snapshot.chatTabs);
      if (changed)
        this.emit('window:update', win.id, snapshot);
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('WebSocket') && !msg.includes('closed')) {
        console.warn(`[window-monitor] Agents poll "${win.title}" failed: ${msg}`);
      }
    }
    finally {
      client.disconnect();
    }
  }

  private async pollCodeBuddyWindow(win: CursorWindow): Promise<void> {
    const targets = await this.listTargetsImpl();
    const panel = pickCodingCopilotTarget(targets, { workbenchId: win.id, requireUnique: true });
    if (!panel?.webSocketDebuggerUrl)
      return;
    const state = await this.extractCodeBuddyLiveImpl(panel.webSocketDebuggerUrl);
    if (!state)
      return;
    this.ingestWindowLive(win, win.title, state);
  }

  private async extractCodeBuddyLive(wsUrl: string): Promise<CursorState | null> {
    const client = new CdpClient();
    try {
      await client.connect(wsUrl);
      const dump = await client.callFunctionWithTimeout(
        dumpCodeBuddyLive as (...args: never[]) => unknown,
        [],
        EVALUATE_TIMEOUT_MS,
      ) as CodeBuddyLiveDump | null;
      if (!dump)
        return null;
      return { ...emptyCursorState(), ...mapCodeBuddyLive(dump), messages: [] };
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('WebSocket') && !msg.includes('closed')) {
        console.warn(`[window-monitor] CodeBuddy poll failed: ${msg}`);
      }
      return null;
    }
    finally {
      client.disconnect();
    }
  }

  private ingestWindowLive(win: CursorWindow, windowTitle: string, state: CursorState): void {
    const snapshot: WindowSnapshot = {
      windowId: win.id,
      windowTitle,
      messages: state.messages,
      chatTabs: (state.chatTabs ?? []).map(tab => (tab.windowId ? tab : { ...tab, windowId: win.id })),
      pendingApprovals: state.pendingApprovals,
      agentStatus: state.agentStatus,
      agentActivityText: state.agentActivityText,
      agentActivityLive: state.agentActivityLive,
      agentActivitySource: state.agentActivitySource,
      composerQueue: state.composerQueue,
      mode: state.mode,
      model: state.model,
      questionnaire: state.questionnaire,
      lastUpdated: Date.now(),
      activeComposerId: state.activeComposerId ?? '',
    };
    const prev = this.snapshots.get(win.id);
    const changed = !prev
      || JSON.stringify(prev.chatTabs) !== JSON.stringify(snapshot.chatTabs)
      || prev.agentStatus !== snapshot.agentStatus
      || prev.agentActivityText !== snapshot.agentActivityText;
    this.snapshots.set(win.id, snapshot);
    this.stateManager.updateWindowChatTabs(win.id, snapshot.chatTabs);
    if (changed)
      this.emit('window:update', win.id, snapshot);
  }

  private async extractFromClient(client: CdpClient, windowTitle: string): Promise<CursorState | null> {
    if (this.kind === 'codebuddy') {
      throw new Error('Cursor extractionFunction must not run on a codebuddy slot');
    }
    try {
      const { extractionFunction } = await import('./drivers/cursor/extractor.js');

      const result = await client.callFunctionWithTimeout(
        extractionFunction as (...args: never[]) => unknown,
        [
          this.selectors.chatContainer?.strategies ?? [],
          this.selectors.approveButton?.strategies ?? [],
          this.selectors.approveButton?.textMatch ?? [],
          this.selectors.rejectButton?.strategies ?? [],
          this.selectors.rejectButton?.textMatch ?? [],
          this.selectors.chatInput?.strategies ?? [],
          this.selectors.agentStatus?.strategies ?? [],
          this.selectors.chatTabList?.strategies ?? [],
          this.selectors.modeDropdown?.strategies ?? [],
          this.selectors.modelDropdown?.strategies ?? [],
          windowTitle,
        ],
        EVALUATE_TIMEOUT_MS,
      );

      const state = result as CursorState | null;
      return state ? postProcessCursorState(state) : null;
    }
    catch {
      return null;
    }
  }
}

async function fetchCdpJsonTargets(cdpUrl: string): Promise<CodingCopilotTargetFields[]> {
  try {
    const response = await fetch(`${cdpUrl}/json`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok)
      return [];
    const targets = await response.json() as CodingCopilotTargetFields[];
    return Array.isArray(targets) ? targets : [];
  }
  catch {
    return [];
  }
}
