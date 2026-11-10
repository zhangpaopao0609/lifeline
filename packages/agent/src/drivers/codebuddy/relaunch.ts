import type { DarwinProcDeps, IdeCdpRelaunchDeps, OpenDeps, RelaunchResult, WinProcDeps } from '../../cdp/relaunch-engine.js';
import type { ExeLookupDeps } from '../../win-paths.js';
import { execFile as execFileCb } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import {
  CDP_RELAUNCH_COOLDOWN_MS,
  CDP_RELAUNCH_GRACE_MS,
  createIdeCdpRelauncher,
  defaultQueryRegistry,
  defaultQueryUninstallRegistry,
  isDarwinProcessRunning,
  isIdeUpdaterRunningDarwin,
  isProcessRunningWin,
  memoizeExeWithTtl,

  openIdeWithCdpWin,

  quitProcessWin,

} from '../../cdp/relaunch-engine.js';
import { VSCODE_APP_NAME, vscodeCodeBuddyPluginInstalled } from '../../codebuddy-vscode.js';
import {
  CODEBUDDY_APP_PATHS_EXES,
  CODEBUDDY_IMAGE_NAMES,
  codeBuddyExeCandidates,
  findIdeExe,
  VSCODE_APP_PATHS_EXES,

  VSCODE_IMAGE_NAME,
  vscodeExeCandidates,
} from '../../win-paths.js';

const execFile = promisify(execFileCb);

const QUIT_WAIT_MS = 25_000;
const QUIT_POLL_MS = 250;

/** First installed product wins: Chinese build, then international. */
export const CODEBUDDY_APP_CANDIDATES = ['CodeBuddy CN', 'CodeBuddy'] as const;

