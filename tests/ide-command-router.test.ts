import type { CDPBridge } from '../packages/agent/src/cdp/bridge.js';
import type { CommandTarget } from '../packages/agent/src/command-router.js';
import type { CommandExecutor } from '../packages/agent/src/drivers/cursor/executor.js';
import type { CommandPayload, CommandResult } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  attachCommandHandlers,
  attachIdeCommandHandlers,

} from '../packages/agent/src/command-router.js';
import { isRetryableCommandError } from '../packages/agent/src/drivers/cursor/executor.js';

function mockExecutor(): { calls: number; executor: CommandExecutor } {
  let calls = 0;
  const executor = {
    sendMessage: async (commandId: string, _text: string): Promise<CommandResult> => {
      calls += 1;
      return { commandId, ok: true };
    },
  } as unknown as CommandExecutor;
  return {
    get calls() {
      return calls;
    },
    executor,
  };
}

function mockBridge(activeTargetId = 'home'): CDPBridge & {
  raised: number;
  switched: string[];
  activeTargetId: string;
} {
  const bridge = {
    raised: 0,
    switched: [] as string[],
    activeTargetId,
    raiseActiveWindow() {
      bridge.raised += 1;
      return Promise.resolve();
    },
    async switchWindow(targetId: string) {
      bridge.switched.push(targetId);
      bridge.activeTargetId = targetId;
    },
  };
  return bridge as CDPBridge & { raised: number; switched: string[]; activeTargetId: string };
}

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

function targetOf(
  executor: CommandExecutor,
  results: CommandResult[],
): CommandTarget {
  return {
    commandExecutor: executor,
    cdpBridge: mockBridge(),
    emitResult: (result) => {
      results.push(result);
    },
  };
}

