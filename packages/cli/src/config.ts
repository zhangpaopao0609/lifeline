import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';

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
  /** Absolute path of the Cursor ACP binary. Relative paths are not accepted. */
  cursorCliPath?: string;
  /** Absolute path of the CodeBuddy ACP binary. Relative paths are not accepted. */
  codebuddyCliPath?: string;
  /** Absolute path of the Codex CLI (`codex app-server`). */
  codexCliPath?: string;
  /** CodeBuddy headless credential. Never log, wire, or put this in an error string. */
  codebuddyApiKey?: string;
  /** Value written to `CODEBUDDY_INTERNET_ENVIRONMENT` for the ACP child. */
  codebuddyInternetEnvironment?: string;
}

const KNOWN_CONFIG_KEYS = new Set([
  'serverUrl',
  'agentToken',
  'cdpUrl',
  'pollIntervalMs',
  'debounceMs',
  'agentId',
  'selectorsPath',
  'managedCdpArgv',
  'managedCodebuddyCdpArgv',
  'includeProcess',
  'cursorCliPath',
  'codebuddyCliPath',
  'codexCliPath',
  'codebuddyApiKey',
  'codebuddyInternetEnvironment',
]);

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
  return readCliConfigFile(CONFIG_PATH);
}

/** Load one config file. Unknown JSON fields are copied through. */
export function readCliConfigFile(filePath: string): CliConfig | null {
  try {
    if (!existsSync(filePath))
      return null;
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!isRecord(parsed))
      return null;
    return normalizeCliConfig(parsed);
  }
  catch {
    return null;
  }
}

export function saveCliConfig(config: CliConfig): void {
  writeCliConfigFile(config, CONFIG_PATH);
}

/**
 * Atomic replace. The final file mode is `0600`.
 * A relative provider path is refused and the previous file is left in place.
 * The thrown message does not include credentials or the path value.
 */
export function writeCliConfigFile(config: CliConfig, filePath: string): void {
  assertAbsoluteProviderPaths(config);
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, filePath);
  chmodSync(filePath, 0o600);
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

export type CliProviderSource = 'cursor-cli' | 'codebuddy-cli' | 'codex-cli';

const CLI_BINARY_NAMES: Record<CliProviderSource, string> = {
  'cursor-cli': 'cursor-agent',
  'codebuddy-cli': 'codebuddy',
  'codex-cli': 'codex',
};

export interface PersistedCliProviderInput {
  config: CliConfig;
  existing?: CliConfig | null;
  lookup?: (source: CliProviderSource) => string | undefined;
  codebuddyApiKey?: string;
  codebuddyInternetEnvironment?: string;
}

/**
 * Setup rebuilds a config object and would otherwise drop provider fields.
 * Keep an existing absolute path, fill a missing one only from an absolute lookup,
 * and copy the CodeBuddy key and environment from the argument or the previous file.
 */
/** Non-empty setup env values become helper arguments. Empty strings are omitted. */
export function codebuddyProviderEnv(env: NodeJS.ProcessEnv): Pick<PersistedCliProviderInput, 'codebuddyApiKey' | 'codebuddyInternetEnvironment'> {
  const out: Pick<PersistedCliProviderInput, 'codebuddyApiKey' | 'codebuddyInternetEnvironment'> = {};
  const key = env.CODEBUDDY_API_KEY;
  if (typeof key === 'string' && key.length > 0)
    out.codebuddyApiKey = key;
  const environment = env.CODEBUDDY_INTERNET_ENVIRONMENT;
  if (typeof environment === 'string' && environment.length > 0)
    out.codebuddyInternetEnvironment = environment;
  return out;
}

export function withPersistedCliProviders(input: PersistedCliProviderInput): CliConfig {
  const next: CliConfig = { ...input.config };
  const cursorCliPath = chooseProviderPath(input.existing?.cursorCliPath, input.config.cursorCliPath, input.lookup?.('cursor-cli'));
  const codebuddyCliPath = chooseProviderPath(input.existing?.codebuddyCliPath, input.config.codebuddyCliPath, input.lookup?.('codebuddy-cli'));
  const codexCliPath = chooseProviderPath(input.existing?.codexCliPath, input.config.codexCliPath, input.lookup?.('codex-cli'));
  if (cursorCliPath)
    next.cursorCliPath = cursorCliPath;
  else
    delete next.cursorCliPath;
  if (codebuddyCliPath)
    next.codebuddyCliPath = codebuddyCliPath;
  else
    delete next.codebuddyCliPath;
  if (codexCliPath)
    next.codexCliPath = codexCliPath;
  else
    delete next.codexCliPath;
  const key = input.codebuddyApiKey ?? input.existing?.codebuddyApiKey;
  if (typeof key === 'string' && key.length > 0)
    next.codebuddyApiKey = key;
  else
    delete next.codebuddyApiKey;
  const environment = input.codebuddyInternetEnvironment ?? input.existing?.codebuddyInternetEnvironment;
  if (typeof environment === 'string' && environment.length > 0)
    next.codebuddyInternetEnvironment = environment;
  else
    delete next.codebuddyInternetEnvironment;
  return next;
}

