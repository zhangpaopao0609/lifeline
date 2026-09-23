import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CliConfig {
  serverUrl: string;
  agentToken: string;
  cdpUrl: string;
  pollIntervalMs: number;
  debounceMs: number;
  agentId?: string;
  /** Optional explicit selectors.json; defaults to the one shipped with the package. */
  selectorsPath?: string;
  /** We added remote-debugging-port to ~/.cursor/argv.json; uninstall should remove it. */
  managedCdpArgv?: boolean;
  /** We added remote-debugging-port to CodeBuddy argv.json; uninstall should remove it. */
  managedCodebuddyCdpArgv?: boolean;
  /** When true, project tool + thought. Missing/false = lean I/O timeline. */
  includeProcess?: boolean;
}

export function includeProcessEnabled(
  raw: { includeProcess?: unknown } | null | undefined,
): boolean {
  return raw?.includeProcess === true;
}

export const CONFIG_DIR = join(homedir(), '.lifeline');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
export const LOG_DIR = join(CONFIG_DIR, 'logs');

export function cliConfigPath(): string {
  return CONFIG_PATH;
}

export function loadCliConfig(): CliConfig | null {
  try {
    if (!existsSync(CONFIG_PATH))
      return null;
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Partial<CliConfig>;
    if (!raw.serverUrl || !raw.agentToken)
      return null;
    return {
      serverUrl: raw.serverUrl,
      agentToken: raw.agentToken,
      cdpUrl: raw.cdpUrl || 'http://127.0.0.1:9222',
      pollIntervalMs: raw.pollIntervalMs || 500,
      debounceMs: raw.debounceMs || 300,
      agentId: raw.agentId,
      selectorsPath: raw.selectorsPath,
      managedCdpArgv: raw.managedCdpArgv,
      managedCodebuddyCdpArgv: raw.managedCodebuddyCdpArgv,
      includeProcess: includeProcessEnabled(raw),
    };
  }
  catch {
    return null;
  }
}

export function saveCliConfig(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

/**
 * Machine identity: `machine-<uuid>`. **Do not fall back to hostname-derived** (`agent-${hostname()}`) —
 * same-named hosts resolve to the same agentId, two machines fight over one server slot: whoever registers last takes ownership,
 * and snapshots / session mirrors get mixed (fixed 2026-09-17). Generate once at setup / start, write into config,
 * and it stays with this machine; the server re-signs an old id that is "same owner + same hostname + offline".
 */
export function newAgentId(): string {
  return `machine-${randomUUID()}`;
}

/**
 * Machine identity: use the env var (`AGENT_ID`) if config has none, generate only after that.
 * **`||` not `??`**: an empty string must count as "absent" — `AGENT_ID=""` makes the server fall back to the socket id as the machine id,
 * and every reconnect adds a ghost machine.
 */
export function resolveAgentId(
  existing?: string,
  fromEnv: string | undefined = process.env.AGENT_ID,
): string {
  return existing || fromEnv || newAgentId();
}

/** Shared by setup / start: if config has no agentId, mint one and persist it; it stays with this machine. */
export function ensureAgentId(
  config: CliConfig,
  save: (config: CliConfig) => void = saveCliConfig,
): CliConfig {
  if (config.agentId)
    return config;
  const next = { ...config, agentId: resolveAgentId() };
  save(next);
  return next;
}
