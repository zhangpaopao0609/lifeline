import type {
  ChatElement,
  CliApproval,
  CliApprovalOptionKind,
  CliModelCatalog,
  CliModelChoice,
  CliPermissionResponse,
  CliSessionStatus,
  CliSource,
  CommandErrorCode,
} from '@lifeline/protocol';
import type { AcpClient } from './drivers/acp/client.js';
import type { CodebuddyCliFollow } from './drivers/acp/codebuddy-cli-transcript.js';
import type { CursorParameterState } from './drivers/acp/session-catalog.js';
import type { CliSessionRecord } from './drivers/acp/session-ledger.js';
import type { AcpClientEvent, AcpPermissionEvent, AcpPermissionRespondResult } from './drivers/acp/types.js';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  checkSyncWireBudget,
  CLI_APPEND_MAX_BYTES,
  CLI_APPEND_MAX_ELEMENTS,
  CLI_FULL_MAX_BYTES,
  CLI_RESUME_COMMAND_MAX,
  COMMAND_ERROR_CODES,
} from '@lifeline/protocol';
import { fitWireMessages } from './cli-wire-budget.js';
import { AcpTimelineAssembler } from './drivers/acp/assemble.js';
import { catalogFreshness, readStoredCatalog, writeStoredCatalog } from './drivers/acp/catalog-disk.js';
import { codebuddyProjectSlug, createCodebuddyCliFollow, projectCodebuddyCliGrowth, readCodebuddyCliGrowth } from './drivers/acp/codebuddy-cli-transcript.js';
import { peekCursorModels } from './drivers/acp/cursor-models.js';
import { JsonlRpcError } from './drivers/acp/jsonl-rpc.js';
import { codebuddyAcpProfile, cursorAcpProfile } from './drivers/acp/profiles.js';
import { currentModelLabel, cursorEffortOf, cursorListedId, cursorListIdFromParameters, cursorModelFamily, impliedCursorEffort, readCursorParameters, resolveCursorListSelection, rewriteCursorEffort } from './drivers/acp/session-catalog.js';
import { cliResumeCommand, readCliSessionLedger, writeCliSessionLedger } from './drivers/acp/session-ledger.js';

const SYNC_RETRY_AFTER_MS = 120_000;
const DISK_POLL_MS = 1000;

/**
 * Web owns the 120s timer. This only answers what that timer should do:
 * the first quiet window retries once, and the next one becomes `sync-error`.
 */
export function nextSyncAttempt(elapsedMs: number, attempts: number): 'wait' | 'retry' | 'sync-error' {
  if (elapsedMs < SYNC_RETRY_AFTER_MS)
    return 'wait';
  if (attempts < 1)
    return 'retry';
  return 'sync-error';
}

export interface CliSessionClientInput {
  source: CliSource;
  cwd: string;
  modelId?: string;
  onEvent: (event: AcpClientEvent) => void;
  /**
   * Throwaway catalog probe. A live session keeps the default grace so an
   * in-flight turn can finish. The probe has nothing to finish.
   */
  killGraceMs?: number;
}

export type CliSessionClient = Pick<AcpClient, 'start' | 'initialize' | 'sessionNew' | 'prompt' | 'cancel' | 'close'> & {
  setConfigOption?: AcpClient['setConfigOption'];
  sessionLoad?: AcpClient['sessionLoad'];
};

export interface CliSessionManagerOptions {
  epoch: string;
  emit: (event: string, payload: unknown) => void;
  createClient: (input: CliSessionClientInput) => CliSessionClient;
  /** When set, provider session ids are kept here so the next process can `session/load`. */
  ledgerPath?: string;
  /**
   * Last model lists. A later process answers the dialog from this file, then
   * refreshes in the background. Tests leave this unset.
   */
  catalogPath?: string;
  /** CodeBuddy session files. Defaults to `~/.codebuddy/projects`. */
  codebuddyProjectsRoot?: string;
  /**
   * Fired once a published session has left the map, before the child is killed.
   * `live` is how many published sessions of that source are still open.
   */
  onSourceLive?: (source: CliSource, live: number) => void;
  /**
   * Flat Cursor model list (`grok-4.7-low`). Defaults to the warmed
   * `cursor-agent --list-models` cache. Effort and speed stay inside that id.
   */
  cursorModels?: () => readonly CliModelChoice[] | undefined;
  /** Catalog cache clock. Tests move it; the process uses `Date.now`. */
  now?: () => number;
}

export interface CliSessionStartInput {
  source: CliSource;
  cwd: string;
  commandId?: string;
  clientRequestId?: string;
  modelId?: string;
  thinking?: string;
}

export type CliCatalogResult
  = | { ok: true; data: { catalog?: CliModelCatalog } }
    | { ok: false; errorCode: CommandErrorCode };

export interface CliSessionTarget {
  source: CliSource;
  sessionId: string;
}

export interface CliSessionPromptInput extends CliSessionTarget {
  text: string;
  clientMessageId: string;
}

export interface CliSessionRespondInput extends CliSessionTarget {
  approvalId: string;
  response: CliPermissionResponse;
}

export type CliStartResult
  = | { ok: true; data: { epoch: string; source: CliSource; sessionId: string } }
    | { ok: false; errorCode: CommandErrorCode };

export type CliPromptResult
  = | { ok: true }
    | { ok: false; state: 'busy' }
    | { ok: false; errorCode: CommandErrorCode };

export type CliRespondResult
  = | { ok: true }
    | { ok: false; state: 'already-resolved' | 'unsupported-permission-option' }
    | { ok: false; errorCode: CommandErrorCode };

export type CliStopResult
  = | { ok: true }
    | { ok: false; errorCode: CommandErrorCode };

interface LiveApproval extends CliApproval {
  respond: (response: CliPermissionResponse) => Promise<AcpPermissionRespondResult>;
}

