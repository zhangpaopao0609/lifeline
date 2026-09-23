import type { CdpIssueKind } from '../../../protocol/src/index.js';
import { spawn, spawnSync } from 'node:child_process';

export type RelaunchResult
  = | 'relaunched'
    | 'skipped-not-running'
    | 'skipped-cooldown'
    | 'skipped-platform'
    | 'skipped-quit-pending'
    | 'skipped-warming-up'
    | 'skipped-no-exe'
    | 'skipped-throttled';

/**
 * Platforms that support "quit the IDE → launch with a debug port".
 *
 * **Must match `canControlIde()`** (unit tests cross-assert): missing a
 * platform makes `no-listener` reconnect forever at **500ms**
 * (`QUIET_NO_LISTENER_MS` only applies on `skipped-not-running`); adding one
 * would kill the user's IDE on a platform we do not support.
 */
export const RELAUNCH_PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'win32'];

/**
 * Rate fuse: blocks loops of "wrong diagnosis, keep killing the user's IDE".
 * Cooldown (60s) only prevents consecutive triggers; it does not stop
 * "once every 60s, forever" (review R3 reproduced 3 times).
 */
export const CDP_RELAUNCH_BURST_WINDOW_MS = 10 * 60_000;
export const CDP_RELAUNCH_BURST_MAX = 3;

export interface IdeCdpRelaunchDeps {
  platform: NodeJS.Platform;
  now: () => number;
  isRunning: () => boolean;
  /**
   * Whether we can actually launch it with a debug port (on win32: "did exe resolve").
   * `undefined` = do not check. **Ask before quitting**: if we cannot launch, we must not quit.
   */
  canRelaunch?: () => boolean;
  quit: () => Promise<boolean>;
  openWithCdp: (port: number) => Promise<void>;
  log: (msg: string) => void;
}

export const CDP_RELAUNCH_COOLDOWN_MS = 60_000;
export const CDP_RELAUNCH_GRACE_MS = 1_500;
const DEFAULT_COOLDOWN_MS = CDP_RELAUNCH_COOLDOWN_MS;
const DEFAULT_GRACE_MS = CDP_RELAUNCH_GRACE_MS;
const UNREACHABLE_POLL_MS = 500;
export const QUIT_WAIT_MS = 25_000;
export const QUIT_POLL_MS = 250;

/**
 * no-listener interval on non-GUI machines (remote dev boxes): that port will
 * **never** have a listener, so 500ms fast poll is wasted. On GUI machines,
 * 30s when unrecognized is enough — once we actually connect we switch back
 * to the normal cadence, so a mis-detect is no longer permanent unavailability
 * (review R1).
 */
export const QUIET_NO_LISTENER_MS = 30_000;

export function nextReconnectDelay(
  current: number,
  opts: { kind?: CdpIssueKind; unreachable?: boolean; max: number; quietNoListener?: boolean },
): number {
  const kind = opts.kind ?? (opts.unreachable ? 'no-listener' : undefined);
  if (kind === 'no-listener')
    return opts.quietNoListener ? QUIET_NO_LISTENER_MS : UNREACHABLE_POLL_MS;
  if (kind === 'no-window')
    return 2000;
  if (kind === 'not-cdp') {
    if (!current || current < 5000)
      return 5000;
    return Math.min(current * 2, 30_000);
  }
  if (kind === 'no-workbench' || kind === 'attach-failed' || kind === 'unknown') {
    if (!current || current < 1000)
      return 1000;
    return Math.min(current * 2, 10_000);
  }
  return Math.min(current * 2, opts.max);
}

export function isCdpUnreachable(err: unknown): boolean {
  if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'AbortError') {
    return false;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/aborted/i.test(message))
    return false;
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(message);
}

export function cdpPortFromUrl(cdpUrl: string): number {
  try {
    const url = new URL(cdpUrl);
    if (url.port)
      return Number(url.port);
    return url.protocol === 'https:' ? 443 : 80;
  }
  catch {
    return 9222;
  }
}

