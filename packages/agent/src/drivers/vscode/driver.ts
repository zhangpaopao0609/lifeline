import type { IdeDriver } from '../types.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CODEBUDDY_TITLE_SUFFIXES } from '../../cdp/bridge.js';
import { vscodeActivePortCandidates } from '../../cdp/endpoint.js';
import { VSCODE_APP_NAME, vscodeCodeBuddyPluginInstalled } from '../../codebuddy-vscode.js';
import { codeBuddyHostShardExists, tryOpenCodeBuddyAdapter } from '../../content-runtime.js';
import { vscodeExeCandidates } from '../../win-paths.js';
import { codeBuddyLiveHandlers } from '../codebuddy/driver.js';
import { CodeBuddyExecutor } from '../codebuddy/executor.js';
import { CodeBuddyExtractor } from '../codebuddy/extractor.js';
import {
  createCodeBuddyCdpRelauncher,
  defaultVscodeHostCdpRelaunchDeps,
} from '../codebuddy/relaunch.js';

/**
 * The `vscode` host slot: a **VSCode process**, not a CodeBuddy product.
 *
 * The CodeBuddy plugin runs here as one of possibly several chat surfaces; the
 * slot owns only what belongs to the process — its CDP port, its `argv.json`, its
 * relauncher, its windows. Everything about the webview is the same extension as
 * the standalone IDE, so extractor / executor / live state machine are reused
 * verbatim from the codebuddy driver.
 *
 * Three boundaries that must stay on this side:
 *  - port candidates: only `…/Code/DevToolsActivePort` (never the CodeBuddy IDE's);
 *  - argv: `~/.vscode/argv.json` on every platform — **not** the user-data-dir
 *    (`packages/cli/src/cdp-argv-file.ts`), or the debug port never opens;
 *  - relauncher: quits/reopens VSCode only (never the standalone IDE).
 *
 * `isEnabled` (存在性门控) keeps the slot off machines without the plugin, so the
 * console gains no dead entry. The **disk adapter** is gated separately (data
 * directory shard), so a content-only machine can still answer `session:get`.
 */
export const vscodeDriver: IdeDriver = {
  kind: 'vscode',

  cdpUrlOf: config => config.vscodeCdpUrl,
  portCandidates: vscodeActivePortCandidates,
  // ⚠️ As on the codebuddy driver, nothing reads this to write a file: the real
  // write path is `cli/src/cdp-argv-file.ts` (`ensureCodeBuddyCdpArgv`, one file
  // per installed host). `argv.json` lives in `~/.vscode`, not in the
  // user-data-dir next to `DevToolsActivePort`.
  argvPaths: () => [join(homedir(), '.vscode', 'argv.json')],

  // The slot only exists on plugin machines (see `isEnabled`), so this answers
  // "is VSCode itself installed".
  hasLiveApp(exists, home, platform, env) {
    if (!vscodeCodeBuddyPluginInstalled({ exists, home }))
      return false;
    if (platform === 'darwin') {
      return exists(`/Applications/${VSCODE_APP_NAME}.app`)
        || exists(join(home, 'Applications', `${VSCODE_APP_NAME}.app`));
    }
    if (platform === 'win32')
      return vscodeExeCandidates(env, home).some(exists);
    return false;
  },

  isEnabled: () => vscodeCodeBuddyPluginInstalled(),

  bridgeOptions() {
    // relauncher 与 quietWake 共享同一份 deps（同一判据）；deps 锁定 VSCode-only。
    const deps = defaultVscodeHostCdpRelaunchDeps();
    return {
      titleSuffixes: [...CODEBUDDY_TITLE_SUFFIXES],
      appNames: [VSCODE_APP_NAME],
      relauncher: createCodeBuddyCdpRelauncher({ deps, productName: VSCODE_APP_NAME }),
      quietWake: {
        isRunning: deps.isCodeBuddyRunning,
        pollMs: process.platform === 'win32' ? 5_000 : undefined,
      },
    };
  },

  openDiskAdapter: opts => tryOpenCodeBuddyAdapter(undefined, { ...opts, ide: 'vscode' }),
  hasContent: () => codeBuddyHostShardExists('vscode'),
  capabilities: { getPlanFull: false },

  windowMonitor: { otherWindowsRequireWsUrl: false },

  createExtractor(ctx) {
    return new CodeBuddyExtractor(ctx.onExtraction);
  },

  createExecutor(_ctx) {
    return new CodeBuddyExecutor();
  },

  attachLive: codeBuddyLiveHandlers.attachLive,
  detachLive: codeBuddyLiveHandlers.detachLive,
  waitUntilReady: codeBuddyLiveHandlers.waitUntilReady,
};
