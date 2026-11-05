import type { CliAvailability, CliCapabilities, CliSource, CliSourceAvailability, CommandErrorCode } from '@lifeline/protocol';
import type { CliPromptResult, CliRespondResult, CliSessionClient, CliSessionRespondInput, CliSessionStartInput, CliStartResult, CliStopResult } from '../../cli-session-manager.js';
import type { CheckedAtState, ReadinessClient, ReadinessReport } from './readiness.js';
import type { AcpClientOptions } from './types.js';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { assertCliCatalog, assertCliStart, assertCliTarget, CLI_SOURCES, isCliPlatform } from '@lifeline/protocol';
import { CliSessionManager } from '../../cli-session-manager.js';
import { readServerCommand } from '../../server-inbound.js';
import { codexBridgeLaunch, isExecutableFile } from '../codex/launch.js';
import { AcpClient } from './client.js';
import { listCursorModels } from './cursor-models.js';
import { JsonlRpcError, JsonlRpcRemoteError } from './jsonl-rpc.js';
import { acpProfileFor } from './profiles.js';
import { acpSpawnAllowed, buildChildEnv, probeReadiness, takeCheckedAt, withCliBinOnPath } from './readiness.js';
import { isCursorModelId } from './session-catalog.js';

const COMMAND_ENV: Record<CliSource, 'LIFELINE_CURSOR_CLI' | 'LIFELINE_CODEBUDDY_CLI' | 'LIFELINE_CODEX_CLI'> = {
  'cursor-cli': 'LIFELINE_CURSOR_CLI',
  'codebuddy-cli': 'LIFELINE_CODEBUDDY_CLI',
  'codex-cli': 'LIFELINE_CODEX_CLI',
};

export interface AcpLaunch {
  command: string;
  args: string[];
}

/**
 * The ACP child for a source, or undefined when its binary is not configured (`binary-missing`).
 * Cursor / CodeBuddy speak ACP themselves: the saved absolute path with the profile args.
 * Codex does not: the child is this program's built-in bridge, and the saved Codex path must be an
 * executable file now, because only the bridge would notice later (as a provider error).
 */
export function resolveAcpLaunch(env: NodeJS.ProcessEnv, source: CliSource): AcpLaunch | undefined {
  const command = savedCommand(env, source);
  if (command == null)
    return undefined;
  if (source === 'codex-cli')
    return isExecutableFile(command) ? codexBridgeLaunch() : undefined;
  return { command, args: [...acpProfileFor(source).args] };
}

export interface LiveAcpClientInput {
  source: CliSource;
  cwd: string;
  /** Cursor model id. Passed as `--model` before `acp`, not via `session/set_model`. */
  modelId?: string;
  onEvent?: AcpClientOptions['onEvent'];
  env: NodeJS.ProcessEnv;
  apiKey?: string;
  environment?: string;
  platform?: NodeJS.Platform;
  /** Throwaway catalog probe. Omitted for a live session. */
  killGraceMs?: number;
}

export interface LiveCliEntryOptions {
  epoch: string;
  emit: (event: string, payload: unknown) => void;
  /** Provider session ids kept across process restarts. Tests leave this unset. */
  ledgerPath?: string;
  /** Model lists kept across process restarts. Tests leave this unset. */
  catalogPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  apiKey?: string;
  environment?: string;
  now?: () => number;
  construct?: (options: AcpClientOptions) => CliSessionClient;
  probeOpen?: () => ReadinessClient;
}

export interface LiveCliEntry {
  readonly manager: CliSessionManager;
  probe: (source: CliSource) => Promise<ReadinessReport>;
  start: (input: CliSessionStartInput) => Promise<CliStartResult>;
  acceptStart: (payload: unknown) => Promise<void>;
  acceptCatalog: (payload: unknown) => Promise<void>;
  acceptModel: (payload: unknown) => void;
  acceptThinking: (payload: unknown) => void;
  acceptSend: (payload: unknown) => void;
  acceptStop: (payload: unknown) => void;
  acceptClose: (payload: unknown) => void;
  acceptPermission: (payload: unknown) => void;
}

