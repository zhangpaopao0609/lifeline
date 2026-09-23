import type { CdpIssue, CursorState, CursorWindow } from './types.js';
import { EventEmitter } from 'node:events';
import { AGENT_ACTIVITY_STALE_MS } from './activity-stale.js';
import { emptyCursorState } from './types.js';

function emptyState(): CursorState {
  return emptyCursorState();
}

export function sameCdpIssue(
  a: CdpIssue | null | undefined,
  b: CdpIssue | null | undefined,
): boolean {
  if (a === b)
    return true;
  if (a == null || b == null)
    return false;
  return a.kind === b.kind
    && a.scope === b.scope
    && a.cdpUrl === b.cdpUrl
    && a.detail === b.detail
    && a.occupant === b.occupant
    && a.notCdpCause === b.notCdpCause
    && a.relaunch === b.relaunch
    && a.browser === b.browser;
}

/** CDP window lists have no chatTabs; keep previously extracted sidebars. */
export function mergeWindowChatTabs(prev: CursorWindow[], next: CursorWindow[]): CursorWindow[] {
  const prevById = new Map(prev.map(w => [w.id, w]));
  return next.map((w) => {
    if (w.chatTabs && w.chatTabs.length > 0)
      return w;
    const old = prevById.get(w.id);
    if (old?.chatTabs && old.chatTabs.length > 0)
      return { ...w, chatTabs: old.chatTabs };
    return w;
  });
}

export class StateManager extends EventEmitter {
  private currentState: CursorState = emptyState();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPatch: Partial<CursorState> | null = null;
  private debounceMs: number;
  private consecutiveNulls = 0;
  private readonly nullWarningThreshold = 10;
  private _generation = 0;
  /** When the current activity string first appeared (unchanged since). */
  private activityStableSince: number | null = null;
  private activityStableText: string | undefined = undefined;
  /**
   * After staleness clears `agentActivityText`, the DOM often keeps sending the same
   * string every poll; suppress that exact label until it changes or clears.
   */
  private activitySuppressedMatch: string | undefined = undefined;

  get generation(): number {
    return this._generation;
  }

  constructor(debounceMs: number) {
    super();
    this.debounceMs = debounceMs;
  }

  getCurrentState(): CursorState {
    return this.currentState;
  }

  /**
   * Called by the DOM extractor on each poll cycle.
   * Diffs against previous state and emits patches.
   */
  onExtraction(newState: CursorState | null): void {
    if (newState === null) {
      this.onExtractionFailure('Extraction returned null');
      return;
    }

    this.consecutiveNulls = 0;
    this._generation++;
    // Preserve bridge-managed fields that the DOM extractor should not own.
    const now = Date.now();
    newState.connected = this.currentState.connected;
    newState.extractorStatus = this.currentState.connected ? 'ok' : 'idle';
    newState.lastExtractionAt = now;
    newState.consecutiveExtractionFailures = 0;
    newState.lastExtractionError = null;
    newState.windows = this.currentState.windows;
    newState.activeWindowId = this.currentState.activeWindowId;
    newState.contentSource = this.currentState.contentSource;
    newState.cdpIssue = this.currentState.cdpIssue ?? null;
    newState.liveIssue = this.currentState.liveIssue ?? null;
    if (newState.activeWindowId && Array.isArray(newState.chatTabs)) {
      newState.chatTabs = newState.chatTabs.map(tab =>
        tab.windowId ? tab : { ...tab, windowId: newState.activeWindowId },
      );
    }
    // Timeline moved to session:* — never broadcast messages on state:patch.
    newState.messages = [];
    delete newState.lastAssistantText;
    if (!newState.liveActions)
      newState.liveActions = {};

    const stateForApply = this.applyActivityStaleness(newState);

    const patch = this.diff(this.currentState, stateForApply);
    if (!patch)
      return;

    this.currentState = stateForApply;
    this.schedulePatch(patch);
  }

