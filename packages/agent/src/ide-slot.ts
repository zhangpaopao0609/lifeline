import type { CdpEndpointSource } from '../../protocol/src/index.js';
import type { ContentLiveRuntime } from './content-runtime.js';
import type { CdpTargetFields, LiveSlotHandle } from './drivers/types.js';
import type { AgentConfig, CursorState, IdeKind, SelectorConfig } from './types.js';
import { CDPBridge } from './cdp/bridge.js';
import { CdpClient } from './cdp/client.js';
import { resolveEndpoint } from './cdp/endpoint.js';
import { probeCdpEndpoint } from './cdp/probe.js';
import { DRIVERS } from './drivers/index.js';
import { StateManager } from './state-manager.js';
import { WindowMonitor } from './window-monitor.js';

/** After a command switches tabs: wait for the IDE to paint, then force one extract. */
const REFRESH_SETTLE_MS = 200;
const TARGET_FETCH_TIMEOUT_MS = 5000;

export interface CreateIdeSlotOptions {
  kind: IdeKind;
  cdpUrl: string;
  selectors: SelectorConfig;
  config: AgentConfig;
  runtime: ContentLiveRuntime | null;
  onPatch: (patch: Partial<CursorState>) => void;
  onConnection?: (connected: boolean) => void;
  /** Test hook: override /json listing so coding-copilot attach need not hit CDP. */
  fetchCdpTargets?: typeof fetchCdpTargets;
  /** Test hook: override live-client construction (avoid a real WebSocket). */
  createLiveClient?: () => CdpClient;
  /** Test hook: injectable timer for live retry. */
  setTimeout?: typeof setTimeout;
  /** Test hook: clock for liveIssue.at. */
  now?: () => number;
}

export interface IdeSlot {
  kind: IdeKind;
  cdpUrl: string;
  cdp: CDPBridge;
  extractor: LiveSlotHandle['extractor'];
  executor: LiveSlotHandle['executor'];
  stateManager: StateManager;
  runtime: ContentLiveRuntime | null;
  windowMonitor: WindowMonitor;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  pauseLive: () => void;
  resumeLive: () => void;
  waitUntilReady: () => Promise<boolean>;
  /** After a command changed the current session: force one extract + flush immediately so the browser need not wait for the next poll. */
  refreshState: () => Promise<void>;
}

function feedContentLive(runtime: ContentLiveRuntime | null, state: CursorState): void {
  if (!runtime)
    return;
  runtime.setActiveSession(state.activeComposerId || null);
  runtime.setLiveTail(
    state.activeComposerId && state.lastAssistantText
      ? { sessionId: state.activeComposerId, text: state.lastAssistantText }
      : undefined,
  );
}