/** `cli:sync` reuses `snapshotForSync`. Connect and disconnect only flip the uplink gate. */
export function attachCliUplinkSync(
  on: (event: string, handler: () => void) => void,
  sessions: {
    snapshotForSync: () => void;
    onUplinkUp: () => void;
    onUplinkDown: () => void;
  },
  connected: boolean,
): void {
  on('cli:sync', () => sessions.snapshotForSync());
  on('disconnected', () => sessions.onUplinkDown());
  on('connected', () => sessions.onUplinkUp());
  if (connected)
    sessions.onUplinkUp();
}

/** Start Cursor's model list before the dialog asks, so the click is not the wait. */
export function warmCursorModels(env: NodeJS.ProcessEnv, catalogPath?: string): void {
  const command = savedCommand(env, 'cursor-cli');
  if (command)
    void listCursorModels(command, env, catalogPath ? { catalogPath } : undefined);
}

export function attachLiveCliListeners(
  on: (event: string, handler: (payload: unknown) => void) => void,
  entry: LiveCliEntry,
): void {
  on('command:cli_start', payload => void entry.acceptStart(payload));
  on('command:cli_catalog', payload => void entry.acceptCatalog(payload));
  on('command:cli_model', payload => entry.acceptModel(payload));
  on('command:cli_thinking', payload => entry.acceptThinking(payload));
  on('command:cli_close', payload => entry.acceptClose(payload));
  on('command:cli_permission_response', payload => entry.acceptPermission(payload));
  on('command:send_message', payload => entry.acceptSend(payload));
  on('command:stop', payload => entry.acceptStop(payload));
}

/**
 * Options for one ACP child. The command is the saved absolute path.
 * The returned env is the only place a CodeBuddy key is copied.
 */
export function buildLiveAcpClientOptions(input: LiveAcpClientInput): AcpClientOptions {
  const profile = acpProfileFor(input.source);
  const launch = resolveAcpLaunch(input.env, input.source);
  if (launch == null)
    throw new JsonlRpcError('binary-missing', 'binary-missing');
  const { command } = launch;
  const { env } = buildChildEnv({
    source: input.source,
    base: input.env,
    apiKey: input.apiKey,
    environment: input.environment,
  });
  return {
    profile,
    command,
    args: acpArgs(profile, launch.args, input.modelId),
    cwd: input.cwd,
    env: withCliBinOnPath(env, command),
    apiKey: input.apiKey,
    environment: input.environment,
    onEvent: input.onEvent,
    ...(input.killGraceMs != null ? { killGraceMs: input.killGraceMs } : {}),
  };
}

/** Platform gate runs before `construct`, so a refused host never builds a client. */
export function openLiveAcpClient(
  input: LiveAcpClientInput,
  construct: (options: AcpClientOptions) => CliSessionClient = options => new AcpClient(options),
): CliSessionClient {
  if (!acpSpawnAllowed(input.platform ?? process.platform, input.env))
    throw new JsonlRpcError('unsupported-platform', 'unsupported-platform');
  return construct(buildLiveAcpClientOptions(input));
}

