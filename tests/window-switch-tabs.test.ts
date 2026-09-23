import type { CDPBridge } from '../packages/agent/src/cdp/bridge.js';
import type { CdpClient } from '../packages/agent/src/cdp/client.js';
import type { ChatTab, CursorState, CursorWindow, SelectorConfig, ServerConfig } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { CodeBuddyExtractor } from '../packages/agent/src/drivers/codebuddy/extractor.js';
import { DOMExtractor } from '../packages/agent/src/drivers/cursor/extractor.js';
import { StateManager } from '../packages/agent/src/state-manager.js';
import { tabsBelongTo, WindowMonitor } from '../packages/agent/src/window-monitor.js';
import { emptyCursorState } from '../packages/server/src/pages/empty-state.js';

/**
 * 2026-09-15 feedback: after switching from a local-window session to a remote window, the web
 * session list "flashes" — the remote group vanishes as a whole, then flashes back.
 *
 * Chain: switchWindow first sets cdpBridge.activeTargetId to the new window while state.chatTabs
 * still belongs to the previous one (the new window waits for the next extract); captureHomeWindow
 * records those tabs under the new window, but each tab's own windowId is still the old window →
 * the web UI buckets by windowId and the new-window group is empty. switchGeneration only covers
 * "after connect"; the first patch is earlier than setHomeWindow.
 */

const selectors = {
  chatContainer: { strategies: [] },
  approveButton: { strategies: [], textMatch: [] },
  rejectButton: { strategies: [], textMatch: [] },
  chatInput: { strategies: [] },
  agentStatus: { strategies: [] },
} as unknown as SelectorConfig;

function dummyConfig(): ServerConfig {
  return {
    cdpUrl: 'http://127.0.0.1:9223',
    codebuddyCdpUrl: 'http://127.0.0.1:9223',
    serverPort: 3000,
    serverHost: '127.0.0.1',
    pollIntervalMs: 500,
    debounceMs: 10,
    selectorsPath: './selectors.json',
    logLevel: 'error',
    windowTitleQualifier: true,
    dataDir: '/tmp',
    mode: 'local',
    remoteUrl: '',
    agentToken: '',
  };
}

class FakeBridge extends EventEmitter {
  public windows: CursorWindow[];
  public activeTargetId: string;

  constructor(windows: CursorWindow[], active: string) {
    super();
    this.windows = windows;
    this.activeTargetId = active;
  }

  isConnected(): boolean {
    return true;
  }

  async refreshWindows(): Promise<CursorWindow[]> {
    return this.windows;
  }
}

const LOCAL: CursorWindow = {
  id: 'wa',
  title: 'local',
  url: 'vscode-file://wa/workbench.html',
  wsUrl: 'ws://wa',
};
const REMOTE: CursorWindow = {
  id: 'wb',
  title: 'workspace [SSH: remote]',
  url: 'vscode-file://wb/workbench.html',
  wsUrl: 'ws://wb',
};

/** A webview/DOM dump: tabs carry no windowId, StateManager stamps them. */
function dumpTabs(titles: string[]): ChatTab[] {
  return titles.map(title => ({
    composerId: `c-${title}`,
    title,
    isActive: true,
    status: 'active',
    selectorPath: `sp-${title}`,
  }));
}

function extraction(titles: string[]): CursorState {
  return { ...emptyCursorState(), connected: true, chatTabs: dumpTabs(titles) };
}

/**
 * The web's groupTabsByWindow: tabs bucket by their own windowId, and a tab that
 * is already in the group (same composerId + title) is not pushed twice.
 */
function groupRows(state: CursorState): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const w of state.windows ?? []) out[w.id] = [];
  const seen = new Set<string>();
  const push = (t: ChatTab) => {
    const wid = t.windowId || state.activeWindowId || 'home';
    const key = `${wid}\0${t.composerId}\0${t.title}`;
    if (seen.has(key))
      return;
    seen.add(key);
    (out[wid] ??= []).push(t.title);
  };
  for (const t of state.chatTabs ?? []) push(t);
  for (const w of state.windows ?? []) {
    for (const t of w.chatTabs ?? []) push(t);
  }
  return out;
}

