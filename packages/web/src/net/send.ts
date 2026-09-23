import { isSyntheticComposerId, liveSessionKeyOf, sendTargetOf, useIdesStore, viewedTabOf } from '../store/ides';
import { useSessionsStore } from '../store/sessions';
import { useUiStore } from '../store/ui';
import { newCommandId, sendCommand, sendCommandAwaitResult } from './socket';

/** A stop command is in flight (see stopSession): block a second press until the state reply arrives. */
let stopping = false;

/**
 * Send a user message: derive target → optimistic bubble → command:send_message.
 * Shared by Composer and failure retry; lives in the net layer to avoid cyclic store deps.
 */
export function sendUserMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed)
    return false;
  const { ides, selectedIde } = useIdesStore.getState();
  const state = ides[selectedIde];
  if (!state)
    return false;
  const target = sendTargetOf(state);
  if (!target)
    return false;
  const commandId = newCommandId();
  const liveKey = liveSessionKeyOf(selectedIde, state);
  // A draft's liveKey is empty (no body attached, no request), but the optimistic bubble still hangs on its own real id:
  // after the message is sent and the session is on disk, liveKey switches to this session and the bubble joins — first message still has instant feedback.
  const optimisticKey
    = liveKey
      || (() => {
        const id = viewedTabOf(state)?.composerId;
        return id && !isSyntheticComposerId(id) ? `${selectedIde}:${id}` : '';
      })();
  if (optimisticKey)
    useSessionsStore.getState().echoPendingSend(trimmed, commandId, optimisticKey);
  sendCommand('command:send_message', { commandId, text: trimmed, ...target, ide: selectedIde });
  return true;
}

/**
 * Stop generation currently running on this session.
 *
 * target uses the same derivation as send (the session being viewed + its window): stop is "an action on a session";
 * the IDE side lands on that session first then clicks stop — a background-running session can be stopped too,
 * instead of wrongly stopping whatever the IDE is currently showing. Failures (machine offline / Cursor not enrolled)
 * are explained via toast, not swallowed silently.
 */
export function stopSession(): boolean {
  const { ides, selectedIde } = useIdesStore.getState();
  const state = ides[selectedIde];
  if (!state)
    return false;
  const target = sendTargetOf(state);
  if (!target)
    return false;
  // De-dupe double-clicks: until the state reply, the button is still the stop key, and a second press would hit
  // a session that's already stopped, popping a wasted "Not generating".
  if (stopping)
    return false;
  stopping = true;
  void sendCommandAwaitResult('command:stop', { ...target, ide: selectedIde })
    .then((result) => {
      if (result.ok)
        return;
      useUiStore.getState().pushToast(`停止失败：${result.error ?? '未知错误'}`, 'error');
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      useUiStore.getState().pushToast(`停止失败：${message}`, 'error');
    })
    .finally(() => {
      stopping = false;
    });
  return true;
}

/** Failure retry: drop the old bubble and meta, resend the original text (new commandId). */
export function retryUserMessage(failedCommandId: string): boolean {
  const sessions = useSessionsStore.getState();
  const info = sessions.pendingSends[failedCommandId];
  if (!info)
    return false;
  sessions.removePendingBubble(failedCommandId);
  return sendUserMessage(info.text);
}
