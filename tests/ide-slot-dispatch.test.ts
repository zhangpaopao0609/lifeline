import type { CdpClient } from '../packages/agent/src/cdp/client.js';
import type { SelectorConfig, ServerConfig } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { CodeBuddyExecutor } from '../packages/agent/src/drivers/codebuddy/executor.js';
import { CodeBuddyExtractor, pickCodingCopilotTarget } from '../packages/agent/src/drivers/codebuddy/extractor.js';
import { CommandExecutor } from '../packages/agent/src/drivers/cursor/executor.js';
import { DOMExtractor } from '../packages/agent/src/drivers/cursor/extractor.js';
import { createIdeSlot } from '../packages/agent/src/ide-slot.js';
import { shouldParallelExtractLive } from '../packages/agent/src/window-monitor.js';

function dummyConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
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
    ...overrides,
  };
}

function dummySelectors(): SelectorConfig {
  return {
    chatContainer: { strategies: [] },
    approveButton: { strategies: [], textMatch: [] },
    rejectButton: { strategies: [], textMatch: [] },
    chatInput: { strategies: [] },
    agentStatus: { strategies: [] },
  };
}

describe('createIdeSlot', () => {
  it('builds a cursor slot with DOM extractor and CommandExecutor', () => {
    const config = dummyConfig();
    const slot = createIdeSlot({
      kind: 'cursor',
      cdpUrl: config.cdpUrl,
      selectors: dummySelectors(),
      config,
      runtime: null,
      onPatch: () => {},
    });
    assert.equal(slot.kind, 'cursor');
    assert.equal(slot.cdpUrl, 'http://127.0.0.1:9222');
    assert.ok(slot.executor instanceof CommandExecutor);
    assert.ok(slot.extractor instanceof DOMExtractor);
    assert.equal(slot.executor instanceof CodeBuddyExecutor, false);
  });

  it('builds a codebuddy slot with CodeBuddy extractor and executor on 9223', () => {
    const config = dummyConfig();
    const slot = createIdeSlot({
      kind: 'codebuddy',
      cdpUrl: config.codebuddyCdpUrl,
      selectors: dummySelectors(),
      config,
      runtime: null,
      onPatch: () => {},
    });
    assert.equal(slot.kind, 'codebuddy');
    assert.equal(slot.cdpUrl, 'http://127.0.0.1:9223');
    assert.ok(slot.executor instanceof CodeBuddyExecutor);
    assert.ok(slot.extractor instanceof CodeBuddyExtractor);
    assert.equal(slot.executor instanceof CommandExecutor, false);
  });

  it('keeps contentSource patches on the slot that produced them', () => {
    const config = dummyConfig();
    const selectors = dummySelectors();
    const cursorPatches: unknown[] = [];
    const buddyPatches: unknown[] = [];
    const cursor = createIdeSlot({
      kind: 'cursor',
      cdpUrl: config.cdpUrl,
      selectors,
      config,
      runtime: null,
      onPatch: (patch) => {
        cursorPatches.push(patch);
      },
    });
    const buddy = createIdeSlot({
      kind: 'codebuddy',
      cdpUrl: config.codebuddyCdpUrl,
      selectors,
      config,
      runtime: null,
      onPatch: (patch) => {
        buddyPatches.push(patch);
      },
    });

    cursor.stateManager.setContentSource('unavailable');
    buddy.stateManager.setContentSource('unavailable');

    assert.equal(cursor.stateManager.getCurrentState().contentSource, 'unavailable');
    assert.equal(buddy.stateManager.getCurrentState().contentSource, 'unavailable');
    assert.deepEqual(cursorPatches, [{ contentSource: 'unavailable' }]);
    assert.deepEqual(buddyPatches, [{ contentSource: 'unavailable' }]);
  });

  it('tags the CodeBuddy slot so WindowMonitor will not run Cursor DOM extract', () => {
    const config = dummyConfig();
    const slot = createIdeSlot({
      kind: 'codebuddy',
      cdpUrl: config.codebuddyCdpUrl,
      selectors: dummySelectors(),
      config,
      runtime: null,
      onPatch: () => {},
    });
    assert.equal(slot.windowMonitor.kind, 'codebuddy');
    assert.equal(shouldParallelExtractLive('codebuddy'), true);
    assert.equal(shouldParallelExtractLive('cursor'), true);
    assert.equal(slot.cdp.raiseAppNames.includes('Cursor'), false);
    assert.ok(slot.cdp.raiseAppNames.some(name => name.startsWith('CodeBuddy')));
  });
});

