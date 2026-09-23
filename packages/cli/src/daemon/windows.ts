import type { DaemonOpts, DaemonOutcome } from '../ui.js';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyCodeBuddyCdpArgv, applyCursorCdpArgv, revertCodeBuddyCdpArgvIfManaged, revertCursorCdpArgvIfManaged } from '../cdp-argv-state.js';
import { CONFIG_DIR, loadCliConfig, LOG_DIR, saveCliConfig } from '../config.js';
import { rebuildSqliteFor } from '../installer.js';
import { log, requireConfig, resolveCliEntry } from '../ui.js';
import {
  isUnlimitedExecution,
  newLifelinePids,
  parseWindowsAgentPids,
  parseWindowsTaskStatus,
  queryWindowsStatement,
  runWindowsStatement,
  stopWindowsDaemon,
  WINDOWS_DAEMON_SCRIPT_NAME,
  WINDOWS_DAEMON_TASK,
  windowsAgentProbePsCommand,
  windowsLifelinePidsPsCommand,
  windowsRegisterPsCommand,
  windowsStatusPsCommand,
  windowsUnregisterPsCommand,
  writeWindowsDaemonScript,
} from '../win-daemon.js';
import { pidAlive, readUnixDaemonPid, startDetachedAgent, unixDaemonPidPath } from './systemd.js';

/** On-disk path of the supervisor script (counterpart of Linux's unit and macOS's plist). */
export function windowsDaemonScriptPath(): string {
  return join(CONFIG_DIR, WINDOWS_DAEMON_SCRIPT_NAME);
}

/**
 * Windows daemon: a scheduled task runs a supervisor script.
 *
 * Same split as Linux — prefer the system mechanism (Task Scheduler here); if registration fails, degrade to a detached
 * process + pidfile (the agent still runs, but a crash does not self-heal; the note explains this).
 *
 * **Cannot rely on `RestartOnFailure`**: measured, it never restarts on a non-zero exit (see the top of `win-daemon.ts`).
 * Self-healing comes from the supervisor script's own loop.
 */
