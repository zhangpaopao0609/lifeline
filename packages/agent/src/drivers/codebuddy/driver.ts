import type { CdpClient } from '../../cdp/client.js';
import type { ExecutorFactoryContext, ExtractorFactoryContext, IdeDriver, LiveSlotHandle } from '../types.js';
import { join } from 'node:path';
import { codeBuddyArgvCandidates } from '../../../../cli/src/cdp-argv-file.js';
import { CODEBUDDY_TITLE_SUFFIXES } from '../../cdp/bridge.js';
import { codeBuddyActivePortCandidates } from '../../cdp/endpoint.js';
import { cdpPortFromUrl, nextReconnectDelay } from '../../cdp/relaunch-engine.js';
import { tryOpenCodeBuddyAdapter } from '../../content-runtime.js';
import { codeBuddyExeCandidates } from '../../win-paths.js';
import { CodeBuddyExecutor } from './executor.js';
import { CodeBuddyExtractor, pickCodingCopilotTarget } from './extractor.js';
import {
  CODEBUDDY_APP_CANDIDATES,
  createCodeBuddyCdpRelauncher,
  defaultCodeBuddyCdpRelaunchDeps,
  resolveCodeBuddyAppName,
} from './relaunch.js';

const LIVE_RETRY_MS = 2000;

/**
 * CodeBuddy: dual-connection strategy — besides workbench CDP, live state
 * (tabs / approvals / input) uses a direct CdpClient to the coding-copilot
 * webview, with generation (gen) and backoff retry self-heal; new-session "+"
 * lives on the workbench, so the executor also holds a workbench client.
 *
 * Live state is **one copy per slot** (the driver is a singleton; state must
 * never hang off the driver instance) — WeakMap keyed by LiveSlotHandle, so
 * tests that create multiple slots of the same kind do not interfere.
 */
interface LiveState {
  gen: number;
  client: CdpClient | null;
  retry: ReturnType<typeof setTimeout> | null;
  delay: number;
}

const liveStates = new WeakMap<LiveSlotHandle, LiveState>();

function liveState(slot: LiveSlotHandle): LiveState {
  let state = liveStates.get(slot);
  if (!state) {
    state = { gen: 0, client: null, retry: null, delay: LIVE_RETRY_MS };
    liveStates.set(slot, state);
  }
  return state;
}

function stopLive(slot: LiveSlotHandle): void {
  const state = liveState(slot);
  state.gen += 1;
  if (state.retry) {
    clearTimeout(state.retry);
    state.retry = null;
  }
  state.delay = LIVE_RETRY_MS;
  slot.extractor.stop();
  slot.executor.setClient(null);
  if (state.client) {
    state.client.disconnect();
    state.client = null;
  }
  slot.stateManager.setLiveIssue(null);
}

function scheduleRetry(slot: LiveSlotHandle, gen: number): void {
  const state = liveState(slot);
  const delay = state.delay;
  state.delay = nextReconnectDelay(delay, { kind: 'no-workbench', max: 10_000 });
  state.retry = slot.schedule(() => {
    liveState(slot).retry = null;
    void attachCodingCopilot(slot, gen);
  }, delay);
}

async function attachCodingCopilot(slot: LiveSlotHandle, gen: number): Promise<void> {
  const state = liveState(slot);
  const targets = await slot.fetchCdpTargets(slot.currentCdpUrl());
  if (gen !== state.gen)
    return;
  const target = pickCodingCopilotTarget(targets, {
    workbenchId: slot.cdp.activeTargetId,
    requireUnique: true,
  });
  if (!target?.webSocketDebuggerUrl) {
    slot.stateManager.setLiveIssue(null);
    scheduleRetry(slot, gen);
    return;
  }
  const client = slot.createLiveClient();
  try {
    await client.connect(target.webSocketDebuggerUrl);
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ide-slot:${slot.kind}] coding-copilot connect failed: ${message}`);
    if (gen !== state.gen)
      return;
    slot.stateManager.setLiveIssue({
      kind: 'attach-failed',
      scope: 'live',
      cdpUrl: slot.currentCdpUrl(),
      port: cdpPortFromUrl(slot.currentCdpUrl()),
      detail: message,
      at: slot.now(),
      endpointSource: slot.endpointSource(),
    });
    scheduleRetry(slot, gen);
    return;
  }
  if (gen !== state.gen) {
    client.disconnect();
    return;
  }
  state.client = client;
  state.delay = LIVE_RETRY_MS;
  slot.stateManager.setLiveIssue(null);
  client.on('disconnected', () => {
    if (gen !== state.gen || state.client !== client)
      return;
    slot.extractor.stop();
    slot.executor.setClient(null);
    state.client = null;
    scheduleRetry(slot, state.gen);
  });
  slot.extractor.start(client, slot.pollIntervalMs);
  slot.executor.setClient(client);
}

export const codebuddyDriver: IdeDriver = {
  kind: 'codebuddy',

  cdpUrlOf: config => config.codebuddyCdpUrl,
  portCandidates: codeBuddyActivePortCandidates,
  argvPaths: codeBuddyArgvCandidates,

  hasLiveApp(exists, home, platform, env) {
    if (platform === 'darwin') {
      return CODEBUDDY_APP_CANDIDATES.some(
        name => exists(`/Applications/${name}.app`) || exists(join(home, 'Applications', `${name}.app`)),
      );
    }
    if (platform === 'win32') {
      return codeBuddyExeCandidates(env, home).some(exists);
    }
    return false;
  },

  bridgeOptions() {
    const resolved = resolveCodeBuddyAppName();
    const appNames = resolved
      ? [resolved, ...CODEBUDDY_APP_CANDIDATES.filter(name => name !== resolved)]
      : [...CODEBUDDY_APP_CANDIDATES];
    return {
      titleSuffixes: [...CODEBUDDY_TITLE_SUFFIXES],
      appNames,
      relauncher: createCodeBuddyCdpRelauncher({
        deps: defaultCodeBuddyCdpRelaunchDeps(),
      }),
    };
  },

  openDiskAdapter: opts => tryOpenCodeBuddyAdapter(undefined, opts),
  capabilities: { getPlanFull: false },

  windowMonitor: { otherWindowsRequireWsUrl: false },

  createExtractor(ctx: ExtractorFactoryContext) {
    return new CodeBuddyExtractor(ctx.onExtraction);
  },

  createExecutor(_ctx: ExecutorFactoryContext) {
    return new CodeBuddyExecutor();
  },

  attachLive(slot) {
    stopLive(slot);
    // New-session "+" is on the workbench: the executor holds both workbench and webview clients.
    if (slot.executor instanceof CodeBuddyExecutor) {
      slot.executor.setWorkbenchClient(slot.cdp.getClient());
    }
    void attachCodingCopilot(slot, liveState(slot).gen);
  },

  detachLive(slot) {
    stopLive(slot);
    if (slot.executor instanceof CodeBuddyExecutor) {
      slot.executor.setWorkbenchClient(null);
    }
  },

  async waitUntilReady(slot) {
    const buddy = slot.executor;
    if (!(buddy instanceof CodeBuddyExecutor))
      return true;
    if (typeof buddy.isReady !== 'function')
      return true;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (buddy.isReady())
        return true;
      await new Promise(r => setTimeout(r, 50));
    }
    return buddy.isReady();
  },
};
