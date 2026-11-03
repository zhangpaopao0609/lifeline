import { useIdesStore, viewedLiveKeyOf } from '../store/ides';
import { useUiStore } from '../store/ui';
import { usePendingNewChat } from './usePendingNewChat';

/**
 * React binding of `viewedLiveKeyOf` — the session body key currently being viewed.
 * AppShell uses it as the Timeline remount key; the Timeline wrapper uses it to select the body.
 */
export function useLiveSessionKey(): string {
  const selectedIde = useIdesStore(s => s.selectedIde);
  const state = useIdesStore(s => s.ides[selectedIde]);
  const pendingSwitch = useUiStore(s => s.pendingSwitch);
  const pendingNewChat = usePendingNewChat();
  /**
   * Create in flight: the pane must already look like the brand-new empty session, not keep painting the previous
   * one until the IDE answers (measured 2321ms on the live site). '' is the "no body" key → Timeline's draft hint.
   */
  if (pendingNewChat)
    return '';
  return viewedLiveKeyOf(selectedIde, state, pendingSwitch);
}
