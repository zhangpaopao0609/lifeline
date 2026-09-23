import type { IdeKind } from '../net/protocol';
import { create } from 'zustand';

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

interface UiStore {
  toasts: ToastItem[];
  pushToast: (text: string, kind?: ToastItem['kind']) => void;
  dismissToast: (id: number) => void;
  /** Incrementing this asks the timeline to scroll to the bottom (prototype behavior: force-to-bottom after sending your own message). */
  bottomNonce: number;
  requestScrollToBottom: () => void;
  pendingSwitch: PendingSwitch | null;
  setPendingSwitch: (pending: PendingSwitch) => void;
  /**
   * Server confirms the switch completed (reply includes landedComposerId check): become "confirmed",
   * highlight stays on the target row, and clearPendingSwitch drops it once state catches up.
   */
  confirmPendingSwitch: (commandId: string, landedComposerId?: string) => void;
  /** Drop "switching"; with a commandId, only clear the matching one (so an old timer cannot clear a new switch). */
  clearPendingSwitch: (commandId?: string) => void;
}

let nextToastId = 1;
let pendingTimer: number | null = null;

function stopPendingTimer(): void {
  if (pendingTimer !== null) {
    window.clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

export const useUiStore = create<UiStore>()((set, get) => ({
  toasts: [],
  bottomNonce: 0,
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
}));
