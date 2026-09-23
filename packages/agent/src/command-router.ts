import type { CDPBridge } from './cdp/bridge.js';
import type { CommandExecutor } from './drivers/cursor/executor.js';
import type { CommandPayload, CommandResult, IdeKind } from './types.js';
import { COMMAND_EVENTS, IDE_LABELS } from '../../protocol/src/index.js';
import { readPlanFile } from './drivers/cursor/plan-files.js';
import { DRIVERS } from './drivers/index.js';
import { timingLog, timingPreview } from './timing-log.js';
import { parseIde } from './types.js';

export { COMMAND_EVENTS };

/** Structural command API so CodeBuddyExecutor can be a CommandTarget without a cast. */
export type CommandExecutorApi = Pick<
  CommandExecutor,
  | 'sendMessage'
  | 'clickApproval'
  | 'approveAll'
  | 'reject'
  | 'stop'
  | 'switchTab'
  | 'activateCurrentTab'
  | 'newChat'
  | 'setMode'
  | 'setModel'
  | 'getModelOptions'
  | 'getPlanModelOptions'
  | 'setPlanModel'
  | 'clickAction'
  | 'setClient'
>;

export interface CommandTarget {
  commandExecutor: CommandExecutorApi;
  cdpBridge: CDPBridge;
  /** Deliver the result back to whoever issued the command. */
  emitResult: (result: CommandResult) => void;
  /** Pause content ticks + extractor polls so a send is not queued behind sqlite/CDP. */
  pauseLive?: () => void;
  resumeLive?: () => void;
  /** After switchWindow, CodeBuddy must reattach the coding-copilot webview. */
  waitUntilReady?: () => Promise<boolean>;
  /** Force an immediate extraction + flush after a command switched the active tab. */
  refreshState?: () => Promise<void>;
}

export type OnEvent = (event: string, handler: (payload: CommandPayload) => void) => void;

/**
 * Commands that change which session the IDE shows — push fresh state right after.
 * new_chat counts too: the draft session created by ＋ is known only to the
 * extractor (the new session's id / title exist only on the live DOM);
 * without a refresh the web waits for the next poll, and that gap is a
 * "where is the new session?" blank.
 */
const REFRESH_AFTER_EVENTS = new Set(['command:switch_tab', 'command:switch_window', 'command:new_chat']);

/**
 * Run one command against a single IDE target. Shared by attachCommandHandlers
 * (one slot) and attachIdeCommandHandlers (dispatch by payload.ide).
 */
export async function handleCommand(
  event: string,
  payload: CommandPayload,
  target: CommandTarget,
): Promise<void> {
  target.pauseLive?.();
  try {
    await dispatchCommand(event, payload, target);
  }
  finally {
    target.resumeLive?.();
    // Fire-and-forget: the command queue must not wait ~0.5s for the refresh.
    // A newer switch still wins — it pauses the extractor again.
    if (REFRESH_AFTER_EVENTS.has(event))
      void target.refreshState?.();
  }
}

