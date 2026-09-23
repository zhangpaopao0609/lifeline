import type { DaemonOutcome } from '../ui.js';
import { canControlIde } from '../../../agent/src/live-ides.js';
import { cursorArgvPath, resolveCodeBuddyArgvPath } from '../cdp-argv-file.js';
import {
  applyCodeBuddyCdpArgv,
  applyCursorCdpArgv,
  cdpArgvLines,
  cdpNotReachable,
  cdpSummary,
} from '../cdp-argv-state.js';
import { cliConfigPath, loadCliConfig, resolveAgentId, saveCliConfig } from '../config.js';
import { startCallbackServer } from '../setup-callback.js';
import {
  createAsker,

  detail,
  hyperlink,
  log,
  openBrowser,
  resolveCliEntry,
  row,
  shortPath,
} from '../ui.js';
import { PUBLIC_PREFIX } from '../version.js';
import { cmdDaemon } from './daemon.js';

/**
 * Remote IDE sandboxes (Cloud Studio / Codespaces / code-server) forward ports
 * by scanning terminal output for a dev-server URL. Only there is it worth
 * printing the callback port: on a desktop it is noise — the login link is the
 * only thing the user needs. LIFELINE_PORT_HINT=1 forces it for unlisted
 * sandboxes.
 */
function inRemoteIde(): boolean {
  const env = process.env;
  return Boolean(
    env.LIFELINE_PORT_HINT
    || env.CLOUD_STUDIO
    || env.CLOUDSTUDIO_AGENT
    || env.CODESTUDIO_HOME
    || env.CODESPACES
    || env.CODE_SERVER
    || env.GITPOD_WORKSPACE_ID
    || env.VSCODE_PROXY_URI,
  );
}

function startAgentAfterSetup(): DaemonOutcome {
  if (!resolveCliEntry()) {
    return { ok: true, summary: 'not started', notes: ['start it yourself with: lifeline start'] };
  }
  // quiet install always reports an outcome; the fallback is only for type safety.
  return cmdDaemon('install', { quiet: true }) ?? { ok: false, summary: 'not started', notes: [] };
}

async function cmdSetupBrowser(serverUrl: string): Promise<void> {
  const base = serverUrl.replace(/\/+$/, '');
  const { port, wait } = await startCallbackServer();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const setupUrl = `${base}/cli-setup?redirect_uri=${encodeURIComponent(redirectUri)}`;

  log('');
  log('Lifeline setup');
  log('');
  row('sign-in', 'opening the login page in your browser');
  detail('If nothing opened, open this link instead:');
  detail(hyperlink(setupUrl));
  if (inRemoteIde()) {
    // The port is URL-encoded inside setupUrl's redirect_uri, so the scanners
    // cannot see it there; print the form they do match.
    detail(`Local: http://localhost:${port}/`);
  }
  if (process.platform === 'linux') {
    detail(`Browser on another machine? Forward the port first: ssh -L ${port}:127.0.0.1:${port} <this-host>`);
  }
  openBrowser(setupUrl);
  detail('Waiting for the login callback — up to 3 minutes.');

  const code = await Promise.race([
    wait,
    new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error('timeout')), 180_000);
    }),
  ]).catch(() => {
    console.error('Login timed out after 3 minutes. Re-run: lifeline setup --server-url <url>');
    process.exit(1);
  });
  if (!code) {
    console.error('Browser login did not return a setup code.');
    process.exit(1);
  }

  const existing = loadCliConfig();
  const agentId = resolveAgentId(existing?.agentId);
  const token = await exchangeSetupCode(base, code, agentId);
  await finishSetup(base, token, agentId);
}