export function createIdeCdpRelauncher(opts: {
  productName: string;
  cooldownMs?: number;
  graceMs?: number;
  burstWindowMs?: number;
  burstMax?: number;
  deps: IdeCdpRelaunchDeps;
}): {
  maybeRelaunch: (port: number) => Promise<RelaunchResult>;
  noteConnected: () => void;
} {
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const burstWindowMs = opts.burstWindowMs ?? CDP_RELAUNCH_BURST_WINDOW_MS;
  const burstMax = opts.burstMax ?? CDP_RELAUNCH_BURST_MAX;
  const { productName, deps } = opts;
  let lastAttempt = 0;
  let seenRunningAt = 0;
  let attempts: number[] = [];
  /**
   * Log "exe not found" only once.
   *
   * `skipped-no-exe` **deliberately does not consume cooldown** (consuming it
   * would land the next attempt in `skipped-cooldown` → cdp-bridge's default
   * branch → 500ms fast-poll jitter). The cost is this state is hit on every
   * 30s reconnect; without de-dupe that is **two lines of permanent noise per
   * minute**. Reset after a successful connect so a lingering problem can
   * report once more.
   */
  let noExeLogged = false;

  return {
    async maybeRelaunch(port: number): Promise<RelaunchResult> {
      if (!RELAUNCH_PLATFORMS.includes(deps.platform))
        return 'skipped-platform';
      if (!deps.isRunning()) {
        seenRunningAt = 0;
        return 'skipped-not-running';
      }
      const now = deps.now();
      if (seenRunningAt === 0)
        seenRunningAt = now;
      if (now - seenRunningAt < graceMs)
        return 'skipped-warming-up';
      if (lastAttempt > 0 && now - lastAttempt < cooldownMs)
        return 'skipped-cooldown';
      // Rate fuse: cooldown only guarantees "not consecutive"; it does not stop "once every 60s, forever" (review R3 reproduced 3 times).
      attempts = attempts.filter(t => now - t < burstWindowMs);
      if (attempts.length >= burstMax) {
        deps.log(
          `${productName} has been relaunched ${attempts.length} time(s) in the last `
          + `${Math.round(burstWindowMs / 60_000)}min; NOT killing it again. `
          + 'Check the CDP endpoint / DevToolsActivePort before the next attempt.',
        );
        return 'skipped-throttled';
      }
      // "Quit first, then launch" has a trap: **if we cannot launch, we have
      // just closed the user's IDE** — worse than not self-healing.
      // So **before quitting** confirm we can launch (on win32 = exe resolved).
      //
      // ⚠️ This block **must sit before `lastAttempt = now`**: it neither quits
      // nor records `attempts`, so it has no reason to consume cooldown;
      // worse, **if we record cooldown first**, the next attempt (after a quiet
      // 30s reconnect) lands in `skipped-cooldown`, and `cdp-bridge` treats
      // `skipped-cooldown` as the **default branch → 500ms fast poll**, becoming
      // a periodic "quiet 30s + fast poll 30s" jitter. Putting this first,
      // every reconnect stably returns `skipped-no-exe`.
      if (deps.canRelaunch && !deps.canRelaunch()) {
        if (!noExeLogged) {
          noExeLogged = true;
          deps.log(
            `${productName} cannot be relaunched (its executable was not found); NOT quitting it. `
            + 'Install it in a standard location, or check the App Paths registry entry.',
          );
        }
        return 'skipped-no-exe';
      }
      // Cooldown uses lastAttempt, **not recorded as an attempt**: the user just opened a save dialog, not a mistaken relaunch.
      lastAttempt = now;
      deps.log(
        `${productName} is running without CDP; quitting and relaunching with --remote-debugging-port=${port}`,
      );
      const quit = await deps.quit();
      if (!quit) {
        deps.log(`${productName} did not quit (save dialog or already exiting); will retry later`);
        return 'skipped-quit-pending';
      }
      // Only count it once we actually quit and relaunched.
      attempts.push(now);
      seenRunningAt = 0;
      await deps.openWithCdp(port);
      return 'relaunched';
    },

    /**
     * Connected → reset the fuse.
     *
     * Without this, a normal user is collateral: Cursor does not read
     * argv.json (review §8 confirmed), **every Dock cold start needs one
     * self-heal**, and four opens in an afternoon would throttle, leaving
     * them disconnected for up to 10 minutes.
     * The fuse should target "consecutive failures", not punish "connected after a restart".
     */
    noteConnected() {
      lastAttempt = 0;
      attempts = [];
      noExeLogged = false;
    },
  };
}

/** First field of each `tasklist /NH /FO CSV` row (image name). On no match there is only an `INFO:` line → `[]`. */
export function parseTasklistImages(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*"([^"]+)"/.exec(line);
    if (m?.[1])
      out.push(m[1]);
  }
  return out;
}

export interface WinProcDeps {
  run?: typeof spawnSync;
}

/**
 * Whether this process is running on Windows (`tasklist`; `pgrep` does not exist on Windows).
 *
 * **Must compare the image name exactly**: `stdout.includes(name)` would treat
 * `NotCursor.exe` as a hit. Also cannot treat "non-empty output" as running —
 * on no match, tasklist prints
 * `INFO: No tasks are running which match the specified criteria.`
 * Image names are case-insensitive (Windows files/process names are).
 */
