import type { DaemonOpts, DaemonOutcome } from '../ui.js';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyCodeBuddyCdpArgv, applyCursorCdpArgv, revertCodeBuddyCdpArgvIfManaged, revertCursorCdpArgvIfManaged } from '../cdp-argv-state.js';
import { CONFIG_DIR, loadCliConfig, LOG_DIR, saveCliConfig } from '../config.js';
import { rebuildSqliteFor } from '../installer.js';
import { log, requireConfig, resolveCliEntry, tryRun } from '../ui.js';

export const LINUX_SERVICE_UNIT = 'lifeline.service';

/** systemd --user is absent in most containers; fall back to a detached process. */
export function hasSystemdUserManager(): boolean {
  try {
    execSync('systemctl --user show-environment', { stdio: 'ignore' });
    return true;
  }
  catch {
    return false;
  }
}

/** systemd ExecStart splits on spaces; quote absolute paths that contain them. */
function systemdArg(path: string): string {
  return path.includes(' ') ? `"${path}"` : path;
}

export function systemdUserUnit(nodeBin: string, cliEntry: string): string {
  return `[Unit]
Description=Lifeline agent
After=network-online.target

[Service]
Type=simple
ExecStart=${systemdArg(nodeBin)} ${systemdArg(cliEntry)} start
Restart=on-failure
RestartSec=10
StandardOutput=append:${join(LOG_DIR, 'agent.out.log')}
StandardError=append:${join(LOG_DIR, 'agent.err.log')}

[Install]
WantedBy=default.target
`;
}

export function linuxUserUnitPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(process.env.HOME ?? '~', '.config');
  return join(configHome, 'systemd', 'user', LINUX_SERVICE_UNIT);
}

export function unixDaemonPidPath(): string {
  return join(CONFIG_DIR, 'daemon.pid');
}

export function startDetachedAgent(cliEntry: string): number | undefined {
  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(join(LOG_DIR, 'agent.out.log'), 'a');
  const err = openSync(join(LOG_DIR, 'agent.err.log'), 'a');
  const child = spawn(process.execPath, [cliEntry, 'start'], {
    detached: true,
    stdio: ['ignore', out, err],
    // Windows: without this, the fallback path (when scheduled-task registration fails) pops a console window.
    // No-op on POSIX.
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

export function readUnixDaemonPid(pidPath: string): number | null {
  try {
    const pid = Number(readFileSync(pidPath, 'utf-8').trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  }
  catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  }
  catch {
    return false;
  }
}

export function systemdUnitActive(): boolean {
  return execSync(`systemctl --user is-active ${LINUX_SERVICE_UNIT} || true`, {
    encoding: 'utf-8',
  }).trim() === 'active';
}

/**
 * Linux daemon: prefer systemd --user (starts on login, restarts after exit);
 * in a container / without systemd, fall back to a detached background process + pidfile (no auto-restart).
 */
export function cmdDaemonUnix(action: string, opts: DaemonOpts = {}): DaemonOutcome | undefined {
  const unitPath = linuxUserUnitPath();
  const pidPath = unixDaemonPidPath();
  const systemd = hasSystemdUserManager();

  if (action === 'install') {
    requireConfig();
    const cliEntry = resolveCliEntry();
    if (!cliEntry) {
      console.error(`Cannot resolve CLI entry (argv[1]=${process.argv[1]}). Run via the installed command.`);
      process.exit(1);
    }
    const nodeBin = process.execPath;
    const notes: string[] = [];
    const sqliteError = rebuildSqliteFor(nodeBin);
    if (sqliteError)
      notes.push(`better-sqlite3 rebuild failed (${sqliteError}); chat history may be unavailable.`);
    mkdirSync(LOG_DIR, { recursive: true });

    let ok = true;
    let summary: string;
    if (systemd) {
      mkdirSync(dirname(unitPath), { recursive: true });
      writeFileSync(unitPath, systemdUserUnit(nodeBin, cliEntry), 'utf-8');
      execSync('systemctl --user daemon-reload');
      const failed = tryRun(`systemctl --user enable --now ${LINUX_SERVICE_UNIT}`);
      ok = !failed;
      summary = failed ? 'not started' : `started (systemd --user ${LINUX_SERVICE_UNIT})`;
      if (failed) {
        notes.push(`systemctl: ${failed}`);
        notes.push(`retry by hand: systemctl --user enable --now ${LINUX_SERVICE_UNIT}`);
      }
      else {
        notes.push(`user services stop at logout unless lingering is on: loginctl enable-linger ${process.env.USER ?? '$USER'}`);
      }
    }
    else {
      const pid = startDetachedAgent(cliEntry);
      if (pid)
        writeFileSync(pidPath, `${pid}\n`);
      ok = Boolean(pid);
      summary = pid ? `started in the background (pid ${pid})` : 'not started';
      notes.push('no systemd --user here, so it is not restarted after logout or reboot');
    }

    const cfg = loadCliConfig();
    if (cfg)
      saveCliConfig(applyCodeBuddyCdpArgv(applyCursorCdpArgv(cfg).config).config);

    const outcome: DaemonOutcome = { ok, summary, notes };
    if (opts.quiet)
      return outcome;

    if (systemd) {
      log(ok ? `Installed and started: ${LINUX_SERVICE_UNIT}` : `Could not start ${LINUX_SERVICE_UNIT}.`);
      log(`  unit   ${unitPath}`);
    }
    else {
      log(`systemd --user unavailable; ${summary}.`);
    }
    log(`  logs   ${join(LOG_DIR, 'agent.out.log')}`);
    log('Check with: lifeline daemon status');
    for (const note of notes) log(`  note   ${note}`);
    return outcome;
  }

  if (action === 'uninstall') {
    if (systemd) {
      execSync(`systemctl --user disable --now ${LINUX_SERVICE_UNIT} 2>/dev/null || true`);
      execSync(`systemctl --user reset-failed ${LINUX_SERVICE_UNIT} 2>/dev/null || true`);
    }
    if (existsSync(unitPath)) {
      unlinkSync(unitPath);
      log(`Removed ${unitPath}`);
      if (systemd)
        execSync('systemctl --user daemon-reload 2>/dev/null || true');
    }
    const pid = readUnixDaemonPid(pidPath);
    if (pid && pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
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
    let found = false;
    if (systemd && existsSync(unitPath)) {
      const state = execSync(`systemctl --user is-active ${LINUX_SERVICE_UNIT} || true`, {
        encoding: 'utf-8',
      }).trim() || 'unknown';
      const mainPid = execSync(`systemctl --user show -p MainPID --value ${LINUX_SERVICE_UNIT} || true`, {
        encoding: 'utf-8',
      }).trim();
      log(`daemon   ${state}${mainPid && mainPid !== '0' ? ` (pid ${mainPid})` : ''}`);
      found = true;
    }
    const pid = readUnixDaemonPid(pidPath);
    if (pid && pidAlive(pid)) {
      log(`daemon   running in background (pid ${pid})`);
      found = true;
    }
    else if (pid) {
      unlinkSync(pidPath);
    }
    if (!found)
      log('daemon   not installed (run: lifeline daemon install)');
    return;
  }

  console.error(`Unknown daemon action: ${action} (expected install | uninstall | status)`);
  process.exit(1);
}
