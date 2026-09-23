import type { DaemonOpts, DaemonOutcome } from '../ui.js';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { applyCodeBuddyCdpArgv, applyCursorCdpArgv, revertCodeBuddyCdpArgvIfManaged, revertCursorCdpArgvIfManaged } from '../cdp-argv-state.js';
import { loadCliConfig, LOG_DIR, saveCliConfig } from '../config.js';
import { rebuildSqliteFor } from '../installer.js';
import { log, requireConfig, tryRun } from '../ui.js';

export const DAEMON_LABEL = 'com.lifeline.agent';

export function launchdPlist(nodeBin: string, cliEntry: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${cliEntry}</string>
    <string>start</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>ProcessType</key>
  <string>Background</string>

  <key>StandardOutPath</key>
  <string>${join(LOG_DIR, 'agent.out.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(LOG_DIR, 'agent.err.log')}</string>
</dict>
</plist>
`;
}

export function launchdPlistPath(): string {
  return join(process.env.HOME ?? '~', 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
}

/** launchctl says "Input/output error" for a job that is stale or half-loaded — say so. */
export function explainLaunchctl(text: string): string {
  return /Input\/output error/.test(text)
    ? `${text} (launchd usually means a stale copy of the job is still registered)`
    : text;
}

/**
 * `launchctl bootout` followed **immediately** by `bootstrap` always fails on a live machine:
 * measured 2026-09-21 (macOS 15), delay=0s returns `Bootstrap failed: 5: Input/output error`
 * every time, 50ms always succeeds — it is a time window, not a broken plist. So every
 * bootstrap waits first.
 */
const BOOTSTRAP_ATTEMPTS = 4;
const BOOTSTRAP_DELAY_MS = 150;

/** Sync nap: install is a fully synchronous flow, and Atomics.wait beats spawning `sleep`. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Register the plist with the launchd domain.
 *
 * ⚠️ The verdict is **the `launchdJobLoaded` read-back**, never a launchctl exit code — both
 * traps were hit on a real machine:
 *
 * 1. bootstrap inside the EIO window that follows a bootout (see `BOOTSTRAP_DELAY_MS`);
 * 2. legacy `load -w` **exits 0 even when it fails** (measured: it prints
 *    `Load failed: 5: Input/output error` and still exits 0). Trusting tryRun's result there
 *    reports "Installed and started" for an agent that does not exist — the 2026-09-21 incident:
 *    plist present, job not loaded, log stopped at `[agent] Shutting down...` with no startup banner.
 */
export function bootstrapLaunchd(uid: string, plistPath: string): { ok: true } | { ok: false; error: string } {
  const serviceRef = `gui/${uid}/${DAEMON_LABEL}`;
  let lastError = '';

  for (let attempt = 0; attempt < BOOTSTRAP_ATTEMPTS; attempt++) {
    sleepSync(BOOTSTRAP_DELAY_MS);
    const failed = tryRun(`launchctl bootstrap gui/${uid} "${plistPath}"`);
    // The read-back decides: a reported error may still have registered the job, and no error
    // does not prove it registered either.
    if (launchdJobLoaded(serviceRef))
      return { ok: true };
    lastError = failed ?? `job ${DAEMON_LABEL} did not register`;
  }

  // Last resort: legacy `load -w` (launchd still honours it, through a different path). Same rule.
  sleepSync(BOOTSTRAP_DELAY_MS);
  tryRun(`launchctl load -w "${plistPath}"`);
  if (launchdJobLoaded(serviceRef))
    return { ok: true };
  return { ok: false, error: explainLaunchctl(lastError) };
}

/**
 * Restart an **already registered** job in place: `kickstart -k` swaps the process without
 * touching the registration, so it cannot hit the bootout → bootstrap EIO window. Re-registering
 * is only for when the plist itself changed.
 *
 * Read back here too: kickstart's exit code is not proof the agent is back.
 */
export function kickstartLaunchd(serviceRef: string): { ok: true } | { ok: false; error: string } {
  const failed = tryRun(`launchctl kickstart -k ${serviceRef}`);
  if (launchdJobLoaded(serviceRef))
    return { ok: true };
  return { ok: false, error: explainLaunchctl(failed ?? `job ${DAEMON_LABEL} is not loaded`) };
}

/** Is the launchd job currently registered (running, or waiting for a restart)? */
export function launchdJobLoaded(serviceRef: string): boolean {
  try {
    execSync(`launchctl print ${serviceRef}`, { stdio: 'ignore' });
    return true;
  }
  catch {
    return false;
  }
}

/** macOS daemon: launchd (RunAtLoad + KeepAlive). Darwin implementation of install / uninstall / status. */
export function cmdDaemonLaunchd(action: string, opts: DaemonOpts = {}): DaemonOutcome | undefined {
  const plistPath = launchdPlistPath();
  const uid = execSync('id -u').toString().trim();
  const serviceRef = `gui/${uid}/${DAEMON_LABEL}`;

  if (action === 'install') {
    requireConfig();
    const nodeBin = process.execPath;
    // Resolve through symlink layers: argv[1] may be a session-scoped shim
    // (fnm multishells) that disappears once the shell exits. Bake the real
    // installation path into the plist so launchd can always find it.
    let cliEntry: string | undefined;
    try {
      cliEntry = process.argv[1] ? realpathSync(process.argv[1]) : undefined;
    }
    catch {
      cliEntry = undefined;
    }
    if (!cliEntry || !existsSync(cliEntry)) {
      console.error(`Cannot resolve CLI entry (argv[1]=${process.argv[1]}). Run via the installed command.`);
      process.exit(1);
    }

    mkdirSync(LOG_DIR, { recursive: true });
    // A fresh account may not have ~/Library/LaunchAgents yet.
    mkdirSync(dirname(plistPath), { recursive: true });

    const plist = launchdPlist(nodeBin, resolve(cliEntry));
    const notes: string[] = [];
    const sqliteError = rebuildSqliteFor(nodeBin);
    if (sqliteError)
      notes.push(`better-sqlite3 rebuild failed (${sqliteError}); chat history may be unavailable.`);

    /**
     * Byte-identical registration + the job still loaded = this is just "swapped the runtime,
     * restart it". `install.sh && lifeline daemon install` lands exactly here: swapping the
     * runtime changes no path, so the plist is character-for-character the same.
     *
     * That case must kickstart, never bootout + bootstrap — there is an EIO window between the
     * two, and hitting it kills the old process while the new one never registers, leaving the
     * agent down for good (real-machine incident, 2026-09-21).
     */
    const restartOnly
      = existsSync(plistPath) && readFileSync(plistPath, 'utf-8') === plist && launchdJobLoaded(serviceRef);

    let ok: boolean;
    if (restartOnly) {
      const restarted = kickstartLaunchd(serviceRef);
      ok = restarted.ok;
      if (!restarted.ok) {
        notes.push(`launchctl: ${restarted.error}`);
        notes.push('retry by hand: lifeline daemon install');
      }
    }
    else {
      execSync(`launchctl bootout ${serviceRef} 2>/dev/null || true`);
      writeFileSync(plistPath, plist, 'utf-8');
      const boot = bootstrapLaunchd(uid, plistPath);
      ok = boot.ok;
      if (!boot.ok) {
        notes.push(`launchctl: ${boot.error}`);
        notes.push(`retry by hand: launchctl bootstrap gui/${uid} "${plistPath}"`);
      }
    }

    const cfg = loadCliConfig();
    if (cfg)
      saveCliConfig(applyCodeBuddyCdpArgv(applyCursorCdpArgv(cfg).config).config);

    const outcome: DaemonOutcome = {
      ok,
      summary: ok ? `${restartOnly ? 'restarted' : 'started'} (launchd ${DAEMON_LABEL})` : 'not started',
      notes,
    };
    if (opts.quiet)
      return outcome;

    log(
      ok
        ? `${restartOnly ? 'Restarted' : 'Installed and started'}: ${DAEMON_LABEL}`
        : `Could not start ${DAEMON_LABEL}.`,
    );
    log(`  plist  ${plistPath}`);
    log(`  logs   ${join(LOG_DIR, 'agent.out.log')}`);
    log('Check with: lifeline daemon status');
    for (const note of notes) log(`  note   ${note}`);
    return outcome;
  }

  if (action === 'uninstall') {
    execSync(`launchctl bootout ${serviceRef} 2>/dev/null || true`);
    let removedAny = false;
    if (existsSync(plistPath)) {
      execSync(`rm "${plistPath}"`);
      log(`Removed ${plistPath}`);
      removedAny = true;
    }
    if (!removedAny) {
      log(`Nothing to remove.`);
    }
    revertCursorCdpArgvIfManaged();
    revertCodeBuddyCdpArgvIfManaged();
    return;
  }

  if (action === 'status') {
    try {
      const out = execSync(`launchctl print ${serviceRef} 2>/dev/null`, { encoding: 'utf-8' });
      const state = /state = (\S+)/.exec(out)?.[1];
      const pid = /^\s*pid = (\d+)/m.exec(out)?.[1];
      log(`daemon   ${state ?? 'unknown'}${pid ? ` (pid ${pid})` : ''}`);
    }
    catch {
      log(`daemon   not installed (run: lifeline daemon install)`);
    }
    return;
  }

  console.error(`Unknown daemon action: ${action} (expected install | uninstall | status)`);
  process.exit(1);
}
