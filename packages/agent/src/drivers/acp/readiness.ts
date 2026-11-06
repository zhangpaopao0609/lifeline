import type { CliAvailability, CliCapabilities, CliSource, CommandErrorCode } from '@lifeline/protocol';
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { JsonlRpcError, JsonlRpcRemoteError } from './jsonl-rpc.js';
import { acpProfileFor } from './profiles.js';
import { createProviderClient } from './provider-client.js';

const DETAIL_MAX = 160;

/**
 * Agent-side ACP gate. This is `process.platform === 'darwin'` at the call site.
 * `LIFELINE_LINUX_CDP` does not make Linux able to spawn a CLI. The IDE control helper is a different gate.
 */
export function acpSpawnAllowed(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  void env.LIFELINE_LINUX_CDP;
  return platform === 'darwin';
}

export interface CheckedAtState {
  last?: number;
}

/** Later reports never move backward when the clock does. */
export function takeCheckedAt(state: CheckedAtState, now: number): number {
  const checkedAt = state.last == null ? now : Math.max(now, state.last);
  state.last = checkedAt;
  return checkedAt;
}

export interface ReadinessClient {
  start: () => Promise<void>;
  initialize: () => Promise<{ protocolVersion: number }>;
  sessionNew: (input: { cwd: string }) => Promise<{ sessionId: string }>;
  close: () => Promise<void>;
}

export interface ReadinessSignal {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  cwdAbsoluteDirectory: boolean;
  spawnCode: 'ENOENT' | 'EACCES' | 'OK';
  protocolVersion?: number;
  authStructured: boolean;
  hasKey: boolean;
  phase: 'probe' | 'start';
  ok: boolean;
  /** Ignored. `cursor/list_available_models` is not a v1 gate. */
  listedModels?: boolean;
}

export interface ReadinessVerdict {
  errorCode?: CommandErrorCode;
  availability: CliAvailability;
  detail?: string;
}

export interface ReadinessReport extends ReadinessVerdict {
  ok: boolean;
  hasKey: boolean;
  checkedAt: number;
}

export interface ChildEnvInput {
  source: CliSource;
  base: NodeJS.ProcessEnv;
  apiKey?: string;
  environment?: string;
}

export interface ReadinessInput {
  source: CliSource;
  command: string;
  args?: readonly string[];
  cwd: string;
  platform?: NodeJS.Platform;
  /** Gate env. `LIFELINE_LINUX_CDP` is ignored. */
  env?: NodeJS.ProcessEnv;
  baseEnv?: NodeJS.ProcessEnv;
  apiKey?: string;
  environment?: string;
  epoch?: string;
  now?: () => number;
  checkedAt?: CheckedAtState;
  emit?: (event: 'cli:capabilities', payload: CliCapabilities) => void;
  killGraceMs?: number;
  open?: () => ReadinessClient;
}

/**
 * Copy `base`, drop Lifeline secrets, keep PATH, HOME, and proxy variables, then overlay the provider.
 * `hasKey` is the final env, after `AGENT_TOKEN` / `REMOTE_URL` are gone.
 */
export function buildChildEnv(input: ChildEnvInput): { env: NodeJS.ProcessEnv; hasKey: boolean } {
  const base: NodeJS.ProcessEnv = { ...input.base };
  delete base.AGENT_TOKEN;
  delete base.REMOTE_URL;
  const env = acpProfileFor(input.source).childEnv({
    base,
    apiKey: input.apiKey,
    environment: input.environment,
  });
  delete env.AGENT_TOKEN;
  delete env.REMOTE_URL;
  const key = env.CODEBUDDY_API_KEY;
  return { env, hasKey: typeof key === 'string' && key.length > 0 };
}

/**
 * launchd's PATH is `/usr/bin:/bin`. A `#!/usr/bin/env node` shim still has to find
 * that interpreter. The command directory covers a shim that sits beside `node`.
 * A symlink elsewhere resolves to the real file, then walks up to the install's
 * `bin/<interpreter>`. A native binary has no env shebang and only contributes
 * its own directory.
 */
export function withCliBinOnPath(env: NodeJS.ProcessEnv, command: string): NodeJS.ProcessEnv {
  const dirs: string[] = [];
  const commandDir = dirname(command);
  if (isAbsolute(commandDir))
    dirs.push(commandDir);
  const resolved = resolvedCommand(command);
  const tool = envShebangTool(resolved);
  if (tool) {
    const interpreterDir = interpreterDirectory(resolved, tool);
    if (interpreterDir)
      dirs.unshift(interpreterDir);
  }
  return prependPath(env, dirs);
}

function resolvedCommand(command: string): string {
  try {
    return realpathSync(command);
  }
  catch {
    return command;
  }
}

