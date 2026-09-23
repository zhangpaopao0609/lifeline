import type {
  AgentStatus,
  ChatTab,
  CursorState,
  CursorWindow,
  IdeKind,
  SendMessageTarget,
  StateFullWire,
  StatePatchWire,
} from '../net/protocol';
import type { PendingSwitch } from './ui';
import { create } from 'zustand';
import { cdpIssueCopy } from '../lib/cdp-issue-copy';
import { currentViewHint } from '../lib/view-state';
import { IDE_KINDS, parseIde } from '../net/protocol';

/** Production app.js: a synthetic composer id is not a real session (DOM placeholder tab-N) */
export function isSyntheticComposerId(id: string | undefined | null): boolean {
  return !id || /^tab-\d+$/.test(id);
}

/** unwrapIdes: use the {ides} shape as-is; otherwise treat the whole payload as a single cursor (legacy/local compat) */
export function unwrapIdes(payload: StateFullWire): Partial<Record<IdeKind, CursorState>> {
  if (payload && typeof payload === 'object' && 'ides' in payload) {
    const ides = (payload as { ides: unknown }).ides;
    if (ides && typeof ides === 'object') {
      return ides as Partial<Record<IdeKind, CursorState>>;
    }
  }
  return { cursor: (payload as CursorState) || ({} as CursorState) };
}

/** sanitizeIncomingLive: do not pass through a synthetic activeComposerId (app.js 382-387) */
function sanitizeIncomingLive(body: Partial<CursorState>): Partial<CursorState> {
  const next = { ...body };
  if (typeof next.activeComposerId === 'string' && isSyntheticComposerId(next.activeComposerId)) {
    delete next.activeComposerId;
  }
  return next;
}

/** activeTab: prefer isActive; fall back when there is only one tab (app.js 661-664) */
export function activeTabOf(state: CursorState): ChatTab | null {
  const tabs = state.chatTabs ?? [];
  const active = tabs.find(t => t.isActive);
  if (active)
    return active;
  if (tabs.length === 1)
    return tabs[0];
  return null;
}

/**
 * Whether this session is a "draft": created via '+' / New Agent, before the first message is sent.
 *
 * Either source counts: the Agents-window row-level status (`status === 'draft'`) and the extractor's
 * `isDraft` (drafts created via '+' in the project window take this path — their row status is active).
 * A draft has no body, and the body does not belong to it; every place on the web that "gets the current session body" must ask this first.
 */
export function isDraftTab(tab: ChatTab | undefined | null): boolean {
  return tab?.isDraft === true || tab?.status === 'draft';
}

/** sendTarget: windowId + tabTitle are required; include composerId only when it is not synthetic (app.js 667-676) */
export function sendTargetOf(state: CursorState): SendMessageTarget | null {
  const tab = activeTabOf(state);
  if (!tab || !tab.title)
    return null;
  const windowId = tab.windowId || state.activeWindowId;
  if (!windowId)
    return null;
  const target: SendMessageTarget = { windowId, tabTitle: tab.title };
  if (tab.selectorPath)
    target.selectorPath = tab.selectorPath;
  if (tab.section)
    target.section = tab.section;
  if (tab.composerId && !isSyntheticComposerId(tab.composerId))
    target.composerId = tab.composerId;
  return target;
}

/**
 * Cache key for the live session body; empty string when there is no real session / the current one is a draft.
 *
 * Drafts must short-circuit here, for two reasons:
 * 1. **Agents-window drafts have no composerId** (the main pane has no `data-composer-id` on the full page,
 *    and the empty-name row in the library is not in the sidebar sequence), so `activeComposerId` is still
 *    **the previous session** — without the short-circuit, the newly created session UI would keep showing
 *    the previous session's body
 *    (2026-09-18 feedback: "after adding a session, the session UI still keeps the previous session's history").
 * 2. **Drafts that already have a real id (created via '+' in the project window) also short-circuit**: they have
 *    not been persisted yet, so neither the server ledger nor the content-source disk has them; a body request
 *    will vanish into the void — the web can only hang on a skeleton screen (2026-09-20 feedback:
 *    "a newly created session keeps spinning"). The draft UI is expressed by Timeline's draft hint, not by a body;
 *    after the first message is sent and the session is persisted, live state switches to the real session and liveKey recovers.
 *    If `isDraft` is wrong in edge cases such as occlusion, switching sessions restores it — cheaper than spinning forever.
 */
