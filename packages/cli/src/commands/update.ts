import { join } from 'node:path';
import { DEFAULT_SERVER_URL as DEFAULT_SERVER_URL_BUILD } from '../build-config.js';
import { BUILD_VERSION as VERSION } from '../build-version.js';
import { loadCliConfig } from '../config.js';
import { restartDaemon } from '../daemon/stop.js';
import { installedVersion, runInstaller, runtimeHome, runtimeNodeName } from '../installer.js';
import { log, resolveCliEntry } from '../ui.js';
import { fetchLatestVersion, isBundledRuntimeEntry, isNewer, PUBLIC_PREFIX } from '../version.js';
import { startWindowsDaemon, stopWindowsDaemon } from '../win-daemon.js';

/** Default origin for install.sh when no config is readable: baked in at build time (empty if unset). */
const DEFAULT_SERVER_URL = DEFAULT_SERVER_URL_BUILD;

export async function cmdUpdate(argv: string[]): Promise<void> {
  const force = argv.includes('--force');
  const home = runtimeHome();
  const base = (loadCliConfig()?.serverUrl ?? DEFAULT_SERVER_URL).replace(/\/+$/, '');
  // Open-source builds don't bake a default origin: with no serverUrl, don't guess — send the user to setup.
  if (!base) {
    console.error('No server configured. Run: lifeline setup --server-url <url>');
    process.exit(1);
  }

  const entry = resolveCliEntry();
  if (!isBundledRuntimeEntry(entry, home)) {
    const oneLiner
      = process.platform === 'win32'
        ? `irm ${base}${PUBLIC_PREFIX}/install.ps1 | iex`
        : `curl -fsSL ${base}${PUBLIC_PREFIX}/install.sh | sh`;
    console.error('This CLI was not installed by the one-liner installer, so it cannot update itself.');
    console.error(`  current entry: ${entry ?? process.argv[1] ?? 'unknown'}`);
    console.error('  pnpm install:  pnpm run build:cli && pnpm add -g .');
    console.error(`  one-liner:     ${oneLiner}`);
    process.exit(1);
  }

  const latest = await fetchLatestVersion(base);
  if (latest && !force && !isNewer(latest, VERSION)) {
    log(`Already up to date: v${VERSION}.`);
    return;
  }
  if (latest) {
    log(`Updating v${VERSION} → v${latest} (${base}) ...`);
  }
  else {
    log(`Reading the release manifest failed; installing from ${base} anyway ...`);
  }

  /**
   * On Windows the daemon MUST be **stopped before swapping the runtime** (POSIX is the opposite: swap first, then `restartDaemon`).
   *
   * Reason: file locks + the supervisor script. install.ps1 uses rename to dodge a running `node.exe`, but if the supervisor
   * is still alive it will respawn the process the instant runtime is renamed — the new process starts from a directory
   * that's being deleted, and the user sees "the agent vanished after the update". Stopping the task means nothing races to restart it.
   */
  const onWindows = process.platform === 'win32';
  if (onWindows) {
    if (stopWindowsDaemon())
      log('Stopped the background agent for the swap.');
  }

  await runInstaller(base, { ...process.env, LIFELINE_SERVER: base, LIFELINE_HOME: home });

  const nodeBin = join(home, 'runtime', runtimeNodeName());
  const mjs = join(home, 'runtime', 'lifeline.mjs');
  /**
   * **This is the real success check, not the exit code.**
   *
   * Measured on Windows: `powershell -Command -` consumes stdin statement by
   * statement, so a terminating error inside the installer still leaves exit code
   * 0 as soon as the next statement succeeds (the installer's own trailing
   * cleanup does exactly that). `result.status` is therefore not trustworthy on
   * that path, and it never was a proof of success on any platform. Running the
   * freshly installed bundle is.
   */
  const now = installedVersion(nodeBin, mjs);
  if (!now) {
    // On Windows the daemon was stopped *before* the swap, so a failed update
    // must start it again -- otherwise "just updating" leaves the user with a
    // dead agent and no obvious reason.
    if (onWindows)
      startWindowsDaemon();
    console.error(`Update failed: ${mjs} did not run. The existing runtime was left in place.`);
    process.exit(1);
  }
  log(`Installed: v${now} (${mjs})`);

  if (onWindows) {
    // Task may not exist yet (fresh install) -- startWindowsDaemon is a no-op then.
    startWindowsDaemon();
    log('Check with: lifeline status');
    return;
  }
  restartDaemon();
  log(`Check with: lifeline status`);
}