interface LiveSession {
  source: CliSource;
  sessionId: string;
  cwd: string;
  status: CliSessionStatus;
  statusError?: string;
  /** Current model label. Display only. */
  modelLabel?: string;
  catalog?: CliModelCatalog;
  /**
   * Cursor family name plus the effort and speed dials.
   * A flat list id is written as those dials, not as one bracket string.
   */
  cursorParameters?: CursorParameterState;
  /** ACP config id for the model dial, when the CLI exposes one. */
  modelConfigId?: string;
  /** ACP config id for the thinking dial, when the CLI exposes one. */
  thinkingConfigId?: string;
  seq: number;
  assembler: AcpTimelineAssembler;
  client?: CliSessionClient;
  approvals: LiveApproval[];
  prompting: boolean;
  ready: boolean;
  closed: boolean;
  crashed: boolean;
  clientClosed: boolean;
  /**
   * Provider session id. It reaches the page only inside `resumeCommand`.
   */
  providerSessionId?: string;
  /** `session/load` is replaying history. Updates stay in the assembler until `cli:full`. */
  capturingHistory?: boolean;
  /** CodeBuddy jsonl tail. Absent for Cursor and for a session that never became ready. */
  disk?: CodebuddyCliFollow;
  diskPath?: string;
  /** Message ids already on the timeline when the tail attached. Later disk lines must not claim these. */
  diskBaseline?: Set<string>;
  /** ACP messages that arrived after the tail attached. A matching disk line is their echo. */
  claimable: Set<string>;
  diskTimer?: ReturnType<typeof setInterval>;
}

interface FrozenSession {
  source: CliSource;
  sessionId: string;
  cwd: string;
  status: CliSessionStatus;
  seq: number;
  approvals: CliApproval[];
  messages: ChatElement[];
  truncatedBefore: boolean;
  firstRetainedFlatIndex: number | null;
  modelLabel?: string;
  catalog?: CliModelCatalog;
  resumeCommand?: string;
}

/**
 * In-memory CLI sessions for one agent epoch.
 * A crashed child stays in the snapshot until `close`, so the page can still see it.
 */
