import type { CliPermissionResponse, CliSource, CliTarget, CommandEvent, CommandPayload, CommandResult, MessageAttachment } from './protocol';
import { dispatchCli, useCliStore } from '../store/cli';
import { draftSessionKeyOf, liveSessionKeyOf, sendTargetOf, useIdesStore } from '../store/ides';
import { useSessionsStore } from '../store/sessions';
import { useUiStore } from '../store/ui';
import { newCommandId, sendCommand, sendCommandAwaitResult, socket } from './socket';

/** A stop command is in flight (see stopSession): block a second press until the state reply arrives. */
let stopping = false;

/**
 * Send a user message: derive target → optimistic bubble → command:send_message.
 * Shared by Composer and failure retry; lives in the net layer to avoid cyclic store deps.
 *
 * `attachments` are the files picked in the composer. Their bytes ride in the payload — the agent
 * writes them to the IDE machine's disk and types their paths (protocol/src/attachments.ts).
 */
export function sendUserMessage(text: string, attachments: MessageAttachment[] = []): boolean {
  const trimmed = text.trim();
  if (!trimmed && attachments.length === 0)
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
  const optimisticKey = liveKey || draftSessionKeyOf(selectedIde, state);
  if (optimisticKey)
    useSessionsStore.getState().echoPendingSend(trimmed, commandId, optimisticKey, attachments);
  sendCommand('command:send_message', {
    commandId,
    text: trimmed,
    ...target,
    ide: selectedIde,
    ...(attachments.length > 0 ? { attachments } : {}),
  });
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

function sendCliCommand(
  event: 'command:cli_start' | 'command:cli_catalog' | 'command:cli_model' | 'command:cli_thinking' | 'command:cli_close' | 'command:cli_permission_response',
  payload: Omit<CommandPayload, 'commandId'>,
  timeoutMs?: number,
): Promise<CommandResult> {
  return sendCommandAwaitResult(event as unknown as CommandEvent, payload, timeoutMs);
}

/** CLI prompt. Admission only — completion arrives as `cli:status`. Does not touch the IDE session store. */
export function sendCliMessage(target: CliTarget, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed)
    return false;
  sendCommand('command:send_message', {
    text: trimmed,
    target,
    clientMessageId: newCommandId(),
  });
  return true;
}

let cliStopping = false;

export function stopCliSession(target: CliTarget): boolean {
  if (cliStopping)
    return false;
  cliStopping = true;
  void sendCommandAwaitResult('command:stop', { target })
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
      cliStopping = false;
    });
  return true;
}

export function sendCliStart(
  source: CliSource,
  cwd: string,
  choice?: { modelId?: string; thinking?: string },
): Promise<CommandResult> {
  return sendCliCommand('command:cli_start', {
    source,
    cwd,
    ...(choice?.modelId ? { modelId: choice.modelId } : {}),
    ...(choice?.thinking ? { thinking: choice.thinking } : {}),
  });
}

/** Ask the selected CLI which models this account can use. Cursor answers from `--list-models`. */
export function sendCliCatalog(source: CliSource, cwd?: string): Promise<CommandResult> {
  return sendCliCommand('command:cli_catalog', {
    source,
    ...(cwd ? { cwd } : {}),
  }, source === 'cursor-cli' ? 20_000 : 45_000);
}

let cliDial = false;

/** The page target also carries `agentId` and `epoch`. The command schema only accepts these three. */
function cliWireTarget(target: CliTarget): CliTarget {
  return { kind: 'cli', source: target.source, sessionId: target.sessionId };
}

/** Switch the open session's model. Writes `session/set_config_option`, not `session/set_model`. */
export function selectCliModel(target: CliTarget, modelId: string): boolean {
  if (cliDial || modelId.length === 0)
    return false;
  cliDial = true;
  void sendCliCommand('command:cli_model', { target: cliWireTarget(target), modelId })
    .then((result) => {
      if (result.ok)
        return;
      useUiStore.getState().pushToast(`切换模型失败：${result.error ?? '未知错误'}`, 'error');
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      useUiStore.getState().pushToast(`切换模型失败：${message}`, 'error');
    })
    .finally(() => {
      cliDial = false;
    });
  return true;
}

/** Switch the current model's thinking level. The session stays the one already open. */
export function selectCliThinking(target: CliTarget, thinking: string): boolean {
  if (cliDial || thinking.length === 0)
    return false;
  cliDial = true;
  void sendCliCommand('command:cli_thinking', { target: cliWireTarget(target), thinking })
    .then((result) => {
      if (result.ok)
        return;
      useUiStore.getState().pushToast(`切换思考强度失败：${result.error ?? '未知错误'}`, 'error');
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      useUiStore.getState().pushToast(`切换思考强度失败：${message}`, 'error');
    })
    .finally(() => {
      cliDial = false;
    });
  return true;
}

const cliClosing = new Set<string>();

/** Forget this CLI session. The row leaves immediately; the child exits afterward. */
export function closeCliSession(target: CliTarget & { agentId: string }): void {
  const key = `${target.source}\0${target.sessionId}`;
  if (cliClosing.has(key))
    return;
  cliClosing.add(key);
  const epoch = useCliStore.getState().cli.agents[target.agentId]?.epoch;
  if (epoch) {
    dispatchCli({
      type: 'session-removed',
      agentId: target.agentId,
      removed: { epoch, source: target.source, sessionId: target.sessionId },
      now: Date.now(),
    });
    const active = useUiStore.getState().activeTarget;
    if (
      active.kind === 'cli'
      && active.agentId === target.agentId
      && active.source === target.source
      && active.sessionId === target.sessionId
    ) {
      useUiStore.getState().showCliHome(target.agentId);
    }
  }
  void sendCliCommand('command:cli_close', { target: cliWireTarget(target) })
    .then((result) => {
      if (result.ok)
        return;
      useUiStore.getState().pushToast(`关闭失败：${result.error ?? '未知错误'}`, 'error');
      socket.emit('cli:sync-request', {});
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      useUiStore.getState().pushToast(`关闭失败：${message}`, 'error');
      socket.emit('cli:sync-request', {});
    })
    .finally(() => {
      cliClosing.delete(key);
    });
}

export function sendCliPermission(
  target: CliTarget,
  approvalId: string,
  response: CliPermissionResponse,
): Promise<CommandResult> {
  return sendCliCommand('command:cli_permission_response', { target, approvalId, response });
}

/** Failure retry: drop the old bubble and meta, resend the original text **and files** (new commandId). */
export function retryUserMessage(failedCommandId: string): boolean {
  const sessions = useSessionsStore.getState();
  const info = sessions.pendingSends[failedCommandId];
  if (!info)
    return false;
  sessions.removePendingBubble(failedCommandId);
  return sendUserMessage(info.text, info.attachments ?? []);
}