export function createLiveCliEntry(options: LiveCliEntryOptions): LiveCliEntry {
  const stamp: CheckedAtState = {};
  const capabilityRows = new Map<CliSource, CliSourceAvailability>();
  const parentEnv = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const construct = options.construct ?? (clientOptions => new AcpClient(clientOptions));
  const manager = new CliSessionManager({
    epoch: options.epoch,
    emit: options.emit,
    ...(options.ledgerPath ? { ledgerPath: options.ledgerPath } : {}),
    ...(options.catalogPath ? { catalogPath: options.catalogPath } : {}),
    onSourceLive: (source, live) => {
      if (live === 0)
        emitAvailability(source, 'unknown');
    },
    createClient: (input) => {
      const { hasKey } = buildChildEnv({
        source: input.source,
        base: parentEnv,
        apiKey: options.apiKey,
        environment: options.environment,
      });
      return guardLiveAuth(openLiveAcpClient({
        source: input.source,
        cwd: input.cwd,
        modelId: input.modelId,
        onEvent: input.onEvent,
        env: parentEnv,
        apiKey: options.apiKey,
        environment: options.environment,
        platform,
        ...(input.killGraceMs != null ? { killGraceMs: input.killGraceMs } : {}),
      }, construct), hasKey);
    },
  });

  function emitAvailability(source: CliSource, availability: CliAvailability, detail?: string): void {
    if (!isCliPlatform(platform))
      return;
    const row: CliSourceAvailability = {
      source,
      availability,
      checkedAt: takeCheckedAt(stamp, now()),
    };
    if (detail)
      row.detail = detail;
    emitCapabilities(row);
  }

  function emitCapabilities(row: CliSourceAvailability): void {
    if (!isCliPlatform(platform))
      return;
    capabilityRows.set(row.source, row);
    const payload: CliCapabilities = {
      epoch: options.epoch,
      platform,
      sources: orderedCapabilityRows(),
    };
    options.emit('cli:capabilities', payload);
  }

  function orderedCapabilityRows(): CliSourceAvailability[] {
    const ordered: CliSourceAvailability[] = [];
    for (const source of CLI_SOURCES) {
      const row = capabilityRows.get(source);
      if (row)
        ordered.push(row);
    }
    return ordered;
  }

  function staticReport(source: CliSource, errorCode: CommandErrorCode): ReadinessReport {
    emitAvailability(source, coarse(errorCode), errorCode);
    return {
      ok: false,
      errorCode,
      availability: coarse(errorCode),
      detail: errorCode,
      hasKey: false,
      checkedAt: stamp.last ?? 0,
    };
  }

  async function probe(source: CliSource): Promise<ReadinessReport> {
    if (!acpSpawnAllowed(platform, parentEnv))
      return staticReport(source, 'unsupported-platform');
    const launch = resolveAcpLaunch(parentEnv, source);
    if (launch == null)
      return staticReport(source, 'binary-missing');
    return probeReadiness({
      source,
      command: launch.command,
      args: launch.args,
      cwd: tmpdir(),
      platform,
      env: parentEnv,
      baseEnv: parentEnv,
      apiKey: options.apiKey,
      environment: options.environment,
      epoch: options.epoch,
      now,
      checkedAt: stamp,
      emit: (event, payload) => {
        if (event !== 'cli:capabilities') {
          options.emit(event, payload);
          return;
        }
        for (const row of payload.sources)
          emitCapabilities(row);
      },
      ...(options.probeOpen ? { open: options.probeOpen } : {}),
    });
  }

  async function start(input: CliSessionStartInput): Promise<CliStartResult> {
    if (!acpSpawnAllowed(platform, parentEnv))
      return { ok: false, errorCode: 'unsupported-platform' };
    emitAvailability(input.source, 'unknown');
    const result = await manager.start(input);
    if (result.ok)
      emitAvailability(input.source, 'ready');
    else
      emitAvailability(input.source, coarse(result.errorCode), result.errorCode);
    return result;
  }

  async function acceptStart(payload: unknown): Promise<void> {
    const commandId = isRecord(payload) ? commandIdOf(payload) : '';
    const read = readServerCommand('command:cli_start', payload);
    if (!read.ok) {
      emitInvalid(options.emit, commandId);
      return;
    }
    try {
      const started = assertCliStart(read.data);
      const result = await start({
        source: started.source,
        cwd: started.cwd,
        commandId: started.commandId,
        clientRequestId: started.clientRequestId,
        modelId: started.modelId,
        thinking: started.thinking,
      });
      options.emit('command:result', result.ok
        ? { commandId: started.commandId, ok: true, data: result.data }
        : { commandId: started.commandId, ok: false, errorCode: result.errorCode, error: result.errorCode });
    }
    catch {
      emitInvalid(options.emit, commandId);
    }
  }

  async function readCursorCatalog() {
    const command = savedCommand(parentEnv, 'cursor-cli');
    if (command == null)
      return { ok: false as const, errorCode: 'binary-missing' as const };
    return listCursorModels(command, parentEnv, {
      ...(options.catalogPath ? { catalogPath: options.catalogPath } : {}),
      now,
    });
  }

  /** CodeBuddy and Codex list models on `session/new` in the asked cwd. */
  async function readSessionNewCatalog(source: CliSource, cwd: string | undefined) {
    if (!cwd)
      return { ok: false as const, errorCode: 'invalid-cwd' as const };
    if (resolveAcpLaunch(parentEnv, source) == null)
      return { ok: false as const, errorCode: 'binary-missing' as const };
    return manager.readCatalog({ source, cwd });
  }

  async function acceptCatalog(payload: unknown): Promise<void> {
    const commandId = isRecord(payload) ? commandIdOf(payload) : '';
    const read = readServerCommand('command:cli_catalog', payload);
    if (!read.ok) {
      emitInvalid(options.emit, commandId);
      return;
    }
    try {
      const asked = assertCliCatalog(read.data);
      if (!acpSpawnAllowed(platform, parentEnv)) {
        options.emit('command:result', {
          commandId: asked.commandId,
          ok: false,
          errorCode: 'unsupported-platform',
          error: 'unsupported-platform',
        });
        return;
      }
      const result = asked.source === 'cursor-cli'
        ? await readCursorCatalog()
        : await readSessionNewCatalog(asked.source, asked.cwd);
      options.emit('command:result', result.ok
        ? { commandId: asked.commandId, ok: true, data: result.data }
        : { commandId: asked.commandId, ok: false, errorCode: result.errorCode, error: result.errorCode });
    }
    catch {
      emitInvalid(options.emit, commandId);
    }
  }

  function acceptSend(payload: unknown): void {
    if (!isCliCommand(payload))
      return;
    const commandId = commandIdOf(payload);
    try {
      const target = assertCliTarget(payload.target);
      if (typeof payload.text !== 'string' || typeof payload.clientMessageId !== 'string' || payload.clientMessageId.length === 0)
        throw new Error('invalid-payload');
      emitManagerResult(options.emit, commandId, manager.prompt({
        source: target.source,
        sessionId: target.sessionId,
        text: payload.text,
        clientMessageId: payload.clientMessageId,
      }));
    }
    catch {
      emitInvalid(options.emit, commandId);
    }
  }

  function acceptStop(payload: unknown): void {
    if (!isCliCommand(payload))
      return;
    const commandId = commandIdOf(payload);
    try {
      const target = assertCliTarget(payload.target);
      emitManagerResult(options.emit, commandId, manager.admitStop({
        source: target.source,
        sessionId: target.sessionId,
      }));
    }
    catch {
      emitInvalid(options.emit, commandId);
    }
  }

  function acceptClose(payload: unknown): void {
    if (!isCliCommand(payload))
      return;
    const commandId = commandIdOf(payload);
    let target;
    try {
      target = assertCliTarget(payload.target);
    }
    catch {
      emitInvalid(options.emit, commandId);
      return;
    }
    void manager.close({ source: target.source, sessionId: target.sessionId }).then(
      result => emitManagerResult(options.emit, commandId, result),
      () => emitManagerResult(options.emit, commandId, { ok: false, errorCode: 'provider-error' }),
    );
  }

  function acceptModel(payload: unknown): void {
    if (!isCliCommand(payload))
      return;
    const commandId = commandIdOf(payload);
    try {
      const target = assertCliTarget(payload.target);
      if (typeof payload.modelId !== 'string' || payload.modelId.length === 0)
        throw new Error('invalid-payload');
      void manager.selectModel({
        source: target.source,
        sessionId: target.sessionId,
        modelId: payload.modelId,
      }).then(
        result => emitManagerResult(options.emit, commandId, result),
        () => emitManagerResult(options.emit, commandId, { ok: false, errorCode: 'provider-error' }),
      );
    }
    catch {
      emitInvalid(options.emit, commandId);
    }
  }

  function acceptThinking(payload: unknown): void {
    if (!isCliCommand(payload))
      return;
    const commandId = commandIdOf(payload);
    try {
      const target = assertCliTarget(payload.target);
      if (typeof payload.thinking !== 'string' || payload.thinking.length === 0)
        throw new Error('invalid-payload');
      void manager.selectThinking({
        source: target.source,
        sessionId: target.sessionId,
        thinking: payload.thinking,
      }).then(
        result => emitManagerResult(options.emit, commandId, result),
        () => emitManagerResult(options.emit, commandId, { ok: false, errorCode: 'provider-error' }),
      );
    }
    catch {
      emitInvalid(options.emit, commandId);
    }
  }

  function acceptPermission(payload: unknown): void {
    if (!isCliCommand(payload))
      return;
    const commandId = commandIdOf(payload);
    let input: CliSessionRespondInput;
    try {
      input = readPermission(payload);
    }
    catch {
      emitInvalid(options.emit, commandId);
      return;
    }
    void manager.respond(input).then(
      result => emitManagerResult(options.emit, commandId, result),
      () => emitManagerResult(options.emit, commandId, { ok: false, errorCode: 'provider-error' }),
    );
  }

  return { manager, probe, start, acceptStart, acceptCatalog, acceptModel, acceptThinking, acceptSend, acceptStop, acceptClose, acceptPermission };
}

