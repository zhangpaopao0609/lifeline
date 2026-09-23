import type { ViewHint } from './view-state';
import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { sendCommand } from '../net/socket';
import { useIdesStore, viewedSessionIdOf } from '../store/ides';
import { useMachinesStore } from '../store/machines';
import { useUiStore } from '../store/ui';
import {
  currentViewHint,
  findTabByComposerId,
  formatViewQuery,

  writeStoredView,
} from './view-state';

/** How long to wait for the session to appear in the list (state is async; time out so we don't yank the user later). */
const RESTORE_DEADLINE_MS = 10_000;

let userTookOver = false;

/** User switched / opened a session themselves → abandon this load's "return to last viewed". */
export function noteUserSwitch(): void {
  userTookOver = true;
}

/**
 * Wire up "last viewed": restore machine + IDE + session on load, then keep mirroring the current view to the URL query and localStorage.
 *
 * Session restore is one-shot, and only emits command:switch_tab when "it's in the list, but the server-active one isn't it" —
 * on a normal refresh the server's active tab is already last time's (clicking a session really switched the IDE), so the
 * command never fires. Only if you switched sessions on the computer while the page was closed do we pull you back, with a toast.
 *
 * Mounted only on the console screen (`/console` element in App.tsx): while browsing the landing page this hook does not exist,
 * mirroring won't rewrite the landing URL to `/console?m=…`, and restore won't switch an IDE tab while you're on the site.
 */
export function useViewState(): void {
  const selectedAgentId = useMachinesStore(s => s.selectedAgentId);
  const ides = useIdesStore(s => s.ides);
  const selectedIde = useIdesStore(s => s.selectedIde);
  const pendingSwitch = useUiStore(s => s.pendingSwitch);
  const pushToast = useUiStore(s => s.pushToast);
  const navigate = useNavigate();

  const state = ides[selectedIde];
  /**
   * What is mirrored is "the session being viewed" — **optimistic switch counts** (same truth as list highlight and timeline).
   * Following only the server-confirmed activeComposerId lags a whole round: measured 1.07s after a click before the
   * address bar changes; six rapid clicks only land the last one (6.3s), which looks like the address bar is stuck.
   */
  const liveSessionId = viewedSessionIdOf(state, pendingSwitch);

  // Read once this load; after that the URL follows the current view and is not re-read, so we don't write then read ourselves.
  const target: ViewHint = useMemo(() => currentViewHint(), []);
  // Deadline is from "restore actually started" (= the moment we entered the console): browsing the landing first should not already be expired on entry.
  const deadlineRef = useRef<number | null>(null);
  const settled = useRef(false);

  useEffect(() => {
    if (settled.current || userTookOver)
      return;
    if (!target.agentId || !target.ide || !target.sessionId)
      return;
    if (deadlineRef.current === null)
      deadlineRef.current = Date.now() + RESTORE_DEADLINE_MS;
    const deadline = deadlineRef.current;
    // Not yet on that machine / IDE: wait for machines:list and state:full.
    if (selectedAgentId !== target.agentId || selectedIde !== target.ide)
      return;
    if (!state)
      return;
    // Machine offline: the mirror is read-only, sending would only fail (another chance once online, so don't settle).
    if (state.connected === false)
      return;
    if (liveSessionId === target.sessionId) {
      settled.current = true;
      return;
    }
    const tab = findTabByComposerId(state, target.sessionId);
    if (!tab) {
      // List already arrived without it → session is gone; list not yet here → wait until the deadline.
      const hasTabs
        = (state.chatTabs?.length ?? 0) > 0 || (state.windows ?? []).some(w => (w.chatTabs?.length ?? 0) > 0);
      if (hasTabs || Date.now() > deadline)
        settled.current = true;
      return;
    }
    settled.current = true;
    sendCommand('command:switch_tab', {
      ide: target.ide,
      tabTitle: tab.title,
      windowId: tab.windowId || state.activeWindowId,
      ...(tab.selectorPath ? { selectorPath: tab.selectorPath } : {}),
    });
    pushToast(`已回到上次的会话：${tab.title || '（未命名）'}`);
  }, [target, selectedAgentId, selectedIde, state, liveSessionId, pushToast]);

  useEffect(() => {
    // No machine selected yet, or this IDE's state hasn't arrived: an empty sessionId here only means "don't know yet";
    // overwriting with a partial record would actually lose "last viewed" on the next refresh.
    if (!selectedAgentId || !state)
      return;
    const view = { agentId: selectedAgentId, ide: selectedIde, sessionId: liveSessionId };
    writeStoredView(window.localStorage, view);
    const search = formatViewQuery(view);
    // replace: switching sessions must not push history (or extra Back). If the URL is already this, do nothing.
    if (window.location.search !== search)
      navigate({ search }, { replace: true });
  }, [selectedAgentId, selectedIde, liveSessionId, state, navigate]);
}