function setup(): { bridge: FakeBridge; sm: StateManager; monitor: WindowMonitor } {
  const bridge = new FakeBridge([{ ...LOCAL }, { ...REMOTE }], 'wb');
  const sm = new StateManager(10);
  const monitor = new WindowMonitor(
    bridge as unknown as CDPBridge,
    sm,
    { start() {}, stop() {} },
    dummyConfig(),
    selectors,
    {
      kind: 'codebuddy',
      extractFromClient: async () => {
        throw new Error('must not use Cursor extract');
      },
      listTargets: async () => [],
    },
  );
  monitor.start();
  return { bridge, sm, monitor };
}

/** The agent's window-switch order: disconnected → connected handlers → monitor. */
function switchWindow(bridge: FakeBridge, sm: StateManager, targetId: string): void {
  bridge.activeTargetId = '';
  sm.onConnectionChanged(false);
  bridge.activeTargetId = targetId;
  bridge.windows = [
    { ...LOCAL },
    { ...REMOTE },
  ];
  sm.onConnectionChanged(true);
  sm.updateWindows(bridge.windows, targetId);
  bridge.emit('connected');
}

describe('tabsBelongTo', () => {
  it('accepts own and unstamped tabs, rejects another window\'s', () => {
    assert.equal(tabsBelongTo('wa', []), true);
    assert.equal(tabsBelongTo('wa', undefined), true);
    assert.equal(tabsBelongTo('wa', [{ ...dumpTabs(['x'])[0] }]), true);
    assert.equal(tabsBelongTo('wa', dumpTabs(['x']).map(t => ({ ...t, windowId: 'wa' }))), true);
    assert.equal(tabsBelongTo('wa', dumpTabs(['x']).map(t => ({ ...t, windowId: 'wb' }))), false);
    assert.equal(
      tabsBelongTo('wa', [
        ...dumpTabs(['own']).map(t => ({ ...t, windowId: 'wa' })),
        ...dumpTabs(['foreign']).map(t => ({ ...t, windowId: 'wb' })),
      ]),
      false,
    );
  });
});

describe('window switch keeps every group\'s own sidebar', () => {
  it('switching back to the remote window never empties its group', async (t) => {
    const { bridge, sm, monitor } = setup();
    // Stop the poll timer even if the assertion fails, otherwise node --test hangs and never exits
    t.after(() => monitor.stop());
    const state: CursorState = { ...emptyCursorState() };
    let frames: Record<string, string[]>[] = [];
    sm.on('state:patch', (patch: Partial<CursorState>) => {
      Object.assign(state, patch);
      frames.push(groupRows(state));
    });

    // The remote window is home at this moment and has already been extracted once (the user is looking at it)
    switchWindow(bridge, sm, 'wb');
    sm.onExtraction(extraction(['remote-1', 'remote-2']));
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(groupRows(state).wb, ['remote-1', 'remote-2']);

    // Switch to the local window first
    frames = [];
    switchWindow(bridge, sm, 'wa');
    sm.onExtraction(extraction(['local-1', 'local-2']));
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(groupRows(state), { wa: ['local-1', 'local-2'], wb: ['remote-1', 'remote-2'] });

    // Switch back to the remote window: from the first patch onward the remote group must stay present
    frames = [];
    switchWindow(bridge, sm, 'wb');
    sm.onExtraction(extraction(['remote-1', 'remote-2']));
    await new Promise(r => setTimeout(r, 30));

    assert.ok(frames.length > 0, 'expected the switch to emit patches');
    const empty = frames.filter(f => (f.wb ?? []).length === 0);
    assert.equal(empty.length, 0, `remote group went empty: ${JSON.stringify(frames)}`);
    assert.deepEqual(groupRows(state), { wa: ['local-1', 'local-2'], wb: ['remote-1', 'remote-2'] });
  });

  it('does not write the previous window\'s tabs into the new window slot', async (t) => {
    const { bridge, sm, monitor } = setup();
    t.after(() => monitor.stop());
    switchWindow(bridge, sm, 'wa');
    sm.onExtraction(extraction(['local-1']));
    await new Promise(r => setTimeout(r, 30));

    const writes: CursorWindow[][] = [];
    sm.on('state:patch', (patch: Partial<CursorState>) => {
      if (patch.windows)
        writes.push(patch.windows);
    });

    switchWindow(bridge, sm, 'wb');
    for (const windows of writes) {
      const wb = windows.find(w => w.id === 'wb');
      for (const tab of wb?.chatTabs ?? []) {
        assert.equal(tab.windowId, 'wb', 'another window\'s tab landed in wb');
      }
    }
  });
});