interface JsonTarget {
  url: string;
  webSocketDebuggerUrl?: string;
  id?: string;
  parentId?: string;
}

class FakeLiveClient extends EventEmitter {
  constructor(private readonly failWith?: string) {
    super();
  }

  async connect(_wsUrl: string): Promise<void> {
    if (this.failWith)
      throw new Error(this.failWith);
  }

  disconnect(): void {}
  isConnected(): boolean {
    return !this.failWith;
  }
}

async function afterAttach(): Promise<void> {
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

function codebuddyLiveSlot(hooks: {
  fetchCdpTargets: () => Promise<JsonTarget[]>;
  createLiveClient?: () => CdpClient;
  now?: () => number;
}): { slot: ReturnType<typeof createIdeSlot>; delays: number[]; fireNext: () => void } {
  const delays: number[] = [];
  const queued: Array<() => void> = [];
  const config = dummyConfig();
  const slot = createIdeSlot({
    kind: 'codebuddy',
    cdpUrl: config.codebuddyCdpUrl,
    selectors: dummySelectors(),
    config,
    runtime: null,
    onPatch: () => {},
    fetchCdpTargets: hooks.fetchCdpTargets,
    createLiveClient: hooks.createLiveClient,
    now: hooks.now,
    setTimeout: ((fn: () => void, ms?: number) => {
      delays.push(Number(ms));
      queued.push(fn);
      return delays.length as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
  });
  return {
    slot,
    delays,
    fireNext: () => {
      const next = queued.shift();
      next?.();
    },
  };
}

describe('CodeBuddy coding-copilot liveIssue', () => {
  it('does not set liveIssue when the chat panel is collapsed (no target)', async () => {
    const { slot, delays, fireNext } = codebuddyLiveSlot({
      fetchCdpTargets: async () => [
        { url: 'vscode-file://app/workbench.html', webSocketDebuggerUrl: 'ws://wb', id: 'wb' },
      ],
    });
    slot.cdp.emit('connected');
    await afterAttach();
    assert.equal(slot.stateManager.getCurrentState().liveIssue, null);
    assert.equal(delays[0], 2000);

    fireNext();
    await afterAttach();
    assert.equal(slot.stateManager.getCurrentState().liveIssue, null);
    assert.equal(delays[1], 4000);

    fireNext();
    await afterAttach();
    assert.equal(slot.stateManager.getCurrentState().liveIssue, null);
    assert.equal(delays[2], 8000);

    fireNext();
    await afterAttach();
    assert.equal(delays[3], 10_000);

    fireNext();
    await afterAttach();
    assert.equal(delays[4], 10_000);
    await slot.stop();
  });

  it('reports attach-failed when coding-copilot handshake throws', async () => {
    const { slot, delays } = codebuddyLiveSlot({
      fetchCdpTargets: async () => [
        {
          url: 'vscode-webview://hash/coding-copilot',
          webSocketDebuggerUrl: 'ws://wv',
          id: 'wv',
        },
      ],
      createLiveClient: () => new FakeLiveClient('ws handshake refused') as unknown as CdpClient,
      now: () => 1_700_000_000_000,
    });
    slot.cdp.emit('connected');
    await afterAttach();
    const issue = slot.stateManager.getCurrentState().liveIssue;
    assert.equal(issue?.kind, 'attach-failed');
    assert.equal(issue?.scope, 'live');
    assert.equal(issue?.cdpUrl, 'http://127.0.0.1:9223');
    assert.equal(issue?.port, 9223);
    assert.equal(issue?.detail, 'ws handshake refused');
    assert.equal(issue?.at, 1_700_000_000_000);
    assert.equal(delays[0], 2000);
    await slot.stop();
  });

  it('clears liveIssue when the coding-copilot target disappears after a handshake fail', async () => {
    let includeCopilot = true;
    const { slot, fireNext } = codebuddyLiveSlot({
      fetchCdpTargets: async () => {
        const targets: JsonTarget[] = [
          { url: 'vscode-file://app/workbench.html', webSocketDebuggerUrl: 'ws://wb', id: 'wb' },
        ];
        if (includeCopilot) {
          targets.push({
            url: 'vscode-webview://hash/coding-copilot',
            webSocketDebuggerUrl: 'ws://wv',
            id: 'wv',
          });
        }
        return targets;
      },
      createLiveClient: () => new FakeLiveClient('ws handshake refused') as unknown as CdpClient,
    });
    slot.cdp.emit('connected');
    await afterAttach();
    assert.equal(slot.stateManager.getCurrentState().liveIssue?.kind, 'attach-failed');
    includeCopilot = false;
    fireNext();
    await afterAttach();
    assert.equal(slot.stateManager.getCurrentState().liveIssue, null);
    await slot.stop();
  });

  it('clears liveIssue after a successful coding-copilot attach', async () => {
    let failHandshake = true;
    const { slot, fireNext } = codebuddyLiveSlot({
      fetchCdpTargets: async () => [
        {
          url: 'vscode-webview://hash/coding-copilot',
          webSocketDebuggerUrl: 'ws://wv',
          id: 'wv',
        },
      ],
      createLiveClient: () =>
        new FakeLiveClient(failHandshake ? 'ws handshake refused' : undefined) as unknown as CdpClient,
    });
    slot.cdp.emit('connected');
    await afterAttach();
    assert.equal(slot.stateManager.getCurrentState().liveIssue?.kind, 'attach-failed');
    failHandshake = false;
    fireNext();
    await afterAttach();
    assert.equal(slot.stateManager.getCurrentState().liveIssue, null);
    await slot.stop();
  });

  it('clears liveIssue when the workbench disconnects', async () => {
    const { slot } = codebuddyLiveSlot({
      fetchCdpTargets: async () => [
        {
          url: 'vscode-webview://hash/coding-copilot',
          webSocketDebuggerUrl: 'ws://wv',
          id: 'wv',
        },
      ],
      createLiveClient: () => new FakeLiveClient('ws handshake refused') as unknown as CdpClient,
    });
    slot.cdp.emit('connected');
    await afterAttach();
    assert.equal(slot.stateManager.getCurrentState().liveIssue?.kind, 'attach-failed');
    slot.cdp.emit('disconnected');
    assert.equal(slot.stateManager.getCurrentState().liveIssue, null);
    await slot.stop();
  });
});

/**
 * Heuristic (see pickCodingCopilotTarget): parentId / openerId of the webview
 * equal the active workbench id; else same browserContextId as that workbench;
 * else first coding-copilot with a websocket (single-window fallback).
 */
describe('pickCodingCopilotTarget for the active workbench', () => {
  const twoWindows = [
    {
      id: 'wb-a',
      type: 'page',
      title: 'proj-a - CodeBuddy',
      url: 'vscode-file://app/workbench.html',
      webSocketDebuggerUrl: 'ws://wb-a',
      browserContextId: 'ctx-a',
    },
    {
      id: 'wb-b',
      type: 'page',
      title: 'proj-b - CodeBuddy',
      url: 'vscode-file://app/workbench.html',
      webSocketDebuggerUrl: 'ws://wb-b',
      browserContextId: 'ctx-b',
    },
    {
      id: 'wv-a',
      type: 'iframe',
      title: 'coding-copilot',
      url: 'vscode-webview://hash-a/coding-copilot',
      webSocketDebuggerUrl: 'ws://wv-a',
      parentId: 'wb-a',
      openerId: 'wb-a',
      browserContextId: 'ctx-a',
    },
    {
      id: 'wv-b',
      type: 'iframe',
      title: 'coding-copilot',
      url: 'vscode-webview://hash-b/coding-copilot',
      webSocketDebuggerUrl: 'ws://wv-b',
      parentId: 'wb-b',
      openerId: 'wb-b',
      browserContextId: 'ctx-b',
    },
  ];

  it('picks the webview whose parentId is the active workbench, not the first match', () => {
    const first = pickCodingCopilotTarget(twoWindows);
    assert.equal(first?.id, 'wv-a');
    const forB = pickCodingCopilotTarget(twoWindows, { workbenchId: 'wb-b' });
    assert.equal(forB?.id, 'wv-b');
    const forA = pickCodingCopilotTarget(twoWindows, { workbenchId: 'wb-a' });
    assert.equal(forA?.id, 'wv-a');
  });

  it('falls back to same browserContextId when parentId is missing', () => {
    const noParent = twoWindows.map(({ parentId: _p, openerId: _o, ...rest }) => rest);
    const forB = pickCodingCopilotTarget(noParent, { workbenchId: 'wb-b' });
    assert.equal(forB?.id, 'wv-b');
  });

  it('does not fall back to the first panel when requireUnique is set', () => {
    const noParent = twoWindows.map(({ parentId: _p, openerId: _o, browserContextId: _c, ...rest }) => rest);
    const forB = pickCodingCopilotTarget(noParent, { workbenchId: 'wb-b', requireUnique: true });
    assert.equal(forB, undefined);
  });
});