export class CliSessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private uplinkUp = true;
  /** Set by shutdown claim. Later `start` must not spawn. */
  private stopping = false;
  /** Last CodeBuddy list that actually named models. Empty and failed reads are not stored. */
  private readonly catalogCache = new Map<CliSource, { at: number; catalog: CliModelCatalog }>();
  private readonly catalogInflight = new Map<CliSource, Promise<CliCatalogResult>>();

  constructor(private readonly options: CliSessionManagerOptions) {}

  async start(input: CliSessionStartInput): Promise<CliStartResult> {
    if (this.stopping)
      return { ok: false, errorCode: 'shutting-down' };
    const cwd = resolveCwd(input.cwd);
    if (cwd == null)
      return { ok: false, errorCode: 'invalid-cwd' };

    const sessionId = randomUUID();
    const session: LiveSession = {
      source: input.source,
      sessionId,
      cwd,
      status: 'starting',
      seq: 0,
      assembler: new AcpTimelineAssembler(),
      approvals: [],
      prompting: false,
      ready: false,
      closed: false,
      crashed: false,
      clientClosed: false,
      claimable: new Set(),
    };
    this.sessions.set(sessionId, session);
    // The row is visible while cursor-agent / codebuddy is still starting.
    this.emitIncremental('cli:session-created', sessionCreatedPayload(this.options.epoch, session, input));

    try {
      const client = this.options.createClient({
        source: input.source,
        cwd,
        modelId: input.modelId,
        onEvent: event => this.onClientEvent(session, event),
      });
      session.client = client;
      await client.start();
      if (session.closed)
        return { ok: false, errorCode: 'shutting-down' };
      const initialized = await client.initialize();
      if (session.closed)
        return { ok: false, errorCode: 'shutting-down' };
      if (initialized.protocolVersion !== 1)
        throw new JsonlRpcError('unsupported-acp-version', 'unsupported-acp-version');
      const created = await client.sessionNew({ cwd });
      if (session.closed)
        return { ok: false, errorCode: 'shutting-down' };
      if (created.cursorParameters)
        session.cursorParameters = created.cursorParameters;
      if (created.modelConfigId)
        session.modelConfigId = created.modelConfigId;
      if (created.thinkingConfigId)
        session.thinkingConfigId = created.thinkingConfigId;
      if (created.catalog)
        this.adoptCursorList(session, created.catalog);
      await applyRequestedSelection(client, created, input, session);
      if (session.closed)
        return { ok: false, errorCode: 'shutting-down' };
      session.providerSessionId = created.sessionId;
      if (created.catalog) {
        session.catalog = created.catalog;
        const label = currentModelLabel(created.catalog);
        if (label)
          session.modelLabel = label;
      }
      this.remember(session);
      session.ready = true;
      this.setStatus(session, 'idle');
      this.armExternalTranscript(session);
      this.emitIncremental('cli:full', fullPayload(this.options.epoch, randomUUID(), session));
      return {
        ok: true,
        data: { epoch: this.options.epoch, source: session.source, sessionId },
      };
    }
    catch (err) {
      await this.discardStart(session);
      return { ok: false, errorCode: mapStartError(err) };
    }
  }

  /**
   * Loads every session the previous process recorded.
   * A rejected id is dropped. Any other failure stays on disk for the next start.
   */
  async restore(): Promise<void> {
    const ledgerPath = this.options.ledgerPath;
    if (!ledgerPath || this.stopping)
      return;
    for (const record of readCliSessionLedger(ledgerPath)) {
      if (this.stopping)
        return;
      await this.resume(record);
    }
  }

  private async resume(record: CliSessionRecord): Promise<void> {
    const cwd = resolveCwd(record.cwd);
    if (cwd == null) {
      this.forgetRecord(record);
      return;
    }
    const sessionId = randomUUID();
    const session: LiveSession = {
      source: record.source,
      sessionId,
      cwd,
      status: 'starting',
      seq: 0,
      assembler: new AcpTimelineAssembler(),
      approvals: [],
      prompting: false,
      ready: false,
      closed: false,
      crashed: false,
      clientClosed: false,
      claimable: new Set(),
      capturingHistory: true,
      providerSessionId: record.providerSessionId,
    };
    this.sessions.set(sessionId, session);
    try {
      const client = this.options.createClient({
        source: record.source,
        cwd,
        onEvent: event => this.onClientEvent(session, event),
      });
      session.client = client;
      if (!client.sessionLoad)
        throw new JsonlRpcError('provider-error', 'session/load is unavailable');
      await client.start();
      if (session.closed)
        return;
      const initialized = await client.initialize();
      if (session.closed)
        return;
      if (initialized.protocolVersion !== 1)
        throw new JsonlRpcError('unsupported-acp-version', 'unsupported-acp-version');
      const created = await client.sessionLoad({ cwd, sessionId: record.providerSessionId });
      if (session.closed)
        return;
      session.capturingHistory = false;
      session.providerSessionId = created.sessionId;
      if (created.cursorParameters)
        session.cursorParameters = created.cursorParameters;
      if (created.modelConfigId)
        session.modelConfigId = created.modelConfigId;
      if (created.thinkingConfigId)
        session.thinkingConfigId = created.thinkingConfigId;
      if (created.catalog) {
        this.adoptCursorList(session, created.catalog);
        session.catalog = created.catalog;
        const label = currentModelLabel(created.catalog);
        if (label)
          session.modelLabel = label;
      }
      const applied = await this.applyRecordedSelection(session, record);
      session.ready = true;
      this.remember(session, applied ? undefined : record);
      this.emitIncremental('cli:session-created', sessionCreatedPayload(this.options.epoch, session, { source: record.source, cwd }));
      this.setStatus(session, 'idle');
      this.armExternalTranscript(session);
      this.emitIncremental('cli:full', fullPayload(this.options.epoch, randomUUID(), session));
    }
    catch (err) {
      session.capturingHistory = false;
      if (resumeRejected(err))
        this.forgetRecord(record);
      else
        console.error(`[cli] session/load failed for ${record.source}: ${err instanceof Error ? err.message : 'provider-error'}`);
      await this.dropUnpublished(session);
    }
  }

  /**
   * Model list for the new-session dialog. A live session, or a list saved in
   * the last minute, answers without spawning. A list younger than a day is
   * still returned at once, and one throwaway `session/new` replaces it in
   * the background. The first read, and a list older than a day, wait for
   * that probe. The probe is not a Lifeline session and does not take a slot.
   * Its child is closed without the live-session kill grace.
   */
  async readCatalog(input: { source: CliSource; cwd: string }): Promise<CliCatalogResult> {
    if (this.stopping)
      return { ok: false, errorCode: 'shutting-down' };
    const cwd = resolveCwd(input.cwd);
    if (cwd == null)
      return { ok: false, errorCode: 'invalid-cwd' };
    this.hydrateCatalog(input.source);
    const live = this.liveCatalog(input.source);
    if (live)
      return { ok: true, data: { catalog: this.rememberCatalog(input.source, live) } };
    const saved = this.catalogCache.get(input.source);
    if (saved) {
      const freshness = catalogFreshness(saved.at, this.clock());
      if (freshness === 'fresh')
        return { ok: true, data: { catalog: saved.catalog } };
      if (freshness === 'stale') {
        this.refreshCatalog(input.source, cwd);
        return { ok: true, data: { catalog: saved.catalog } };
      }
    }
    const existing = this.catalogInflight.get(input.source);
    if (existing)
      return existing;
    return this.trackCatalogProbe(input.source, cwd);
  }

  /** Replace a saved list. A failed read keeps the old one and waits out another window. */
  private refreshCatalog(source: CliSource, cwd: string): void {
    if (this.catalogInflight.has(source))
      return;
    const task = this.probeCatalog(source, cwd).then((result) => {
      if (!result.ok || result.data.catalog == null)
        this.touchCatalog(source);
      return result;
    });
    this.trackCatalog(source, task);
  }

  private trackCatalogProbe(source: CliSource, cwd: string): Promise<CliCatalogResult> {
    const task = this.probeCatalog(source, cwd);
    return this.trackCatalog(source, task);
  }

  private trackCatalog(source: CliSource, task: Promise<CliCatalogResult>): Promise<CliCatalogResult> {
    this.catalogInflight.set(source, task);
    void task.finally(() => {
      if (this.catalogInflight.get(source) === task)
        this.catalogInflight.delete(source);
    });
    return task;
  }

  private liveCatalog(source: CliSource): CliModelCatalog | undefined {
    for (const session of this.sessions.values()) {
      if (session.source !== source || session.closed)
        continue;
      if (session.catalog && session.catalog.models.length > 0)
        return session.catalog;
    }
    return undefined;
  }

  private hydrateCatalog(source: CliSource): void {
    if (this.catalogCache.has(source))
      return;
    const path = this.options.catalogPath;
    if (!path)
      return;
    const stored = readStoredCatalog(path, source);
    if (stored)
      this.catalogCache.set(source, stored);
  }

  private rememberCatalog(source: CliSource, catalog: CliModelCatalog): CliModelCatalog {
    const copy = structuredClone(catalog);
    this.catalogCache.set(source, { at: this.clock(), catalog: copy });
    this.persistCatalog(source);
    return copy;
  }

  /** A failed refresh must not wipe the list, and must not spawn again on the next open. */
  private touchCatalog(source: CliSource): void {
    const hit = this.catalogCache.get(source);
    if (!hit)
      return;
    hit.at = this.clock();
    this.persistCatalog(source);
  }

  private persistCatalog(source: CliSource): void {
    const path = this.options.catalogPath;
    const hit = this.catalogCache.get(source);
    if (!path || !hit)
      return;
    try {
      writeStoredCatalog(path, source, hit);
    }
    catch {
      // The dialog still has the list. The next process reads whatever was saved.
    }
  }

  private clock(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async probeCatalog(source: CliSource, cwd: string): Promise<CliCatalogResult> {
    let client: CliSessionClient | undefined;
    try {
      client = this.options.createClient({
        source,
        cwd,
        onEvent: () => {},
        killGraceMs: 0,
      });
      await client.start();
      const initialized = await client.initialize();
      if (initialized.protocolVersion !== 1)
        throw new JsonlRpcError('unsupported-acp-version', 'unsupported-acp-version');
      const created = await client.sessionNew({ cwd });
      if (created.catalog && created.catalog.models.length > 0)
        return { ok: true, data: { catalog: this.rememberCatalog(source, created.catalog) } };
      return { ok: true, data: {} };
    }
    catch (err) {
      return { ok: false, errorCode: mapStartError(err) };
    }
    finally {
      // The dialog already has the list. Waiting here used to add the 5s
      // live-session grace before the page could show a single model.
      void client?.close().catch(() => {});
    }
  }

  prompt(input: CliSessionPromptInput): CliPromptResult {
    const session = this.find(input.source, input.sessionId);
    if (!session?.ready || session.closed)
      return { ok: false, errorCode: 'invalid-payload' };
    if (session.crashed || !session.client)
      return { ok: false, errorCode: 'provider-error' };
    if (session.prompting)
      return { ok: false, state: 'busy' };
    session.prompting = true;
    this.setStatus(session, 'running');
    this.publish(session, () => {
      session.assembler.appendHuman({
        clientMessageId: input.clientMessageId,
        text: input.text,
      });
    });
    void session.client.prompt(input.text).then(
      () => this.finishPrompt(session),
      () => this.failPrompt(session),
    );
    return { ok: true };
  }

  async respond(input: CliSessionRespondInput): Promise<CliRespondResult> {
    const session = this.find(input.source, input.sessionId);
    if (!session || session.closed)
      return { ok: false, errorCode: 'invalid-payload' };
    const approval = session.approvals.find(item => item.approvalId === input.approvalId);
    if (!approval || approval.state !== 'pending')
      return { ok: false, state: 'already-resolved' };
    const response = input.response;
    if (response.outcome === 'cancelled')
      return this.claim(session, approval, 'cancelled', { outcome: 'cancelled' });
    const option = approval.options.find(item => item.optionId === response.optionId);
    if (!option)
      return { ok: false, errorCode: 'invalid-payload' };
    if (option.kind === 'unknown') {
      const result = await approval.respond(response);
      if (!result.ok)
        return { ok: false, state: 'unsupported-permission-option' };
      return { ok: true };
    }
    return this.claim(session, approval, resolutionFor(option.kind), response);
  }

  /**
   * Changes the open session's model with `session/set_config_option`.
   * `session/set_model` writes the CLI user's own preference and is not called.
   */
  async selectModel(input: CliSessionTarget & { modelId: string }): Promise<CliStopResult> {
    const session = this.find(input.source, input.sessionId);
    if (!session || session.closed || !session.ready || session.prompting || session.status !== 'idle')
      return { ok: false, errorCode: 'invalid-payload' };
    const catalog = session.catalog;
    if (!catalog?.models.some(model => model.id === input.modelId))
      return { ok: false, errorCode: 'invalid-payload' };
    if (input.modelId === catalog.currentModelId)
      return { ok: true };
    const client = session.client;
    if (!session.modelConfigId || !client?.setConfigOption)
      return { ok: false, errorCode: 'provider-error' };
    try {
      if (session.cursorParameters) {
        const wrote = await writeCursorModel(client, session, input.modelId, catalog.models);
        if (!wrote)
          return { ok: false, errorCode: 'provider-error' };
      }
      else {
        await client.setConfigOption(session.modelConfigId, input.modelId);
      }
    }
    catch {
      return { ok: false, errorCode: 'provider-error' };
    }
    catalog.currentModelId = input.modelId;
    const label = currentModelLabel(catalog);
    if (label)
      session.modelLabel = label;
    this.remember(session);
    this.publishStatus(session);
    return { ok: true };
  }

  /**
   * Changes the thinking level of the current model.
   * Cursor hides the level inside the model id, so that write uses the model dial.
   * CodeBuddy writes its own thinking dial. `session/set_model` is not called.
   */
  async selectThinking(input: CliSessionTarget & { thinking: string }): Promise<CliStopResult> {
    const session = this.find(input.source, input.sessionId);
    if (!session || session.closed || !session.ready || session.prompting || session.status !== 'idle')
      return { ok: false, errorCode: 'invalid-payload' };
    const catalog = session.catalog;
    const model = catalog?.models.find(item => item.id === catalog.currentModelId);
    const levels = model?.thinking?.levels ?? catalog?.thinking?.levels;
    if (!levels?.some(level => level.value === input.thinking))
      return { ok: false, errorCode: 'invalid-payload' };
    const client = session.client;
    if (!client?.setConfigOption)
      return { ok: false, errorCode: 'provider-error' };
    if (input.source === 'cursor-cli') {
      if (!session.modelConfigId || !model)
        return { ok: false, errorCode: 'invalid-payload' };
      const nextId = rewriteCursorEffort(model.id, input.thinking);
      if (!nextId)
        return { ok: false, errorCode: 'invalid-payload' };
      if (nextId !== model.id) {
        try {
          await client.setConfigOption(session.modelConfigId, nextId);
        }
        catch {
          return { ok: false, errorCode: 'provider-error' };
        }
        model.id = nextId;
        if (session.catalog)
          session.catalog.currentModelId = nextId;
      }
    }
    else {
      if (!session.thinkingConfigId)
        return { ok: false, errorCode: 'invalid-payload' };
      if (input.thinking !== (model?.thinking?.current ?? catalog?.thinking?.current)) {
        try {
          await client.setConfigOption(session.thinkingConfigId, input.thinking);
        }
        catch {
          return { ok: false, errorCode: 'provider-error' };
        }
      }
    }
    if (model?.thinking)
      model.thinking.current = input.thinking;
    if (catalog?.thinking)
      catalog.thinking.current = input.thinking;
    const label = currentModelLabel(catalog);
    if (label)
      session.modelLabel = label;
    this.remember(session);
    this.publishStatus(session);
    return { ok: true };
  }

  async stop(input: CliSessionTarget): Promise<CliStopResult> {
    const session = this.find(input.source, input.sessionId);
    if (!session?.ready || !session.client)
      return { ok: false, errorCode: 'invalid-payload' };
    this.enqueueCancellations(session);
    await session.client.cancel().catch(() => {});
    return { ok: true };
  }

  /**
   * Stop admission that returns before `session/cancel` settles.
   * `stop` still waits for cancel. Callers that share an emitter with the IDE router
   * use this so their `command:result` is first.
   */
  admitStop(input: CliSessionTarget): CliStopResult {
    const session = this.find(input.source, input.sessionId);
    if (!session?.ready || !session.client)
      return { ok: false, errorCode: 'invalid-payload' };
    this.enqueueCancellations(session);
    void this.cancelTurn(session);
    return { ok: true };
  }

  /**
   * Reads CodeBuddy session files that grew after the ACP child attached.
   * The poll calls this. A turn the page already shows is claimed, not copied.
   */
  followExternalTranscripts(): void {
    for (const session of this.sessions.values())
      this.readDisk(session, session.claimable);
  }

  async close(input: CliSessionTarget): Promise<CliStopResult> {
    const session = this.find(input.source, input.sessionId);
    if (!session)
      return { ok: false, errorCode: 'invalid-payload' };
    await this.closeSession(session, true);
    return { ok: true };
  }

  async stopAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    for (const session of sessions)
      this.enqueueCancellations(session);
    await Promise.all(sessions.map(session => this.cancelTurn(session)));
    await Promise.all(sessions.map(session => this.closeSession(session, false)));
  }

  /**
   * Claim every pending approval and enqueue `cancelled` without waiting for the provider.
   * Also refuses later `start` calls, so shutdown cannot spawn another CLI.
   */
  claimAndEnqueueCancelled(): Promise<unknown>[] {
    this.stopping = true;
    const inflight: Promise<unknown>[] = [];
    for (const session of this.sessions.values())
      inflight.push(...this.enqueueCancellations(session));
    return inflight;
  }

  /** Start `session/cancel` for every live session. Does not await the writes. */
  enqueueCancels(): Promise<unknown>[] {
    return [...this.sessions.values()].map(session => this.cancelTurn(session));
  }

  /** Close every CLI client. `AcpClient.close` is `JsonlRpc.close` (group SIGTERM, then SIGKILL). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(session => this.closeSession(session, false)));
  }

  snapshotForSync(): void {
    const snapshotId = randomUUID();
    const frozen = [...this.sessions.values()].map(freezeSession);
    const snapshot = {
      epoch: this.options.epoch,
      snapshotId,
      sessions: frozen.map(session => ({
        source: session.source,
        sessionId: session.sessionId,
        cwd: session.cwd,
        status: session.status,
        seq: session.seq,
        approvals: session.approvals,
        ...(session.modelLabel ? { model: session.modelLabel } : {}),
        ...(session.catalog ? { catalog: session.catalog } : {}),
        ...(session.resumeCommand ? { resumeCommand: session.resumeCommand } : {}),
      })),
    };
    this.options.emit('cli:snapshot', snapshot);
    const rows = frozen.map(session => ({
      session,
      messages: session.messages.slice(),
      truncatedBefore: session.truncatedBefore,
      firstRetainedFlatIndex: session.firstRetainedFlatIndex,
    }));
    const buildFulls = () => rows.map(row => fitWireMessages({
      messages: row.messages,
      truncatedBefore: row.truncatedBefore,
      firstRetainedFlatIndex: row.firstRetainedFlatIndex,
      budget: CLI_FULL_MAX_BYTES,
      build: (messages, mark) => ({
        epoch: this.options.epoch,
        snapshotId,
        source: row.session.source,
        sessionId: row.session.sessionId,
        seq: row.session.seq,
        messages,
        ...mark,
      }),
    }));
    let fulls = buildFulls();
    let guard = 0;
    const limit = rows.reduce((sum, row) => sum + row.messages.length, 0) + 1;
    while (guard < limit && !checkSyncWireBudget([snapshot, ...fulls]).ok) {
      guard += 1;
      const row = rows.find(item => item.messages.length > 0);
      if (!row)
        break;
      row.messages.shift();
      row.truncatedBefore = true;
      row.firstRetainedFlatIndex = row.messages[0]?.flatIndex ?? null;
      fulls = buildFulls();
    }
    for (const full of fulls)
      this.options.emit('cli:full', full);
  }

  onUplinkDown(): void {
    this.uplinkUp = false;
  }

  onUplinkUp(): void {
    this.uplinkUp = true;
    this.snapshotForSync();
  }

  private async claim(
    session: LiveSession,
    approval: LiveApproval,
    resolution: string,
    response: CliPermissionResponse,
  ): Promise<CliRespondResult> {
    approval.state = 'resolving';
    const result = await approval.respond(response);
    if (!result.ok) {
      approval.state = 'pending';
      return { ok: false, state: result.state };
    }
    this.settle(session, approval, resolution);
    return { ok: true };
  }

  private settle(session: LiveSession, approval: LiveApproval, resolution: string): void {
    approval.state = 'resolved';
    this.emitIncremental('cli:approval-resolved', {
      epoch: this.options.epoch,
      source: session.source,
      sessionId: session.sessionId,
      approvalId: approval.approvalId,
      resolution,
    });
    this.refreshStatus(session);
  }

  private enqueueCancellations(session: LiveSession): Promise<unknown>[] {
    const pending = session.approvals.filter(approval => approval.state === 'pending');
    const inflight: Promise<unknown>[] = [];
    for (const approval of pending) {
      approval.state = 'resolved';
      inflight.push(approval.respond({ outcome: 'cancelled' }).catch(() => {}));
      this.emitIncremental('cli:approval-resolved', {
        epoch: this.options.epoch,
        source: session.source,
        sessionId: session.sessionId,
        approvalId: approval.approvalId,
        resolution: 'cancelled',
      });
    }
    this.refreshStatus(session);
    return inflight;
  }

  private expireApprovals(session: LiveSession): void {
    for (const approval of session.approvals) {
      if (approval.state === 'resolved')
        continue;
      approval.state = 'resolved';
      this.emitIncremental('cli:approval-resolved', {
        epoch: this.options.epoch,
        source: session.source,
        sessionId: session.sessionId,
        approvalId: approval.approvalId,
        resolution: 'expired',
      });
    }
  }

  private failActiveTools(session: LiveSession): void {
    const loading = session.assembler.snapshot().messages.flatMap((message) => {
      if (message.type === 'tool' && message.status === 'loading')
        return [message.toolCallId];
      return [];
    });
    for (const toolCallId of loading) {
      this.publish(session, () => {
        session.assembler.apply({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'failed',
        });
      });
    }
  }

  private finishPrompt(session: LiveSession): void {
    if (session.crashed || session.closed)
      return;
    session.prompting = false;
    this.enqueueCancellations(session);
    this.refreshStatus(session);
    this.followExternalTranscripts();
  }

  /** A rejected prompt ends the turn. Only an unexpected `exit` is a crash. */
  private failPrompt(session: LiveSession): void {
    this.finishPrompt(session);
  }

  private crashSession(session: LiveSession): void {
    if (session.crashed || session.closed || !session.ready)
      return;
    session.crashed = true;
    session.prompting = false;
    this.expireApprovals(session);
    this.failActiveTools(session);
    this.setStatus(session, 'error', 'process exited');
  }

  private async cancelTurn(session: LiveSession): Promise<void> {
    if (!session.client || session.crashed || session.clientClosed)
      return;
    await session.client.cancel().catch(() => {});
  }

  private async closeSession(session: LiveSession, cancelTurn: boolean): Promise<void> {
    if (session.closed)
      return;
    session.closed = true;
    this.stopDisk(session);
    if (cancelTurn)
      this.forget(session);
    if (cancelTurn && !session.crashed)
      this.enqueueCancellations(session);
    session.prompting = false;
    // The page drops the row here. Killing the child waits out a SIGTERM grace
    // and must not hold the row on screen.
    this.sessions.delete(session.sessionId);
    if (session.ready) {
      const live = [...this.sessions.values()].filter(row => row.source === session.source && row.ready).length;
      this.options.onSourceLive?.(session.source, live);
      this.emitIncremental('cli:session-removed', {
        epoch: this.options.epoch,
        source: session.source,
        sessionId: session.sessionId,
      });
    }
    if (cancelTurn)
      await this.cancelTurn(session);
    await this.shutdownClient(session);
  }

  private async discardStart(session: LiveSession): Promise<void> {
    session.closed = true;
    this.stopDisk(session);
    this.sessions.delete(session.sessionId);
    await this.shutdownClient(session);
    this.emitIncremental('cli:session-removed', {
      epoch: this.options.epoch,
      source: session.source,
      sessionId: session.sessionId,
    });
  }

  private async dropUnpublished(session: LiveSession): Promise<void> {
    session.closed = true;
    this.stopDisk(session);
    this.sessions.delete(session.sessionId);
    await this.shutdownClient(session);
  }

  private remember(session: LiveSession, saved?: Pick<CliSessionRecord, 'modelId' | 'thinking'>): void {
    const path = this.options.ledgerPath;
    const providerSessionId = session.providerSessionId;
    if (!path || !providerSessionId)
      return;
    const selection = saved ?? recordedSelection(session);
    try {
      const records = readCliSessionLedger(path).filter(row => row.providerSessionId !== providerSessionId);
      records.push({
        source: session.source,
        cwd: session.cwd,
        providerSessionId,
        ...(selection.modelId ? { modelId: selection.modelId } : {}),
        ...(selection.thinking ? { thinking: selection.thinking } : {}),
      });
      writeCliSessionLedger(path, records);
    }
    catch {
      // The live session still works. The next process just cannot reload it.
    }
  }

  private forget(session: LiveSession): void {
    const providerSessionId = session.providerSessionId;
    if (!providerSessionId)
      return;
    this.forgetRecord({ source: session.source, cwd: session.cwd, providerSessionId });
  }

  private forgetRecord(record: CliSessionRecord): void {
    const path = this.options.ledgerPath;
    if (!path)
      return;
    try {
      const records = readCliSessionLedger(path).filter(row => row.providerSessionId !== record.providerSessionId);
      writeCliSessionLedger(path, records);
    }
    catch {
      // A later close can try again.
    }
  }

  /**
   * Cursor's page catalog is the flat `--list-models` list.
   * The family name and effort / speed dials stay on `cursorParameters`.
   */
  private adoptCursorList(session: LiveSession, catalog: CliModelCatalog): void {
    if (session.source !== 'cursor-cli')
      return;
    const listed = this.options.cursorModels ? this.options.cursorModels() : peekCursorModels();
    if (!listed || listed.length === 0)
      return;
    const current = session.cursorParameters
      ? cursorListIdFromParameters(session.cursorParameters, listed)
      : (catalog.currentModelId ? cursorListedId(catalog.currentModelId, listed) : undefined);
    catalog.models = listed.map(model => ({ id: model.id, label: model.label }));
    delete catalog.thinking;
    if (current)
      catalog.currentModelId = current;
    else
      delete catalog.currentModelId;
  }

  /**
   * `session/load` reports the account's current model. Put back the model and
   * thinking stored for this session. A failed write leaves that stored choice
   * on disk. Replay metadata is not a selection.
   * Returns whether the live catalog now matches the stored choice.
   */
  private async applyRecordedSelection(session: LiveSession, record: CliSessionRecord): Promise<boolean> {
    const catalog = session.catalog;
    const client = session.client;
    if (!record.modelId && !record.thinking)
      return true;
    if (!catalog || !client?.setConfigOption)
      return false;
    if (session.source === 'cursor-cli' && session.cursorParameters && record.modelId) {
      const wanted = catalog.models.some(model => model.id === record.modelId)
        ? record.modelId
        : cursorListedId(record.modelId, catalog.models);
      if (!wanted || !session.modelConfigId)
        return false;
      if (catalog.currentModelId !== wanted) {
        try {
          const wrote = await writeCursorModel(client, session, wanted, catalog.models);
          if (!wrote)
            return false;
        }
        catch {
          return false;
        }
        catalog.currentModelId = wanted;
        const label = currentModelLabel(catalog);
        if (label)
          session.modelLabel = label;
      }
      return true;
    }
    if (record.modelId && catalog.currentModelId !== record.modelId) {
      const exact = catalog.models.find(model => model.id === record.modelId);
      const family = cursorModelFamily(record.modelId);
      const related = exact ?? (session.source === 'cursor-cli' && family
        ? catalog.models.find(model => model.id === family || cursorModelFamily(model.id) === family)
        : undefined);
      if (!related || !session.modelConfigId)
        return false;
      try {
        await client.setConfigOption(session.modelConfigId, record.modelId);
      }
      catch {
        return false;
      }
      if (related.id !== record.modelId)
        related.id = record.modelId;
      catalog.currentModelId = record.modelId;
      const effort = cursorEffortOf(record.modelId);
      if (effort && related.thinking?.levels.some(level => level.value === effort))
        related.thinking.current = effort;
      const label = currentModelLabel(catalog);
      if (label)
        session.modelLabel = label;
    }
    if (session.source === 'codebuddy-cli' && record.thinking) {
      const chosen = catalog.models.find(model => model.id === catalog.currentModelId);
      const levels = chosen?.thinking?.levels ?? catalog.thinking?.levels;
      const current = chosen?.thinking?.current ?? catalog.thinking?.current;
      if (!session.thinkingConfigId || !levels?.some(level => level.value === record.thinking))
        return !record.modelId || catalog.currentModelId === record.modelId;
      if (record.thinking !== current) {
        try {
          await client.setConfigOption(session.thinkingConfigId, record.thinking);
        }
        catch {
          return false;
        }
        if (chosen?.thinking)
          chosen.thinking.current = record.thinking;
        if (catalog.thinking)
          catalog.thinking.current = record.thinking;
      }
    }
    return true;
  }

  private async shutdownClient(session: LiveSession): Promise<void> {
    if (session.clientClosed)
      return;
    session.clientClosed = true;
    await session.client?.close().catch(() => {});
  }

  private onClientEvent(session: LiveSession, event: AcpClientEvent): void {
    if (session.closed)
      return;
    if (event.type === 'update') {
      this.publish(session, () => {
        session.assembler.apply(event.update, session.capturingHistory ? { replayUser: true } : undefined);
      });
      return;
    }
    if (event.type === 'permission') {
      this.onPermission(session, event);
      return;
    }
    this.crashSession(session);
  }

  private onPermission(session: LiveSession, event: AcpPermissionEvent): void {
    if (session.closed || session.crashed || !session.ready)
      return;
    const profile = session.source === 'cursor-cli' ? cursorAcpProfile : codebuddyAcpProfile;
    const approval = profile.toCliApproval(event.raw, randomUUID(), session.sessionId);
    session.approvals.push({ ...approval, respond: event.respond });
    this.emitIncremental('cli:approval', {
      epoch: this.options.epoch,
      source: session.source,
      sessionId: session.sessionId,
      approval: wireApproval(approval),
    });
    this.setStatus(session, 'waiting_approval');
  }

  private armExternalTranscript(session: LiveSession): void {
    if (session.source !== 'codebuddy-cli' || !session.providerSessionId)
      return;
    const root = this.options.codebuddyProjectsRoot ?? join(homedir(), '.codebuddy', 'projects');
    session.diskPath = join(root, codebuddyProjectSlug(session.cwd), `${session.providerSessionId}.jsonl`);
    session.disk = createCodebuddyCliFollow();
    const present = new Set(session.assembler.snapshot().messages.map(message => message.id));
    this.readDisk(session, present);
    session.diskBaseline = new Set(session.assembler.snapshot().messages.map(message => message.id));
    session.claimable = new Set();
    const timer = setInterval(() => {
      if (session.closed || session.prompting || !session.diskBaseline)
        return;
      this.readDisk(session, session.claimable);
    }, DISK_POLL_MS);
    timer.unref();
    session.diskTimer = timer;
  }

  private readDisk(session: LiveSession, claimable: ReadonlySet<string>): void {
    if (!session.disk || !session.diskPath || session.closed || session.prompting)
      return;
    const chunk = readCodebuddyCliGrowth(session.diskPath, session.disk);
    if (!chunk?.length)
      return;
    const projected = projectCodebuddyCliGrowth(
      session.disk,
      chunk,
      session.assembler.snapshot().messages,
      claimable,
    );
    if (projected.append.length === 0 && projected.patches.length === 0)
      return;
    const apply = () => {
      for (const element of projected.append)
        session.assembler.insertPrepared(element);
      for (const patch of projected.patches) {
        session.assembler.updatePrepared(patch.id, (element) => {
          if (element.type !== 'tool')
            return;
          element.status = patch.status;
          element.details = patch.details;
        });
      }
    };
    if (session.diskBaseline)
      this.publish(session, apply);
    else
      apply();
  }

  private noteClaimable(session: LiveSession): void {
    if (!session.diskBaseline)
      return;
    for (const message of session.assembler.snapshot().messages) {
      if (session.diskBaseline.has(message.id) || message.id.startsWith('disk-'))
        continue;
      session.claimable.add(message.id);
    }
  }

  private stopDisk(session: LiveSession): void {
    if (!session.diskTimer)
      return;
    clearInterval(session.diskTimer);
    session.diskTimer = undefined;
  }

  private publish(session: LiveSession, mutate: () => void): void {
    const before = new Map(session.assembler.snapshot().messages.map(message => [message.id, JSON.stringify(message)]));
    mutate();
    this.noteClaimable(session);
    if (session.capturingHistory)
      return;
    const view = session.assembler.trim();
    const messages = view.messages.filter(message => before.get(message.id) !== JSON.stringify(message));
    if (messages.length === 0)
      return;
    session.seq += 1;
    const payload = fitWireMessages({
      messages,
      truncatedBefore: view.truncatedBefore,
      firstRetainedFlatIndex: view.firstRetainedFlatIndex,
      budget: CLI_APPEND_MAX_BYTES,
      maxElements: CLI_APPEND_MAX_ELEMENTS,
      build: (kept, mark) => ({
        epoch: this.options.epoch,
        source: session.source,
        sessionId: session.sessionId,
        seq: session.seq,
        messages: kept,
        ...mark,
      }),
    });
    if (payload.messages.length === 0) {
      session.seq -= 1;
      return;
    }
    this.emitIncremental('cli:append', payload);
  }

  private refreshStatus(session: LiveSession): void {
    if (session.crashed || session.closed || !session.ready)
      return;
    const open = session.approvals.some(approval => approval.state === 'pending' || approval.state === 'resolving');
    this.setStatus(session, open ? 'waiting_approval' : (session.prompting ? 'running' : 'idle'));
  }

  private setStatus(session: LiveSession, status: CliSessionStatus, error?: string): void {
    if (session.status === status && session.statusError === error)
      return;
    session.status = status;
    session.statusError = error;
    this.publishStatus(session);
  }

  private publishStatus(session: LiveSession): void {
    const payload: {
      epoch: string;
      source: CliSource;
      sessionId: string;
      status: CliSessionStatus;
      model?: string;
      catalog?: CliModelCatalog;
      resumeCommand?: string;
      error?: string;
    } = {
      epoch: this.options.epoch,
      source: session.source,
      sessionId: session.sessionId,
      status: session.status,
    };
    if (session.modelLabel !== undefined)
      payload.model = session.modelLabel;
    if (session.catalog !== undefined)
      payload.catalog = session.catalog;
    const resumeCommand = sessionResumeCommand(session);
    if (resumeCommand !== undefined)
      payload.resumeCommand = resumeCommand;
    if (session.statusError !== undefined)
      payload.error = session.statusError;
    this.emitIncremental('cli:status', payload);
  }

  private emitIncremental(event: string, payload: unknown): void {
    if (!this.uplinkUp)
      return;
    this.options.emit(event, payload);
  }

  private find(source: CliSource, sessionId: string): LiveSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.source !== source)
      return undefined;
    return session;
  }
}

