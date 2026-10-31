import type { CliSource } from '@lifeline/protocol';
import type { ChildProcess } from 'node:child_process';
import type { DaemonProbe } from '../commands/daemon.js';
import type { DaemonOpts, DaemonOutcome } from '../ui.js';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { codebuddyAcpProfile, cursorAcpProfile } from '../../../agent/src/drivers/acp/profiles.js';
import { buildChildEnv, withCliBinOnPath } from '../../../agent/src/drivers/acp/readiness.js';
import { BUILD_VERSION } from '../build-version.js';
import { applyCodeBuddyCdpArgv, applyCursorCdpArgv, revertCodeBuddyCdpArgvIfManaged, revertCursorCdpArgvIfManaged } from '../cdp-argv-state.js';
import { loadCliConfig, LOG_DIR, saveCliConfig } from '../config.js';
import { rebuildSqliteFor } from '../installer.js';
import { log, requireConfig, resolveCliEntry, tryRun } from '../ui.js';
import { lifelinePidsExcept } from './agent-processes.js';
import { decideEnsure } from './ensure-decision.js';
import { readServiceVersion, writeServiceVersion } from './service-version.js';

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
    <string>run</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>LIFELINE_SUPERVISED</key>
    <string>1</string>
  </dict>

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

interface LaunchdJob {
  state?: string;
  pid?: number;
}

function launchctlFailureText(err: unknown): string {
  if (!(err instanceof Error))
    return String(err);
  const extra = err as Error & { stderr?: unknown; stdout?: unknown };
  return [extra.stderr, extra.stdout, extra.message].map(part => (part == null ? '' : String(part))).join('\n');
}

/** "Could not find service" is launchctl's not-loaded result. Other failures must not look like that. */
function launchctlSaysNotLoaded(text: string): boolean {
  return /Could not find service/i.test(text) || /\bnot loaded\b/i.test(text);
}

/**
 * True when `pid` is the launchd job's pid.
 * Not loaded → false. Any other `launchctl print` failure → true, so a sandboxed
 * print runs the agent instead of bootout of this process. Non-darwin has no launchd job.
 */
export function currentProcessIsLaunchdJob(pid: number): boolean {
  if (process.platform !== 'darwin')
    return false;
  try {
    // Default execSync stderr is inherited, so a not-loaded job would print
    // "Could not find service" on a normal `lifeline start`. Keep both streams.
    const quiet = {
      encoding: 'utf-8' as const,
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    };
    const uid = execSync('id -u', quiet).trim();
    const out = execSync(`launchctl print gui/${uid}/${DAEMON_LABEL}`, quiet);
    const jobPid = /^\s*pid = (\d+)/m.exec(out)?.[1];
    return jobPid != null && Number(jobPid) === pid;
  }
  catch (err) {
    return !launchctlSaysNotLoaded(launchctlFailureText(err));
  }
}

/** `launchctl print` body. Null when the job is not loaded. Job-loaded alone is not "running". */
function readLaunchdJob(serviceRef: string): LaunchdJob | null {
  try {
    const out = execSync(`launchctl print ${serviceRef}`, { encoding: 'utf-8' });
    const state = /state = (\S+)/.exec(out)?.[1];
    const pidText = /^\s*pid = (\d+)/m.exec(out)?.[1];
    const pid = pidText ? Number(pidText) : undefined;
    return { state, pid };
  }
  catch {
    return null;
  }
}

/** Running means `state = running` and a pid. A loaded job that is waiting to restart is not running. */
function launchdAgentUp(job: LaunchdJob | null): boolean {
  return job?.state === 'running' && typeof job.pid === 'number' && job.pid > 0;
}

function currentCliEntry(): string | undefined {
  const entry = resolveCliEntry();
  return entry ? resolve(entry) : undefined;
}

export function probeLaunchdDaemon(): DaemonProbe {
  const plistPath = launchdPlistPath();
  const installed = existsSync(plistPath);
  const cliEntry = currentCliEntry();
  let registrationMatches = false;
  if (installed && cliEntry) {
    try {
      registrationMatches = readFileSync(plistPath, 'utf-8') === launchdPlist(process.execPath, cliEntry);
    }
    catch {
      registrationMatches = false;
    }
  }
  const uid = execSync('id -u').toString().trim();
  const job = readLaunchdJob(`gui/${uid}/${DAEMON_LABEL}`);
  return {
    installed,
    running: launchdAgentUp(job),
    registrationMatches,
  };
}