export function liveSessionKeyOf(
  ide: IdeKind,
  state: CursorState | undefined,
  pending?: PendingSwitch | null,
): string {
  if (!state)
    return '';
  const tab = viewedTabOf(state, pending);
  if (isDraftTab(tab))
    return '';
  const id = state.activeComposerId;
  return isSyntheticComposerId(id) ? '' : `${ide}:${id}`;
}

/** Whether the session is in progress (thinking / generating / running a tool) — shared by the session-row loading indicator and the composer input lock. Completed (idle) does not get the flag. */
export function isSessionWorking(state: CursorState | undefined): boolean {
  if (!state)
    return false;
  return state.agentActivityLive === true
    || state.agentStatus === 'thinking'
    || state.agentStatus === 'generating'
    || state.agentStatus === 'running_tool';
}

/**
 * Whether this session row is currently running — based on the IDE sidebar row-level status (`tab.status === 'generating'`,
 * i.e. the sidebar leading icon is spinning). The sidebar spinner is the IDE's own ground truth for running and stops when it finishes;
 * `agentStatus` / `agentActivityLive` are derived from the transcript pane and can lag or go dark during long tasks.
 */
export function isTabRunning(tab: ChatTab | undefined | null): boolean {
  return tab?.status === 'generating';
}

/**
 * Whether this session row is "finished, result not yet viewed" — the small dot on the IDE session tab
 * (CodeBuddy's agent-state-dot: terminal state + unread).
 *
 * It is row-level ground truth, not global state: clicking in (switching sessions) makes the IDE mark it read and the dot disappears;
 * so on the web it means exactly "this work is done, the result is waiting for you".
 */
export function isTabUnread(tab: ChatTab | undefined | null): boolean {
  return tab?.status === 'unread';
}

/** Status copy on the right of the top bar (shared by TargetBar and the status dot). */
export const AGENT_STATUS_TEXT: Record<AgentStatus, string> = {
  idle: '空闲',
  thinking: '思考中',
  generating: '生成中',
  running_tool: '工具执行中',
  waiting_approval: '等待审批',
  error: '出错',
};

/**
 * What the top bar should display.
 *
 * Copy must follow the "spinner": the spinner comes from row-level status (sidebar ground truth), while agentStatus is
 * derived from the transcript pane and can lag to idle during long tasks — in the old form `running ? (activityText || TEXT[agentStatus] || '进行中')`
 * `TEXT.idle = '空闲'` is truthy, so at the same moment the left side spun while the right side said '空闲' (observed 2026-09-15).
 * Falling back to '空闲' is only allowed when the global status itself is also not running.
 *
 * `unread` is the row-level "finished, not yet viewed" (the dot on the session tab): it must override global idle —
 * the global copy at that moment is exactly '空闲', which cannot distinguish "just finished, result waiting for you" from "was never running".
 * Error still wins: if something actually went wrong, report the error; do not cover it with a success message.
 *
 * When CDP is not connected, do not leave only a grey dot: `no-window` shows '等待窗口'; other kinds use the issue short phrase.
 * The spinner still wins and must not be covered by an issue.
 */
export function targetBarStatusText(
  state: CursorState | undefined,
  running: boolean,
  unread = false,
  ideLabel = 'Cursor',
): string {
  if (!state)
    return '';
  if (!running) {
    if (!state.connected && state.cdpIssue?.kind === 'no-window')
      return '等待窗口';
    if (!state.connected && state.cdpIssue)
      return cdpIssueCopy(state.cdpIssue, ideLabel).text;
    if (unread && state.agentStatus !== 'error')
      return '已完成';
    return AGENT_STATUS_TEXT[state.agentStatus] ?? state.agentStatus;
  }
  const activity = state.agentActivityText;
  if (activity)
    return activity;
  return isSessionWorking(state) ? AGENT_STATUS_TEXT[state.agentStatus] ?? state.agentStatus : '进行中';
}

