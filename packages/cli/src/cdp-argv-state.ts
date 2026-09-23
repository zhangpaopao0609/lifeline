import type { CliConfig } from './config.js';
import { describePortOccupant, probeCdpEndpoint } from '../../agent/src/cdp/probe.js';
import { canControlIde } from '../../agent/src/live-ides.js';
import {
  cursorArgvPath,
  ensureCodeBuddyCdpArgv,
  ensureCursorCdpArgv,
  removeCodeBuddyCdpArgv,
  removeCursorCdpArgv,
  resolveCodeBuddyArgvPath,
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

export function applyCodeBuddyCdpArgv(config: CliConfig): { config: CliConfig; state: CdpArgvState } {
  const result = ensureCodeBuddyCdpArgv();
  if (result === 'skipped' || !resolveCodeBuddyArgvPath())
    return { config, state: 'skipped' };
  if (result === 'already') {
    return {
      config: { ...config, managedCodebuddyCdpArgv: config.managedCodebuddyCdpArgv ?? false },
      state: 'already',
    };
  }
  return { config: { ...config, managedCodebuddyCdpArgv: true }, state: 'wrote' };
}

/** Report line + the one thing the user may have to do about it. */
export function cdpSummary(cursor: CdpArgvState, codebuddy: CdpArgvState): { value: string; notes: string[] } {
  const configured = [
    cursor === 'skipped' ? '' : 'Cursor',
    codebuddy === 'skipped' ? '' : 'CodeBuddy',
  ].filter(Boolean);
  const restart = [
    cursor === 'wrote' ? 'Cursor' : '',
    codebuddy === 'wrote' ? 'CodeBuddy' : '',
  ].filter(Boolean);
  return {
    value: configured.join(' · ') || 'no Cursor / CodeBuddy install found',
    // ⚠️ **Do not tell the user to "quit and reopen"**: measured, Cursor 3.20.21 does not read argv.json's remote-debugging-port
    // (in out/main.js that key only appears in app.commandLine.getSwitchValue(...), with no inject branch),
    // so a manual reopen just puts it back in the "no debug port" state, then the agent restarts it again.
    notes: !canControlIde()
      ? ['This machine only reads session data (Linux); the debug port is not used here.']
      : restart.length
        ? [`Do NOT restart ${restart.join(' / ')} by hand: this build ignores argv.json, so lifeline restarts the IDE itself when the debug port is missing.`]
        : [],
  };
}

/** Verbose wording, for `daemon install` and the interactive setup. */
export function cdpArgvLines(name: string, state: CdpArgvState, path: string, port: number): string[] {
  if (state === 'skipped')
    return [`${name} not installed; skipped the remote-debugging-port=${port} argv.`];
  if (state === 'already')
    return [`${name} already keeps remote-debugging-port=${port} on (${path}).`];
  return [
    `Wrote ${path} (remote-debugging-port=${port}).`,
    // This line **deliberately no longer says "restart it and it takes effect"**: that key is a no-op in practice (see above); we write it so uninstall can strip it cleanly.
    `Note: ${name} ignores this key (verified); lifeline passes the debug flag when it launches the IDE.`,
  ];
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
