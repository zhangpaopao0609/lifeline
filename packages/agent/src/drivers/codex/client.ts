import type { AcpClientEvent, AcpClientOptions, AcpSessionNewResult } from '../acp/types.js';
import { CLI_MODEL_LIMIT, CLI_SESSION_BODY_MAX_ELEMENTS } from '@lifeline/protocol';
import { BUILD_VERSION } from '../../../../cli/src/build-version.js';
import { JsonlRpc, JsonlRpcError, JsonlRpcMethodNotFound, JsonlRpcRemoteError } from '../acp/jsonl-rpc.js';
import { readSessionCatalog } from '../acp/session-catalog.js';
import { codexItemUpdate, codexTextUpdate, record, text } from './updates.js';

interface TurnWaiter {
  start: Promise<unknown>;
  id?: string;
  resolve: (value: { stopReason: string }) => void;
  reject: (error: Error) => void;
}

/** Native app-server protocol, normalized onto Lifeline's existing CLI client contract. */
export class CodexClient {
  private readonly rpc: JsonlRpc;
  private readonly onEvent: AcpClientOptions['onEvent'];
  private readonly permissions = new Set<(decision: string) => void>();
  private readonly streamed = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly toolTitles = new Map<string, string>();
  private models: Record<string, unknown>[] = [];
  private model = '';
  private effort = '';
  private threadId?: string;
  private pending?: TurnWaiter;
  private closing?: Promise<void>;

  constructor(options: AcpClientOptions) {
    this.onEvent = options.onEvent;
    this.rpc = new JsonlRpc({
      ...options,
      command: options.command ?? options.profile.command,
      args: [...(options.args ?? options.profile.args)],
      omitJsonrpc: true,
      onRequest: request => this.request(request.method, request.params),
      onNotification: notification => this.notification(notification.method, notification.params),
      onExit: (info) => {
        this.rejectTurn(new JsonlRpcError('closed', 'Codex process exited'));
        this.cancelPermissions();
        this.onEvent?.({ type: 'exit', ...info });
      },
    });
  }

  start(): Promise<void> {
    return this.rpc.start();
  }

  async initialize(): Promise<{ protocolVersion: number }> {
    await this.rpc.sendRequest('initialize', {
      clientInfo: { name: 'lifeline', title: 'Lifeline', version: BUILD_VERSION },
      capabilities: {},
    }).response;
    await this.rpc.notify('initialized', {}).written;
    const auth = record(await this.rpc.sendRequest('account/read', { refreshToken: false }).response);
    if (auth?.requiresOpenaiAuth === true && !auth.account)
      throw new JsonlRpcRemoteError(401, 'Codex login required');
    let cursor: string | undefined;
    do {
      const page = record(await this.rpc.sendRequest('model/list', { cursor, limit: 100 }).response);
      for (const raw of Array.isArray(page?.data) ? page.data : []) {
        const model = record(raw);
        if (model && !model.hidden && text(model.model) && !this.models.some(row => row.model === model.model))
          this.models.push(model);
      }
      const next = text(page?.nextCursor);
      if (next === cursor)
        break;
      cursor = next || undefined;
    } while (cursor && this.models.length < CLI_MODEL_LIMIT);
    this.models = this.models.slice(0, CLI_MODEL_LIMIT);
    // This is the normalized Lifeline CLI contract version, not Codex's wire protocol.
    return { protocolVersion: 1 };
  }

  async sessionNew(input: { cwd: string }): Promise<AcpSessionNewResult> {
    return this.adopt(await this.rpc.sendRequest('thread/start', { cwd: input.cwd }).response);
  }

  async sessionLoad(input: { cwd: string; sessionId: string }): Promise<AcpSessionNewResult> {
    const result = record(await this.rpc.sendRequest('thread/resume', {
      threadId: input.sessionId,
      cwd: input.cwd,
      excludeTurns: true,
    }).response);
    const payload = this.adopt(result);
    const thread = record(result?.thread);
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    if (turns.length > 0) {
      for (const turn of turns.slice(-CLI_SESSION_BODY_MAX_ELEMENTS)) {
        const items = record(turn)?.items;
        for (const item of Array.isArray(items) ? items : [])
          this.item(item, true);
      }
    }
    else if (thread?.historyMode === 'paginated') {
      await this.replayHistory();
    }
    return payload;
  }