/** Interpreter name from `#!/usr/bin/env [-S] name`. An absolute shebang needs no PATH entry. */
function envShebangTool(file: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  }
  catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(160);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, n).toString('utf8').split('\n', 1)[0] ?? '';
    return /^#!\s*\/usr\/bin\/env(?:\s+-S)?\s+([\w.+-]+)/.exec(line)?.[1];
  }
  finally {
    closeSync(fd);
  }
}

/** Nearest directory that contains `tool`, either beside this file or in an ancestor `bin`. */
function interpreterDirectory(file: string, tool: string): string | undefined {
  let dir = dirname(file);
  for (;;) {
    if (isFile(join(dir, tool)))
      return dir;
    if (isFile(join(dir, 'bin', tool)))
      return join(dir, 'bin');
    const parent = dirname(dir);
    if (parent === dir)
      return undefined;
    dir = parent;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  }
  catch {
    return false;
  }
}

function prependPath(env: NodeJS.ProcessEnv, dirs: readonly string[]): NodeJS.ProcessEnv {
  const current = env.PATH ?? '';
  const parts = current.split(':').filter(part => part.length > 0);
  const prefix: string[] = [];
  for (const dir of dirs) {
    if (!isAbsolute(dir) || prefix.includes(dir) || parts.includes(dir))
      continue;
    prefix.push(dir);
  }
  if (prefix.length === 0)
    return env;
  return { ...env, PATH: [...prefix, ...parts].join(':') };
}

/** Short-circuit: platform, cwd, spawn, ACP version, credential, then provider-error. */
export function classifyReadinessSignal(input: ReadinessSignal): ReadinessVerdict {
  void input.listedModels;
  if (!acpSpawnAllowed(input.platform, input.env))
    return failure('unsupported-platform');
  if (!input.cwdAbsoluteDirectory)
    return failure('invalid-cwd');
  if (input.spawnCode === 'ENOENT')
    return failure('binary-missing');
  if (input.spawnCode === 'EACCES')
    return failure('binary-not-executable');
  if (input.protocolVersion !== undefined && input.protocolVersion !== 1)
    return failure('unsupported-acp-version');
  if (input.authStructured && !input.hasKey)
    return failure('no-credential');
  if (input.authStructured && input.hasKey)
    return failure('auth-rejected');
  if (!input.ok)
    return failure('provider-error');
  return { availability: input.phase === 'probe' ? 'unknown' : 'ready' };
}

/**
 * Background probe: absolute spawn + `initialize`, then close.
 * No `session/new`. A successful initialize is `unknown`, not `ready`.
 */
export async function probeReadiness(input: ReadinessInput): Promise<ReadinessReport> {
  const facts = await collect(input, false);
  return publish(input, facts.verdict, facts.hasKey);
}

/**
 * Real start. One child, one `session/new`. The process stays up on success.
 * Emits `cli:capabilities` before the attempt and again after success or failure.
 */
export async function startProviderSession(input: ReadinessInput): Promise<ReadinessReport> {
  const platform = input.platform ?? process.platform;
  const gateEnv = input.env ?? input.baseEnv ?? {};
  const { hasKey } = childEnvFor(input);
  const cwdOk = directoryCwd(input.cwd);
  if (!acpSpawnAllowed(platform, gateEnv) || !cwdOk) {
    const verdict = classifyReadinessSignal({
      platform,
      env: gateEnv,
      cwdAbsoluteDirectory: cwdOk,
      spawnCode: 'OK',
      authStructured: false,
      hasKey,
      phase: 'start',
      ok: false,
    });
    return publish(input, verdict, hasKey);
  }
  publish(input, classifyReadinessSignal({
    platform,
    env: gateEnv,
    cwdAbsoluteDirectory: true,
    spawnCode: 'OK',
    protocolVersion: 1,
    authStructured: false,
    hasKey,
    phase: 'probe',
    ok: true,
  }), hasKey);
  const facts = await collect(input, true);
  return publish(input, facts.verdict, facts.hasKey);
}

function childEnvFor(input: ReadinessInput): { env: NodeJS.ProcessEnv; hasKey: boolean } {
  return buildChildEnv({
    source: input.source,
    base: input.baseEnv ?? {},
    apiKey: input.apiKey,
    environment: input.environment,
  });
}