function freezeSession(session: LiveSession): FrozenSession {
  const view = session.assembler.trim();
  return {
    source: session.source,
    sessionId: session.sessionId,
    cwd: session.cwd,
    status: session.status,
    seq: session.seq,
    approvals: session.approvals.filter(approval => approval.state !== 'resolved').map(wireApproval),
    messages: view.messages,
    truncatedBefore: view.truncatedBefore,
    firstRetainedFlatIndex: view.firstRetainedFlatIndex,
    ...(session.modelLabel ? { modelLabel: session.modelLabel } : {}),
    ...(session.catalog ? { catalog: session.catalog } : {}),
    ...resumeField(session),
  };
}

function resumeField(session: LiveSession): { resumeCommand: string } | Record<string, never> {
  const resumeCommand = sessionResumeCommand(session);
  return resumeCommand ? { resumeCommand } : {};
}

function wireApproval(approval: CliApproval): CliApproval {
  return {
    approvalId: approval.approvalId,
    sessionId: approval.sessionId,
    title: approval.title,
    state: approval.state,
    options: approval.options.map(option => ({ ...option })),
  };
}

function sessionCreatedPayload(epoch: string, session: LiveSession, input: CliSessionStartInput) {
  const payload: {
    epoch: string;
    source: CliSource;
    sessionId: string;
    cwd: string;
    status: CliSessionStatus;
    seq: number;
    originCommandId?: string;
    clientRequestId?: string;
  } = {
    epoch,
    source: session.source,
    sessionId: session.sessionId,
    cwd: session.cwd,
    status: session.status,
    seq: session.seq,
  };
  if (input.commandId !== undefined)
    payload.originCommandId = input.commandId;
  if (input.clientRequestId !== undefined)
    payload.clientRequestId = input.clientRequestId;
  return payload;
}