  onExtractionFailure(message: string | null): void {
    this.consecutiveNulls++;
    if (this.consecutiveNulls === this.nullWarningThreshold) {
      console.warn(
        `[state-manager] ${this.nullWarningThreshold} consecutive failed extractions. `
        + 'Selectors may need updating or the Cursor window may be background-throttled.',
      );
    }

    const connected = this.currentState.connected;
    const nextState: CursorState = {
      ...this.currentState,
      extractorStatus:
        connected && this.currentState.lastExtractionAt != null ? 'stale' : connected ? 'waiting' : 'idle',
      consecutiveExtractionFailures: this.currentState.consecutiveExtractionFailures + 1,
      lastExtractionError: message,
    };

    const patch = this.diff(this.currentState, nextState);
    if (!patch)
      return;
    this.currentState = nextState;
    this.schedulePatch(patch);
  }

  /**
   * The activity label alone cannot tell "still working" from "stopped and the DOM
   * kept a leftover indicator". The transcript signals do: while any of them is
   * present the agent is genuinely running (a long `npm install`, a long edit),
   * and its label often does not change for minutes.
   *
   * Reads the raw DOM signals of this poll only — not `agentActivityLive` /
   * `agentActivitySource`, which are derived from the very stay-or-clear decision
   * this method feeds.
   */
  private hasWorkSignals(state: CursorState): boolean {
    const raw = state._rawSignals;
    if (!raw)
      return false;
    return raw.loadingIndicator
      || raw.shimmer.length > 0
      || (raw.orphanIndicators?.length ?? 0) > 0
      || raw.elements.some(el => el.toolStatus === 'loading'
        || el.parsedAs === 'skipped:loading'
        || el.indicators.includes('loading-v3'));
  }

  /**
   * Drop `agentActivityText` after AGENT_ACTIVITY_STALE_MS with no text change so
   * the web header does not show "Thinking" forever after the agent has stopped.
   *
   * Never clears while work signals are still present: a session running a long
   * tool keeps the same label for minutes, and clearing it used to kill the
   * session-row spinner and the header status of a session that is still working
   * (2026-09-15 feedback: switching into a running session showed no loading).
   */
  private applyActivityStaleness(newState: CursorState): CursorState {
    const text = newState.agentActivityText?.trim()
      ? newState.agentActivityText.trim()
      : null;
    // Evaluated once per poll; `_rawSignals` is the DOM as of this extraction.
    const workInProgress = this.hasWorkSignals(newState);

    if (!text) {
      if (workInProgress)
        return newState;
      this.activityStableSince = null;
      this.activityStableText = undefined;
      this.activitySuppressedMatch = undefined;
      if (newState.agentActivityText === null || newState.agentActivityText === '') {
        return newState;
      }
      return {
        ...newState,
        agentActivityText: null,
        agentActivityLive: false,
        agentActivitySource: 'none',
      };
    }

    if (
      this.activitySuppressedMatch != null
      && text === this.activitySuppressedMatch
    ) {
      if (workInProgress) {
        this.activitySuppressedMatch = undefined;
        this.activityStableText = text;
        this.activityStableSince = Date.now();
        return newState;
      }
      return {
        ...newState,
        agentStatus:
          newState.agentStatus === 'waiting_approval' || newState.agentStatus === 'error'
            ? newState.agentStatus
            : 'idle',
        agentActivityText: null,
        agentActivityLive: false,
        agentActivitySource: 'none',
      };
    }

    if (this.activitySuppressedMatch != null && text !== this.activitySuppressedMatch) {
      this.activitySuppressedMatch = undefined;
    }

    const now = Date.now();
    if (text === this.activityStableText && this.activityStableSince != null) {
      if (now - this.activityStableSince >= AGENT_ACTIVITY_STALE_MS && !workInProgress) {
        this.activityStableSince = null;
        this.activityStableText = undefined;
        this.activitySuppressedMatch = text;
        return {
          ...newState,
          agentStatus:
            newState.agentStatus === 'waiting_approval' || newState.agentStatus === 'error'
              ? newState.agentStatus
              : 'idle',
          agentActivityText: null,
          agentActivityLive: false,
          agentActivitySource: 'none',
        };
      }
      return newState;
    }

    this.activityStableText = text;
    this.activityStableSince = now;
    return newState;
  }

