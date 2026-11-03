import type { CursorState } from '../net/protocol';
import type { PendingNewChat } from '../store/ui';
import { isDraftTab } from '../store/ides';

/**
 * Has the IDE caught up with an optimistic "new session" click?
 *
 * The optimistic row (and the empty pane) exist only until the live state shows the create actually happened. Landing
 * must therefore be a **delta against the click-time baseline**, not "some state is present", and it must be judged
 * from a tab **of the target window** — never from the global `activeComposerId`.
 *
 * Why not `activeComposerId`: the window raise that precedes a cross-window ＋ is reported by window-monitor as a
 * `state:patch` that carries only `windows` / `activeWindowId` (the extractor is paused for the command), so the
 * global active id still belongs to the *previous* window for a moment. Measured on the live site 2026-11-03: the row
 * vanished 81ms after the click that way, while the real draft only appeared ~200ms later.
 *
 * Rules:
 *  - the tab list may hold the target window twice (the raised window's `chatTabs`, and the per-window cache in
 *    `windows[]`) — merge both, same as `groupTabsByWindow`;
 *  - a draft is the create landing iff its id was not already active in that window at click time (`baseDraftIds`) —
 *    that is what keeps the *second* ＋ from being dropped by the first draft, and it works even when the window's
 *    tabs were never reported (an empty baseline is still a baseline for drafts);
 *  - a non-draft tab can only be "the new chat" when the baseline knew the window: with an empty baseline (a window
 *    the agent has never extracted) every tab there looks new, so the old active chat would read as landed.
 */
export function newChatLanded(
  pending: Pick<PendingNewChat, 'windowId' | 'section' | 'baseComposerIds' | 'baseDraftIds'>,
  state: CursorState | undefined,
): boolean {
  if (!state)
    return false;
  const activeWindow = state.activeWindowId || '';
  const tabsInTargetWindow = [
    ...(state.chatTabs ?? []),
    ...(state.windows ?? []).flatMap(w => w.chatTabs ?? []),
  ].filter(tab => (tab.windowId || activeWindow) === pending.windowId);

  return tabsInTargetWindow.some((tab) => {
    if (tab.isActive !== true)
      return false;
    if (pending.section !== undefined && (tab.section ?? '') !== pending.section)
      return false;
    if (isDraftTab(tab))
      return !pending.baseDraftIds.includes(tab.composerId);
    return pending.baseComposerIds.length > 0 && !pending.baseComposerIds.includes(tab.composerId);
  });
}
