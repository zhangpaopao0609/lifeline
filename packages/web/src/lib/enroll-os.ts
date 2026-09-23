import type { AgentPlatform } from '../net/protocol';
import { useSyncExternalStore } from 'react';

export type InstallOs = 'unix' | 'windows';

/**
 * When we know which machine it is, command shape follows **that machine's** OS, not a UA guess from the browser viewing the page.
 *
 * The three platforms collapse to two: Windows gets PowerShell; darwin / linux share `uninstall.sh` / `install.sh`
 * (the scripts branch on `uname -s` themselves; the page doesn't need to).
 *
 * Returns `undefined` = the machine didn't report a platform (older agent) → caller falls back to the OS switch.
 */
export function machineCommandOs(platform?: AgentPlatform): InstallOs | undefined {
  if (platform === undefined)
    return undefined;
  return platform === 'win32' ? 'windows' : 'unix';
}

/**
 * Guess OS from UA — only so Windows users **default** to seeing their own command, not a security check.
 *
 * Unknown falls to `unix`: we used to ship only unix commands, so a wrong guess is no worse than before;
 * the reverse (showing PowerShell to a Mac user by default) would actually be a regression.
 */
export function detectInstallOs(ua?: string): InstallOs {
  return /Windows/i.test(ua ?? '') ? 'windows' : 'unix';
}

const initialUa = typeof navigator === 'undefined' ? '' : navigator.userAgent;
let current: InstallOs = detectInstallOs(initialUa);
const listeners = new Set<() => void>();

export function getInstallOs(): InstallOs {
  return current;
}

export function setInstallOs(next: InstallOs): void {
  if (next === current)
    return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeInstallOs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * OS choice for the enroll-command area. **Module-level singleton + `useSyncExternalStore`**, so the 5 render
 * sites on the page (empty state, landing, enroll dialog, command palette, machine-row menu) **stay in sync
 * after one switch** — with separate useState, switching in the machine-row menu would leave the palette on the old value.
 */
export function useInstallOs(): InstallOs {
  return useSyncExternalStore(subscribeInstallOs, getInstallOs, getInstallOs);
}
