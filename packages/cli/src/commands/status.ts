import { codeBuddyActivePortCandidates, cursorActivePortCandidates } from '../../../agent/src/cdp/endpoint.js';
import { describePortOccupant, probeCdpEndpoint } from '../../../agent/src/cdp/probe.js';
import { canControlIde } from '../../../agent/src/live-ides.js';
import { BUILD_VERSION as VERSION } from '../build-version.js';
import { formatCdpStatusLine, formatContentSourceLine, probeStatusCdp } from '../cdp-status.js';
import { cliConfigPath } from '../config.js';
import { log, requireConfig } from '../ui.js';
import { fetchLatestVersion, updateHint } from '../version.js';

export async function cmdStatus(): Promise<void> {
  const config = requireConfig();

  // Fire the release check first so it overlaps the local probes below; a
  // missing manifest resolves to null and prints nothing.
  const latestVersion = fetchLatestVersion(config.serverUrl);

  log(`cli      v${VERSION}`);
  log(`config   ${cliConfigPath()}`);
  log(`server   ${config.serverUrl}`);

  const control = canControlIde();
  const codebuddyCdpUrl = process.env.CODEBUDDY_CDP_URL ?? 'http://127.0.0.1:9223';

  async function logCdpStatus(ide: 'cursor' | 'codebuddy', cdpUrl: string): Promise<void> {
    const label = ide === 'cursor' ? 'cursor   ' : 'codebuddy ';
    // Skip the probe only when "this machine does not control the IDE" (Linux = content source).
    // Do **not** skip based on "is it in the app inventory": that would label machines with a non-standard
    // install path as "no GUI", while the agent still probes — CLI and the web page would contradict each other (review Q8).
    if (!control) {
      log(`${label}${formatContentSourceLine()}`);
      return;
    }
    const { probed, source } = await probeStatusCdp({
      ide,
      configuredUrl: cdpUrl,
      probe: probeCdpEndpoint,
      candidates: ide === 'cursor' ? cursorActivePortCandidates() : codeBuddyActivePortCandidates(),
      lookupOccupant: describePortOccupant,
    });
    log(`${label}${formatCdpStatusLine(probed, source)}`);
  }

  await logCdpStatus('cursor', config.cdpUrl);
  await logCdpStatus('codebuddy', codebuddyCdpUrl);

  try {
    const res = await fetch(`${config.serverUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      log(`remote   NOT reachable — HTTP ${res.status}`);
    }
    else {
      log(`remote   ok`);
    }
  }
  catch (err) {
    log(`remote   NOT reachable — ${err instanceof Error ? err.message : String(err)}`);
  }

  const hint = updateHint(await latestVersion, VERSION);
  if (hint)
    log(`update   ${hint}`);
}
