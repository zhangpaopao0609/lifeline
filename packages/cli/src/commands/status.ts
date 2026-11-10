import type { IdeKind } from '../../../agent/src/sources/types.js';
import { codeBuddyActivePortCandidates, cursorActivePortCandidates, vscodeActivePortCandidates } from '../../../agent/src/cdp/endpoint.js';
import { describePortOccupant, probeCdpEndpoint } from '../../../agent/src/cdp/probe.js';
import { canControlIde } from '../../../agent/src/live-ides.js';
import { agentLockPath, readAgentLock } from '../../../agent/src/single-instance.js';
import { BUILD_VERSION as VERSION } from '../build-version.js';
import { formatCdpStatusLine, formatContentSourceLine, probeStatusCdp } from '../cdp-status.js';
import { cliConfigPath } from '../config.js';
import { pidAlive, processCommandLine, scanAgentPids } from '../daemon/agent-processes.js';
import { agentStatusLines } from '../daemon/agent-status-lines.js';
import { log, requireConfig } from '../ui.js';
import { fetchLatestVersion, updateHint } from '../version.js';
import { daemonProbe, logDaemonStatus } from './daemon.js';

export async function cmdStatus(): Promise<void> {
  const config = requireConfig();

  // Fire the release check first so it overlaps the local probes below; a
  // missing manifest resolves to null and prints nothing.
  const latestVersion = fetchLatestVersion(config.serverUrl);

  log(`cli      v${VERSION}`);
  log(`config   ${cliConfigPath()}`);
  log(`server   ${config.serverUrl}`);

  const control = canControlIde();
  // The agent's defaults (packages/agent/src/config.ts); the CLI has no persisted fields
  // for these two hosts, so read the same env names the agent reads.
  const codebuddyCdpUrl = process.env.CODEBUDDY_CDP_URL ?? 'http://127.0.0.1:9223';
  const vscodeCdpUrl = process.env.VSCODE_CDP_URL ?? 'http://127.0.0.1:9225';

  async function logCdpStatus(ide: IdeKind, cdpUrl: string): Promise<void> {
    // Slot = host, so every host gets its own line: the VSCode slot used to be invisible
    // here while the CodeBuddy line (which no longer claims VSCode's port file) could
    // never go green for a plugin-only user.
    const label = ide === 'cursor' ? 'cursor   ' : ide === 'codebuddy' ? 'codebuddy ' : 'vscode   ';
    const candidates = ide === 'cursor'
      ? cursorActivePortCandidates()
      : ide === 'codebuddy' ? codeBuddyActivePortCandidates() : vscodeActivePortCandidates();
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
      candidates,
      lookupOccupant: describePortOccupant,
    });
    log(`${label}${formatCdpStatusLine(probed, source)}`);
  }

  await logCdpStatus('cursor', config.cdpUrl);
  await logCdpStatus('codebuddy', codebuddyCdpUrl);
  await logCdpStatus('vscode', vscodeCdpUrl);

  const daemon = daemonProbe();
  logDaemonStatus(daemon);

  // Who owns this machine locally. Reads the lock file and the process list only: this diagnosis has
  // to work when the server — or the network — is the thing that is broken, so no request is added.
  // The pid probes are lazy: `processCommandLine` spawns `ps` (or a CIM query on Windows), so it runs
  // only for a lock that is present and whose pid is alive.
  const lockPath = agentLockPath();
  const lock = readAgentLock(lockPath);
  const holderPid = lock.kind === 'ok' ? lock.lock.pid : null;
  const holderAlive = holderPid != null && pidAlive(holderPid);
  for (const line of agentStatusLines({
    lock,
    probe: {
      alive: holderAlive,
      commandLine: holderAlive && holderPid != null ? processCommandLine(holderPid) : null,
    },
    instances: scanAgentPids(),
    daemonRunning: daemon.running,
    lockPath,
  })) {
    log(line);
  }

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
