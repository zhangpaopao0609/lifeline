import type { ExecutorFactoryContext, ExtractorFactoryContext, IdeDriver } from '../types.js';
import { join } from 'node:path';
import { cursorArgvPath } from '../../../../cli/src/cdp-argv-file.js';
import { cursorActivePortCandidates } from '../../cdp/endpoint.js';
import { tryOpenCursorAdapter } from '../../content-runtime.js';
import { cursorExeCandidates } from '../../win-paths.js';
import { CommandExecutor } from './executor.js';
import { DOMExtractor } from './extractor.js';

/**
 * Cursor: single-connection strategy — workbench CDP is everything (extract /
 * execute / window poll all use the bridge client).
 * Agents overview window differences come from the extractor factory's
 * activeWindowKind.
 */
export const cursorDriver: IdeDriver = {
  kind: 'cursor',

  cdpUrlOf: config => config.cdpUrl,
  portCandidates: cursorActivePortCandidates,
  argvPaths: () => [cursorArgvPath()],

  hasLiveApp(exists, home, platform, env) {
    if (platform === 'darwin') {
      return exists('/Applications/Cursor.app') || exists(join(home, 'Applications/Cursor.app'));
    }
    if (platform === 'win32') {
      return cursorExeCandidates(env, home).some(exists);
    }
    return false;
  },

  bridgeOptions: () => ({}),
  windowMonitor: { otherWindowsRequireWsUrl: true },

  openDiskAdapter: opts => tryOpenCursorAdapter(undefined, opts),
  capabilities: { getPlanFull: true },

  createExtractor(ctx: ExtractorFactoryContext) {
    return new DOMExtractor(ctx.selectors, ctx.onExtraction, ctx.activeWindowTitle, {
      activeWindowKind: ctx.activeWindowKind,
    });
  },

  createExecutor(ctx: ExecutorFactoryContext) {
    const executor = new CommandExecutor(ctx.selectors);
    executor.setWindowKindProvider(ctx.windowKindProvider);
    return executor;
  },

  attachLive(slot) {
    const client = slot.cdp.getClient();
    slot.executor.setClient(client);
    if (client)
      slot.extractor.start(client, slot.pollIntervalMs);
  },

  detachLive(slot) {
    slot.executor.setClient(null);
    slot.extractor.stop();
  },

  async waitUntilReady() {
    return true;
  },
};
