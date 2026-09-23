import type { IdeCdpRelaunchDeps, OpenDeps, QuitDeps, RelaunchResult, WinProcDeps } from '../../cdp/relaunch-engine.js';
import type { ExeLookupDeps } from '../../win-paths.js';
import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import {
  CDP_RELAUNCH_COOLDOWN_MS,
  CDP_RELAUNCH_GRACE_MS,
  createIdeCdpRelauncher,
  defaultQueryRegistry,
  defaultQueryUninstallRegistry,

  isProcessRunningWin,
  memoizeExeWithTtl,

  openIdeWithCdpWin,

  quitProcessWin,

} from '../../cdp/relaunch-engine.js';
import {
  CODEBUDDY_APP_PATHS_EXES,
  CODEBUDDY_IMAGE_NAMES,
  codeBuddyExeCandidates,

  findIdeExe,
} from '../../win-paths.js';

const execFile = promisify(execFileCb);

const QUIT_WAIT_MS = 25_000;
const QUIT_POLL_MS = 250;

/** First installed product wins: Chinese build, then international. */
export const CODEBUDDY_APP_CANDIDATES = ['CodeBuddy CN', 'CodeBuddy'] as const;

export interface CodeBuddyCdpRelaunchDeps {
  platform: NodeJS.Platform;
  now: () => number;
  isCodeBuddyRunning: () => boolean;
  /** See `IdeCdpRelaunchDeps.canRelaunch`: ask **before** quitting; if we cannot relaunch, do not quit. */
  canRelaunch?: () => boolean;
  quitCodeBuddy: () => Promise<boolean>;
  openCodeBuddyWithCdp: (port: number) => Promise<void>;
  log: (msg: string) => void;
}

export function resolveCodeBuddyAppName(exists: (p: string) => boolean = existsSync): string | null {
  for (const name of CODEBUDDY_APP_CANDIDATES) {
    if (exists(`/Applications/${name}.app`))
      return name;
  }
  return null;
}

export function createCodeBuddyCdpRelauncher(opts: {
  cooldownMs?: number;
  graceMs?: number;
  deps: CodeBuddyCdpRelaunchDeps;
}): {
  maybeRelaunch: (port: number) => Promise<RelaunchResult>;
  noteConnected: () => void;
} {
  const mapped: IdeCdpRelaunchDeps = {
    platform: opts.deps.platform,
    now: opts.deps.now,
    isRunning: opts.deps.isCodeBuddyRunning,
    canRelaunch: opts.deps.canRelaunch,
    quit: opts.deps.quitCodeBuddy,
    openWithCdp: opts.deps.openCodeBuddyWithCdp,
    log: opts.deps.log,
  };
  return createIdeCdpRelauncher({
    productName: 'CodeBuddy',
    cooldownMs: opts.cooldownMs ?? CDP_RELAUNCH_COOLDOWN_MS,
    graceMs: opts.graceMs ?? CDP_RELAUNCH_GRACE_MS,
    deps: mapped,
  });
}

/**
 * CodeBuddy CN's main binary is Electron; `pgrep -x "CodeBuddy CN"` never matches.
 *
 * **Deliberately omit the `/Applications/` prefix**: we match the path suffix
 * `<App>.app/Contents/MacOS/`, so installs in `~/Applications`, Setapp, or any
 * custom dir still match. Prefixing `/Applications/` would classify those
 * machines as "not running" → the slot goes quiet and never self-heals
 * (same inventory-miss class as the Cursor slot).
 */
export function codeBuddyMainProcessPattern(appName: string): string {
  return `${appName}.app/Contents/MacOS/`;
}

export function isCodeBuddyMainCommand(command: string, appName: string): boolean {
  return command.includes(codeBuddyMainProcessPattern(appName));
}

function isNamedCodeBuddyRunning(name: string): boolean {
  try {
    const result = spawnSync('pgrep', ['-f', codeBuddyMainProcessPattern(name)], {
      encoding: 'utf-8',
    });
    return result.status === 0 && Boolean(result.stdout?.trim());
  }
  catch {
    return false;
  }
}

export function isCodeBuddyRunningDarwin(): boolean {
  return CODEBUDDY_APP_CANDIDATES.some(isNamedCodeBuddyRunning);
}

async function quitCodeBuddyDarwin(): Promise<boolean> {
  const app = resolveCodeBuddyAppName() ?? CODEBUDDY_APP_CANDIDATES.find(isNamedCodeBuddyRunning);
  if (!app)
    return true;
  try {
    await execFile('osascript', ['-e', `tell application "${app}" to quit`], { timeout: 10_000 });
  }
  catch {
    /* quit can fail if the app already exited */
  }
  const deadline = Date.now() + QUIT_WAIT_MS;
  while (Date.now() < deadline) {
    if (!isCodeBuddyRunningDarwin())
      return true;
    await new Promise(r => setTimeout(r, QUIT_POLL_MS));
  }
  return !isCodeBuddyRunningDarwin();
}

async function openCodeBuddyWithCdpDarwin(port: number): Promise<void> {
  const app = resolveCodeBuddyAppName();
  if (!app)
    return;
  await execFile('open', ['-a', app, '--args', `--remote-debugging-port=${port}`], {
    timeout: 10_000,
  });
}

/**
 * Whether CodeBuddy is running on Windows (`tasklist`; `pgrep` does not exist
 * on Windows). Check both product names — CN and international may both be installed.
 */
export function isCodeBuddyRunningWin(deps: WinProcDeps = {}): boolean {
  return CODEBUDDY_IMAGE_NAMES.some(n => isProcessRunningWin(n, deps));
}

/** Graceful quit (`taskkill` without `/F`; success is decided only by polling). Send both image names. */
export function quitCodeBuddyWin(deps: QuitDeps = {}): Promise<boolean> {
  return quitProcessWin(CODEBUDDY_IMAGE_NAMES, deps);
}

export function defaultFindCodeBuddyExe(deps: ExeLookupDeps = {}): string | undefined {
  return findIdeExe(codeBuddyExeCandidates(), CODEBUDDY_APP_PATHS_EXES, {
    queryRegistry: defaultQueryRegistry,
    queryUninstall: defaultQueryUninstallRegistry,
    ...deps,
  });
}

/** Launch CodeBuddy with the debug port. Display name is the two product names joined (logs show which was looked up). */
export async function openCodeBuddyWithCdpWin(port: number, deps: OpenDeps = {}): Promise<void> {
  await openIdeWithCdpWin(
    CODEBUDDY_IMAGE_NAMES.join(' / '),
    deps.findExe ?? defaultFindCodeBuddyExe,
    port,
    deps,
  );
}

export function defaultCodeBuddyCdpRelaunchDeps(opts: { exeTtlMs?: number } = {}): CodeBuddyCdpRelaunchDeps {
  const win = process.platform === 'win32';
  const resolveExe = memoizeExeWithTtl(defaultFindCodeBuddyExe, opts.exeTtlMs ?? 60_000);

  return {
    platform: process.platform,
    now: () => Date.now(),
    isCodeBuddyRunning: win ? isCodeBuddyRunningWin : isCodeBuddyRunningDarwin,
    canRelaunch: win ? () => resolveExe() !== undefined : undefined,
    quitCodeBuddy: win ? quitCodeBuddyWin : quitCodeBuddyDarwin,
    openCodeBuddyWithCdp: win ? p => openCodeBuddyWithCdpWin(p, { findExe: resolveExe }) : openCodeBuddyWithCdpDarwin,
    log: msg => console.log(`[cdp-bridge] ${msg}`),
  };
}