export function cmdDaemonWindows(action: string, opts: DaemonOpts = {}): DaemonOutcome | undefined {
  const scriptPath = windowsDaemonScriptPath();
  const pidPath = unixDaemonPidPath();

  if (action === 'install') {
    requireConfig();
    const cliEntry = resolveCliEntry();
    if (!cliEntry) {
      console.error(`Cannot resolve CLI entry (argv[1]=${process.argv[1]}). Run via the installed command.`);
      process.exit(1);
    }
    const nodeBin = process.execPath;
    const notes: string[] = [];
    /**
     * Stop the previous daemon cleanly first — and it must happen before writing the script / registering.
     *
     * Measured on a real machine (2026-09-20): an agent started via the fallback path (`startDetachedAgent`) is not in the task tree,
     * so `Register-ScheduledTask -Force` does not touch it — and it keeps holding `agent.out.log`, so the new supervisor's
     * `1>>` cannot open every round and node is never spawned (the error goes into Task Scheduler's black hole). Symptom: after the upgrade
     * the web page still says "update available", because the running process is still the old one.
     *
     * Use **the same entry** (`cmdStop` / `cmdUpdate` both use it): stop's criterion is "orphans whose parent is already dead",
     * so a user-run foreground `lifeline start` is unaffected and will not be killed by mistake.
     */
    stopWindowsDaemon({ scriptPath });
    /**
     * Baseline for the read-back check ("before start" snapshot): lifeline processes **still alive** after stop.
     *
     * Two uses: ① set-difference against the after-start snapshot — only **new** pids count as "the agent this run started";
     * ② ones stop cannot collect (a user's foreground `lifeline start`) must be stated: while they hold `agent.out.log`
     * the new agent cannot start (the measured `1>>` failure; see supervisor.log in the supervisor script).
     *
     * `excludePid: process.pid` cannot be omitted: the CLI's own command line is
     * `node.exe …lifeline.mjs daemon install`, which also matches the probe criterion (found in code review on a real machine).
     */
    const pidsBefore = parseWindowsAgentPids(
      queryWindowsStatement(windowsLifelinePidsPsCommand(process.pid)),
    );
    if (pidsBefore.length > 0) {
      notes.push(
        `another lifeline agent is already running (pid ${pidsBefore.join(', ')}); it may hold the logs — stop it with \`lifeline stop\``,
      );
    }
    const sqliteError = rebuildSqliteFor(nodeBin);
    if (sqliteError)
      notes.push(`better-sqlite3 rebuild failed (${sqliteError}); chat history may be unavailable.`);
    mkdirSync(LOG_DIR, { recursive: true });

    // UTF-8 with BOM: the script embeds a path that may not be ASCII (Chinese username).
    writeWindowsDaemonScript(scriptPath, nodeBin, cliEntry);

    let ok = runWindowsStatement(windowsRegisterPsCommand({ scriptPath }));
    let summary: string;
    /** Task running ≠ agent running: only a new pid in the process-table set-difference counts as actually up. */
    let agentUp = true;
    if (ok) {
      summary = `started (scheduled task ${WINDOWS_DAEMON_TASK})`;
      // Read-back check: ExecutionTimeLimit defaults to 72 hours; the agent would vanish **silently** after three days.
      const status = parseWindowsTaskStatus(queryWindowsStatement(windowsStatusPsCommand()));
      if (status.executionTimeLimit && !isUnlimitedExecution(status.executionTimeLimit)) {
        notes.push(
          `ExecutionTimeLimit is ${status.executionTimeLimit} (expected PT0S/00:00:00): the scheduler will kill the agent.`,
        );
      }
      if (!status.running) {
        notes.push('the task is registered but did not report Running yet; check `lifeline daemon status`.');
      }
      // Task Running only means the **supervisor** is running — the agent itself may fail at the launch layer every round (see
      // supervisor.log in the supervisor script). Wait a few seconds, look at the process table, **set-difference against the before-start snapshot**, and don't report "didn't
      // actually come up" as Installed and started (hit on a real machine: the user thought the upgrade finished, but the running process was still the old one,
      // and the web page kept saying "update available").
      const fresh = newLifelinePids(
        pidsBefore,
        parseWindowsAgentPids(
          queryWindowsStatement(windowsAgentProbePsCommand({ excludePid: process.pid })),
        ),
      );
      if (fresh.length === 0) {
        agentUp = false;
        summary = 'installed, but the agent process did not come up';
        notes.push(
          `the agent process did not come up — check ${LOG_DIR}; if the launch itself failed, supervisor.log says why`,
        );
      }
    }
    else {
      const pid = startDetachedAgent(cliEntry);
      if (pid)
        writeFileSync(pidPath, `${pid}\n`);
      ok = Boolean(pid);
      summary = pid ? `started in the background (pid ${pid})` : 'not started';
      notes.push('the scheduled task could not be registered, so it is not restarted after a crash');
      if (!pid)
        notes.push('retry by hand: lifeline daemon install');
    }

    const cfg = loadCliConfig();
    if (cfg)
      saveCliConfig(applyCodeBuddyCdpArgv(applyCursorCdpArgv(cfg).config).config);

    const outcome: DaemonOutcome = { ok, summary, notes };
    if (opts.quiet)
      return outcome;

    // Spell out the three exits separately; don't paper over "didn't come up" with a single "Installed and started".
    if (!ok)
      log(`Could not start ${WINDOWS_DAEMON_TASK}.`);
    else if (agentUp)
      log(`Installed and started: ${WINDOWS_DAEMON_TASK}`);
    else log(`Installed ${WINDOWS_DAEMON_TASK}, but the agent is not running.`);
    log(`  script ${scriptPath}`);
    log(`  logs   ${join(LOG_DIR, 'agent.out.log')}`);
    log('Check with: lifeline daemon status');
    for (const note of notes) log(`  note   ${note}`);
    return outcome;
  }

  if (action === 'uninstall') {
    runWindowsStatement(windowsUnregisterPsCommand(WINDOWS_DAEMON_TASK, scriptPath));
    if (existsSync(scriptPath)) {
      unlinkSync(scriptPath);
      log(`Removed ${scriptPath}`);
    }
    const pid = readUnixDaemonPid(pidPath);
    if (pid && pidAlive(pid)) {
      try {
        process.kill(pid);
        log(`Stopped background agent (pid ${pid})`);
      }
      catch {
        /* already gone */
      }
    }
    if (existsSync(pidPath))
      unlinkSync(pidPath);
    revertCursorCdpArgvIfManaged();
    revertCodeBuddyCdpArgvIfManaged();
    return;
  }

  if (action === 'status') {
    const status = parseWindowsTaskStatus(queryWindowsStatement(windowsStatusPsCommand()));
    const pid = readUnixDaemonPid(pidPath);
    const bgAlive = Boolean(pid && pidAlive(pid));
    if (status.state) {
      // 267009 is "currently running", not an error — parseWindowsTaskStatus already translated it
      log(`daemon   ${status.state}${status.running ? ' (running)' : ''}`);
      if (status.executionTimeLimit && !isUnlimitedExecution(status.executionTimeLimit)) {
        log(`  note   ExecutionTimeLimit is ${status.executionTimeLimit} (expected PT0S/00:00:00)`);
      }
    }
    if (bgAlive)
      log(`daemon   running in background (pid ${pid})`);
    else if (pid)
      unlinkSync(pidPath);
    if (!status.state && !bgAlive)
      log('daemon   not installed (run: lifeline daemon install)');
    return;
  }

  console.error(`Unknown daemon action: ${action} (expected install | uninstall | status)`);
  process.exit(1);
}