  onConnectionChanged(connected: boolean): void {
    const nextState: CursorState = {
      ...this.currentState,
      connected,
      extractorStatus: connected ? 'waiting' : 'idle',
      lastExtractionAt: null,
      consecutiveExtractionFailures: 0,
      lastExtractionError: null,
    };
    const patch = this.diff(this.currentState, nextState);
    if (!patch)
      return;
    this.currentState = nextState;
    this.emit('state:patch', patch);
    this.emit('connection:changed', connected);
  }

  setContentSource(contentSource: CursorState['contentSource']): void {
    if (this.currentState.contentSource === contentSource)
      return;
    this.currentState = { ...this.currentState, contentSource };
    this.emit('state:patch', { contentSource });
  }

  setCdpIssue(issue: CdpIssue | null): void {
    const prev = this.currentState.cdpIssue ?? null;
    if (sameCdpIssue(prev, issue))
      return;
    this.currentState = { ...this.currentState, cdpIssue: issue };
    this.emit('state:patch', { cdpIssue: issue });
  }

  setLiveIssue(issue: CdpIssue | null): void {
    const prev = this.currentState.liveIssue ?? null;
    if (sameCdpIssue(prev, issue))
      return;
    this.currentState = { ...this.currentState, liveIssue: issue };
    this.emit('state:patch', { liveIssue: issue });
  }

  updateWindows(windows: CursorWindow[], activeWindowId: string): void {
    const merged = mergeWindowChatTabs(this.currentState.windows, windows);
    const changed
      = this.currentState.activeWindowId !== activeWindowId
        || JSON.stringify(this.currentState.windows) !== JSON.stringify(merged);
    if (!changed)
      return;
    this.currentState = { ...this.currentState, windows: merged, activeWindowId };
    this.emit('state:patch', { windows: merged, activeWindowId });
  }

  /** Stamp one window's sidebar tabs without dropping the rest of the window list. */
  updateWindowChatTabs(windowId: string, chatTabs: CursorWindow['chatTabs']): void {
    if (!windowId || !Array.isArray(chatTabs) || chatTabs.length === 0)
      return;
    const windows = this.currentState.windows;
    const idx = windows.findIndex(w => w.id === windowId);
    if (idx < 0)
      return;
    if (JSON.stringify(windows[idx].chatTabs ?? []) === JSON.stringify(chatTabs))
      return;
    const next = windows.slice();
    next[idx] = { ...next[idx], chatTabs };
    this.currentState = { ...this.currentState, windows: next };
    this.emit('state:patch', { windows: next });
  }

  /** Push per-window mode/model into global state (e.g. from a cached snapshot on window switch). */
  updateModeModel(mode: CursorState['mode'], model: CursorState['model']): void {
    const modeChanged = this.currentState.mode?.current !== mode?.current;
    const modelChanged = this.currentState.model?.current !== model?.current
      || this.currentState.model?.currentId !== model?.currentId;
    if (!modeChanged && !modelChanged)
      return;
    const patch: Partial<CursorState> = {};
    if (modeChanged)
      patch.mode = mode;
    if (modelChanged)
      patch.model = model;
    this.currentState = { ...this.currentState, ...patch };
    this.emit('state:patch', patch);
  }