async function dispatchCommand(
  event: string,
  payload: CommandPayload,
  target: CommandTarget,
): Promise<void> {
  const { commandExecutor, cdpBridge, emitResult, waitUntilReady } = target;
  const started = Date.now();
  const commandId = payload.commandId ?? 'unknown';
  const ide = parseIde(payload.ide);
  timingLog('router:in', {
    event,
    commandId,
    ide,
    chars: payload.text?.length,
    preview: payload.text ? timingPreview(payload.text) : undefined,
  });

  const fail = (id: string | undefined, error: string): void => {
    timingLog('router:fail', { event, commandId: id ?? 'unknown', ide, error, ms: Date.now() - started });
    emitResult({ commandId: id ?? 'unknown', ok: false, error } satisfies CommandResult);
  };

  const done = (result: CommandResult): void => {
    timingLog('router:out', {
      event,
      commandId: result.commandId,
      ide,
      ok: result.ok,
      error: result.error,
      ms: Date.now() - started,
    });
    emitResult(result);
  };

  switch (event) {
    case 'command:send_message': {
      if (!payload.commandId || !payload.text)
        return fail(payload.commandId, 'Missing commandId or text');
      const execStarted = Date.now();
      if (payload.windowId || payload.tabTitle || payload.selectorPath) {
        const land = await landOnOpenChat(commandExecutor, cdpBridge, commandId, ide, payload, waitUntilReady);
        if (land && !land.ok) {
          timingLog('router:executed', { commandId, ide, ok: false, ms: Date.now() - execStarted });
          done(land);
          return;
        }
      }
      const result = await withRaiseFallback(cdpBridge, commandId, ide, () =>
        commandExecutor.sendMessage(payload.commandId!, payload.text!));
      timingLog('router:executed', { commandId, ide, ok: result.ok, ms: Date.now() - execStarted });
      done(result);
      return;
    }
    case 'command:approve': {
      if (!payload.commandId || !payload.selectorPath)
        return fail(payload.commandId, 'Missing commandId or selectorPath');
      const result = await commandExecutor.clickApproval(payload.commandId, payload.selectorPath);
      done(result);
      return;
    }
    case 'command:approve_all': {
      if (!payload.commandId)
        return fail(payload.commandId, 'Missing commandId');
      // selectorPath is optional: with a path, click that one button (allowlist /
      // multi-accept-card cases); without a path the executor finds "Accept All" by label.
      const result = await commandExecutor.approveAll(payload.commandId, payload.selectorPath);
      done(result);
      return;
    }
    case 'command:reject': {
      if (!payload.commandId || !payload.selectorPath)
        return fail(payload.commandId, 'Missing commandId or selectorPath');
      const result = await commandExecutor.reject(payload.commandId, payload.selectorPath);
      done(result);
      return;
    }
    case 'command:stop': {
      if (!payload.commandId)
        return fail(payload.commandId, 'Missing commandId');
      // Stop is an action "against one running session": land on that session
      // first, same as send, so we do not stop whatever the IDE currently shows
      // (a background session must be switched to before its stop can be clicked).
      if (payload.windowId || payload.tabTitle || payload.selectorPath) {
        const land = await landOnOpenChat(commandExecutor, cdpBridge, commandId, ide, payload, waitUntilReady);
        if (land && !land.ok) {
          done(land);
          return;
        }
      }
      const result = await commandExecutor.stop(payload.commandId);
      done(result);
      return;
    }
    case 'command:switch_tab': {
      if (!payload.commandId || (!payload.tabTitle && !payload.selectorPath)) {
        return fail(payload.commandId, 'Missing commandId and tab target');
      }
      const result = await landOnOpenChat(commandExecutor, cdpBridge, commandId, ide, payload, waitUntilReady);
      done(result ?? { commandId, ok: false, error: 'Missing commandId and tab target' });
      return;
    }
    case 'command:new_chat': {
      if (!payload.commandId)
        return fail(payload.commandId, 'Missing commandId');
      // windowId is optional (spec §13 decision 4: a new session belongs to a window); default = currently raised window (production behavior)
      if (payload.windowId) {
        const land = await landOnOpenChat(commandExecutor, cdpBridge, commandId, ide, payload, waitUntilReady);
        if (land && !land.ok) {
          done(land);
          return;
        }
      }
      const result = await withRaiseFallback(cdpBridge, commandId, ide, () =>
        commandExecutor.newChat(payload.commandId!, { section: payload.section }));
      done(result);
      return;
    }
    case 'command:set_mode': {
      if (!payload.commandId || !payload.modeId)
        return fail(payload.commandId, 'Missing commandId or modeId');
      const result = await commandExecutor.setMode(payload.commandId, payload.modeId);
      done(result);
      return;
    }
    case 'command:set_model': {
      if (!payload.commandId || !payload.modelId)
        return fail(payload.commandId, 'Missing commandId or modelId');
      const result = await commandExecutor.setModel(payload.commandId, payload.modelId);
      done(result);
      return;
    }
    case 'command:get_model_options': {
      if (!payload.commandId)
        return fail(payload.commandId, 'Missing commandId');
      const result = await commandExecutor.getModelOptions(payload.commandId);
      done(result);
      return;
    }
    case 'command:get_plan_full': {
      // Capability table (P4): CodeBuddy has no Cursor-style plan-card DOM —
      // declared by the driver, not a hard-coded kind check in the router.
      if (!DRIVERS[parseIde(payload.ide)]?.capabilities.getPlanFull) {
        done({
          commandId: payload.commandId ?? 'unknown',
          ok: false,
          error: 'unsupported',
        } satisfies CommandResult);
        return;
      }
      if (!payload.commandId || !payload.planLabel)
        return fail(payload.commandId, 'Missing commandId or planLabel');
      const planFile = readPlanFile(payload.planLabel);
      if (!planFile) {
        done({ commandId: payload.commandId, ok: false, error: 'Plan file not found' } satisfies CommandResult);
        return;
      }
      done({
        commandId: payload.commandId,
        ok: true,
        data: {
          todos: planFile.todos,
          body: planFile.body,
        },
      } satisfies CommandResult);
      return;
    }
    case 'command:get_plan_model_options': {
      if (!payload.commandId || !payload.selectorPath)
        return fail(payload.commandId, 'Missing commandId or selectorPath');
      const result = await commandExecutor.getPlanModelOptions(payload.commandId, payload.selectorPath);
      done(result);
      return;
    }
    case 'command:set_plan_model': {
      if (!payload.commandId || !payload.selectorPath || !payload.planModelId) {
        return fail(payload.commandId, 'Missing commandId, selectorPath, or planModelId');
      }
      const result = await commandExecutor.setPlanModel(
        payload.commandId,
        payload.selectorPath,
        payload.planModelId,
      );
      done(result);
      return;
    }
    case 'command:click_action': {
      if (!payload.commandId || !payload.selectorPath)
        return fail(payload.commandId, 'Missing commandId or selectorPath');
      const result = await commandExecutor.clickAction(
        payload.commandId,
        payload.selectorPath,
        payload.actionLabel,
      );
      done(result);
      return;
    }
    case 'command:switch_window': {
      if (!payload.commandId || !payload.windowId)
        return fail(payload.commandId, 'Missing commandId or windowId');
      try {
        const winStarted = Date.now();
        await cdpBridge.switchWindow(payload.windowId);
        timingLog('router:window', {
          commandId,
          ide,
          windowId: payload.windowId,
          ms: Date.now() - winStarted,
        });
        const ready = await awaitCommandReady(waitUntilReady, commandId, ide);
        if (ready && !ready.ok) {
          done(ready);
          return;
        }
      }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        done({ commandId: payload.commandId, ok: false, error: msg } satisfies CommandResult);
        return;
      }
      const result = await withRaiseFallback(cdpBridge, commandId, ide, () =>
        commandExecutor.activateCurrentTab(payload.commandId!));
      done(result);
      break;
    }
    default:
  }
}

