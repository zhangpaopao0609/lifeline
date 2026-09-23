import type { DaemonOpts, DaemonOutcome } from '../ui.js';
import { cmdDaemonLaunchd } from '../daemon/launchd.js';
import { cmdDaemonUnix } from '../daemon/systemd.js';
import { cmdDaemonWindows } from '../daemon/windows.js';

/** `lifeline daemon <install|uninstall|status>` — dispatch to the platform implementation. */
export function cmdDaemon(action: string, opts: DaemonOpts = {}): DaemonOutcome | undefined {
  if (process.platform === 'win32') {
    return cmdDaemonWindows(action, opts);
  }
  if (process.platform !== 'darwin') {
    return cmdDaemonUnix(action, opts);
  }
  return cmdDaemonLaunchd(action, opts);
}