async function collect(input: ReadinessInput, session: boolean): Promise<{ verdict: ReadinessVerdict; hasKey: boolean }> {
  const platform = input.platform ?? process.platform;
  const gateEnv = input.env ?? input.baseEnv ?? {};
  const built = childEnvFor(input);
  const cwdOk = directoryCwd(input.cwd);
  let spawnCode: ReadinessSignal['spawnCode'] = 'OK';
  let protocolVersion: number | undefined;
  let authStructured = false;
  let ok = false;
  if (acpSpawnAllowed(platform, gateEnv) && cwdOk) {
    const client = input.open ? input.open() : openDefault(input, withCliBinOnPath(built.env, input.command));
    let failed = true;
    try {
      await client.start();
      const initialized = await client.initialize();
      protocolVersion = initialized.protocolVersion;
      if (session) {
        if (protocolVersion !== 1)
          throw new JsonlRpcError('unsupported-acp-version', 'unsupported-acp-version');
        await client.sessionNew({ cwd: input.cwd });
      }
      ok = true;
      failed = protocolVersion !== 1;
    }
    catch (err) {
      spawnCode = readSpawnCode(err);
      authStructured = isStructuredAuth(err);
      ok = false;
      failed = true;
    }
    finally {
      if (!session || failed)
        await client.close().catch(() => {});
    }
  }
  const verdict = classifyReadinessSignal({
    platform,
    env: gateEnv,
    cwdAbsoluteDirectory: cwdOk,
    spawnCode,
    protocolVersion,
    authStructured,
    hasKey: built.hasKey,
    phase: session ? 'start' : 'probe',
    ok: ok && protocolVersion === 1,
  });
  if (verdict.errorCode) {
    verdict.detail = sanitizeCliDetail(verdict.errorCode, [
      input.apiKey ?? '',
      input.command,
      input.cwd,
    ]);
  }
  return { verdict, hasKey: built.hasKey };
}

function openDefault(input: ReadinessInput, env: NodeJS.ProcessEnv): ReadinessClient {
  const profile = acpProfileFor(input.source);
  return createProviderClient({
    profile,
    command: input.command,
    args: input.args ? [...input.args] : [...profile.args],
    cwd: input.cwd,
    env,
    apiKey: input.apiKey,
    environment: input.environment,
    killGraceMs: input.killGraceMs,
  });
}

function publish(input: ReadinessInput, verdict: ReadinessVerdict, hasKey: boolean): ReadinessReport {
  const state = input.checkedAt ?? {};
  const checkedAt = takeCheckedAt(state, input.now?.() ?? Date.now());
  const platform = input.platform ?? process.platform;
  if (input.emit && input.epoch && platform === 'darwin') {
    const row: CliCapabilities['sources'][number] = {
      source: input.source,
      availability: verdict.availability,
      checkedAt,
    };
    if (verdict.detail)
      row.detail = verdict.detail;
    input.emit('cli:capabilities', {
      epoch: input.epoch,
      platform: 'darwin',
      sources: [row],
    });
  }
  const succeeded = verdict.errorCode == null && (verdict.availability === 'ready' || verdict.availability === 'unknown');
  return {
    ok: succeeded,
    availability: verdict.availability,
    errorCode: verdict.errorCode,
    detail: verdict.detail,
    hasKey,
    checkedAt,
  };
}

function failure(errorCode: CommandErrorCode): ReadinessVerdict {
  let availability: CliAvailability = 'error';
  if (errorCode === 'binary-missing')
    availability = 'binary-missing';
  else if (errorCode === 'no-credential' || errorCode === 'auth-rejected')
    availability = 'credential-required';
  return { errorCode, availability, detail: errorCode };
}

function directoryCwd(cwd: string): boolean {
  if (!isAbsolute(cwd))
    return false;
  try {
    return statSync(cwd).isDirectory();
  }
  catch {
    return false;
  }
}

function readSpawnCode(err: unknown): ReadinessSignal['spawnCode'] {
  const code = err instanceof JsonlRpcError
    ? err.code
    : (typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code ?? '') : '');
  if (code === 'binary-missing' || code === 'ENOENT')
    return 'ENOENT';
  if (code === 'binary-not-executable' || code === 'EACCES')
    return 'EACCES';
  return 'OK';
}

function isStructuredAuth(err: unknown): boolean {
  return err instanceof JsonlRpcRemoteError && (err.rpcCode === 401 || err.rpcCode === 403);
}

function sanitizeCliDetail(text: string, secrets: readonly string[]): string {
  let out = text.replace(/[\u0000-\u001F\u007F]/g, '');
  for (const secret of secrets) {
    if (secret.length > 0)
      out = out.split(secret).join('[redacted]');
  }
  out = out.replaceAll('凭据已验证', '');
  out = out.replace(/(^|[\s"'`=:(])(\/[^\s"'`)]+)/g, (_match, prefix: string) => `${prefix}[path]`);
  if (out.length > DETAIL_MAX)
    out = out.slice(0, DETAIL_MAX);
  return out.trim() || text;
}
