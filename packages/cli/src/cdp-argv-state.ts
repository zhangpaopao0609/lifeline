import type { CliConfig } from './config.js';
import { describePortOccupant, probeCdpEndpoint } from '../../agent/src/cdp/probe.js';
import { canControlIde } from '../../agent/src/live-ides.js';
import {
  cursorArgvPath,
  ensureCodeBuddyCdpArgv,
  ensureCursorCdpArgv,
  isVscodeArgvPath,
  removeCodeBuddyCdpArgv,
  removeCursorCdpArgv,
} from './cdp-argv-file.js';
import { cdpQuitAndReopenHint } from './cdp-status.js';
import { loadCliConfig, saveCliConfig } from './config.js';
import { log } from './ui.js';

/** Returns the hint when the IDE debugging port is not answering yet. */
export async function cdpNotReachable(cdpUrl: string): Promise<string | undefined> {
  const probed = await probeCdpEndpoint(cdpUrl, 'cursor', { lookupOccupant: describePortOccupant });
  return cdpQuitAndReopenHint(probed.kind);
}

export type CdpArgvState = 'already' | 'wrote' | 'skipped';

export function applyCursorCdpArgv(config: CliConfig): { config: CliConfig; state: CdpArgvState } {
  if (ensureCursorCdpArgv() === 'already') {
    return { config: { ...config, managedCdpArgv: config.managedCdpArgv ?? false }, state: 'already' };
  }
  return { config: { ...config, managedCdpArgv: true }, state: 'wrote' };
}

export function applyCodeBuddyCdpArgv(config: CliConfig): {
  config: CliConfig;
  state: CdpArgvState;
  /** Every argv.json managed right now (one per installed host). */
  paths: string[];
  /** The subset actually written this run. */
  written: string[];
} {
  const { state, paths, written } = ensureCodeBuddyCdpArgv();
  if (state === 'skipped')
    return { config, state: 'skipped', paths, written };
  if (state === 'already') {
    return {
      config: { ...config, managedCodebuddyCdpArgv: config.managedCodebuddyCdpArgv ?? false },
      state: 'already',
      paths,
      written,
    };
  }
  return { config: { ...config, managedCodebuddyCdpArgv: true }, state: 'wrote', paths, written };
}

/**
 * Report line + the one thing the user may have to do about it.
 *
 * ⚠️ **Do not blanket-say "quit and reopen is pointless"**: measured, Cursor
 * 3.20.21 and the CodeBuddy IDE do not read argv.json's `remote-debugging-port`
 * (in out/main.js that key only appears in `app.commandLine.getSwitchValue(...)`,
 * with no inject branch). **VSCode does** — the CodeBuddy plugin host applies it
 * through `app.commandLine.appendSwitch` — so telling a VSCode user that a manual
 * reopen does nothing is backwards (and on Windows it is the only step that works,
 * see `docs/ide-drivers.md`). The written path decides which sentence is true.
 */
export function cdpSummary(
  cursor: CdpArgvState,
  codebuddy: CdpArgvState,
  opts: { codebuddyPaths?: readonly string[] } = {},
): { value: string; notes: string[] } {
  const configured = [
    cursor === 'skipped' ? '' : 'Cursor',
    codebuddy === 'skipped' ? '' : 'CodeBuddy',
  ].filter(Boolean);
  const notes: string[] = [];
  if (!canControlIde()) {
    notes.push('This machine only reads session data (Linux); the debug port is not used here.');
  }
  else {
    // A dual-install machine now has one file per host; the sentence differs per
    // host, so decide per file instead of per product name.
    const paths = opts.codebuddyPaths ?? [];
    const vscodePaths = paths.filter(isVscodeArgvPath);
    const idePaths = paths.filter(path => !isVscodeArgvPath(path));
    const ignores = [
      cursor === 'wrote' ? 'Cursor' : '',
      codebuddy === 'wrote' && idePaths.length > 0 ? 'CodeBuddy' : '',
    ].filter(Boolean);
    if (ignores.length > 0)
      notes.push(`Do NOT restart ${ignores.join(' / ')} by hand: this build ignores argv.json, so lifeline restarts the IDE itself when the debug port is missing.`);
    if (codebuddy === 'wrote' && vscodePaths.length > 0)
      notes.push(`The CodeBuddy plugin runs in VS Code, which does read ${vscodePaths.join(', ')}: quitting it fully and reopening also applies the port. lifeline restarts it when the port is missing.`);
  }
  return {
    value: configured.join(' · ') || 'no Cursor / CodeBuddy install found',
    notes,
  };
}

/** Verbose wording, for `daemon install` and the interactive setup. */
export function cdpArgvLines(name: string, state: CdpArgvState, paths: readonly string[], port: number): string[] {
  if (state === 'skipped')
    return [`${name} not installed; skipped the remote-debugging-port=${port} argv.`];
  if (paths.length === 0)
    return [];
  if (state === 'already')
    return paths.map(path => `${name} already keeps remote-debugging-port=${port} on (${path}).`);
  // One "Wrote" + one note per file: on a dual-install machine the two hosts
  // behave differently (VSCode applies the key, the standalone IDE does not).
  return paths.flatMap(path => [
    `Wrote ${path} (remote-debugging-port=${port}).`,
    // Deliberately no "restart it and it takes effect" for Cursor / the CodeBuddy
    // IDE: that key is a no-op in practice (see `cdpSummary`); we write it so
    // uninstall can strip it cleanly. VSCode is the exception and says so.
    isVscodeArgvPath(path)
      ? `Note: VSCode reads this key at startup (verified); lifeline also passes the debug flag when it launches the IDE.`
      : `Note: ${name} ignores this key (verified); lifeline passes the debug flag when it launches the IDE.`,
  ]);
}

export function revertCursorCdpArgvIfManaged(): void {
  const config = loadCliConfig();
  if (!config?.managedCdpArgv)
    return;
  if (removeCursorCdpArgv()) {
    log(`Removed remote-debugging-port from ${cursorArgvPath()}`);
  }
  saveCliConfig({ ...config, managedCdpArgv: false });
}

export function revertCodeBuddyCdpArgvIfManaged(): void {
  const config = loadCliConfig();
  if (!config?.managedCodebuddyCdpArgv)
    return;
  if (removeCodeBuddyCdpArgv()) {
    log(`Removed remote-debugging-port from CodeBuddy argv.json`);
  }
  saveCliConfig({ ...config, managedCodebuddyCdpArgv: false });
}
