import type { CliPermissionResponse } from '@lifeline/protocol';
import type {
  AcpClientEvent,
  AcpClientOptions,
  AcpInitializeResult,
  AcpPermissionRespondResult,
  AcpPermissionWireResult,
  AcpProfile,
  AcpPromptResult,
  AcpSessionNewResult,
} from './types.js';
import {
  JsonlRpc,
  JsonlRpcError,
  JsonlRpcMethodNotFound,
  JsonlRpcRemoteError,
} from './jsonl-rpc.js';
import { readCursorParameters, readSessionCatalog, readSessionConfigIds } from './session-catalog.js';

interface PermissionWaiter {
  settled: boolean;
  resolve: (value: AcpPermissionWireResult) => void;
  reject: (err: Error) => void;
}

/**
 * One ACP child. Provider session ids stay on outbound ACP frames and on
 * `sessionNew()`'s return value. Update, permission, and exit events omit them.
 * Approval ids are supplied by the caller; this class does not mint them.
 */
export class AcpClient {
  private readonly profile: AcpProfile;
  private readonly apiKey: string | undefined;
  private readonly rpc: JsonlRpc;
  private readonly onEvent: AcpClientOptions['onEvent'];
  private readonly permissionWaiters: PermissionWaiter[] = [];
  private providerSessionId: string | undefined;
  private exitEmitted = false;

  constructor(options: AcpClientOptions) {
    this.profile = options.profile;
    this.apiKey = options.apiKey;
    this.onEvent = options.onEvent;
    this.rpc = new JsonlRpc({
      command: options.command ?? options.profile.command,
      args: [...(options.args ?? options.profile.args)],
      cwd: options.cwd,
      env: options.profile.childEnv({
        apiKey: options.apiKey,
        environment: options.environment,
        base: options.env ?? process.env,
      }),
      killGraceMs: options.killGraceMs,
      onRequest: request => this.handleRequest(request.method, request.params),
      onNotification: (notification) => {
        this.handleNotification(notification.method, notification.params);
      },
      onExit: (info) => {
        this.handleExit(info.code, info.signal);
      },
    });
  }

  start(): Promise<void> {
    return this.rpc.start();
  }

  async initialize(): Promise<AcpInitializeResult> {
    const result = await this.capture(this.rpc.sendRequest('initialize', {
      protocolVersion: 1,
      // Cursor rejects a flat list id (`grok-4.7-low`) unless this session
      // exposes the family name and effort / speed as separate dials.
      clientCapabilities: this.profile.source === 'cursor-cli'
        ? { _meta: { parameterizedModelPicker: true } }
        : {},
    }).response);
    if (!isRecord(result) || typeof result.protocolVersion !== 'number')
      throw new JsonlRpcError('provider-error', 'initialize missing protocolVersion');
    return { protocolVersion: result.protocolVersion };
  }

  async sessionNew(input: { cwd: string }): Promise<AcpSessionNewResult> {
    const result = await this.capture(this.rpc.sendRequest('session/new', {
      cwd: input.cwd,
      mcpServers: [],
    }).response);
    if (!isRecord(result) || typeof result.sessionId !== 'string' || result.sessionId.length === 0)
      throw new JsonlRpcError('provider-error', 'session/new missing sessionId');
    this.providerSessionId = result.sessionId;
    return sessionPayload(result, result.sessionId);
  }

  /**
   * Reattach a CLI session after this process died.
   * History arrives as `session/update` before this resolves. The id we asked
   * for stays the provider id when the CLI does not echo one.
   */
  async sessionLoad(input: { cwd: string; sessionId: string }): Promise<AcpSessionNewResult> {
    const result = await this.capture(this.rpc.sendRequest('session/load', {
      cwd: input.cwd,
      sessionId: input.sessionId,
      mcpServers: [],
    }).response);
    if (!isRecord(result))
      throw new JsonlRpcError('provider-error', 'session/load missing result');
    const echoed = typeof result.sessionId === 'string' && result.sessionId.length > 0
      ? result.sessionId
      : input.sessionId;
    this.providerSessionId = echoed;
    return sessionPayload(result, echoed);
  }

  /**
   * Session-scoped setting. This is not `session/set_model`: that call writes
   * the CLI's own user preference and is not used here.
   */
  async setConfigOption(configId: string, value: string): Promise<unknown> {
    const sessionId = this.requireProviderSession();
    return await this.capture(this.rpc.sendRequest('session/set_config_option', {
      sessionId,
      configId,
      value,
    }).response);
  }

