import type { ExecutorFactoryContext, ExtractorFactoryContext, IdeDriver } from '../types.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cursorArgvPath } from '../../../../cli/src/cdp-argv-file.js';
import { cursorActivePortCandidates } from '../../cdp/endpoint.js';
import { DEFAULT_CURSOR_VSCDB, tryOpenCursorAdapter } from '../../content-runtime.js';
import { cursorExeCandidates } from '../../win-paths.js';
import { CommandExecutor } from './executor.js';
import { DOMExtractor } from './extractor.js';
import { defaultCursorCdpRelaunchDeps } from './relaunch.js';

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

  bridgeOptions: () => ({
    // 静默唤醒用与（默认）relauncher 同一判据的进程探针。注意：这里和 bridge
    // 构造器里各建了一份 deps —— 不变量靠的是 `isCursorRunning` 在两份里解析到
    // **同一个无状态函数**；若将来给 isRunning 加状态（缓存等），必须改为共享
    // 实例（见 codebuddy/driver.ts 的做法），否则唤醒判据会偏离自愈判据。
    // win32 的 tasklist 是同步派生（100ms+，timeout 5s），2s tick 会卡事件循环 —— 放宽。
    quietWake: {
      isRunning: defaultCursorCdpRelaunchDeps().isCursorRunning,
      pollMs: process.platform === 'win32' ? 5_000 : undefined,
    },
  }),
  windowMonitor: { otherWindowsRequireWsUrl: true },

  openDiskAdapter: opts => tryOpenCursorAdapter(undefined, opts),
  hasContent: () => existsSync(DEFAULT_CURSOR_VSCDB),
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
