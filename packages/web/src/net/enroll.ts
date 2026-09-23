/** Enroll / uninstall commands (copy matches production app.js 918-924, 2754-2778). */

import type { InstallOs } from '../lib/enroll-os.js';
import { getInstallOs } from '../lib/enroll-os.js';

/**
 * https→http downgrade is a **specialization for a specific deploy shape** (origin only listens on 80,
 * 443 often RST). By default it is a security anti-pattern — so it hangs off
 * `VITE_FORCE_HTTP_COMMANDS === '1'`: the build environment passes it when needed; by default https
 * commands stay as-is. Read at runtime (not a module-level constant) so tests can flip it.
 */
type ImportMetaWithEnv = ImportMeta & { env?: { VITE_FORCE_HTTP_COMMANDS?: string } };

/** Test hook: override the switch (import.meta is module-level; the test file cannot change this env). */
let forceHttpCommandsOverride: string | undefined;

export function __setForceHttpCommandsForTest(value?: string): void {
  forceHttpCommandsOverride = value;
}

function forceHttpCommands(): boolean {
  const value
    = forceHttpCommandsOverride ?? (import.meta as ImportMetaWithEnv).env?.VITE_FORCE_HTTP_COMMANDS;
  return value === '1';
}

function httpOrigin(origin: string): string {
  return forceHttpCommands() ? origin.replace(/^https:\/\//i, 'http://') : origin;
}

/** Unauthenticated assets all live under `/public/` (whitelist: server/public-paths.ts). */
const PUBLIC_PATH = '/public';

export function installCommand(origin = window.location.origin, os: InstallOs = getInstallOs()): string {
  if (os === 'windows')
    return `irm ${httpOrigin(origin)}${PUBLIC_PATH}/install.ps1 | iex`;
  return `curl -fsSL ${httpOrigin(origin)}${PUBLIC_PATH}/install.sh | sh`;
}

export function setupCommand(origin = window.location.origin): string {
  return `lifeline setup --server-url ${httpOrigin(origin)}`;
}

export function uninstallCommand(origin = window.location.origin, os: InstallOs = getInstallOs()): string {
  if (os === 'windows')
    return `irm ${httpOrigin(origin)}${PUBLIC_PATH}/uninstall.ps1 | iex`;
  return `curl -fsSL ${httpOrigin(origin)}${PUBLIC_PATH}/uninstall.sh | sh`;
}

/**
 * Upgrade command. Deliberately not `lifeline update`: that requires a new enough CLI, and this
 * command is for machines that are **already behind**. Re-running install.sh replaces the runtime,
 * but the daemon is still on old code (path unchanged), so a daemon install must follow for it to take effect.
 *
 * On Windows, chain with `;` not `&&` — **PowerShell 5.1 has no `&&`** (that's PS 7 syntax);
 * pasting into older PowerShell is a syntax error.
 */
export function updateCommand(origin = window.location.origin, os: InstallOs = getInstallOs()): string {
  const install = installCommand(origin, os);
  return os === 'windows' ? `${install}; lifeline daemon install` : `${install} && lifeline daemon install`;
}