/** Trades a one-shot setup code for the server's agent token. */
async function exchangeSetupCode(base: string, code: string, agentId: string): Promise<string> {
  let data: { agentToken?: string; error?: string };
  try {
    const res = await fetch(`${base}${PUBLIC_PREFIX}/cli-setup/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, agentId }),
    });
    data = (await res.json()) as { agentToken?: string; error?: string };
  }
  catch (err) {
    console.error(`Failed to reach ${base}: ${err instanceof Error ? err.message : String(err)}`);
    return process.exit(1);
  }
  if (!data.agentToken) {
    console.error(data.error || 'Failed to exchange setup code (codes expire after 120s)');
    return process.exit(1);
  }
  return data.agentToken;
}

/** Shared tail of both sign-in paths: persist the config, then start the agent. */
async function finishSetup(base: string, agentToken: string, agentId: string): Promise<void> {
  const existing = loadCliConfig();
  const cdpUrl = existing?.cdpUrl || 'http://127.0.0.1:9222';
  const cursor = applyCursorCdpArgv({
    serverUrl: base,
    agentToken,
    cdpUrl,
    pollIntervalMs: existing?.pollIntervalMs ?? 500,
    debounceMs: existing?.debounceMs ?? 300,
    agentId,
    selectorsPath: existing?.selectorsPath,
    managedCdpArgv: existing?.managedCdpArgv,
    managedCodebuddyCdpArgv: existing?.managedCodebuddyCdpArgv,
    includeProcess: existing?.includeProcess,
  });
  const codebuddy = applyCodeBuddyCdpArgv(cursor.config);
  saveCliConfig(codebuddy.config);

  const cdp = cdpSummary(cursor.state, codebuddy.state);

  log('');
  row('config', shortPath(cliConfigPath()));
  row('cdp', cdp.value);
  for (const note of cdp.notes) detail(note);
  // On Linux we don't control the IDE (and don't probe CDP), so don't print "lifeline will restart it itself" — that never happens.
  const cdpNote = canControlIde() ? await cdpNotReachable(cdpUrl) : undefined;
  if (cdpNote)
    detail(cdpNote);

  // Printed before the daemon line so the report follows the actual order of work.
  const daemon = startAgentAfterSetup();
  row('daemon', daemon.summary);
  for (const note of daemon.notes) detail(note);
  log('');

  if (!daemon.ok) {
    console.error('Setup is not complete: the agent is not running (see the daemon notes above).');
    process.exit(1);
  }
  log('Setup complete — you can close this terminal.');
  process.exit(0);
}

/**
 * Headless path: sign in from any machine that can reach the server (open the
 * `/cli-setup` link there and copy the `code` out of the redirect URL) instead
 * of waiting for the browser to call back into a port on this machine.
 */
async function cmdSetupWithCode(serverUrl: string, code: string): Promise<void> {
  const base = serverUrl.replace(/\/+$/, '');
  const existing = loadCliConfig();
  const agentId = resolveAgentId(existing?.agentId);
  const token = await exchangeSetupCode(base, code, agentId);
  await finishSetup(base, token, agentId);
}

export async function cmdSetup(serverUrlFlag?: string, codeFlag?: string): Promise<void> {
  if (serverUrlFlag && codeFlag) {
    await cmdSetupWithCode(serverUrlFlag, codeFlag);
    return;
  }
  if (serverUrlFlag) {
    await cmdSetupBrowser(serverUrlFlag);
    return;
  }

  log('');
  log(`Lifeline setup (interactive, config: ${shortPath(cliConfigPath())})`);
  log('');

  const existing = loadCliConfig();
  const asker = createAsker();

  try {
    const serverUrl = (await asker.ask(`Remote server URL${existing ? ` [${existing.serverUrl}]` : ''}: `))
      || existing?.serverUrl
      || '';
    if (!serverUrl) {
      console.error('Server URL is required.');
      process.exit(1);
    }

    const agentToken = (await asker.ask(`Agent token${existing ? ' [saved]' : ''}: `))
      || existing?.agentToken
      || '';
    if (!agentToken) {
      console.error(
        'Agent token is required. Remote servers hand one out per person: `lifeline setup --server-url <url>`.',
      );
      process.exit(1);
    }

    const cdpUrl = (await asker.ask(`Cursor CDP URL [${existing?.cdpUrl ?? 'http://127.0.0.1:9222'}]: `))
      || existing?.cdpUrl
      || 'http://127.0.0.1:9222';

    const cursor = applyCursorCdpArgv({
      serverUrl: serverUrl.replace(/\/+$/, ''),
      agentToken,
      cdpUrl,
      pollIntervalMs: existing?.pollIntervalMs ?? 500,
      debounceMs: existing?.debounceMs ?? 300,
      agentId: resolveAgentId(existing?.agentId),
      managedCdpArgv: existing?.managedCdpArgv,
      managedCodebuddyCdpArgv: existing?.managedCodebuddyCdpArgv,
      includeProcess: existing?.includeProcess,
    });
    const codebuddy = applyCodeBuddyCdpArgv(cursor.config);
    saveCliConfig(codebuddy.config);

    log('');
    row('config', shortPath(cliConfigPath()));
    for (const line of cdpArgvLines('Cursor', cursor.state, cursorArgvPath(), 0)) detail(line);
    for (const line of cdpArgvLines('CodeBuddy', codebuddy.state, resolveCodeBuddyArgvPath() ?? '', 0)) {
      detail(line);
    }
    log('');
    row('next', 'lifeline status          check Cursor + server');
    detail('lifeline daemon install   run it in the background');
  }
  finally {
    asker.close();
  }
}