/**
 * Attach the full command handler set to any event-emitting peer.
 * Used by the local-mode relay (browser sockets) and by the agent
 * (remote server commands arriving over the uplink).
 * CDP Input/evaluate is serialized in the renderer — don't overlap switch + send.
 */
function enqueueCommands(
  on: OnEvent,
  run: (event: string, payload: CommandPayload) => Promise<void>,
): void {
  let tail: Promise<void> = Promise.resolve();
  let inflight = 0;
  for (const event of COMMAND_EVENTS) {
    on(event, (payload) => {
      if (inflight > 0) {
        timingLog('router:queued', { event, commandId: payload.commandId ?? 'unknown' });
      }
      inflight += 1;
      const next = tail.then(() => run(event, payload));
      tail = next
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[command-router] ${event} failed: ${message}`);
        })
        .finally(() => {
          inflight -= 1;
        });
      return next;
    });
  }
}

export function attachCommandHandlers(on: OnEvent, target: CommandTarget): void {
  enqueueCommands(on, (event, payload) => handleCommand(event, payload, target));
}

/**
 * Dispatch each command to the IDE slot named by payload.ide (default cursor).
 * A missing slot fails in place — never falls back to another IDE.
 */
export function attachIdeCommandHandlers(
  on: OnEvent,
  slots: Partial<Record<IdeKind, CommandTarget>>,
): void {
  const tails: Partial<Record<IdeKind, Promise<void>>> = {};
  for (const event of COMMAND_EVENTS) {
    on(event, (payload) => {
      const ide = parseIde(payload.ide);
      const target = slots[ide];
      if (!target) {
        timingLog('router:fail', {
          event,
          commandId: payload.commandId ?? 'unknown',
          ide,
          error: `IDE unavailable: ${ide}`,
        });
        const emit = Object.values(slots).find(slot => slot)?.emitResult;
        emit?.({
          commandId: payload.commandId ?? 'unknown',
          ok: false,
          error: `IDE unavailable: ${ide}`,
        });
        return;
      }
      if (tails[ide]) {
        timingLog('router:queued', { event, commandId: payload.commandId ?? 'unknown', ide });
      }
      const next = (tails[ide] ?? Promise.resolve()).then(() => handleCommand(event, payload, target));
      tails[ide] = next.catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[command-router] ${event} failed: ${message}`);
      });
      return next;
    });
  }
}