function finishLaunchd(opts: DaemonOpts, outcome: DaemonOutcome, lines: string[]): DaemonOutcome {
  if (opts.quiet)
    return outcome;
  for (const line of lines)
    log(line);
  for (const note of outcome.notes)
    log(`  note   ${note}`);
  return outcome;
}

function otherAgentOutcome(opts: DaemonOpts, pids: number[]): DaemonOutcome {
  return finishLaunchd(opts, {
    ok: false,
    summary: `another lifeline agent is already running (pid ${pids.join(', ')})`,
    notes: [],
  }, [
    `Could not start ${DAEMON_LABEL}.`,
    `  another lifeline agent is already running (pid ${pids.join(', ')})`,
  ]);
}

function recordLaunchdVersion(serviceRef: string): void {
  if (launchdAgentUp(readLaunchdJob(serviceRef)))
    writeServiceVersion(BUILD_VERSION);
}

/** kickstart's "job still loaded" is not a new process. The pid has to move. */
function launchdReplaced(serviceRef: string, previousPid: number | undefined): boolean {
  const job = readLaunchdJob(serviceRef);
  return launchdAgentUp(job) && job?.pid !== previousPid;
}

/** macOS daemon: launchd (RunAtLoad + KeepAlive). Darwin implementation of install / uninstall. */
export function cmdDaemonLaunchd(action: string, opts: DaemonOpts = {}, probe?: DaemonProbe): DaemonOutcome | undefined {
  const plistPath = launchdPlistPath();
  const uid = execSync('id -u').toString().trim();
  const serviceRef = `gui/${uid}/${DAEMON_LABEL}`;

  if (action === 'install') {
    requireConfig();
    const nodeBin = process.execPath;
    // Resolve through symlink layers: argv[1] may be a session-scoped shim
    // (fnm multishells) that disappears once the shell exits. Bake the real
    // installation path into the plist so launchd can always find it.
    const cliEntry = currentCliEntry();
    if (!cliEntry || !existsSync(cliEntry)) {
      console.error(`Cannot resolve CLI entry (argv[1]=${process.argv[1]}). Run via the installed command.`);
      process.exit(1);
    }

    const seen = probe ?? probeLaunchdDaemon();
    const ensure = decideEnsure({
      installed: seen.installed,
      registrationMatches: seen.registrationMatches,
      running: seen.running,
      versionMatches: readServiceVersion() === BUILD_VERSION,
    });
    if (ensure === 'noop') {
      return finishLaunchd(opts, {
        ok: true,
        summary: `already running (launchd ${DAEMON_LABEL})`,
        notes: [],
      }, [
        `Already running: ${DAEMON_LABEL}`,
        `  plist  ${plistPath}`,
        `  logs   ${join(LOG_DIR, 'agent.out.log')}`,
        'Check with: lifeline status',
      ]);
    }

    const job = readLaunchdJob(serviceRef);
    const foreign = lifelinePidsExcept(job?.pid ?? null);
    if (foreign.length > 0)
      return otherAgentOutcome(opts, foreign);

    mkdirSync(LOG_DIR, { recursive: true });
    // A fresh account may not have ~/Library/LaunchAgents yet.
    mkdirSync(dirname(plistPath), { recursive: true });

    const notes: string[] = [];
    let ok = false;
    let summary = 'not started';
    let headline = `Could not start ${DAEMON_LABEL}.`;

    if (ensure === 'start-only') {
      // After `lifeline stop` the plist is still on disk but the job is not loaded.
      // bootstrap of that file; bootout or a rewrite would drop the registration.
      // An already-loaded job that is not `state = running` must kickstart:
      // bootstrap fails when the job is already in the domain.
      if (!launchdJobLoaded(serviceRef)) {
        const boot = bootstrapLaunchd(uid, plistPath);
        ok = boot.ok;
        if (!boot.ok) {
          notes.push(`launchctl: ${boot.error}`);
          notes.push(`retry by hand: launchctl bootstrap gui/${uid} "${plistPath}"`);
        }
      }
      else {
        const previousPid = readLaunchdJob(serviceRef)?.pid;
        const restarted = kickstartLaunchd(serviceRef);
        ok = launchdReplaced(serviceRef, previousPid);
        if (!ok) {
          notes.push(restarted.ok
            ? 'the agent process did not change'
            : `launchctl: ${restarted.error}`);
          notes.push('retry by hand: lifeline start');
        }
      }
      summary = ok ? `started (launchd ${DAEMON_LABEL})` : 'not started';
      headline = ok ? `Started: ${DAEMON_LABEL}` : `Could not start ${DAEMON_LABEL}.`;
    }
    else if (ensure === 'restart-in-place') {
      // Bytes already match. kickstart -k swaps the process and never enters the
      // bootout → bootstrap EIO window (real-machine incident, 2026-09-21).
      // Job-loaded is not success: the pid before kickstart must be gone.
      const previousPid = readLaunchdJob(serviceRef)?.pid;
      const restarted = kickstartLaunchd(serviceRef);
      ok = launchdReplaced(serviceRef, previousPid);
      if (!ok) {
        notes.push(restarted.ok
          ? 'the agent process did not change'
          : `launchctl: ${restarted.error}`);
        notes.push('retry by hand: lifeline start');
      }
      summary = ok ? `restarted (launchd ${DAEMON_LABEL})` : 'not started';
      headline = ok ? `Restarted: ${DAEMON_LABEL}` : `Could not start ${DAEMON_LABEL}.`;
    }
    else if (ensure === 'reinstall') {
      const sqliteError = rebuildSqliteFor(nodeBin);
      if (sqliteError)
        notes.push(`better-sqlite3 rebuild failed (${sqliteError}); chat history may be unavailable.`);
      const plist = launchdPlist(nodeBin, cliEntry);
      execSync(`launchctl bootout ${serviceRef} 2>/dev/null || true`);
      writeFileSync(plistPath, plist, 'utf-8');
      const boot = bootstrapLaunchd(uid, plistPath);
      ok = boot.ok;
      if (!boot.ok) {
        notes.push(`launchctl: ${boot.error}`);
        notes.push(`retry by hand: launchctl bootstrap gui/${uid} "${plistPath}"`);
      }
      const cfg = loadCliConfig();
      if (cfg)
        saveCliConfig(applyCodeBuddyCdpArgv(applyCursorCdpArgv(cfg).config).config);
      summary = ok ? `started (launchd ${DAEMON_LABEL})` : 'not started';
      headline = ok ? `Installed and started: ${DAEMON_LABEL}` : `Could not start ${DAEMON_LABEL}.`;
    }

    if (ok)
      recordLaunchdVersion(serviceRef);
    return finishLaunchd(opts, { ok, summary, notes }, [
      headline,
      `  plist  ${plistPath}`,
      `  logs   ${join(LOG_DIR, 'agent.out.log')}`,
      'Check with: lifeline status',
    ]);
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

  console.error(`Unknown daemon action: ${action} (expected install | uninstall | status)`);
  process.exit(1);
}

export interface LaunchdProviderPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * launchd does not inherit an interactive PATH or API key.
 * The spawn command is the absolute path saved at setup.
 */
export function planLaunchdProviderSpawn(input: {
  source: CliSource;
  command: string;
  baseEnv: NodeJS.ProcessEnv;
  apiKey?: string;
  environment?: string;
}): LaunchdProviderPlan {
  if (!isAbsolute(input.command))
    throw new Error('CLI provider path must be an absolute path');
  const profile = input.source === 'cursor-cli' ? cursorAcpProfile : codebuddyAcpProfile;
  const { env } = buildChildEnv({
    source: input.source,
    base: input.baseEnv,
    apiKey: input.apiKey,
    environment: input.environment,
  });
  return { command: input.command, args: [...profile.args], env: withCliBinOnPath(env, input.command) };
}

/** Spawn wrapper. Tests pass `spawnImpl`. Does not call `launchctl`. */
export function spawnAbsoluteProvider(
  plan: LaunchdProviderPlan,
  spawnImpl: typeof spawn = spawn,
): ChildProcess {
  if (!isAbsolute(plan.command))
    throw new Error('CLI provider path must be an absolute path');
  return spawnImpl(plan.command, plan.args, {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: plan.env,
  });
}