function fullPayload(epoch: string, snapshotId: string, session: LiveSession) {
  const view = session.assembler.trim();
  return fitWireMessages({
    messages: view.messages,
    truncatedBefore: view.truncatedBefore,
    firstRetainedFlatIndex: view.firstRetainedFlatIndex,
    budget: CLI_FULL_MAX_BYTES,
    build: (messages, mark) => ({
      epoch,
      snapshotId,
      source: session.source,
      sessionId: session.sessionId,
      seq: session.seq,
      messages,
      ...mark,
    }),
  });
}

function recordedSelection(session: LiveSession): { modelId?: string; thinking?: string } {
  const modelId = session.catalog?.currentModelId;
  const model = session.catalog?.models.find(item => item.id === modelId);
  const thinking = session.source === 'codebuddy-cli'
    ? (model?.thinking?.current ?? session.catalog?.thinking?.current)
    : undefined;
  return {
    ...(modelId ? { modelId } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

function sessionResumeCommand(session: LiveSession): string | undefined {
  const providerSessionId = session.providerSessionId;
  if (!providerSessionId)
    return undefined;
  const command = cliResumeCommand({
    source: session.source,
    cwd: session.cwd,
    providerSessionId,
    ...recordedSelection(session),
  });
  if (command.length > CLI_RESUME_COMMAND_MAX)
    return undefined;
  return command;
}

function resumeRejected(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not found|unknown session|no such session|does not exist/i.test(message);
}

function resolutionFor(kind: CliApprovalOptionKind): string {
  if (kind === 'reject_once')
    return 'rejected';
  return 'allowed';
}

/**
 * Writes a flat Cursor list id as the family name plus effort and speed.
 * A bracket id is not a value Cursor accepts. Context and other dials stay put.
 * Returns false when the list id does not name a dial value on this session.
 */
async function writeCursorModel(
  client: CliSessionClient,
  session: { modelConfigId?: string; cursorParameters?: CursorParameterState },
  listedId: string,
  listed: readonly { id: string }[],
): Promise<boolean> {
  const initial = session.cursorParameters;
  if (!initial || !session.modelConfigId || !client.setConfigOption)
    return false;
  const plan = resolveCursorListSelection(listedId, initial.modelNames);
  if (!plan)
    return false;
  let state = initial;
  if (state.modelId !== plan.modelId) {
    const result = await client.setConfigOption(session.modelConfigId, plan.modelId);
    const next = readCursorParameters(result);
    state = next
      ? { ...next, modelNames: next.modelNames.length > 0 ? next.modelNames : initial.modelNames }
      : { ...state, modelId: plan.modelId };
  }
  const names = state.modelNames.length > 0 ? state.modelNames : initial.modelNames;
  const effort = plan.effort ?? (state.effort
    ? impliedCursorEffort(plan.modelId, names, listed, state.effort.values)
    : undefined);
  if (plan.effort && (!state.effort || !state.effort.values.includes(plan.effort)))
    return false;
  if (state.effort && effort && state.effort.values.includes(effort) && state.effort.value !== effort) {
    const result = await client.setConfigOption(state.effort.id, effort);
    const next = readCursorParameters(result);
    state = next
      ? { ...next, modelNames: next.modelNames.length > 0 ? next.modelNames : names }
      : { ...state, effort: { ...state.effort, value: effort } };
  }
  const fast = plan.fast ? 'true' : 'false';
  if (plan.fast && (!state.fast || !state.fast.values.includes('true')))
    return false;
  if (state.fast && state.fast.values.includes(fast) && state.fast.value !== fast) {
    const result = await client.setConfigOption(state.fast.id, fast);
    const next = readCursorParameters(result);
    state = next
      ? { ...next, modelNames: next.modelNames.length > 0 ? next.modelNames : names }
      : { ...state, fast: { ...state.fast, value: fast } };
  }
  if (state.modelNames.length === 0)
    state = { ...state, modelNames: names };
  session.cursorParameters = state;
  return state.modelId === plan.modelId;
}

/**
 * Applies a dialog choice with `session/set_config_option` only.
 * `session/set_model` writes the CLI user's own preference and is not called.
 * A Cursor list id that Cursor rejects fails the start. CodeBuddy keeps the
 * level `session/new` reported when its thinking write is rejected.
 */
async function applyRequestedSelection(
  client: CliSessionClient,
  created: { catalog?: CliModelCatalog; modelConfigId?: string; thinkingConfigId?: string },
  input: CliSessionStartInput,
  session: LiveSession,
): Promise<void> {
  const catalog = created.catalog;
  if (!catalog || !client.setConfigOption)
    return;
  if (
    input.modelId
    && created.modelConfigId
    && input.modelId !== catalog.currentModelId
    && catalog.models.some(model => model.id === input.modelId)
  ) {
    if (session.cursorParameters) {
      const wrote = await writeCursorModel(client, session, input.modelId, catalog.models);
      if (!wrote)
        throw new JsonlRpcError('provider-error', 'cursor model was not applied');
    }
    else {
      await client.setConfigOption(created.modelConfigId, input.modelId);
    }
    catalog.currentModelId = input.modelId;
  }
  const chosen = catalog.models.find(model => model.id === catalog.currentModelId);
  const levels = chosen?.thinking?.levels ?? catalog.thinking?.levels;
  if (
    input.thinking
    && created.thinkingConfigId
    && levels
    && input.thinking !== catalog.thinking?.current
    && levels.some(level => level.value === input.thinking)
  ) {
    try {
      await client.setConfigOption(created.thinkingConfigId, input.thinking);
      if (catalog.thinking)
        catalog.thinking.current = input.thinking;
    }
    catch {
      // Keep the level session/new reported.
    }
  }
}

function resolveCwd(cwd: string): string | undefined {
  if (!isAbsolute(cwd))
    return undefined;
  try {
    const resolved = realpathSync(cwd);
    if (!statSync(resolved).isDirectory())
      return undefined;
    return resolved;
  }
  catch {
    return undefined;
  }
}

function mapStartError(err: unknown): CommandErrorCode {
  const code = err instanceof JsonlRpcError
    ? err.code
    : (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : undefined);
  if (code === 'ENOENT')
    return 'binary-missing';
  if (code === 'EACCES')
    return 'binary-not-executable';
  if (isCommandErrorCode(code))
    return code;
  return 'provider-error';
}

function isCommandErrorCode(code: string | undefined): code is CommandErrorCode {
  return code !== undefined && (COMMAND_ERROR_CODES as readonly string[]).includes(code);
}