  async prompt(text: string): Promise<AcpPromptResult> {
    const sessionId = this.requireProviderSession();
    const result = await this.capture(this.rpc.sendRequest('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    }).response);
    const stopReason = isRecord(result) && typeof result.stopReason === 'string' ? result.stopReason : '';
    return { stopReason };
  }

  async cancel(): Promise<void> {
    const sessionId = this.requireProviderSession();
    await this.rpc.notify('session/cancel', { sessionId }).written;
  }

  close(): Promise<void> {
    return this.rpc.close();
  }

  private requireProviderSession(): string {
    if (this.providerSessionId == null)
      throw new JsonlRpcError('provider-error', 'session/new is required before this request');
    return this.providerSessionId;
  }

  private handleRequest(method: string, params: unknown): Promise<AcpPermissionWireResult> {
    if (method !== 'session/request_permission')
      throw new JsonlRpcMethodNotFound(method);
    return this.deferPermission(stripSessionId(params));
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update' || !isRecord(params))
      return;
    this.emit({ type: 'update', update: params.update });
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitEmitted)
      return;
    this.exitEmitted = true;
    const err = new JsonlRpcError('closed', 'process exited');
    for (const waiter of this.permissionWaiters)
      settleWaiter(waiter, undefined, err);
    this.permissionWaiters.length = 0;
    this.emit({ type: 'exit', code, signal });
  }

  private deferPermission(raw: unknown): Promise<AcpPermissionWireResult> {
    return new Promise((resolve, reject) => {
      const waiter: PermissionWaiter = { settled: false, resolve, reject };
      this.permissionWaiters.push(waiter);
      this.emit({
        type: 'permission',
        raw,
        respond: response => this.respond(waiter, raw, response),
      });
    });
  }

  private respond(
    waiter: PermissionWaiter,
    raw: unknown,
    response: CliPermissionResponse,
  ): Promise<AcpPermissionRespondResult> {
    if (waiter.settled)
      return Promise.reject(new JsonlRpcError('closed', 'process exited'));
    if (response.outcome === 'cancelled') {
      settleWaiter(waiter, { outcome: { outcome: 'cancelled' } });
      this.forgetWaiter(waiter);
      return Promise.resolve({ ok: true });
    }
    const kind = this.profile.mapOptionKind(optionKind(raw, response.optionId));
    if (kind === 'unknown')
      return Promise.resolve({ ok: false, state: 'unsupported-permission-option' });
    settleWaiter(waiter, { outcome: { outcome: 'selected', optionId: response.optionId } });
    this.forgetWaiter(waiter);
    return Promise.resolve({ ok: true });
  }

  private forgetWaiter(waiter: PermissionWaiter): void {
    const index = this.permissionWaiters.indexOf(waiter);
    if (index >= 0)
      this.permissionWaiters.splice(index, 1);
  }

  private emit(event: AcpClientEvent): void {
    this.onEvent?.(event);
  }

  private async capture<T>(response: Promise<T>): Promise<T> {
    try {
      return await response;
    }
    catch (err) {
      throw redactError(err, this.apiKey);
    }
  }
}

function settleWaiter(waiter: PermissionWaiter, value: AcpPermissionWireResult | undefined, err?: Error): void {
  if (waiter.settled)
    return;
  waiter.settled = true;
  if (err != null)
    waiter.reject(err);
  else if (value != null)
    waiter.resolve(value);
}

function optionKind(raw: unknown, optionId: string): string {
  if (!isRecord(raw) || !Array.isArray(raw.options))
    return '';
  for (const option of raw.options) {
    if (!isRecord(option) || option.optionId !== optionId)
      continue;
    return typeof option.kind === 'string' ? option.kind : '';
  }
  return '';
}

function stripSessionId(params: unknown): unknown {
  if (!isRecord(params))
    return {};
  const copy = { ...params };
  delete copy.sessionId;
  return copy;
}

function sessionPayload(result: Record<string, unknown>, sessionId: string): AcpSessionNewResult {
  const catalog = readSessionCatalog(result);
  const configIds = readSessionConfigIds(result);
  const cursorParameters = readCursorParameters(result);
  return {
    sessionId,
    models: readList(result.models, 'availableModels'),
    modes: readList(result.modes, 'availableModes'),
    ...(catalog ? { catalog } : {}),
    ...(cursorParameters ? { cursorParameters } : {}),
    ...configIds,
  };
}

function readList(value: unknown, nestedKey: string): unknown[] {
  if (Array.isArray(value))
    return value;
  if (isRecord(value) && Array.isArray(value[nestedKey]))
    return value[nestedKey];
  return [];
}

function redactError(err: unknown, secret: string | undefined): Error {
  if (!(err instanceof Error))
    return new Error(redactText(String(err), secret));
  const message = redactText(err.message, secret);
  if (err instanceof JsonlRpcRemoteError)
    return new JsonlRpcRemoteError(err.rpcCode, message);
  if (err instanceof JsonlRpcError)
    return new JsonlRpcError(err.code, message);
  const next = new Error(message);
  next.name = redactText(err.name, secret);
  return next;
}

function redactText(text: string, secret: string | undefined): string {
  if (secret == null || secret.length === 0)
    return text;
  return text.split(secret).join('[redacted]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