/**
 * Whether this "in-progress switch" is for this very row.
 *
 * Use both keys together:
 *  - composerId: a real id is globally unique; a placeholder id (tab-N) is unique only within the window;
 *  - position key (window + same-title index + title): at the moment of landing the row id swaps from placeholder to real id,
 *    but the position key is stable across that moment. Without it, highlight drops then comes back on landing (a flash).
 */
export function pendingMatchesTab(pending: PendingSwitch, tab: ChatTab, windowId: string): boolean {
  const wid = tab.windowId || windowId;
  if (pending.windowId && pending.windowId !== wid)
    return false;
  if (pending.composerId && pending.composerId === tab.composerId)
    return true;
  return typeof pending.sameTitleIndex === 'number'
    && pending.sameTitleIndex === tab.sameTitleIndex
    && pending.title === tab.title;
}

/**
 * Whether this session row is currently "the one being viewed" — at most one row is true at a time.
 *
 * During an optimistic switch, highlight belongs exclusively to the target: the server only moves isActive on the next extract,
 * so if the old row keeps painting highlight from isActive in that gap, the list shows two active states at once
 * (2026-09-15 feedback: switching sessions can capture two rows both highlighted). The caller demotes the old row to secondary style.
 *
 * Do not clear "in-progress switch" as soon as command:result arrives: the reply arrives before state, and clearing too early
 * makes highlight drop back to the old active row then jump back (a flash-back). Confirmed pending is cleared by the caller once state has caught up.
 */
export function isViewingTab(
  tab: ChatTab,
  windowId: string,
  ide: IdeKind,
  state: CursorState | undefined,
  pending?: PendingSwitch | null,
): boolean {
  const pendingHere = pending && pending.ide === ide ? pending : null;
  if (pendingHere)
    return pendingMatchesTab(pendingHere, tab, windowId);
  return tab.isActive && windowId === state?.activeWindowId;
}

/** The session being viewed (during an optimistic switch, prefer the target session) — the session-row loading spinner, body list, and timeline share the same "current". */
export function viewedTabOf(
  state: CursorState | undefined,
  pending?: PendingSwitch | null,
): ChatTab | null {
  if (!state)
    return null;
  const wantId = pending && !isSyntheticComposerId(pending.composerId) ? pending.composerId : '';
  if (wantId) {
    const t = (state.chatTabs ?? []).find(tab => tab.composerId === wantId);
    if (t)
      return t;
  }
  else if (pending) {
    // Target is a placeholder id (tab-N, e.g. a draft row): cannot match by id, so match by position key (window + same-title index + title).
    // Without that match, at the instant of clicking a draft the "current session" is still the previous one — body/empty state both point back to the old session,
    // and the draft UI only appears after the next extract (2026-09-18 feedback).
    // **Match draft rows only**: a draft never has a real id; other rows with a placeholder id are just extract misalignment (library unreadable /
    // mixed sections), and matching them by position key would wrongly treat a real session's body as missing (the mismatch cost is higher).
    const t = (state.chatTabs ?? []).find(tab =>
      isDraftTab(tab) && pendingMatchesTab(pending, tab, tab.windowId || state.activeWindowId));
    if (t)
      return t;
  }
  return activeTabOf(state);
}

/**
 * Id of the "session being viewed" (the target session during an optimistic switch).
 *
 * Session-owned todo cards such as questionnaires are drawn only when they belong to this session: the moment another session is clicked,
 * ownership is still the old session → the card collapses immediately, without waiting for the next server extract (2026-09-17 feedback);
 * switching back (or switching back in the IDE) leaves the question on that composer, and the next extract brings it back as usual.
 *
 * Empty string = session identity unknown (placeholder id / state not yet arrived): the caller treats this as "do not decide",
 * not as "does not belong" — that would wrongly hide the card of the session currently being viewed.
 */
export function viewedSessionIdOf(
  state: CursorState | undefined,
  pending?: PendingSwitch | null,
): string {
  if (pending && !isSyntheticComposerId(pending.composerId))
    return pending.composerId;
  const active = state?.activeComposerId;
  return isSyntheticComposerId(active) ? '' : active ?? '';
}