describe('attachIdeCommandHandlers', () => {
  it('sends payload without ide only to the cursor executor', async () => {
    const cursor = mockExecutor();
    const buddy = mockExecutor();
    const results: CommandResult[] = [];
    const bus = createBus();
    attachIdeCommandHandlers(bus.on, {
      cursor: targetOf(cursor.executor, results),
      codebuddy: targetOf(buddy.executor, results),
    });

    await bus.emit('command:send_message', {
      commandId: 'c1',
      type: 'send_message',
      text: 'hello',
    });

    assert.equal(cursor.calls, 1);
    assert.equal(buddy.calls, 0);
    assert.equal(results[0]?.ok, true);
  });

  it('sends ide codebuddy only to the codebuddy executor', async () => {
    const cursor = mockExecutor();
    const buddy = mockExecutor();
    const results: CommandResult[] = [];
    const bus = createBus();
    attachIdeCommandHandlers(bus.on, {
      cursor: targetOf(cursor.executor, results),
      codebuddy: targetOf(buddy.executor, results),
    });

    await bus.emit('command:send_message', {
      commandId: 'c2',
      type: 'send_message',
      text: 'hello',
      ide: 'codebuddy',
    });

    assert.equal(cursor.calls, 0);
    assert.equal(buddy.calls, 1);
    assert.equal(results[0]?.ok, true);
  });

  it('fails when codebuddy is requested but the slot is missing', async () => {
    const cursor = mockExecutor();
    const buddy = mockExecutor();
    const results: CommandResult[] = [];
    const bus = createBus();
    attachIdeCommandHandlers(bus.on, {
      cursor: targetOf(cursor.executor, results),
    });

    await bus.emit('command:send_message', {
      commandId: 'c3',
      type: 'send_message',
      text: 'hello',
      ide: 'codebuddy',
    });

    assert.equal(cursor.calls, 0);
    assert.equal(buddy.calls, 0);
    assert.equal(results[0]?.ok, false);
    assert.equal(results[0]?.error, 'IDE unavailable: codebuddy');
  });

  it('returns unsupported for get_plan_full on codebuddy without reading plan files', async () => {
    const cursor = mockExecutor();
    const buddy = mockExecutor();
    const results: CommandResult[] = [];
    const bus = createBus();
    attachIdeCommandHandlers(bus.on, {
      cursor: targetOf(cursor.executor, results),
      codebuddy: targetOf(buddy.executor, results),
    });

    await bus.emit('command:get_plan_full', {
      commandId: 'c4',
      type: 'get_plan_full',
      planLabel: 'this-file-must-not-be-read.md',
      ide: 'codebuddy',
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.ok, false);
    assert.equal(results[0]?.error, 'unsupported');
    assert.equal(cursor.calls, 0);
    assert.equal(buddy.calls, 0);
  });
});

describe('attachCommandHandlers', () => {
  it('does not raise when the tab click succeeds', async () => {
    const results: CommandResult[] = [];
    const bridge = mockBridge();
    const executor = {
      switchTab: async (commandId: string): Promise<CommandResult> => ({
        commandId,
        ok: true,
        data: { occluded: false },
      }),
    } as unknown as CommandExecutor;
    const bus = createBus();
    attachCommandHandlers(bus.on, {
      commandExecutor: executor,
      cdpBridge: bridge,
      emitResult: (result) => {
        results.push(result);
      },
    });

    await bus.emit('command:switch_tab', {
      commandId: 't1',
      type: 'switch_tab',
      tabTitle: 'Other chat',
    });

    assert.equal(results[0]?.ok, true);
    assert.equal(bridge.raised, 0);
  });

  it('does not raise after a successful click even if the page was occluded', async () => {
    const results: CommandResult[] = [];
    const bridge = mockBridge();
    const executor = {
      switchTab: async (commandId: string): Promise<CommandResult> => ({
        commandId,
        ok: true,
        data: { occluded: true },
      }),
    } as unknown as CommandExecutor;
    const bus = createBus();
    attachCommandHandlers(bus.on, {
      commandExecutor: executor,
      cdpBridge: bridge,
      emitResult: (result) => {
        results.push(result);
      },
    });

    await bus.emit('command:switch_tab', {
      commandId: 't2',
      type: 'switch_tab',
      tabTitle: 'Other chat',
    });

    assert.equal(results[0]?.ok, true);
    assert.equal(bridge.raised, 0);
  });

  it('raises once and retries when the tab is not found', async () => {
    const results: CommandResult[] = [];
    const bridge = mockBridge();
    let attempts = 0;
    const executor = {
      switchTab: async (commandId: string): Promise<CommandResult> => {
        attempts += 1;
        if (attempts === 1) {
          return { commandId, ok: false, error: 'Tab not found: Other chat' };
        }
        return { commandId, ok: true, data: { occluded: false } };
      },
    } as unknown as CommandExecutor;
    const bus = createBus();
    attachCommandHandlers(bus.on, {
      commandExecutor: executor,
      cdpBridge: bridge,
      emitResult: (result) => {
        results.push(result);
      },
    });

    await bus.emit('command:switch_tab', {
      commandId: 't-miss',
      type: 'switch_tab',
      tabTitle: 'Other chat',
    });

    assert.equal(results[0]?.ok, true);
    assert.equal(attempts, 2);
    assert.equal(bridge.raised, 1);
  });

  it('switches to the tab window before clicking the tab', async () => {
    const order: string[] = [];
    const results: CommandResult[] = [];
    const bridge = mockBridge('home');
    bridge.switchWindow = async (targetId: string) => {
      order.push(`window:${targetId}`);
      bridge.switched.push(targetId);
      bridge.activeTargetId = targetId;
    };
    const executor = {
      switchTab: async (commandId: string, title: string): Promise<CommandResult> => {
        order.push(`tab:${title}`);
        return { commandId, ok: true, data: { occluded: false } };
      },
    } as unknown as CommandExecutor;
    const bus = createBus();
    attachCommandHandlers(bus.on, {
      commandExecutor: executor,
      cdpBridge: bridge,
      emitResult: (result) => {
        results.push(result);
      },
    });

    await bus.emit('command:switch_tab', {
      commandId: 't-win',
      type: 'switch_tab',
      tabTitle: 'Other chat',
      windowId: 'other',
    });

    assert.equal(results[0]?.ok, true);
    assert.deepEqual(order, ['window:other', 'tab:Other chat']);
  });

  it('does not switch window when the tab is already on the active window', async () => {
    const results: CommandResult[] = [];
    const bridge = mockBridge('home');
    const executor = {
      switchTab: async (commandId: string): Promise<CommandResult> => ({
        commandId,
        ok: true,
        data: { occluded: false },
      }),
    } as unknown as CommandExecutor;
    const bus = createBus();
    attachCommandHandlers(bus.on, {
      commandExecutor: executor,
      cdpBridge: bridge,
      emitResult: (result) => {
        results.push(result);
      },
    });

    await bus.emit('command:switch_tab', {
      commandId: 't-same',
      type: 'switch_tab',
      tabTitle: 'This chat',
      windowId: 'home',
    });

    assert.equal(results[0]?.ok, true);
    assert.deepEqual(bridge.switched, []);
  });

  it('does not retry Tab not found', () => {
    assert.equal(isRetryableCommandError('Tab not found: Other chat'), false);
    assert.equal(isRetryableCommandError('Chat composer not found (refusing terminal input)'), false);
    assert.equal(isRetryableCommandError('CDP timeout for Runtime.evaluate (12000ms)'), true);
  });

  it('does not raise before send_message when the composer is already there', async () => {
    const order: string[] = [];
    const bridge = mockBridge();
    bridge.raiseActiveWindow = () => {
      order.push('raise');
      bridge.raised += 1;
      return Promise.resolve();
    };
    const executor = {
      sendMessage: async (commandId: string): Promise<CommandResult> => {
        order.push('send');
        return { commandId, ok: true };
      },
    } as unknown as CommandExecutor;
    const events: string[] = [];
    const results: CommandResult[] = [];
    const bus = createBus();
    attachCommandHandlers(bus.on, {
      commandExecutor: executor,
      cdpBridge: bridge,
      pauseLive: () => events.push('pause'),
      resumeLive: () => events.push('resume'),
      emitResult: (result) => {
        results.push(result);
      },
    });

    await bus.emit('command:send_message', {
      commandId: 's1',
      type: 'send_message',
      text: 'hello',
    });

    assert.equal(results[0]?.ok, true);
    assert.deepEqual(order, ['send']);
    assert.equal(bridge.raised, 0);
    assert.deepEqual(events, ['pause', 'resume']);
  });

  it('raises once and retries send when the composer is missing', async () => {
    const results: CommandResult[] = [];
    const bridge = mockBridge();
    let attempts = 0;
    const executor = {
      sendMessage: async (commandId: string): Promise<CommandResult> => {
        attempts += 1;
        if (attempts === 1) {
          return { commandId, ok: false, error: 'Chat composer not found (refusing terminal input)' };
        }
        return { commandId, ok: true };
      },
    } as unknown as CommandExecutor;
    const bus = createBus();
    attachCommandHandlers(bus.on, {
      commandExecutor: executor,
      cdpBridge: bridge,
      emitResult: (result) => {
        results.push(result);
      },
    });

    await bus.emit('command:send_message', {
      commandId: 's-miss',
      type: 'send_message',
      text: 'hello',
    });

    assert.equal(results[0]?.ok, true);
    assert.equal(attempts, 2);
    assert.equal(bridge.raised, 1);
  });

  it('send_message lands on the requested window and tab before typing', async () => {
    const order: string[] = [];
    const bridge = mockBridge('home');
    const executor = {
      switchTab: async (commandId: string, tabTitle: string): Promise<CommandResult> => {
        order.push(`tab:${tabTitle}@${bridge.activeTargetId}`);
        return { commandId, ok: true, data: { occluded: false } };
      },
      sendMessage: async (commandId: string): Promise<CommandResult> => {
        order.push(`send@${bridge.activeTargetId}`);
        return { commandId, ok: true };
      },
    } as unknown as CommandExecutor;
    const results: CommandResult[] = [];
    const bus = createBus();
    attachCommandHandlers(bus.on, {
      commandExecutor: executor,
      cdpBridge: bridge,
      emitResult: (result) => {
        results.push(result);
      },
    });

    await bus.emit('command:send_message', {
      commandId: 's-land',
      type: 'send_message',
      text: 'hello',
      windowId: 'other',
      tabTitle: 'This chat',
      selectorPath: 'sp1',
    });

    assert.equal(results[0]?.ok, true);
    assert.deepEqual(order, ['tab:This chat@other', 'send@other']);
    assert.deepEqual(bridge.switched, ['other']);
  });

  it('stop lands on the requested chat before stopping it', async () => {
    const order: string[] = [];
    const bridge = mockBridge('home');
    const executor = {
      switchTab: async (commandId: string, tabTitle: string): Promise<CommandResult> => {
        order.push(`tab:${tabTitle}@${bridge.activeTargetId}`);
        return { commandId, ok: true, data: { occluded: false } };
      },
      stop: async (commandId: string): Promise<CommandResult> => {
        order.push(`stop@${bridge.activeTargetId}`);
        return { commandId, ok: true };
      },
    } as unknown as CommandExecutor;
    const results: CommandResult[] = [];
    const bus = createBus();
    attachCommandHandlers(bus.on, {
      commandExecutor: executor,
      cdpBridge: bridge,
      emitResult: (result) => {
        results.push(result);
      },
    });

    await bus.emit('command:stop', {
      commandId: 'x-land',
      type: 'stop',
      windowId: 'other',
      tabTitle: 'Running chat',
    });

    assert.equal(results[0]?.ok, true);
    // Background running session: switch to that one first, then stop — otherwise we stop whichever the IDE currently shows
    assert.deepEqual(order, ['tab:Running chat@other', 'stop@other']);
    assert.deepEqual(bridge.switched, ['other']);
  });

  it('stop without a target stops the active chat in place', async () => {
    const order: string[] = [];
    const bridge = mockBridge();
    const executor = {
      switchTab: async (): Promise<CommandResult> => {
        throw new Error('must not switch without a target');
      },
      stop: async (commandId: string): Promise<CommandResult> => {
        order.push('stop');
        return { commandId, ok: true };
      },
    } as unknown as CommandExecutor;
    const results: CommandResult[] = [];
    const bus = createBus();
    attachCommandHandlers(bus.on, {
      commandExecutor: executor,
      cdpBridge: bridge,
      emitResult: (result) => {
        results.push(result);
      },
    });

    await bus.emit('command:stop', { commandId: 'x-inplace', type: 'stop' });

    assert.equal(results[0]?.ok, true);
    assert.deepEqual(order, ['stop']);
    assert.equal(bridge.raised, 0);
  });

  it('waits for CodeBuddy live reconnect after switching windows before send', async () => {
    const order: string[] = [];
    const bridge = mockBridge('home');
    let live = false;
    const executor = {
      switchTab: async (commandId: string): Promise<CommandResult> => {
        order.push(live ? 'tab-ready' : 'tab-early');
        return { commandId, ok: true, data: { occluded: false } };
      },
      sendMessage: async (commandId: string): Promise<CommandResult> => {
        order.push(live ? 'send-ready' : 'send-early');
        return { commandId, ok: true };
      },
    } as unknown as CommandExecutor;
    const results: CommandResult[] = [];
    const bus = createBus();
    attachCommandHandlers(bus.on, {
      commandExecutor: executor,
      cdpBridge: bridge,
      waitUntilReady: async () => {
        order.push('wait');
        live = true;
        return true;
      },
      emitResult: (result) => {
        results.push(result);
      },
    });

    await bus.emit('command:send_message', {
      commandId: 's-wait',
      type: 'send_message',
      text: 'hello',
      ide: 'codebuddy',
      windowId: 'other',
      tabTitle: 'Buddy chat',
    });

    assert.equal(results[0]?.ok, true);
    assert.deepEqual(order, ['wait', 'tab-ready', 'send-ready']);
  });

  it('does not type when CodeBuddy is still disconnected after a window switch', async () => {
    let sent = 0;
    const executor = {
      switchTab: async (): Promise<CommandResult> => {
        throw new Error('must not click tab before live client');
      },
      sendMessage: async (): Promise<CommandResult> => {
        sent += 1;
        return { commandId: 's-dead', ok: true };
      },
    } as unknown as CommandExecutor;
    const results: CommandResult[] = [];
    const bus = createBus();
    attachCommandHandlers(bus.on, {
      commandExecutor: executor,
      cdpBridge: mockBridge('home'),
      waitUntilReady: async () => false,
      emitResult: (result) => {
        results.push(result);
      },
    });

    await bus.emit('command:send_message', {
      commandId: 's-dead',
      type: 'send_message',
      text: 'hello',
      ide: 'codebuddy',
      windowId: 'other',
      tabTitle: 'Buddy chat',
    });

    assert.equal(sent, 0);
    assert.equal(results[0]?.ok, false);
    assert.equal(results[0]?.error, 'Not connected to CodeBuddy');
  });

  it('send_message does not type when the tab is not in an open sidebar', async () => {
    let sent = 0;
    const executor = {
      switchTab: async (commandId: string): Promise<CommandResult> => ({
        commandId,
        ok: false,
        error: 'Tab not found: Ghost chat',
      }),
      sendMessage: async (commandId: string): Promise<CommandResult> => {
        sent += 1;
        return { commandId, ok: true };
      },
    } as unknown as CommandExecutor;
    const results: CommandResult[] = [];
    const bus = createBus();
    attachCommandHandlers(bus.on, {
      commandExecutor: executor,
      cdpBridge: mockBridge(),
      emitResult: (result) => {
        results.push(result);
      },
    });

    await bus.emit('command:send_message', {
      commandId: 's-ghost',
      type: 'send_message',
      text: 'hello',
      windowId: 'home',
      tabTitle: 'Ghost chat',
    });

    assert.equal(sent, 0);
    assert.equal(results[0]?.ok, false);
    assert.match(results[0]?.error || '', /Tab not found: Ghost chat/);
  });

  it('runs a send after an in-flight tab switch on the same IDE', async () => {
    const order: string[] = [];
    let releaseSwitch: () => void = () => {};
    const switchGate = new Promise<void>((resolve) => {
      releaseSwitch = resolve;
    });
    const executor = {
      switchTab: async (commandId: string): Promise<CommandResult> => {
        order.push('switch-start');
        await switchGate;
        order.push('switch-end');
        return { commandId, ok: true, data: { occluded: false } };
      },
      sendMessage: async (commandId: string): Promise<CommandResult> => {
        order.push('send');
        return { commandId, ok: true };
      },
    } as unknown as CommandExecutor;
    const bus = createBus();
    attachCommandHandlers(bus.on, targetOf(executor, []));

    const switchP = bus.emit('command:switch_tab', {
      commandId: 'sw',
      type: 'switch_tab',
      tabTitle: 'Other chat',
    });
    const sendP = bus.emit('command:send_message', {
      commandId: 'sm',
      type: 'send_message',
      text: 'hello',
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(order, ['switch-start']);
    releaseSwitch();
    await Promise.all([switchP, sendP]);
    assert.deepEqual(order, ['switch-start', 'switch-end', 'send']);
  });

  it('activates the current session after switching windows', async () => {
    const order: string[] = [];
    const results: CommandResult[] = [];
    const bridge = mockBridge('home');
    const executor = {
      activateCurrentTab: async (commandId: string): Promise<CommandResult> => {
        order.push(`activate:${bridge.activeTargetId}`);
        return { commandId, ok: true, data: { activated: true, title: 'Current chat' } };
      },
    } as unknown as CommandExecutor;
    const bus = createBus();
    attachCommandHandlers(bus.on, {
      commandExecutor: executor,
      cdpBridge: bridge,
      emitResult: (result) => {
        results.push(result);
      },
    });

    await bus.emit('command:switch_window', {
      commandId: 'w1',
      type: 'switch_tab',
      windowId: 'other',
    });

    assert.equal(results[0]?.ok, true);
    assert.deepEqual(bridge.switched, ['other']);
    assert.deepEqual(order, ['activate:other']);
  });

  it('does not activate a session when switch_window fails', async () => {
    const order: string[] = [];
    const results: CommandResult[] = [];
    const bridge = mockBridge('home');
    bridge.switchWindow = async () => {
      throw new Error('no such window');
    };
    const executor = {
      activateCurrentTab: async (): Promise<CommandResult> => {
        order.push('activate');
        return { commandId: 'w2', ok: true };
      },
    } as unknown as CommandExecutor;
    const bus = createBus();
    attachCommandHandlers(bus.on, {
      commandExecutor: executor,
      cdpBridge: bridge,
      emitResult: (result) => {
        results.push(result);
      },
    });

    await bus.emit('command:switch_window', {
      commandId: 'w2',
      type: 'switch_tab',
      windowId: 'missing',
    });

    assert.equal(results[0]?.ok, false);
    assert.deepEqual(order, []);
  });

  it('still delivers a payload without ide to the single target', async () => {
    const cursor = mockExecutor();
    const results: CommandResult[] = [];
    const bus = createBus();
    attachCommandHandlers(bus.on, targetOf(cursor.executor, results));

    await bus.emit('command:send_message', {
      commandId: 'legacy',
      type: 'send_message',
      text: 'hello',
    });

    assert.equal(cursor.calls, 1);
    assert.equal(results[0]?.ok, true);
  });

  it('passes the allowlist selectorPath through approve_all', async () => {
    // On the web, Run / Always Run are two buttons; the allowlist one cannot be found by copy ("Always Run 'pnpm'"),
    // so the selectorPath the user clicked must be passed through to the executor.
    const calls: Array<{ commandId: string; selectorPath?: string }> = [];
    const results: CommandResult[] = [];
    const executor = {
      approveAll: async (commandId: string, selectorPath?: string): Promise<CommandResult> => {
        calls.push({ commandId, selectorPath });
        return { commandId, ok: true };
      },
    } as unknown as CommandExecutor;
    const bus = createBus();
    attachCommandHandlers(bus.on, targetOf(executor, results));

    await bus.emit('command:approve_all', {
      commandId: 'aa1',
      type: 'approve_all',
      selectorPath: '#always-run',
    });

    assert.deepEqual(calls, [{ commandId: 'aa1', selectorPath: '#always-run' }]);
    assert.equal(results[0]?.ok, true);
  });

  it('keeps approve_all working for clients that send no selectorPath', async () => {
    const calls: Array<{ commandId: string; selectorPath?: string }> = [];
    const results: CommandResult[] = [];
    const executor = {
      approveAll: async (commandId: string, selectorPath?: string): Promise<CommandResult> => {
        calls.push({ commandId, selectorPath });
        return { commandId, ok: true };
      },
    } as unknown as CommandExecutor;
    const bus = createBus();
    attachCommandHandlers(bus.on, targetOf(executor, results));

    await bus.emit('command:approve_all', {
      commandId: 'aa2',
      type: 'approve_all',
    });

    assert.deepEqual(calls, [{ commandId: 'aa2', selectorPath: undefined }]);
    assert.equal(results[0]?.ok, true);
  });
});