export function isProcessRunningWin(imageName: string, deps: WinProcDeps = {}): boolean {
  const run = deps.run ?? spawnSync;
  try {
    const r = run('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    const want = imageName.toLowerCase();
    return parseTasklistImages(r.stdout ?? '').some(n => n.toLowerCase() === want);
  }
  catch {
    return false;
  }
}

export interface QuitDeps extends WinProcDeps {
  isRunning?: () => boolean;
  now?: () => number;
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Graceful quit: `taskkill /IM <image>` — **deliberately without `/F`**
 * (without it, WM_CLOSE is sent to the top window; unsaved content pops a
 * save dialog → process still running → return false → upper layer reports
 * `skipped-quit-pending`).
 *
 * ⚠️ **Do not judge success from taskkill's exit code/error**: measured, for
 * windowless Electron child processes it returns
 * `ERROR: ... can only be terminated forcefully (with /F option)`, but once
 * the main process exits the children all follow. **Success is decided only
 * by polling `isRunning()`** — which is also why we **must not** default to
 * `/F` (that is SIGKILL and drops unsaved content).
 */
export async function quitProcessWin(
  imageNames: string | readonly string[],
  deps: QuitDeps = {},
): Promise<boolean> {
  // One IDE may have several image names (CodeBuddy CN / international), so we take an array.
  // Do not pre-check "is it running": `taskkill` on a missing image only returns "not found", and the result is ignored anyway.
  const names = typeof imageNames === 'string' ? [imageNames] : [...imageNames];
  const run = deps.run ?? spawnSync;
  const isRunning = deps.isRunning ?? (() => names.some(n => isProcessRunningWin(n, deps)));
  const now = deps.now ?? Date.now;
  const waitMs = deps.waitMs ?? QUIT_WAIT_MS;
  // Guard: `pollMs` of 0 plus `sleep(0)` and a frozen `now` would spin (unreachable under production `Date.now`, but do not leave that landmine)
  const pollMs = Math.max(1, deps.pollMs ?? QUIT_POLL_MS);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

  for (const name of names) {
    try {
      run('taskkill', ['/IM', name], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    }
    catch {
      /* Already exited / access denied: leave it to the poll below */
    }
  }

  const deadline = now() + waitMs;
  while (now() < deadline) {
    if (!isRunning())
      return true;
    await sleep(pollMs);
  }
  return !isRunning();
}

export interface OpenDeps {
  findExe?: () => string | undefined;
  spawnDetached?: (exe: string, args: string[]) => void;
  log?: (msg: string) => void;
}

/**
 * Shared implementation of launching an IDE with a debug port (same for Cursor / CodeBuddy).
 *
 * **Do not go through `cmd /c start`** (quoting hell + `%` expansion); spawn detached.
 * If the exe is not found we **must report it**, not silently return — the
 * caller is supposed to stop this earlier via `canRelaunch`; this is a second
 * fallback (in case the resolve result changed between the two calls).
 */
export async function openIdeWithCdpWin(
  /** Display name **for logs only** (CodeBuddy passes the two product names joined). Which exe is launched is decided by `resolveExe`. */
  displayName: string,
  resolveExe: () => string | undefined,
  port: number,
  deps: Pick<OpenDeps, 'spawnDetached' | 'log'> = {},
): Promise<void> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const exe = resolveExe();
  if (!exe) {
    log(`[cdp-bridge] ${displayName} not found (candidates + App Paths); cannot relaunch it with a debug port`);
    return;
  }
  const spawnDetached
    = deps.spawnDetached
      ?? ((p: string, args: string[]) => {
        const child = spawn(p, args, { detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
      });
  spawnDetached(exe, [`--remote-debugging-port=${port}`]);
}

/** `reg query <key> /ve`: fallback read of `App Paths`. Best-effort; failure returns undefined. */
export function defaultQueryRegistry(key: string): string | undefined {
  try {
    const r = spawnSync('reg', ['query', key, '/ve'], { encoding: 'utf8', timeout: 2000, windowsHide: true });
    return r.status === 0 && r.stdout ? r.stdout : undefined;
  }
  catch {
    return undefined;
  }
}

/**
 * `reg query <parent> /s /f <needle> /d`: fallback read of the "Installed Programs" table.
 *
 * `/d` = search **data** (server-side filter, only matching value lines, small
 * output), `/s` = recurse subkeys.
 * **On no match, reg's exit code is 1** (not 0, and not a throw) → must check
 * `status === 0`. Costlier than `/ve`, but only asked when the candidate table
 * and App Paths both miss; the result is also remembered 60s by `memoizeExeWithTtl`.
 */
export function defaultQueryUninstallRegistry(parent: string, needle: string): string | undefined {
  try {
    const r = spawnSync('reg', ['query', parent, '/s', '/f', needle, '/d'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    return r.status === 0 && r.stdout ? r.stdout : undefined;
  }
  catch {
    return undefined;
  }
}

/**
 * TTL memoization for "resolve exe path" (shared by Cursor / CodeBuddy).
 *
 * Resolve can do up to two **blocking** `reg query`s, and every reconnect cycle
 * asks once; install paths rarely change, so 60s re-probe is enough.
 * **Failures (`undefined`) are memoized too** — machines without an exe need
 * this most, or every cycle re-runs the registry.
 *
 * The sentinel is a boolean, not `at === 0`: an injected test clock may start
 * at 0, which would misread "already resolved" as "not yet resolved".
 */
export function memoizeExeWithTtl(
  resolve: () => string | undefined,
  ttlMs: number,
  now: () => number = Date.now,
): () => string | undefined {
  let resolved = false;
  let exe: string | undefined;
  let at = 0;
  return () => {
    const t = now();
    if (!resolved || t - at >= ttlMs) {
      exe = resolve();
      at = t;
      resolved = true;
    }
    return exe;
  };
}
