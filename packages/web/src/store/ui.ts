import type { IdeKind } from '../net/protocol';
import type { ActiveTarget } from './cli';
import { create } from 'zustand';
import { currentViewHint } from '../lib/view-state';

export interface ToastItem {
  id: number;
  text: string;
  kind: 'error' | 'ok';
}

/**
 * Optimistic "switching" after a session click: list/timeline paint the target session immediately,
 * then clear once server state reconciles; command:result failure or timeout rolls back.
 */
export interface PendingSwitch {
  commandId: string;
  ide: IdeKind;
  composerId: string;
  windowId: string;
  title: string;
  startedAt: number;
  /**
   * "Nth same-title row" from the extract. The row id swaps from a placeholder (tab-N) to a real id at land time;
   * the position key (window + same-title index + title) is stable across that instant — a second identity for that moment.
   */
  sameTitleIndex?: number;
  /**
   * Server has clicked through and read-back verification passed: the switch itself is settled, only one extract is missing
   * to deliver state. **Must not** drop pending here — state hasn't arrived, highlight would snap back to the old active
   * row (flash-back); stay on the target row until state catches up (2026-09-15 feedback).
   */
  confirmed?: boolean;
}

/** Max time to wait for state to reconcile (CodeBuddy window switch waits up to 8s ready, plus a little slack). */
const PENDING_SWITCH_DEADLINE_MS = 10_000;

/** After confirm, wait only one extract (500ms poll + 300ms debounce); drop once there's enough slack. */
const CONFIRMED_SWITCH_DEADLINE_MS = 3_000;

/** Slightly longer than a switch (a create also has to click the IDE's ＋), but it still must not linger. */
const PENDING_NEW_CHAT_DEADLINE_MS = 8_000;

/**
 * Once the IDE reports the ＋ was clicked, only one extract is left (500ms poll + 300ms debounce). Kept short because
 * an IDE that silently does nothing (or reuses the draft it already had) never produces a landing signal at all.
 */
const CONFIRMED_NEW_CHAT_DEADLINE_MS = 3_000;

/**
 * Optimistic "new session" (the ＋ on a window / section header).
 *
 * The click only sends a command: the agent has to click the IDE's own ＋, then force one extract — the new draft
 * exists on the live DOM first. That round trip is 0.5–2s, and until it lands the page showed **nothing at all**
 * (no row, old session still on screen), which reads as "the button did nothing" (2026-10-31 feedback).
 *
 * So the row and the empty pane are painted locally on click and dropped as soon as the real state catches up.
 * Landing is judged as a **delta against the click-time baseline**, never as an absolute state: an active draft, or a
 * moved `activeComposerId`, is also what the previous state already showed (a second ＋, or the window raise that
 * precedes a cross-window create), and treating those as landed dropped the row within one poll.
 *
 * A hard deadline keeps a silently failed create from leaving a ghost row.
 */
export interface PendingNewChat {
  commandId: string;
  ide: IdeKind;
  /** Machine the click happened on: switching machines must not leave the new machine's input locked. */
  agentId: string;
  windowId: string;
  /** Agents-window sections create into one repo; project windows omit it. */
  section?: string;
  /** Composer ids already present in the target window at click time: the chat the IDE makes is the one outside this set. */
  baseComposerIds: string[];
  /** Drafts already on screen in the target window/section: a second ＋ must not be dropped by the first draft. */
  baseDraftIds: string[];
}

interface UiStore {
  subagentPath: Array<{ sessionId: string; title: string }>;
  openSubagent: (sessionId: string, title: string) => void;
  backFromSubagent: () => void;
  closeSubagents: () => void;
  toasts: ToastItem[];
  pushToast: (text: string, kind?: ToastItem['kind']) => void;
  dismissToast: (id: number) => void;
  /** Incrementing this asks the timeline to scroll to the bottom (prototype behavior: force-to-bottom after sending your own message). */
  bottomNonce: number;
  requestScrollToBottom: () => void;
  pendingSwitch: PendingSwitch | null;
  setPendingSwitch: (pending: PendingSwitch) => void;
  /** Optimistic create-in-flight (see PendingNewChat): the row and the empty pane paint before the IDE answers. */
  pendingNewChat: PendingNewChat | null;
  setPendingNewChat: (pending: PendingNewChat) => void;
  /** The IDE reports the ＋ was clicked: shorten the deadline to "one extract" (same two-tier logic as a switch). */
  confirmPendingNewChat: (commandId: string) => void;
  /** Drop the optimistic row; with a commandId, only clear the matching one (an old deadline must not clear a new create). */
  clearPendingNewChat: (commandId?: string) => void;
  /**
   * Server confirms the switch completed (reply includes landedComposerId check): become "confirmed",
   * highlight stays on the target row, and clearPendingSwitch drops it once state catches up.
   */
  confirmPendingSwitch: (commandId: string, landedComposerId?: string) => void;
  /** Drop "switching"; with a commandId, only clear the matching one (so an old timer cannot clear a new switch). */
  clearPendingSwitch: (commandId?: string) => void;
  /**
   * What the main pane is driving. IDE keeps using `selectedIde` for its own state;
   * this only chooses which pane is on screen.
   */
  activeTarget: ActiveTarget;
  setActiveTarget: (target: ActiveTarget) => void;
  showIde: (ide: IdeKind) => void;
  showCliHome: (agentId: string) => void;
  showCli: (target: Extract<ActiveTarget, { kind: 'cli' }>) => void;
}