  /** Settings are applied to the next turn, without writing the user's config.toml. */
  async setConfigOption(configId: string, value: string): Promise<unknown> {
    if (this.pending)
      throw new JsonlRpcError('provider-error', 'Codex turn is busy');
    if (configId === 'model' && this.models.some(model => model.model === value)) {
      this.model = value;
      const chosen = this.models.find(model => model.model === value);
      this.effort = text(chosen?.defaultReasoningEffort);
    }
    else if (configId === 'effort' && this.levels().some(level => level.value === value)) {
      this.effort = value;
    }
    else {
      throw new JsonlRpcError('provider-error', 'Unsupported Codex selection');
    }
    return this.configState();
  }

  prompt(prompt: string): Promise<{ stopReason: string }> {
    if (!this.threadId || this.pending || this.closing)
      return Promise.reject(new JsonlRpcError('provider-error', 'Codex thread is unavailable'));
    this.streamed.clear();
    this.completed.clear();
    this.toolTitles.clear();
    return new Promise((resolve, reject) => {
      const start = this.rpc.sendRequest('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
      }).response;
      const waiter: TurnWaiter = { start, resolve, reject };
      this.pending = waiter;
      void start.then((raw) => {
        if (this.pending !== waiter)
          return;
        const turn = record(record(raw)?.turn);
        waiter.id = text(turn?.id) || waiter.id;
        if (!waiter.id)
          this.rejectTurn(new JsonlRpcError('provider-error', 'Codex turn/start missing turn id'));
      }, () => {
        if (this.pending === waiter)
          this.rejectTurn(new JsonlRpcError('provider-error', 'Codex turn/start failed'));
      });
    });
  }

  async cancel(): Promise<void> {
    this.cancelPermissions();
    const waiter = this.pending;
    if (!waiter)
      return;
    await waiter.start.catch(() => {});
    if (this.pending !== waiter || !waiter.id)
      return;
    await this.rpc.sendRequest('turn/interrupt', { threadId: this.threadId, turnId: waiter.id }).response.catch((error: unknown) => {
      if (this.pending === waiter)
        throw error;
    });
  }

  close(): Promise<void> {
    this.closing ??= this.closeThread();
    return this.closing;
  }

  private async closeThread(): Promise<void> {
    await this.cancel().catch(() => {});
    if (this.threadId) {
      await this.rpc.sendRequest('thread/unsubscribe', { threadId: this.threadId }, { timeoutMs: 2000 }).response.catch(() => {});
    }
    this.rejectTurn(new JsonlRpcError('closed', 'Codex thread closed'));
    await this.rpc.close();
  }

  private adopt(raw: unknown): AcpSessionNewResult {
    const result = record(raw);
    const thread = record(result?.thread);
    const id = text(thread?.id);
    if (!id)
      throw new JsonlRpcError('provider-error', 'Codex response missing thread id');
    this.threadId = id;
    this.model = text(result?.model) || text(thread?.model);
    this.effort = text(result?.reasoningEffort) || text(thread?.reasoningEffort);
    if (this.model && !this.models.some(model => model.model === this.model))
      this.models.unshift({ model: this.model, displayName: this.model });
    const state = this.configState();
    const catalog = readSessionCatalog(state);
    return { sessionId: id, models: [], modes: [], catalog, modelConfigId: 'model', thinkingConfigId: 'effort' };
  }

  private levels(model = this.model): Array<{ value: string; name: string }> {
    const chosen = this.models.find(row => row.model === model);
    return (Array.isArray(chosen?.supportedReasoningEfforts) ? chosen.supportedReasoningEfforts : [])
      .flatMap((raw) => {
        const effort = text(record(raw)?.reasoningEffort);
        return effort ? [{ value: effort, name: effort }] : [];
      });
  }

  private configState(): unknown {
    return {
      models: {
        currentModelId: this.model,
        availableModels: this.models.map(model => ({
          modelId: model.model,
          name: model.displayName || model.model,
          _meta: { effortOptions: this.levels(text(model.model)) },
        })),
      },
      configOptions: [{ id: 'effort', category: 'thought_level', currentValue: this.effort, options: this.levels() }],
    };
  }

  private async replayHistory(): Promise<void> {
    const items: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = record(await this.rpc.sendRequest('thread/items/list', {
        threadId: this.threadId,
        sortDirection: 'desc',
        limit: 100,
        cursor,
      }).response);
      for (const entry of Array.isArray(page?.data) ? page.data : []) {
        if (items.length >= CLI_SESSION_BODY_MAX_ELEMENTS)
          break;
        items.push(record(entry)?.item);
      }
      const next = text(page?.nextCursor);
      if (next === cursor)
        break;
      cursor = next || undefined;
    } while (cursor && items.length < CLI_SESSION_BODY_MAX_ELEMENTS);
    for (const item of items.reverse())
      this.item(item, true);
  }

  private notification(method: string, raw: unknown): void {
    const params = record(raw);
    if (!params || params.threadId !== this.threadId)
      return;
    if (method === 'turn/started' && this.pending)
      this.pending.id = text(record(params.turn)?.id) || this.pending.id;
    if (method === 'turn/completed') {
      const turn = record(params.turn);
      if (!this.pending || (this.pending.id && turn?.id !== this.pending.id))
        return;
      this.cancelPermissions();
      const waiter = this.pending;
      this.pending = undefined;
      if (turn?.status === 'completed' || turn?.status === 'interrupted')
        waiter.resolve({ stopReason: turn.status === 'completed' ? 'end_turn' : 'cancelled' });
      else
        waiter.reject(new JsonlRpcError('provider-error', 'Codex turn failed'));
    }
    else if (method === 'item/started' || method === 'item/completed') {
      this.item(params.item, false, method === 'item/completed');
    }
    else if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta') {
      const id = text(params.itemId);
      const kind = method === 'item/agentMessage/delta' ? 'agent_message_chunk' : 'agent_thought_chunk';
      if (!id || this.completed.has(id))
        return;
      this.streamed.add(id);
      this.update(codexTextUpdate(kind, text(params.delta), id));
    }
    else if (method === 'turn/plan/updated' && Array.isArray(params.plan)) {
      this.update({ sessionUpdate: 'plan', entries: params.plan.map(raw => ({
        content: text(record(raw)?.step),
        status: record(raw)?.status === 'inProgress' ? 'in_progress' : record(raw)?.status,
      })) });
    }
  }

  private item(raw: unknown, replay = false, complete = true): void {
    const item = record(raw);
    if (!item)
      return;
    const id = text(item.id);
    const isText = item.type === 'agentMessage' || item.type === 'reasoning' || item.type === 'userMessage';
    if (isText) {
      if (!complete)
        return;
      const alreadySent = !replay && (this.streamed.has(id) || this.completed.has(id));
      if (!replay)
        this.completed.add(id);
      if (alreadySent)
        return;
    }
    const update = codexItemUpdate(item, replay, complete);
    if (update) {
      const title = text(record(update)?.title);
      if (title && this.toolTitles.size < CLI_SESSION_BODY_MAX_ELEMENTS)
        this.toolTitles.set(id, title.slice(0, 4001));
      this.update(update);
    }
  }

  private request(method: string, raw: unknown): Promise<unknown> {
    const params = record(raw);
    if (!params || !this.threadId || (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') || params.threadId !== this.threadId)
      throw new JsonlRpcMethodNotFound(method);
    const network = record(params.networkApprovalContext);
    const operation = text(params.command) || this.toolTitles.get(text(params.itemId)) || 'File changes';
    const title = [network ? `Network access: ${text(network.protocol)} ${text(network.host)}` : operation, text(params.cwd), text(params.grantRoot), text(params.reason)].filter(Boolean).join('\n');
    const offered = Array.isArray(params.availableDecisions) ? params.availableDecisions : ['accept', 'decline', 'cancel'];
    const allow = offered.includes('accept') && title.length <= 4000;
    const options = [
      ...(allow ? [{ optionId: 'accept', name: 'Allow once', kind: 'allow_once' }] : []),
      ...(offered.includes('decline') ? [{ optionId: 'decline', name: 'Reject', kind: 'reject_once' }] : []),
    ];
    return new Promise((resolve) => {
      const settle = (decision: string) => { this.permissions.delete(settle); resolve({ decision }); };
      this.permissions.add(settle);
      this.onEvent?.({
        type: 'permission',
        raw: { toolCall: { title: title.slice(0, 4000) }, options },
        respond: async (response) => {
          if (!this.permissions.has(settle))
            throw new JsonlRpcError('closed', 'Codex approval resolved');
          if (response.outcome === 'cancelled') {
            settle('cancel');
            return { ok: true };
          }
          if (!options.some(option => option.optionId === response.optionId))
            return { ok: false, state: 'unsupported-permission-option' };
          settle(response.optionId);
          return { ok: true };
        },
      });
    });
  }

  private cancelPermissions(): void {
    for (const settle of this.permissions)
      settle('cancel');
  }

  private rejectTurn(error: Error): void {
    const waiter = this.pending;
    this.pending = undefined;
    waiter?.reject(error);
  }

  private update(update: unknown): void {
    this.onEvent?.({ type: 'update', update } satisfies AcpClientEvent);
  }
}