/** CDP client stand-in: the poll resolves `payload` after `delayMs`. */
class FakeClient {
  constructor(private readonly payload: () => unknown, private readonly delayMs: number) {}
  isConnected(): boolean {
    return true;
  }

  async callFunctionWithTimeout(): Promise<unknown> {
    await new Promise(r => setTimeout(r, this.delayMs));
    return this.payload();
  }
}

function codeBuddyDump(id: string): unknown {
  return {
    inputAvailable: true,
    agentStatus: 'idle',
    agentActivityText: null,
    chatTabs: [{ id, title: id, isActive: true }],
    activeComposerId: id,
    pendingApprovals: [],
    liveActions: {},
    mode: { current: 'Craft', available: [] },
    model: { current: 'Auto', currentId: 'Auto' },
  };
}

describe('a poll that is in flight when the window switches is dropped', () => {
  it('CodeBuddy: the previous window\'s dump never reaches the state', async (t) => {
    const seen: string[] = [];
    const extractor = new CodeBuddyExtractor((state, errorMessage) => {
      seen.push(state ? `state:${state.chatTabs[0]?.composerId ?? '?'}` : `fail:${errorMessage ?? ''}`);
    });
    t.after(() => extractor.stop());

    const oldClient = new FakeClient(() => codeBuddyDump('old-window'), 60);
    const newClient = new FakeClient(() => codeBuddyDump('new-window'), 5);
    extractor.start(oldClient as unknown as CdpClient, 30);
    await new Promise(r => setTimeout(r, 5)); // the old dump is in flight now
    extractor.stop();
    extractor.start(newClient as unknown as CdpClient, 30);
    await new Promise(r => setTimeout(r, 250));

    assert.ok(seen.length > 0, 'expected the new window to be extracted');
    assert.ok(seen.every(s => s === 'state:new-window'), `old window leaked: ${JSON.stringify(seen)}`);
  });

  it('Cursor: the previous window\'s DOM read never reaches the state', async (t) => {
    const seen: string[] = [];
    const extractor = new DOMExtractor(
      selectors,
      (state, errorMessage) => {
        seen.push(state ? `state:${state.chatTabs[0]?.composerId ?? '?'}` : `fail:${errorMessage ?? ''}`);
      },
      () => 'win',
    );
    t.after(() => extractor.stop());

    const dump = (id: string) => () => ({ ...emptyCursorState(), chatTabs: dumpTabs([id]) });
    const oldClient = new FakeClient(dump('old-window'), 60);
    const newClient = new FakeClient(dump('new-window'), 5);
    extractor.start(oldClient as unknown as CdpClient, 30);
    await new Promise(r => setTimeout(r, 5));
    extractor.stop();
    extractor.start(newClient as unknown as CdpClient, 30);
    await new Promise(r => setTimeout(r, 250));

    assert.ok(seen.length > 0, 'expected the new window to be extracted');
    assert.ok(seen.every(s => s === 'state:c-new-window'), `old window leaked: ${JSON.stringify(seen)}`);
  });

  it('the previous window\'s failure is not reported as the new window\'s', async (t) => {
    const seen: string[] = [];
    const extractor = new CodeBuddyExtractor((state, errorMessage) => {
      seen.push(state ? 'state' : `fail:${errorMessage ?? ''}`);
    });
    t.after(() => extractor.stop());

    const oldClient = new FakeClient(() => {
      throw new Error('Intentional disconnect');
    }, 60);
    const newClient = new FakeClient(() => codeBuddyDump('new-window'), 5);
    extractor.start(oldClient as unknown as CdpClient, 30);
    await new Promise(r => setTimeout(r, 5));
    extractor.stop();
    extractor.start(newClient as unknown as CdpClient, 30);
    await new Promise(r => setTimeout(r, 250));

    assert.ok(seen.length > 0, 'expected the new window to be extracted');
    assert.ok(seen.every(s => s === 'state'), `old window failed into the new one: ${JSON.stringify(seen)}`);
  });
});