let nextToastId = 1;
let pendingTimer: number | null = null;
let newChatTimer: number | null = null;

function stopPendingTimer(): void {
  if (pendingTimer !== null) {
    window.clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

function stopNewChatTimer(): void {
  if (newChatTimer !== null) {
    window.clearTimeout(newChatTimer);
    newChatTimer = null;
  }
}

function initialActiveTarget(): ActiveTarget {
  const hint = currentViewHint();
  if (hint.cli && hint.agentId)
    return { kind: 'cli-home', agentId: hint.agentId };
  return { kind: 'ide', ide: hint.ide ?? 'cursor' };
}

export const useUiStore = create<UiStore>()((set, get) => ({
  subagentPath: [],
  openSubagent: (sessionId, title) => set(s => ({ subagentPath: [...s.subagentPath, { sessionId, title }] })),
  backFromSubagent: () => set(s => ({ subagentPath: s.subagentPath.slice(0, -1) })),
  closeSubagents: () => set({ subagentPath: [] }),
  toasts: [],
  bottomNonce: 0,
  activeTarget: initialActiveTarget(),
  setActiveTarget: target => set({ activeTarget: target }),
  // Same target → no write: every row click lands here, and a fresh object re-renders the whole shell for nothing.
  showIde: ide => set(s => (s.activeTarget.kind === 'ide' && s.activeTarget.ide === ide
    ? s
    : { activeTarget: { kind: 'ide', ide } })),
  showCliHome: agentId => set({ activeTarget: { kind: 'cli-home', agentId } }),
  showCli: target => set({ activeTarget: target }),
  requestScrollToBottom: () => set(s => ({ bottomNonce: s.bottomNonce + 1 })),
  pushToast: (text, kind = 'ok') => {
    const id = nextToastId++;
    set(s => ({ toasts: [...s.toasts, { id, text, kind }] }));
    window.setTimeout(() => {
      set(s => ({ toasts: s.toasts.filter(t => t.id !== id) }));
    }, 3200);
  },
  dismissToast: id => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),

  pendingSwitch: null,
  setPendingSwitch: (pending) => {
    stopPendingTimer();
    set({ pendingSwitch: pending });
    pendingTimer = window.setTimeout(() => {
      pendingTimer = null;
      if (get().pendingSwitch?.commandId === pending.commandId)
        set({ pendingSwitch: null });
    }, PENDING_SWITCH_DEADLINE_MS);
  },
  confirmPendingSwitch: (commandId, landedComposerId) => {
    const cur = get().pendingSwitch;
    if (!cur || cur.commandId !== commandId)
      return;
    stopPendingTimer();
    set({
      pendingSwitch: {
        ...cur,
        confirmed: true,
        // The landed id in the reply is real: it can reconcile directly against the next extract (placeholder ids cannot).
        ...(landedComposerId ? { composerId: landedComposerId } : {}),
      },
    });
    pendingTimer = window.setTimeout(() => {
      pendingTimer = null;
      if (get().pendingSwitch?.commandId === commandId)
        set({ pendingSwitch: null });
    }, CONFIRMED_SWITCH_DEADLINE_MS);
  },
  clearPendingSwitch: (commandId) => {
    const cur = get().pendingSwitch;
    if (!cur || (commandId && cur.commandId !== commandId))
      return;
    stopPendingTimer();
    set({ pendingSwitch: null });
  },

  pendingNewChat: null,
  setPendingNewChat: (pending) => {
    stopNewChatTimer();
    set({ pendingNewChat: pending });
    newChatTimer = window.setTimeout(() => {
      newChatTimer = null;
      if (get().pendingNewChat?.commandId === pending.commandId)
        set({ pendingNewChat: null });
    }, PENDING_NEW_CHAT_DEADLINE_MS);
  },
  confirmPendingNewChat: (commandId) => {
    const cur = get().pendingNewChat;
    if (!cur || cur.commandId !== commandId)
      return;
    stopNewChatTimer();
    newChatTimer = window.setTimeout(() => {
      newChatTimer = null;
      if (get().pendingNewChat?.commandId === commandId)
        set({ pendingNewChat: null });
    }, CONFIRMED_NEW_CHAT_DEADLINE_MS);
  },
  clearPendingNewChat: (commandId) => {
    const cur = get().pendingNewChat;
    if (!cur || (commandId && cur.commandId !== commandId))
      return;
    stopNewChatTimer();
    set({ pendingNewChat: null });
  },
}));