/** Click/send first. Raise only when the control was missing (Mini 2026-09-14 probe). */
function missingControlError(error: string | undefined): boolean {
  if (!error)
    return false;
  return (
    error.startsWith('Tab not found:')
    || error.startsWith('Chat composer not found')
    || error === 'New Chat button not found'
    || error === 'Element not found'
  );
}

async function withRaiseFallback(
  cdpBridge: CDPBridge,
  commandId: string,
  ide: IdeKind,
  action: () => Promise<CommandResult>,
): Promise<CommandResult> {
  const first = await action();
  if (first.ok || !missingControlError(first.error))
    return first;
  const raiseStarted = Date.now();
  await cdpBridge.raiseActiveWindow();
  timingLog('router:raised', {
    commandId,
    ide,
    ms: Date.now() - raiseStarted,
    fallback: true,
  });
  return action();
}

/** Switch to the window then the sidebar tab the web is looking at. */
async function landOnOpenChat(
  commandExecutor: CommandExecutorApi,
  cdpBridge: CDPBridge,
  commandId: string,
  ide: IdeKind,
  payload: Pick<CommandPayload, 'windowId' | 'tabTitle' | 'selectorPath' | 'composerId' | 'sameTitleIndex' | 'section'>,
  waitUntilReady?: () => Promise<boolean>,
): Promise<CommandResult | undefined> {
  if (payload.windowId && payload.windowId !== cdpBridge.activeTargetId) {
    const winStarted = Date.now();
    await cdpBridge.switchWindow(payload.windowId);
    timingLog('router:window', {
      commandId,
      ide,
      windowId: payload.windowId,
      ms: Date.now() - winStarted,
    });
    const ready = await awaitCommandReady(waitUntilReady, commandId, ide);
    if (ready && !ready.ok)
      return ready;
  }
  if (!payload.tabTitle && !payload.selectorPath)
    return undefined;
  return withRaiseFallback(cdpBridge, commandId, ide, () =>
    commandExecutor.switchTab(commandId, payload.tabTitle ?? '', payload.selectorPath, {
      composerId: payload.composerId,
      sameTitleIndex: payload.sameTitleIndex,
      section: payload.section,
    }));
}

async function awaitCommandReady(
  waitUntilReady: (() => Promise<boolean>) | undefined,
  commandId: string,
  ide: IdeKind,
): Promise<CommandResult | undefined> {
  if (!waitUntilReady)
    return undefined;
  const started = Date.now();
  const ok = await waitUntilReady();
  timingLog('router:ready', { commandId, ide, ok, ms: Date.now() - started });
  if (ok)
    return undefined;
  return {
    commandId,
    ok: false,
    error: `Not connected to ${IDE_LABELS[ide]}`,
  };
}