/** PATH search only. Does not execute the provider binary. */
export function lookupCliProvider(source: CliProviderSource, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathValue = env.PATH;
  if (typeof pathValue !== 'string' || pathValue.length === 0)
    return undefined;
  const base = CLI_BINARY_NAMES[source];
  const names = process.platform === 'win32' ? [base, `${base}.exe`, `${base}.cmd`] : [base];
  for (const dir of pathValue.split(delimiter)) {
    if (!isAbsolute(dir))
      continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isAbsolute(candidate) && existsSync(candidate))
        return candidate;
    }
  }
  return undefined;
}

function chooseProviderPath(existing: string | undefined, current: string | undefined, lookedUp: string | undefined): string | undefined {
  return acceptedCliPath(existing) ?? acceptedCliPath(current) ?? acceptedCliPath(lookedUp);
}

export function acceptedCliPath(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value))
    return undefined;
  return value;
}

function assertAbsoluteProviderPaths(config: CliConfig): void {
  for (const value of [config.cursorCliPath, config.codebuddyCliPath, config.codexCliPath]) {
    if (value == null || value === '')
      continue;
    if (typeof value !== 'string' || !isAbsolute(value))
      throw new Error('CLI provider path must be an absolute path');
  }
}

function normalizeCliConfig(raw: Record<string, unknown>): CliConfig | null {
  if (typeof raw.serverUrl !== 'string' || raw.serverUrl.length === 0)
    return null;
  if (typeof raw.agentToken !== 'string' || raw.agentToken.length === 0)
    return null;
  const config: CliConfig = {
    serverUrl: raw.serverUrl,
    agentToken: raw.agentToken,
    cdpUrl: typeof raw.cdpUrl === 'string' && raw.cdpUrl.length > 0 ? raw.cdpUrl : 'http://127.0.0.1:9222',
    pollIntervalMs: positiveNumber(raw.pollIntervalMs, 500),
    debounceMs: positiveNumber(raw.debounceMs, 300),
    includeProcess: includeProcessEnabled(raw),
  };
  if (typeof raw.agentId === 'string')
    config.agentId = raw.agentId;
  if (typeof raw.selectorsPath === 'string')
    config.selectorsPath = raw.selectorsPath;
  if (typeof raw.managedCdpArgv === 'boolean')
    config.managedCdpArgv = raw.managedCdpArgv;
  if (typeof raw.managedCodebuddyCdpArgv === 'boolean')
    config.managedCodebuddyCdpArgv = raw.managedCodebuddyCdpArgv;
  const cursorCliPath = acceptedCliPath(typeof raw.cursorCliPath === 'string' ? raw.cursorCliPath : undefined);
  if (cursorCliPath)
    config.cursorCliPath = cursorCliPath;
  const codebuddyCliPath = acceptedCliPath(typeof raw.codebuddyCliPath === 'string' ? raw.codebuddyCliPath : undefined);
  if (codebuddyCliPath)
    config.codebuddyCliPath = codebuddyCliPath;
  const codexCliPath = acceptedCliPath(typeof raw.codexCliPath === 'string' ? raw.codexCliPath : undefined);
  if (codexCliPath)
    config.codexCliPath = codexCliPath;
  if (typeof raw.codebuddyApiKey === 'string' && raw.codebuddyApiKey.length > 0)
    config.codebuddyApiKey = raw.codebuddyApiKey;
  if (typeof raw.codebuddyInternetEnvironment === 'string' && raw.codebuddyInternetEnvironment.length > 0)
    config.codebuddyInternetEnvironment = raw.codebuddyInternetEnvironment;
  const stored = config as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_CONFIG_KEYS.has(key))
      stored[key] = value;
  }
  return config;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
