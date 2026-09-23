import type { CDPBridge } from '../packages/agent/src/cdp/bridge.js';
import type { CommandExecutor } from '../packages/agent/src/drivers/cursor/executor.js';
import type { CommandPayload, CommandResult, CursorState } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attachCommandHandlers } from '../packages/agent/src/command-router.js';
import { StateManager } from '../packages/agent/src/state-manager.js';
import { emptyCursorState } from '../packages/server/src/pages/empty-state.js';

/**
 * After a command switches session, the new state must be pushed to the browser immediately
 * (spec: the fix for "click a session, it takes 1-2s to switch"):
 * - switch_tab / switch_window then trigger refreshState (forced extract + flush debounce)
 * - other commands do not trigger it
 * - StateManager.flush() skips debounce and sends the pending patch immediately
 */

function createBus(): {
  on: (event: string, handler: (payload: CommandPayload) => void) => void;
  emit: (event: string, payload: CommandPayload) => Promise<void>;
} {
  const handlers = new Map<string, Array<(payload: CommandPayload) => unknown>>();
  return {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    async emit(event, payload) {
      const list = handlers.get(event) ?? [];
      await Promise.all(list.map(handler => Promise.resolve(handler(payload))));
    },
  };
}

function mockBridge(): CDPBridge {
  return {
    activeTargetId: 'home',
    raiseActiveWindow: () => Promise.resolve(),
    switchWindow: () => Promise.resolve(),
  } as unknown as CDPBridge;
}

function targetWith(refreshed: { count: number }, executor: unknown) {
  return {
    commandExecutor: executor as CommandExecutor,
    cdpBridge: mockBridge(),
    emitResult: () => {},
    refreshState: async () => {
      refreshed.count += 1;
    },
  };
}

describe('refresh after switch commands', () => {
  it('triggers refreshState after a successful switch_tab', async () => {
    const refreshed = { count: 0 };
    const executor = {
      switchTab: async (commandId: string): Promise<CommandResult> => ({ commandId, ok: true }),
    };
    const bus = createBus();
    attachCommandHandlers(bus.on, targetWith(refreshed, executor));

    await bus.emit('command:switch_tab', { commandId: 'r1', type: 'switch_tab', tabTitle: 'A' });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(refreshed.count, 1);
  });

  it('triggers refreshState after switch_window', async () => {
    const refreshed = { count: 0 };
    const executor = {
      activateCurrentTab: async (commandId: string): Promise<CommandResult> => ({ commandId, ok: true }),
    };
    const bus = createBus();
    attachCommandHandlers(bus.on, targetWith(refreshed, executor));

    await bus.emit('command:switch_window', {
      commandId: 'r2',
      type: 'switch_window',
      windowId: 'home',
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(refreshed.count, 1);
  });

  it('triggers refreshState after new_chat (草稿会话要立刻上网页)', async () => {
    const refreshed = { count: 0 };
    const executor = {
      newChat: async (commandId: string): Promise<CommandResult> => ({ commandId, ok: true }),
    };
    const bus = createBus();
    attachCommandHandlers(bus.on, targetWith(refreshed, executor));

    await bus.emit('command:new_chat', { commandId: 'r4', type: 'new_chat' });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(refreshed.count, 1);
  });

  it('does not refresh for unrelated commands', async () => {
    const refreshed = { count: 0 };
    const executor = {
      sendMessage: async (commandId: string): Promise<CommandResult> => ({ commandId, ok: true }),
    };
    const bus = createBus();
    attachCommandHandlers(bus.on, targetWith(refreshed, executor));

    await bus.emit('command:send_message', { commandId: 'r3', type: 'send_message', text: 'hi' });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(refreshed.count, 0);
  });
});

describe('StateManager.flush', () => {
  it('emits the pending patch immediately, bypassing the debounce', () => {
    const manager = new StateManager(60_000);
    const patches: Array<Partial<CursorState>> = [];
    manager.on('state:patch', (patch: Partial<CursorState>) => patches.push(patch));

    const next = emptyCursorState();
    next.activeComposerId = 'session-1';
    manager.onExtraction(next);
    assert.equal(patches.length, 0, 'debounce window should hold the patch');

    manager.flush();
    assert.equal(patches.length, 1);
    assert.equal(patches[0]?.activeComposerId, 'session-1');
  });

  it('is a no-op when nothing is pending', () => {
    const manager = new StateManager(60_000);
    const patches: Array<Partial<CursorState>> = [];
    manager.on('state:patch', (patch: Partial<CursorState>) => patches.push(patch));

    manager.flush();
    assert.equal(patches.length, 0);
  });
});