function acpArgs(profile: { source: CliSource }, args: readonly string[], modelId: string | undefined): string[] {
  if (profile.source === 'cursor-cli' && modelId && isCursorModelId(modelId))
    return ['--model', modelId, ...args];
  return [...args];
}

function savedCommand(env: NodeJS.ProcessEnv, source: CliSource): string | undefined {
  const value = env[COMMAND_ENV[source]];
  if (typeof value !== 'string' || !isAbsolute(value))
    return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isCliCommand(payload: unknown): payload is Record<string, unknown> & { target: Record<string, unknown> } {
  if (!isRecord(payload) || !isRecord(payload.target))
    return false;
  return payload.target.kind === 'cli';
}

function commandIdOf(payload: Record<string, unknown>): string {
  return typeof payload.commandId === 'string' ? payload.commandId : '';
}

function emitInvalid(emit: (event: string, payload: unknown) => void, commandId: string): void {
  emit('command:result', {
    commandId,
    ok: false,
    errorCode: 'invalid-payload',
    error: 'invalid-payload',
  });
}

function emitManagerResult(
  emit: (event: string, payload: unknown) => void,
  commandId: string,
  result: CliPromptResult | CliRespondResult | CliStopResult,
): void {
  if (result.ok) {
    emit('command:result', { commandId, ok: true });
    return;
  }
  if ('state' in result) {
    emit('command:result', { commandId, ok: false, error: result.state });
    return;
  }
  emit('command:result', { commandId, ok: false, errorCode: result.errorCode, error: result.errorCode });
}

function readPermission(payload: Record<string, unknown>): CliSessionRespondInput {
  const target = assertCliTarget(payload.target);
  if (typeof payload.approvalId !== 'string' || payload.approvalId.length === 0)
    throw new Error('missing approvalId');
  const response = payload.response;
  if (!isRecord(response))
    throw new Error('invalid response');
  if (response.outcome === 'cancelled') {
    return {
      source: target.source,
      sessionId: target.sessionId,
      approvalId: payload.approvalId,
      response: { outcome: 'cancelled' },
    };
  }
  if (response.outcome !== 'selected' || typeof response.optionId !== 'string')
    throw new Error('invalid response');
  return {
    source: target.source,
    sessionId: target.sessionId,
    approvalId: payload.approvalId,
    response: { outcome: 'selected', optionId: response.optionId },
  };
}

function guardLiveAuth(client: CliSessionClient, hasKey: boolean): CliSessionClient {
  return {
    start: () => client.start(),
    initialize: async () => {
      try {
        return await client.initialize();
      }
      catch (err) {
        rethrowLiveAuth(err, hasKey);
      }
    },
    sessionNew: async (input) => {
      try {
        return await client.sessionNew(input);
      }
      catch (err) {
        rethrowLiveAuth(err, hasKey);
      }
    },
    sessionLoad: async (input) => {
      if (!client.sessionLoad)
        throw new JsonlRpcError('provider-error', 'session/load is unavailable');
      try {
        return await client.sessionLoad(input);
      }
      catch (err) {
        rethrowLiveAuth(err, hasKey);
      }
    },
    setConfigOption: (configId, value) => {
      if (!client.setConfigOption)
        return Promise.reject(new JsonlRpcError('provider-error', 'provider-error'));
      return client.setConfigOption(configId, value);
    },
    prompt: text => client.prompt(text),
    cancel: () => client.cancel(),
    close: () => client.close(),
  };
}

function rethrowLiveAuth(err: unknown, hasKey: boolean): never {
  if (err instanceof JsonlRpcRemoteError && (err.rpcCode === 401 || err.rpcCode === 403)) {
    const code = hasKey ? 'auth-rejected' : 'no-credential';
    throw new JsonlRpcError(code, code);
  }
  throw err;
}

function coarse(errorCode: CommandErrorCode): CliAvailability {
  if (errorCode === 'binary-missing')
    return 'binary-missing';
  if (errorCode === 'no-credential' || errorCode === 'auth-rejected')
    return 'credential-required';
  return 'error';
}