export interface CodeBuddyCdpRelaunchDeps {
  platform: NodeJS.Platform;
  now: () => number;
  /**
   * Is a **family member** running: a standalone CodeBuddy IDE (CN /
   * international), or VSCode when it hosts the CodeBuddy plugin. See
   * `codebuddy-vscode.ts` for why the VSCode member must be plugin-gated.
   */
  isCodeBuddyRunning: () => boolean;
  /** See `IdeCdpRelaunchDeps.canRelaunch`: ask **before** quitting; if we cannot relaunch, do not quit. */
  canRelaunch?: () => boolean;
  /** macOS only: ShipIt resident with a staged update → the relauncher must stand down (see `relaunch-engine.ts`). */
  isCodeBuddyUpdaterRunning?: () => boolean;
  /** Quit the running family member (a standalone IDE preferred over VSCode). */
  quitCodeBuddy: () => Promise<boolean>;
  /** Reopen **the product quitCodeBuddy closed** (or the installed default) with the debug port. */
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
  /**
   * Name used in the relaunch log lines. The `vscode` slot reuses this relauncher but
   * quits **VS Code**, so it must not say "CodeBuddy did not quit" while killing the
   * user's editor (the same reason `ideSubject()` exists on the web side).
   */
  productName?: string;
}): {
  maybeRelaunch: (port: number) => Promise<RelaunchResult>;
  noteConnected: () => void;
} {
  const mapped: IdeCdpRelaunchDeps = {
    platform: opts.deps.platform,
    now: opts.deps.now,
    isRunning: opts.deps.isCodeBuddyRunning,
    canRelaunch: opts.deps.canRelaunch,
    isUpdaterRunning: opts.deps.isCodeBuddyUpdaterRunning,
    quit: opts.deps.quitCodeBuddy,
    openWithCdp: opts.deps.openCodeBuddyWithCdp,
    log: opts.deps.log,
  };
  return createIdeCdpRelauncher({
    productName: opts.productName ?? 'CodeBuddy',
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
  // pgrep alone is not enough: the main process can be invisible to it while
  // `ps` still lists it (see `isDarwinProcessRunning`).
  return isDarwinProcessRunning(codeBuddyMainProcessPattern(name));
}

export function isCodeBuddyRunningDarwin(): boolean {
  return CODEBUDDY_APP_CANDIDATES.some(isNamedCodeBuddyRunning);
}

/** VSCode main process (CodeBuddy plugin host) — same suffix-match shape as the CodeBuddy products. */
export function isVscodeRunningDarwin(deps: DarwinProcDeps = {}): boolean {
  return isDarwinProcessRunning(codeBuddyMainProcessPattern(VSCODE_APP_NAME), deps);
}

/** Any family member running: a standalone CodeBuddy IDE, or plugin-hosting VSCode. */
export function isCodeBuddyFamilyRunningDarwin(vscodePlugin: boolean): boolean {
  return isCodeBuddyRunningDarwin() || (vscodePlugin && isVscodeRunningDarwin());
}

export interface FamilyQuitTarget {
  app: string;
  vscode: boolean;
}

/**
 * Which family product a quit should target: a **running** CodeBuddy IDE wins
 * (never quit VSCode while a CodeBuddy IDE is the one without the port), else
 * VSCode when it hosts the plugin. `null` = nothing to quit.
 */
export function pickCodeBuddyFamilyQuitTargetDarwin(vscodePlugin: boolean): FamilyQuitTarget | null {
  const running = CODEBUDDY_APP_CANDIDATES.find(isNamedCodeBuddyRunning);
  if (running)
    return { app: running, vscode: false };
  if (vscodePlugin && isVscodeRunningDarwin())
    return { app: VSCODE_APP_NAME, vscode: true };
  return null;
}

/**
 * Family quit: osascript-quit the picked product, polling **that product only**
 * until it is gone. Returns which app was quit so the reopen lands on the same
 * one (`null` = there was nothing to quit; still `ok`).
 */
export async function quitCodeBuddyFamilyDarwin(
  vscodePlugin: boolean,
): Promise<{ ok: boolean; app: string | null }> {
  const target = pickCodeBuddyFamilyQuitTargetDarwin(vscodePlugin);
  if (!target)
    return { ok: true, app: null };
  try {
    await execFile('osascript', ['-e', `tell application "${target.app}" to quit`], { timeout: 10_000 });
  }
  catch {
    /* quit can fail if the app already exited */
  }
  const stillRunning = () =>
    target.vscode ? isVscodeRunningDarwin() : isNamedCodeBuddyRunning(target.app);
  const deadline = Date.now() + QUIT_WAIT_MS;
  while (Date.now() < deadline) {
    if (!stillRunning())
      return { ok: true, app: target.app };
    await new Promise(r => setTimeout(r, QUIT_POLL_MS));
  }
  return { ok: !stillRunning(), app: target.app };
}

/**
 * Family reopen: the product we just quit, else the first installed CodeBuddy
 * IDE, else plugin-hosting VSCode. Quitting VSCode and reopening CodeBuddy (or
 * the reverse) would be worse than not self-healing at all.
 */
export async function openCodeBuddyFamilyWithCdpDarwin(
  port: number,
  opts: { lastQuitVscode?: boolean; vscodePlugin: boolean },
): Promise<void> {
  const app = (opts.lastQuitVscode ? VSCODE_APP_NAME : null)
    ?? resolveCodeBuddyAppName()
    ?? (opts.vscodePlugin ? VSCODE_APP_NAME : null);
  if (!app)
    return;
  await execFile('open', ['-a', app, '--args', `--remote-debugging-port=${port}`], {
    timeout: 10_000,
  });
}

/**
 * Whether a family member is running on Windows (`tasklist`; `pgrep` does not exist
 * on Windows). CodeBuddy products always; VSCode only when the caller passes the
 * plugin gate (`defaultCodeBuddyCdpRelaunchDeps` owns it — no default IO here so
 * tests stay deterministic).
 */
export function isCodeBuddyRunningWin(deps: WinProcDeps = {}, opts: { vscodePlugin?: boolean } = {}): boolean {
  const images = codeBuddyFamilyImageNames(opts.vscodePlugin === true);
  return images.some(n => isProcessRunningWin(n, deps));
}

/** Family image names: both CodeBuddy products, plus `Code.exe` when plugin-gated in. */
export function codeBuddyFamilyImageNames(vscodePlugin: boolean): string[] {
  return vscodePlugin ? [...CODEBUDDY_IMAGE_NAMES, VSCODE_IMAGE_NAME] : [...CODEBUDDY_IMAGE_NAMES];
}

/**
 * Windows quit target: **the images to kill, and the images to wait for**.
 *
 * A running CodeBuddy IDE wins over VSCode — the same single-target rule as
 * `pickCodeBuddyFamilyQuitTargetDarwin`. Killing the whole family is wrong twice
 * over: it closes a window the slot is not using, and the quit then waits on an
 * image it did not even ask to close (a live `Code.exe` would hold the poll true
 * until the 25s deadline and turn every attempt into `skipped-quit-pending`).
 *
 * Empty = nothing to quit (`quit` is then a no-op, not a failure).
 */
export function pickCodeBuddyQuitImagesWin(
  isRunning: (image: string) => boolean,
  vscodePlugin: boolean,
): string[] {
  const codebuddy = CODEBUDDY_IMAGE_NAMES.filter(isRunning);
  if (codebuddy.length > 0)
    return codebuddy;
  // `Code.exe` joins only through the gate: an ungated quit would close plain
  // VSCode on every machine that happens to have it running.
  return vscodePlugin && isRunning(VSCODE_IMAGE_NAME) ? [VSCODE_IMAGE_NAME] : [];
}

/**
 * Windows family quit as a tiny stateful object: it records **which product it
 * closed**, so the reopen lands on the same one.
 *
 * Split out of `defaultCodeBuddyCdpRelaunchDeps` so the handoff is testable — the
 * shipped bug lived exactly here: the production caller forgot the plugin flag, so
 * `taskkill` got "CodeBuddy only" while the poll predicate still counted
 * `Code.exe` (kill set ⊂ wait set). `quitProcessWin` could never observe the exit,
 * and every plugin-only Windows machine stayed in `skipped-quit-pending`.
 *
 * The `quit` callback must receive **this** list and add no predicate of its own:
 * `quitProcessWin`'s default state derives the poll from the images it just
 * killed, and that equality is the invariant.
 */
export function createWinFamilyQuit(opts: {
  vscodePlugin: boolean;
  isRunning: (image: string) => boolean;
  quit: (images: readonly string[]) => Promise<boolean>;
}): { quit: () => Promise<boolean>; lastQuitVscode: () => boolean } {
  let lastQuitVscode = false;
  return {
    lastQuitVscode: () => lastQuitVscode,
    async quit() {
      // One detection, two uses: what to kill, and which product to reopen. Two
      // separate probes can disagree (a process exiting in between) and reopen the
      // wrong product.
      const images = pickCodeBuddyQuitImagesWin(opts.isRunning, opts.vscodePlugin);
      lastQuitVscode = images.length === 1 && images[0] === VSCODE_IMAGE_NAME;
      if (images.length === 0)
        return true;
      return opts.quit(images);
    },
  };
}

export function defaultFindCodeBuddyExe(
  deps: ExeLookupDeps = {},
  opts: { vscodePlugin?: boolean } = {},
): string | undefined {
  const vscodePlugin = opts.vscodePlugin === true;
  return findIdeExe(
    [...codeBuddyExeCandidates(), ...(vscodePlugin ? vscodeExeCandidates() : [])],
    [...CODEBUDDY_APP_PATHS_EXES, ...(vscodePlugin ? VSCODE_APP_PATHS_EXES : [])],
    {
      queryRegistry: defaultQueryRegistry,
      queryUninstall: defaultQueryUninstallRegistry,
      ...deps,
    },
  );
}

/** Launch CodeBuddy with the debug port. Display name is the two product names joined (logs show which was looked up). */
export async function openCodeBuddyWithCdpWin(
  port: number,
  deps: OpenDeps = {},
  opts: { vscodePlugin?: boolean } = {},
): Promise<void> {
  await openIdeWithCdpWin(
    CODEBUDDY_IMAGE_NAMES.join(' / '),
    // Same gate as the relauncher: `defaultFindCodeBuddyExe` called with no opts
    // looks for a CodeBuddy exe only, so the exported default would report
    // "exe not found" on a plugin-only machine.
    deps.findExe ?? (() => defaultFindCodeBuddyExe({}, opts)),
    port,
    deps,
  );
}

export function defaultCodeBuddyCdpRelaunchDeps(opts: { exeTtlMs?: number; vscodePlugin?: boolean } = {}): CodeBuddyCdpRelaunchDeps {
  const win = process.platform === 'win32';
  const vscodePlugin = opts.vscodePlugin ?? vscodeCodeBuddyPluginInstalled();
  const resolveExe = memoizeExeWithTtl(
    (deps?: ExeLookupDeps) => defaultFindCodeBuddyExe(deps, { vscodePlugin }),
    opts.exeTtlMs ?? 60_000,
  );

  /**
   * Windows family quit. Built once so the **same** decisions (which images are
   * alive, which product that means) feed both the kill and the reopen.
   */
  const winQuit = win
    ? createWinFamilyQuit({
        vscodePlugin,
        isRunning: image => isProcessRunningWin(image),
        // No `isRunning` here on purpose: `quitProcessWin` derives the poll from the
        // images it killed. An independent predicate is what let a live `Code.exe`
        // hold the poll true forever (`skipped-quit-pending`, never relaunched).
        quit: images => quitProcessWin(images),
      })
    : null;

  /**
   * macOS family flavor handoff: quit records which product it closed, open
   * reopens **that** one. Without this, quitting plugin-hosting VSCode on a
   * dual-install machine would reopen the standalone CodeBuddy IDE instead.
   * (Windows gets the same handoff from `createWinFamilyQuit`.)
   */
  let lastQuitVscode = false;

  return {
    platform: process.platform,
    now: () => Date.now(),
    isCodeBuddyRunning: win
      ? () => isCodeBuddyRunningWin(undefined, { vscodePlugin })
      : () => isCodeBuddyFamilyRunningDarwin(vscodePlugin),
    // macOS only (same rationale as Cursor): ShipIt resident = staged update waiting.
    // VSCode is deliberately absent: its macOS builds do not use Squirrel/ShipIt.
    isCodeBuddyUpdaterRunning: win
      ? undefined
      : () => CODEBUDDY_APP_CANDIDATES.some(name => isIdeUpdaterRunningDarwin(name)),
    canRelaunch: win ? () => resolveExe() !== undefined : undefined,
    quitCodeBuddy: winQuit
      ? winQuit.quit
      : async () => {
        const { ok, app } = await quitCodeBuddyFamilyDarwin(vscodePlugin);
        lastQuitVscode = app !== null && app === VSCODE_APP_NAME;
        return ok;
      },
    openCodeBuddyWithCdp: win
      ? p => openCodeBuddyWithCdpWin(p, {
        findExe: () => {
          if (winQuit?.lastQuitVscode()) {
            const vscodeExe = findIdeExe(vscodeExeCandidates(), VSCODE_APP_PATHS_EXES, {
              queryRegistry: defaultQueryRegistry,
              queryUninstall: defaultQueryUninstallRegistry,
            });
            if (vscodeExe)
              return vscodeExe;
          }
          return resolveExe();
        },
      }, { vscodePlugin })
      : p => openCodeBuddyFamilyWithCdpDarwin(p, { lastQuitVscode, vscodePlugin }),
    log: msg => console.log(`[cdp-bridge] ${msg}`),
  };
}

/**
 * Relaunch deps for the **`vscode` host slot**: quit and reopen VSCode only.
 *
 * The standalone CodeBuddy IDE belongs to the `codebuddy` slot and must never be
 * touched here — two slots quitting each other's host is exactly what the split
 * exists to prevent.
 *
 * ⚠️ **`isHostRunning` must branch on the platform.** The old merged code called
 * `isVscodeRunningDarwin()` unconditionally; on Windows that spawns `pgrep`/`ps`
 * (absent), so it answers false forever, `maybeRelaunch` returns
 * `skipped-not-running` on its first line, and both self-heal and quiet-wake are
 * dead for this slot. `platform` / `run` are injectable so a test can pin the
 * Windows branch on macOS CI.
 */
export function defaultVscodeHostCdpRelaunchDeps(
  opts: { platform?: NodeJS.Platform; run?: DarwinProcDeps['run']; exeTtlMs?: number } = {},
): CodeBuddyCdpRelaunchDeps {
  const platform = opts.platform ?? process.platform;
  const win = platform === 'win32';
  const procDeps = opts.run ? { run: opts.run } : {};
  const resolveVscodeExe = memoizeExeWithTtl(
    () => findIdeExe(vscodeExeCandidates(), VSCODE_APP_PATHS_EXES, {
      queryRegistry: defaultQueryRegistry,
      queryUninstall: defaultQueryUninstallRegistry,
    }),
    opts.exeTtlMs ?? 60_000,
  );

  const isHostRunning = (): boolean => {
    if (win)
      return isProcessRunningWin(VSCODE_IMAGE_NAME, procDeps);
    return isVscodeRunningDarwin(procDeps);
  };

  const quitVscode = async (): Promise<boolean> => {
    if (win)
      return quitProcessWin([VSCODE_IMAGE_NAME]);
    try {
      await execFile('osascript', ['-e', `tell application "${VSCODE_APP_NAME}" to quit`], { timeout: 10_000 });
    }
    catch {
      /* quit can fail if the app already exited */
    }
    const deadline = Date.now() + QUIT_WAIT_MS;
    while (Date.now() < deadline) {
      if (!isHostRunning())
        return true;
      await new Promise(r => setTimeout(r, QUIT_POLL_MS));
    }
    return !isHostRunning();
  };

  const openVscodeWithCdp = async (port: number): Promise<void> => {
    if (win) {
      await openIdeWithCdpWin(VSCODE_APP_NAME, () => resolveVscodeExe(), port);
      return;
    }
    await execFile('open', ['-a', VSCODE_APP_NAME, '--args', `--remote-debugging-port=${port}`], {
      timeout: 10_000,
    });
  };

  return {
    platform,
    now: () => Date.now(),
    isCodeBuddyRunning: isHostRunning,
    // VSCode's macOS builds do not use Squirrel/ShipIt, so there is no updater
    // stand-down for this host (same rationale as the codebuddy slot's comment).
    isCodeBuddyUpdaterRunning: undefined,
    canRelaunch: win ? () => resolveVscodeExe() !== undefined : undefined,
    quitCodeBuddy: quitVscode,
    openCodeBuddyWithCdp: openVscodeWithCdp,
    log: msg => console.log(`[cdp-bridge] ${msg}`),
  };
}