/**
 * The "window being viewed" — shared by the top bar and TargetBar's window row.
 *
 * During an optimistic switch, prefer the target (look up pending.windowId directly, which also matches a placeholder composerId);
 * otherwise use the window of the session being viewed, and only then fall back to the active window: clicking a session in another window
 * must change the window name immediately, rather than waiting for server state (2026-09-16 feedback: "optimistic switch everywhere").
 */
export function viewedWindowOf(
  state: CursorState | undefined,
  pending?: PendingSwitch | null,
): CursorWindow | null {
  if (!state)
    return null;
  const winId = pending?.windowId || viewedTabOf(state, pending)?.windowId || state.activeWindowId;
  return (state.windows ?? []).find(w => w.id === winId) ?? null;
}

/** Whether the session being viewed is running: row-level spinner is authoritative; the active row in this window then falls back to live state (older servers / missing row status). */
export function isActiveSessionWorking(
  state: CursorState | undefined,
  pending?: PendingSwitch | null,
): boolean {
  const tab = viewedTabOf(state, pending);
  if (isTabRunning(tab))
    return true;
  if (!tab?.isActive || !state)
    return false;
  if (state.activeWindowId && tab.windowId && tab.windowId !== state.activeWindowId)
    return false;
  return isSessionWorking(state);
}

interface IdesStore {
  ides: Partial<Record<IdeKind, CursorState>>;
  selectedIde: IdeKind;
  setSelectedIde: (ide: IdeKind) => void;
  applyStateFull: (wire: StateFullWire) => void;
  applyStatePatch: (wire: StatePatchWire) => void;
  /**
   * A content-source machine (no IDE/DOM) has no "switch tab" command to send:
   * the web itself writes the "current session" into local state, so clicking a row views that row.
   */
  markLocalActive: (ide: IdeKind, windowId: string, composerId: string) => void;
}

/** Which IDE was last viewed (URL query > localStorage); fall back to cursor only when there is no record */
const initialIde: IdeKind = currentViewHint().ide ?? 'cursor';

export const useIdesStore = create<IdesStore>()(set => ({
  ides: {},
  selectedIde: initialIde,
  setSelectedIde: ide => set({ selectedIde: ide }),

  applyStateFull: (wire) => {
    const incoming = unwrapIdes(wire);
    const ides: Partial<Record<IdeKind, CursorState>> = {};
    for (const ide of IDE_KINDS) {
      const slot = incoming[ide];
      if (slot)
        ides[ide] = sanitizeIncomingLive(slot) as CursorState;
    }
    set({ ides });
  },

  markLocalActive: (ide, windowId, composerId) => {
    set((s) => {
      const state = s.ides[ide];
      if (!state)
        return {};
      const markTabs = (tabs?: ChatTab[]) =>
        tabs?.map(t => (t.windowId === windowId ? { ...t, isActive: t.composerId === composerId } : t));
      return {
        ides: {
          ...s.ides,
          [ide]: {
            ...state,
            activeComposerId: composerId,
            activeWindowId: windowId,
            chatTabs: markTabs(state.chatTabs) ?? state.chatTabs,
            windows: state.windows?.map(w =>
              w.id === windowId ? { ...w, chatTabs: markTabs(w.chatTabs) ?? w.chatTabs } : w,
            ),
          },
        },
      };
    });
  },

  applyStatePatch: (wire) => {
    if (!wire || typeof wire !== 'object')
      return;
    // Two shapes: { ide, patch } (multi-IDE) / bare Partial<CursorState> (legacy cursor)
    let ide: IdeKind = 'cursor';
    let body: Partial<CursorState> = wire as Partial<CursorState>;
    const rec = wire as Record<string, unknown>;
    if (rec.ide && rec.patch && typeof rec.patch === 'object') {
      ide = parseIde(rec.ide);
      body = rec.patch as Partial<CursorState>;
    }
    // A patch never carries messages (the timeline uses session:*); strip the shape keys
    const rest = sanitizeIncomingLive({ ...body });
    delete rest.messages;
    delete (rest as Record<string, unknown>).ide;
    delete (rest as Record<string, unknown>).patch;
    set(s => ({
      ides: { ...s.ides, [ide]: { ...(s.ides[ide] ?? {}), ...rest } as CursorState },
    }));
  },
}));
