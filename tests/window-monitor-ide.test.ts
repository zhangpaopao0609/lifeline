import type { CDPBridge } from '../packages/agent/src/cdp/bridge.js';
import type { CursorWindow, SelectorConfig, ServerConfig } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { StateManager } from '../packages/agent/src/state-manager.js';
import {
  shouldParallelExtractLive,
  WindowMonitor,
} from '../packages/agent/src/window-monitor.js';

function dummyConfig(): ServerConfig {
  return {
    cdpUrl: 'http://127.0.0.1:9222',
    codebuddyCdpUrl: 'http://127.0.0.1:9223',
    serverPort: 3000,
    serverHost: '127.0.0.1',
    pollIntervalMs: 300,
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

const selectors: SelectorConfig = {
  chatContainer: { strategies: [] },
  approveButton: { strategies: [], textMatch: [] },
  rejectButton: { strategies: [], textMatch: [] },
  chatInput: { strategies: [] },
  agentStatus: { strategies: [] },
};

function mockBridge(windows: CursorWindow[]): CDPBridge & { emitConnected: () => void } {
  const bus = new EventEmitter();
  const bridge = {
    windows,
    activeTargetId: windows[0]?.id ?? '',
    isConnected: () => true,
    refreshWindows: async () => windows,
    on: bus.on.bind(bus),
    off: bus.off.bind(bus),
    emitConnected() {
      bus.emit('connected');
    },
  };
  return bridge as CDPBridge & { emitConnected: () => void };
}

describe('WindowMonitor IDE extract guard', () => {
  it('does not call Cursor DOM extract when kind is codebuddy', async () => {
    assert.equal(shouldParallelExtractLive('codebuddy'), true);
    const windows: CursorWindow[] = [
      { id: 'home', title: 'a', url: 'vscode-file://a/workbench.html', wsUrl: 'ws://home' },
      { id: 'other', title: 'b', url: 'vscode-file://b/workbench.html', wsUrl: 'ws://other' },
    ];
    let extractCalls = 0;
    const monitor = new WindowMonitor(
      mockBridge(windows),
      new StateManager(10),
      { start() {}, stop() {} },
      dummyConfig(),
      selectors,
      {
        kind: 'codebuddy',
        extractFromClient: async () => {
          extractCalls += 1;
          return null;
        },
        listTargets: async () => [],
      },
    );
    await monitor.runCycle();
    assert.equal(extractCalls, 0);
  });

  it('stamps other CodeBuddy window tabs from that window\'s coding-copilot webview', async () => {
    const windows: CursorWindow[] = [
      { id: 'wb-a', title: 'a', url: 'vscode-file://a/workbench.html', wsUrl: 'ws://wb-a' },
      { id: 'wb-b', title: 'b', url: 'vscode-file://b/workbench.html', wsUrl: 'ws://wb-b' },
    ];
    const sm = new StateManager(10);
    const seen: string[] = [];
    const monitor = new WindowMonitor(
      mockBridge(windows),
      sm,
      { start() {}, stop() {} },
      dummyConfig(),
      selectors,
      {
        kind: 'codebuddy',
        extractFromClient: async () => {
          throw new Error('must not use Cursor extract');
        },
        listTargets: async () => [
          { id: 'wb-a', url: 'vscode-file://a/workbench.html', webSocketDebuggerUrl: 'ws://wb-a' },
          { id: 'wb-b', url: 'vscode-file://b/workbench.html', webSocketDebuggerUrl: 'ws://wb-b' },
          {
            id: 'wv-a',
            url: 'vscode-webview://hash-a/coding-copilot',
            webSocketDebuggerUrl: 'ws://wv-a',
            parentId: 'wb-a',
          },
          {
            id: 'wv-b',
            url: 'vscode-webview://hash-b/coding-copilot',
            webSocketDebuggerUrl: 'ws://wv-b',
            parentId: 'wb-b',
          },
        ],
        extractCodeBuddyLive: async (wsUrl) => {
          seen.push(wsUrl);
          return {
            connected: true,
            extractorStatus: 'ok',
            lastExtractionAt: null,
            consecutiveExtractionFailures: 0,
            lastExtractionError: null,
            agentStatus: 'idle',
            agentActivityText: null,
            agentActivityLive: false,
            agentActivitySource: 'none',
            messages: [],
            liveActions: {},
            pendingApprovals: [],
            inputAvailable: true,
            chatTabs: [{
              composerId: 'sess-b',
              title: 'Buddy B',
              isActive: true,
              status: 'active',
              selectorPath: 'sp',
              windowId: 'wb-b',
            }],
            activeComposerId: 'sess-b',
            mode: { current: 'craft', available: [] },
            model: { current: 'Auto', currentId: '' },
            windows: [],
            activeWindowId: '',
            composerQueue: { items: [] },
            questionnaire: null,
            contentSource: 'ok',
          };
        },
      },
    );
    await monitor.runCycle();
    assert.deepEqual(seen, ['ws://wv-b']);
    assert.equal(sm.getCurrentState().windows[1].chatTabs?.[0].title, 'Buddy B');
  });

  it('does not stamp the home CodeBuddy webview onto another window', async () => {
    const windows: CursorWindow[] = [
      { id: 'wb-a', title: 'a', url: 'vscode-file://a/workbench.html', wsUrl: 'ws://wb-a' },
      { id: 'wb-b', title: 'b', url: 'vscode-file://b/workbench.html', wsUrl: 'ws://wb-b' },
    ];
    const sm = new StateManager(10);
    const seen: string[] = [];
    const monitor = new WindowMonitor(
      mockBridge(windows),
      sm,
      { start() {}, stop() {} },
      dummyConfig(),
      selectors,
      {
        kind: 'codebuddy',
        listTargets: async () => [
          { id: 'wb-a', url: 'vscode-file://a/workbench.html', webSocketDebuggerUrl: 'ws://wb-a' },
          { id: 'wb-b', url: 'vscode-file://b/workbench.html', webSocketDebuggerUrl: 'ws://wb-b' },
          {
            id: 'wv-a',
            url: 'vscode-webview://hash-a/coding-copilot',
            webSocketDebuggerUrl: 'ws://wv-a',
            parentId: 'wb-a',
          },
        ],
        extractCodeBuddyLive: async (wsUrl) => {
          seen.push(wsUrl);
          return null;
        },
      },
    );
    await monitor.runCycle();
    assert.deepEqual(seen, []);
    assert.equal(sm.getCurrentState().windows[1]?.chatTabs, undefined);
  });

  it('after a window switch, does not parallel-poll the new live CodeBuddy copilot', async () => {
    const windows: CursorWindow[] = [
      { id: 'wb-a', title: 'lifeline', url: 'vscode-file://a/workbench.html', wsUrl: 'ws://wb-a' },
      { id: 'wb-b', title: 'tdesign-vue-next', url: 'vscode-file://b/workbench.html', wsUrl: 'ws://wb-b' },
    ];
    const bridge = mockBridge(windows);
    const seen: string[] = [];
    const monitor = new WindowMonitor(
      bridge,
      new StateManager(10),
      { start() {}, stop() {} },
      dummyConfig(),
      selectors,
      {
        kind: 'codebuddy',
        listTargets: async () => [
          { id: 'wb-a', url: 'vscode-file://a/workbench.html', webSocketDebuggerUrl: 'ws://wb-a' },
          { id: 'wb-b', url: 'vscode-file://b/workbench.html', webSocketDebuggerUrl: 'ws://wb-b' },
          {
            id: 'wv-a',
            url: 'vscode-webview://hash-a/coding-copilot',
            webSocketDebuggerUrl: 'ws://wv-a',
            parentId: 'wb-a',
          },
          {
            id: 'wv-b',
            url: 'vscode-webview://hash-b/coding-copilot',
            webSocketDebuggerUrl: 'ws://wv-b',
            parentId: 'wb-b',
          },
        ],
        extractCodeBuddyLive: async (wsUrl) => {
          seen.push(wsUrl);
          return null;
        },
      },
    );
    monitor.start();
    try {
      bridge.activeTargetId = 'wb-a';
      bridge.emitConnected();
      assert.equal(monitor.getHomeWindowId(), 'wb-a');

      bridge.activeTargetId = 'wb-b';
      bridge.emitConnected();
      assert.equal(monitor.getHomeWindowId(), 'wb-b');

      await monitor.runCycle();
      assert.deepEqual(seen, ['ws://wv-a']);
    }
    finally {
      monitor.stop();
    }
  });
});
