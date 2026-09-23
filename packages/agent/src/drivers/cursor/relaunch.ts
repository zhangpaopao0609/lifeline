import type { OpenDeps, QuitDeps, RelaunchResult, WinProcDeps } from '../../cdp/relaunch-engine.js';
import type { ExeLookupDeps } from '../../win-paths.js';
/**
 * Cursor CDP relauncher wiring (platform process ops and the shared engine live in `cdp/relaunch-engine.ts`).
 */
import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createIdeCdpRelauncher,
  defaultQueryRegistry,
  defaultQueryUninstallRegistry,
  isProcessRunningWin,
  memoizeExeWithTtl,

  openIdeWithCdpWin,
  QUIT_POLL_MS,
  QUIT_WAIT_MS,

  quitProcessWin,

} from '../../cdp/relaunch-engine.js';
import {
  CURSOR_APP_PATHS_EXES,
  CURSOR_IMAGE_NAME,
  cursorExeCandidates,

  findIdeExe,
} from '../../win-paths.js';

const execFile = promisify(execFileCb);

export interface CursorCdpRelaunchDeps {
  platform: NodeJS.Platform;
  now: () => number;
  isCursorRunning: () => boolean;
  canRelaunch?: () => boolean;
  quitCursor: () => Promise<boolean>;
  openCursorWithCdp: (port: number) => Promise<void>;
  log: (msg: string) => void;
}

export function createCursorCdpRelauncher(opts: {
  cooldownMs?: number;
  graceMs?: number;
  burstWindowMs?: number;
  burstMax?: number;
  deps: CursorCdpRelaunchDeps;
}): {
  maybeRelaunch: (port: number) => Promise<RelaunchResult>;
  noteConnected: () => void;
} {
  return createIdeCdpRelauncher({
    productName: 'Cursor',
    cooldownMs: opts.cooldownMs,
    graceMs: opts.graceMs,
    burstWindowMs: opts.burstWindowMs,
    burstMax: opts.burstMax,
    deps: {
      platform: opts.deps.platform,
      now: opts.deps.now,
      isRunning: opts.deps.isCursorRunning,
      canRelaunch: opts.deps.canRelaunch,
      quit: opts.deps.quitCursor,
      openWithCdp: opts.deps.openCursorWithCdp,
      log: opts.deps.log,
    },
  });
}

export function isCursorRunningDarwin(): boolean {
  try {
    const result = spawnSync('pgrep', ['-x', 'Cursor'], { encoding: 'utf-8' });
    return result.status === 0 && Boolean(result.stdout?.trim());
  }
  catch {
    return false;
  }
}

async function quitCursorDarwin(): Promise<boolean> {
  try {
    await execFile('osascript', ['-e', 'tell application "Cursor" to quit'], { timeout: 10_000 });
  }
  catch {
    /* quit can fail if the app already exited */
  }
  const deadline = Date.now() + QUIT_WAIT_MS;
  while (Date.now() < deadline) {
    if (!isCursorRunningDarwin())
      return true;
    await new Promise(r => setTimeout(r, QUIT_POLL_MS));
  }
  return !isCursorRunningDarwin();
}

async function openCursorWithCdpDarwin(port: number): Promise<void> {
  await execFile('open', ['-a', 'Cursor', '--args', `--remote-debugging-port=${port}`], {
    timeout: 10_000,
  });
}

export function isCursorRunningWin(deps: WinProcDeps = {}): boolean {
  return isProcessRunningWin(CURSOR_IMAGE_NAME, deps);
}

export function quitCursorWin(deps: QuitDeps = {}): Promise<boolean> {
  return quitProcessWin(CURSOR_IMAGE_NAME, deps);
}

export async function openCursorWithCdpWin(port: number, deps: OpenDeps = {}): Promise<void> {
  await openIdeWithCdpWin(CURSOR_IMAGE_NAME, deps.findExe ?? defaultFindCursorExe, port, deps);
}

export function defaultFindCursorExe(deps: ExeLookupDeps = {}): string | undefined {
  return findIdeExe(cursorExeCandidates(), CURSOR_APP_PATHS_EXES, {
    queryRegistry: defaultQueryRegistry,
    queryUninstall: defaultQueryUninstallRegistry,
    ...deps,
  });
}

export function defaultCursorCdpRelaunchDeps(opts: { exeTtlMs?: number } = {}): CursorCdpRelaunchDeps {
  const win = process.platform === 'win32';
  const resolveExe = memoizeExeWithTtl(defaultFindCursorExe, opts.exeTtlMs ?? 60_000);
  return {
    platform: process.platform,
    now: () => Date.now(),
    isCursorRunning: win ? isCursorRunningWin : isCursorRunningDarwin,
    // Pre-check on win32 only: macOS uses `open -a Cursor`, LaunchServices resolves the app, there is no "path not found" case.
    canRelaunch: win ? () => resolveExe() !== undefined : undefined,
    quitCursor: win ? quitCursorWin : quitCursorDarwin,
    openCursorWithCdp: win ? p => openCursorWithCdpWin(p, { findExe: resolveExe }) : openCursorWithCdpDarwin,
    log: msg => console.log(`[cdp-bridge] ${msg}`),
  };
}
