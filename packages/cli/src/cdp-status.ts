import type { probeCdpEndpoint, ProbeResult } from '../../agent/src/cdp/probe.js';
import type { CdpEndpointSource, IdeKind } from '../../protocol/src/index.js';
import { resolveEndpoint } from '../../agent/src/cdp/endpoint.js';

function workbenchCount(detail: string): number {
  const m = /^(\d+)\s+workbench\b/.exec(detail);
  return m ? Number(m[1]) : 1;
}

function viaSuffix(port: number, source: CdpEndpointSource): string {
  return `via :${port} (${source})`;
}

/** Value column for `lifeline status` (label is printed separately). */
export function formatCdpStatusLine(probe: ProbeResult, source: CdpEndpointSource): string {
  const tail = viaSuffix(probe.port, source);
  switch (probe.kind) {
    case 'ok': {
      const n = workbenchCount(probe.detail);
      return `ok — ${n} workbench window(s) via :${probe.port} (${source})`;
    }
    case 'no-window':
      return `waiting — no window open ${tail}`;
    case 'not-cdp': {
      const who = probe.occupant ? `occupied by ${probe.occupant}` : 'port in use';
      return `blocked — ${who} ${tail}`;
    }
    case 'no-listener':
      return `down — debug port not listening ${tail}`;
    case 'no-workbench':
      return `no-workbench — no attachable window ${tail}`;
    case 'attach-failed':
      return `handshake-failed — ${probe.detail} ${tail}`;
    case 'unknown':
      return `unknown — ${probe.detail || 'probe failed'} ${tail}`;
    default: {
      const _exhaustive: never = probe.kind;
      return `unknown — ${_exhaustive} ${tail}`;
    }
  }
}

/**
 * This machine is content-source only (current criterion is **platform**: Linux); do not probe CDP.
 *
 * Don't call it "no GUI": that was the old "not found in the app inventory" wording, which would label a non-standard install path as having no GUI,
 * and it contradicts the agent's behavior (it still probes).
 */
export function formatContentSourceLine(): string {
  return 'content source — Linux reads session data only';
}

const QUIT_AND_REOPEN_KINDS = new Set<ProbeResult['kind']>(['no-listener', 'not-cdp', 'unknown']);

/**
 * Tell the user **not to restart the IDE themselves**.
 *
 * Measured: Cursor 3.20.21 does not read `remote-debugging-port` from `~/.cursor/argv.json`
 * (that key only appears in out/main.js as `app.commandLine.getSwitchValue(...)`, with no inject branch),
 * so quitting and reopening by hand just puts it back in the "no debug port" state, and the agent restarts it again.
 */
const QUIT_AND_REOPEN_HINT
  = 'Debugging port is not answering yet; lifeline will restart the IDE itself shortly. '
    + 'Do NOT restart it by hand — this build ignores argv.json, so a manual restart does not help.';

/** Setup/daemon hint: reopen only when the port itself is dead, blocked, or unknown. */
export function cdpQuitAndReopenHint(kind: ProbeResult['kind']): string | undefined {
  if (!QUIT_AND_REOPEN_KINDS.has(kind))
    return undefined;
  return QUIT_AND_REOPEN_HINT;
}

/** Same candidate order as the agent, then a status probe on the resolved URL. */
export async function probeStatusCdp(opts: {
  ide: IdeKind;
  configuredUrl: string;
  probe: typeof probeCdpEndpoint;
  candidates: string[];
  lookupOccupant?: (port: number) => string | undefined;
  readFile?: (p: string) => string | undefined;
  mtime?: (p: string) => number | undefined;
}): Promise<{ probed: ProbeResult; source: CdpEndpointSource }> {
  const resolved = await resolveEndpoint({
    ide: opts.ide,
    configuredUrl: opts.configuredUrl,
    probe: opts.probe,
    candidates: opts.candidates,
    readFile: opts.readFile,
    mtime: opts.mtime,
  });
  const probed = await opts.probe(resolved.cdpUrl, opts.ide, {
    lookupOccupant: opts.lookupOccupant,
    // Same criterion as the agent side: include instance identity so status does not classify differently from the agent.
    expect: { browserUuid: resolved.browserUuid },
  });
  return { probed, source: resolved.source };
}