  private diff(
    prev: CursorState,
    next: CursorState,
  ): Partial<CursorState> | null {
    const patch: Partial<CursorState> = {};
    let hasChange = false;

    if (prev.connected !== next.connected) {
      patch.connected = next.connected;
      hasChange = true;
    }

    if (prev.extractorStatus !== next.extractorStatus) {
      patch.extractorStatus = next.extractorStatus;
      hasChange = true;
    }

    if (prev.lastExtractionAt !== next.lastExtractionAt) {
      patch.lastExtractionAt = next.lastExtractionAt;
      hasChange = true;
    }

    if (prev.consecutiveExtractionFailures !== next.consecutiveExtractionFailures) {
      patch.consecutiveExtractionFailures = next.consecutiveExtractionFailures;
      hasChange = true;
    }

    if (prev.lastExtractionError !== next.lastExtractionError) {
      patch.lastExtractionError = next.lastExtractionError;
      hasChange = true;
    }

    if (prev.agentStatus !== next.agentStatus) {
      patch.agentStatus = next.agentStatus;
      hasChange = true;
    }

    if (prev.agentActivityText !== next.agentActivityText) {
      patch.agentActivityText = next.agentActivityText;
      hasChange = true;
    }

    if (prev.agentActivityLive !== next.agentActivityLive) {
      patch.agentActivityLive = next.agentActivityLive;
      hasChange = true;
    }

    if (prev.agentActivitySource !== next.agentActivitySource) {
      patch.agentActivitySource = next.agentActivitySource;
      hasChange = true;
    }

    if (prev.inputAvailable !== next.inputAvailable) {
      patch.inputAvailable = next.inputAvailable;
      hasChange = true;
    }

    if (prev.activeComposerId !== next.activeComposerId) {
      patch.activeComposerId = next.activeComposerId;
      hasChange = true;
    }

    if (JSON.stringify(prev.liveActions) !== JSON.stringify(next.liveActions)) {
      patch.liveActions = next.liveActions;
      hasChange = true;
    }

    if (JSON.stringify(prev.pendingApprovals) !== JSON.stringify(next.pendingApprovals)) {
      patch.pendingApprovals = next.pendingApprovals;
      hasChange = true;
    }

    if (JSON.stringify(prev.chatTabs) !== JSON.stringify(next.chatTabs)) {
      patch.chatTabs = next.chatTabs;
      hasChange = true;
    }

    if (prev.mode?.current !== next.mode?.current) {
      patch.mode = next.mode;
      hasChange = true;
    }

    if (prev.model?.current !== next.model?.current || prev.model?.currentId !== next.model?.currentId) {
      patch.model = next.model;
      hasChange = true;
    }

    if (JSON.stringify(prev.windows) !== JSON.stringify(next.windows)) {
      patch.windows = next.windows;
      hasChange = true;
    }

    if (prev.activeWindowId !== next.activeWindowId) {
      patch.activeWindowId = next.activeWindowId;
      hasChange = true;
    }

    if (JSON.stringify(prev.composerQueue) !== JSON.stringify(next.composerQueue)) {
      patch.composerQueue = next.composerQueue;
      hasChange = true;
    }

    if (JSON.stringify(prev.questionnaire) !== JSON.stringify(next.questionnaire)) {
      patch.questionnaire = next.questionnaire;
      hasChange = true;
    }

    if (prev.contentSource !== next.contentSource) {
      patch.contentSource = next.contentSource;
      hasChange = true;
    }

    if (!sameCdpIssue(prev.cdpIssue ?? null, next.cdpIssue ?? null)) {
      patch.cdpIssue = next.cdpIssue ?? null;
      hasChange = true;
    }

    if (!sameCdpIssue(prev.liveIssue ?? null, next.liveIssue ?? null)) {
      patch.liveIssue = next.liveIssue ?? null;
      hasChange = true;
    }

    return hasChange ? patch : null;
  }

  private schedulePatch(patch: Partial<CursorState>): void {
    this.pendingPatch = this.pendingPatch
      ? { ...this.pendingPatch, ...patch }
      : patch;

    if (!this.debounceTimer) {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        if (this.pendingPatch) {
          this.emit('state:patch', this.pendingPatch);
          this.pendingPatch = null;
        }
      }, this.debounceMs);
    }
  }

  /**
   * Emit the pending patch now, skipping the debounce. Used right after a command
   * switched the active tab so the browser does not wait another debounce window.
   */
  flush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (!this.pendingPatch)
      return;
    const patch = this.pendingPatch;
    this.pendingPatch = null;
    this.emit('state:patch', patch);
  }
}
