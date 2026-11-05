import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import process from 'node:process';
import { ensureCodexSharedServer, readCodexSessions } from '../../../agent/src/drivers/codex/shared.js';
import { acceptedCliPath, loadCliConfig, lookupCliProvider } from '../config.js';

/** Codex subcommands that do not open a session: run as-is, without the shared server. */
const PASSTHROUGH = new Set([
  'exec',
  'e',
  'review',
  'login',
  'logout',
  'mcp',
  'mcp-server',
  'app-server',
  'completion',
  'sandbox',
  'debug',
  'apply',
  'a',
  'cloud',
  'features',
  'help',
  '-h',
  '--help',
  '-V',
  '--version',
]);
/** Session subcommands that take `--remote` after the subcommand name. */
const SESSION_SUBCOMMANDS = new Set(['resume', 'fork']);

/** A Lifeline Codex session id (from the web's "copy to terminal") becomes its Codex thread id. */
export function resolveSessionAliases(args: readonly string[], sessions: Record<string, { threadId: string }>): string[] {
  return args.map(arg => sessions[arg]?.threadId ?? arg);
}

/**
 * Codex arguments that attach the interactive session to the shared app-server:
 * `codex --remote unix://… -C <cwd> …`, or `codex resume --remote unix://… …`.
 */
export function codexRemoteArgs(args: readonly string[], remote: string, cwd: string): string[] {
  const [first, ...rest] = args;
  if (first && PASSTHROUGH.has(first))
    return [...args];
  if (first && SESSION_SUBCOMMANDS.has(first))
    return [first, '--remote', remote, ...rest];
  const hasCd = args.some(a => a === '-C' || a === '--cd' || a.startsWith('--cd='));
  return ['--remote', remote, ...(hasCd ? [] : ['-C', cwd]), ...args];
}

/**
 * `lifeline codex [codex args…]`: Codex in this terminal, on the same app-server as the web console, so the
 * phone sees the session live (replies, commands, approvals) and `/attach` there can follow it.
 */
export async function cmdCodex(args: string[]): Promise<void> {
  // The prompt may contain words like "run": keep them off this process's command line, which the agent
  // process scan reads (`commandLineIsRunningAgent`).
  process.title = 'lifeline codex';
  const codex = acceptedCliPath(process.env.LIFELINE_CODEX_CLI)
    ?? acceptedCliPath(loadCliConfig()?.codexCliPath)
    ?? lookupCliProvider('codex-cli');
  if (!codex) {
    console.error('lifeline codex: Codex CLI not found. Install `codex`, or set "codexCliPath" in ~/.lifeline/config.json.');
    process.exit(1);
  }
  let argv = resolveSessionAliases(args, readCodexSessions());
  if (!(argv[0] && PASSTHROUGH.has(argv[0]))) {
    const sock = await ensureCodexSharedServer({ codex, log: msg => console.error(`lifeline codex: ${msg}`) });
    if (sock)
      argv = codexRemoteArgs(argv, `unix://${sock}`, process.cwd());
    else
      console.error('lifeline codex: shared Codex server unavailable; running Codex on its own (the web console will not see this session).');
  }
  const child = spawn(codex, argv, { stdio: 'inherit' });
  // Terminal signals reach the child directly (same process group); this process only waits for it.
  process.on('SIGINT', () => {});
  process.on('SIGQUIT', () => {});
  for (const sig of ['SIGTERM', 'SIGHUP'] as const)
    process.on(sig, () => child.kill(sig));
  child.on('error', (err) => {
    console.error(`lifeline codex: cannot run ${codex}: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1));
  });
}
