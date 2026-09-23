import { execSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { log, resolveCliEntry, tryRun } from '../ui.js';
import { startWindowsDaemon, stopWindowsDaemon, WINDOWS_DAEMON_TASK } from '../win-daemon.js';
import { DAEMON_LABEL, explainLaunchctl, kickstartLaunchd, launchdJobLoaded, launchdPlistPath } from './launchd.js';
import {
  hasSystemdUserManager,
  LINUX_SERVICE_UNIT,
  linuxUserUnitPath,
  pidAlive,
  readUnixDaemonPid,
  startDetachedAgent,
  systemdUnitActive,
  unixDaemonPidPath,
} from './systemd.js';
import { windowsDaemonScriptPath } from './windows.js';

/** Stopped is not uninstalled: the plist / unit stays, so the next login brings it back. */
const STOP_NOTE_KEPT = '  note   still installed: starts again at login, or run `lifeline daemon install`';
/** A foreground `lifeline start` is not in launchd/systemd — say where it can be stopped. */
const STOP_NOTE_FOREGROUND = '  note   `lifeline start` runs in the foreground — stop it there (Ctrl+C)';

/**
 * `lifeline stop` — stop the background agent, keep it installed. The
 * non-destructive counterpart of `daemon uninstall`, which also removes the
 * registration and the CDP argv it wrote.
 */
export function cmdStop(): void {
  if (process.platform === 'win32') {
    // Go through the shared entry (`cmdUpdate` uses it too); don't assemble another copy of the statement here — two copies will eventually diverge.
    // Task registration **stays**: that is `daemon uninstall`'s job; stop should only stop the agent.
    stopWindowsDaemon({ scriptPath: windowsDaemonScriptPath() });
    log(`Stopped ${WINDOWS_DAEMON_TASK}.`);
    log(STOP_NOTE_KEPT);
    log(STOP_NOTE_FOREGROUND);
    return;
  }
  if (process.platform !== 'darwin') {
    stopDaemonUnix();
    return;
  }
  const plistPath = launchdPlistPath();
  const uid = execSync('id -u').toString().trim();
  const serviceRef = `gui/${uid}/${DAEMON_LABEL}`;
  const installed = existsSync(plistPath);

  if (!launchdJobLoaded(serviceRef)) {
    log(installed
      ? `daemon   already stopped (launchd ${DAEMON_LABEL})`
      : 'daemon   not installed (run: lifeline daemon install)');
    log(installed ? STOP_NOTE_KEPT : STOP_NOTE_FOREGROUND);
    return;
  }

  const failed = tryRun(`launchctl bootout ${serviceRef}`);
  // bootout occasionally returns EIO (same origin as bootstrap): read back once; if the job is really gone, treat stop as success.
  if (failed && launchdJobLoaded(serviceRef)) {
    console.error(`daemon   could not stop ${DAEMON_LABEL}: ${explainLaunchctl(failed)}`);
    console.error(`  retry by hand: launchctl bootout ${serviceRef}`);
    process.exit(1);
  }
  log(`daemon   stopped (launchd ${DAEMON_LABEL})`);
  log(STOP_NOTE_KEPT);
}

/** Linux uses the same ladder: stop the unit if systemd --user is present, otherwise collect the background process from the pidfile. */
export function stopDaemonUnix(): void {
  const unitPath = linuxUserUnitPath();
  const pidPath = unixDaemonPidPath();
  const systemd = hasSystemdUserManager();

  if (systemd && existsSync(unitPath)) {
    const active = systemdUnitActive();
    const failed = active ? tryRun(`systemctl --user stop ${LINUX_SERVICE_UNIT}`) : undefined;
    if (failed) {
      console.error(`daemon   could not stop ${LINUX_SERVICE_UNIT}: ${failed}`);
      process.exit(1);
    }
    log(active
      ? `daemon   stopped (systemd --user ${LINUX_SERVICE_UNIT})`
      : `daemon   already stopped (systemd --user ${LINUX_SERVICE_UNIT})`);
    log(STOP_NOTE_KEPT);
    return;
  }

  const pid = readUnixDaemonPid(pidPath);
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      log(`daemon   stopped (pid ${pid})`);
    }
    catch {
      log(`daemon   already stopped (pid ${pid})`);
    }
    if (existsSync(pidPath))
      unlinkSync(pidPath);
    log('  note   start it again with `lifeline daemon install`');
    return;
  }

  if (existsSync(pidPath))
    unlinkSync(pidPath);
  log('daemon   not installed (run: lifeline daemon install)');
  log(STOP_NOTE_FOREGROUND);
}

/** `update` swaps the runtime under a running daemon — restart it so the new code takes over. */
export function restartDaemon(): void {
  if (process.platform === 'win32') {
    // Stop (including orphan sweep) → start. Order cannot reverse: on Windows a running node.exe is locked,
    // and the supervisor would respawn the process the instant runtime is renamed.
    stopWindowsDaemon({ scriptPath: windowsDaemonScriptPath() });
    if (startWindowsDaemon())
      log(`Restarted ${WINDOWS_DAEMON_TASK}.`);
    else log('Could not restart the daemon. Run: lifeline daemon install');
    return;
  }
  if (process.platform !== 'darwin') {
    restartDaemonUnix();
    return;
  }
  const plistPath = launchdPlistPath();
  if (!existsSync(plistPath)) {
    log('No daemon installed. Start the agent with: lifeline daemon install');
    return;
  }
  const uid = execSync('id -u').toString().trim();
  // One entry point (the `daemon install` restart branch uses it too): kickstart + **read-back**.
  // A bare kickstart's exit code is not proof the agent came back, and "reported restarted, actually
  // offline" is the most expensive kind of false success.
  if (kickstartLaunchd(`gui/${uid}/${DAEMON_LABEL}`).ok)
    log(`Restarted ${DAEMON_LABEL}.`);
  else log(`Could not restart the daemon. Run: lifeline daemon install`);
}

export function restartDaemonUnix(): void {
  if (hasSystemdUserManager() && existsSync(linuxUserUnitPath())) {
    try {
      execSync(`systemctl --user restart ${LINUX_SERVICE_UNIT}`, { stdio: 'ignore' });
      log(`Restarted ${LINUX_SERVICE_UNIT}.`);
    }
    catch {
      log(`Could not restart ${LINUX_SERVICE_UNIT}. Run: systemctl --user restart ${LINUX_SERVICE_UNIT}`);
    }
    return;
  }

  const pidPath = unixDaemonPidPath();
  const pid = readUnixDaemonPid(pidPath);
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      log(`Stopped background agent (pid ${pid}).`);
    }
    catch {
      /* already gone */
    }
  }
  const cliEntry = resolveCliEntry();
  if (!cliEntry) {
    log('No daemon installed. Start the agent with: lifeline daemon install');
    return;
  }
  const started = startDetachedAgent(cliEntry);
  if (started)
    writeFileSync(pidPath, `${started}\n`);
  log(`Restarted the background agent (pid ${started ?? '?'}).`);
}
