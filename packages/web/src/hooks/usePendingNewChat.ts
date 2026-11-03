import type { PendingNewChat } from '../store/ui';
import { newChatLanded } from '../lib/new-chat';
import { useIdesStore } from '../store/ides';
import { useMachinesStore } from '../store/machines';
import { useUiStore } from '../store/ui';

/**
 * The create-in-flight that belongs to what is on screen, or null once IDE state proves it landed.
 *
 * One derivation for the rail row, the empty pane, the composer lock and the live key: when each of them re-decides
 * "has it landed" on its own, a writer that forgets to reconcile leaves the rail without the row while the pane keeps
 * the hint and the input stays locked.
 */
export function usePendingNewChat(): PendingNewChat | null {
  const pending = useUiStore(s => s.pendingNewChat);
  const selectedIde = useIdesStore(s => s.selectedIde);
  const state = useIdesStore(s => s.ides[s.selectedIde]);
  const agentId = useMachinesStore(s => s.selectedAgentId);
  if (!pending || pending.ide !== selectedIde || pending.agentId !== agentId)
    return null;
  return newChatLanded(pending, state) ? null : pending;
}