export async function fetchCdpTargets(cdpUrl: string): Promise<CdpTargetFields[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TARGET_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${cdpUrl}/json`, { signal: controller.signal });
    if (!response.ok)
      return [];
    const targets = await response.json() as CdpTargetFields[];
    return Array.isArray(targets) ? targets : [];
  }
  catch {
    return [];
  }
  finally {
    clearTimeout(timeout);
  }
}

/**
 * Assemble one IDE's CDP + live extractor + executor + state + window monitor.
 *
 * Pure skeleton (P3): all IDE differences — port candidates, bridge config,
 * extractor/executor construction, live-connect strategy (cursor single
 * connection / codebuddy dual-connection state machine) — look up DRIVERS[kind];
 * this file keeps only the lifecycle skeleton (connect/disconnect/start/stop/
 * ready/force-refresh). Adding an IDE does not change this file.
 */
export function createIdeSlot(options: CreateIdeSlotOptions): IdeSlot {
  const { kind, selectors, config, onPatch, onConnection } = options;
  const driver = DRIVERS[kind];
  if (!driver) {
    throw new Error(`no IDE driver registered for "${kind}" (see drivers/index.ts)`);
  }
  const configuredUrl = options.cdpUrl;
  let currentCdpUrl = configuredUrl;
  let endpointSource: CdpEndpointSource | undefined;
  const fetchTargets = options.fetchCdpTargets ?? fetchCdpTargets;
  const schedule = options.setTimeout ?? setTimeout;
  const createLiveClient = options.createLiveClient ?? (() => new CdpClient());
  const now = options.now ?? Date.now;
  const slotConfig: AgentConfig = { ...config, cdpUrl: currentCdpUrl };
  const stateManager = new StateManager(config.debounceMs);
  const runtimeRef = options;

  const resolveThis = () => resolveEndpoint({
    ide: kind,
    configuredUrl,
    probe: probeCdpEndpoint,
    candidates: driver.portCandidates(),
  }).then((resolved) => {
    currentCdpUrl = resolved.cdpUrl;
    endpointSource = resolved.source;
    return resolved;
  });

  const cdp = new CDPBridge(slotConfig, {
    ide: kind,
    resolveUrl: resolveThis,
    ...driver.bridgeOptions(),
  });

  const onExtraction = (state: CursorState | null, errorMessage?: string | null): void => {
    if (state) {
      feedContentLive(runtimeRef.runtime, state);
      stateManager.onExtraction(state);
    }
    else {
      stateManager.onExtractionFailure(errorMessage ?? 'Extraction failed');
    }
  };

  const extractor = driver.createExtractor({
    selectors,
    onExtraction,
    activeWindowTitle: () => cdp.windows.find(w => w.id === cdp.activeTargetId)?.title ?? '',
    // When the home window is Cursor's Agents overview, this round runs agents extract (project extract is unchanged)
    activeWindowKind: () => cdp.windows.find(w => w.id === cdp.activeTargetId)?.kind ?? 'project',
  });

  const executor = driver.createExecutor({
    selectors,
    windowKindProvider: () =>
      (cdp.windows.find(w => w.id === cdp.activeTargetId)?.kind ?? 'project') === 'agents' ? 'agents' : 'project',
  });

  // Live ops surface: the driver drives only through this (codebuddy's dual-connection state machine is in drivers/codebuddy.ts)
  const handle: LiveSlotHandle = {
    kind,
    cdp,
    stateManager,
    extractor,
    executor,
    currentCdpUrl: () => currentCdpUrl,
    endpointSource: () => endpointSource,
    pollIntervalMs: config.pollIntervalMs,
    fetchCdpTargets: fetchTargets,
    createLiveClient,
    schedule,
    now,
  };

  stateManager.on('state:patch', (patch: Partial<CursorState>) => {
    if (typeof patch.activeComposerId === 'string') {
      runtimeRef.runtime?.setActiveSession(patch.activeComposerId || null);
    }
    onPatch(patch);
  });
  if (onConnection) {
    stateManager.on('connection:changed', (connected: boolean) => {
      onConnection(connected);
    });
  }

  cdp.on('connected', () => {
    stateManager.onConnectionChanged(true);
    stateManager.updateWindows(cdp.windows, cdp.activeTargetId);
    driver.attachLive(handle);
  });

  cdp.on('disconnected', () => {
    stateManager.onConnectionChanged(false);
    driver.detachLive(handle);
  });

  cdp.on('error', (err: Error) => {
    console.error(`[ide-slot:${kind}] CDP error: ${err.message}`);
  });

  cdp.on('issue', (issue) => {
    stateManager.setCdpIssue(issue);
  });

  const windowMonitor = new WindowMonitor(cdp, stateManager, extractor, slotConfig, selectors, {
    kind,
    ...driver.windowMonitor,
  });

  return {
    kind,
    get cdpUrl() {
      return currentCdpUrl;
    },
    cdp,
    extractor,
    executor,
    stateManager,
    get runtime() {
      return runtimeRef.runtime;
    },
    windowMonitor,
    async start() {
      // CDP attach lives only here. index.ts skips start() when the machine has no GUI.
      const resolved = await resolveThis();
      cdp.setCdpUrl(resolved.cdpUrl, resolved);
      windowMonitor.start();
      console.log(`[ide-slot:${kind}] Connecting at ${currentCdpUrl}...`);
      await cdp.connect();
    },
    async stop() {
      windowMonitor.stop();
      driver.detachLive(handle);
      await cdp.disconnect();
    },
    pauseLive() {
      runtimeRef.runtime?.pauseTicks();
      extractor.pause();
    },
    resumeLive() {
      extractor.resume();
      runtimeRef.runtime?.resumeTicks();
    },
    async waitUntilReady() {
      return driver.waitUntilReady(handle);
    },
    async refreshState() {
      await new Promise(resolve => setTimeout(resolve, REFRESH_SETTLE_MS));
      await extractor.pollNow();
      stateManager.flush();
    },
  };
}
