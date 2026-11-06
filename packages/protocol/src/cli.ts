import type { ChatElement } from './wire.js';
import { isAbsolute } from 'node:path';

export const CLI_SOURCES = ['cursor-cli', 'codebuddy-cli', 'codex-cli'] as const;
export type CliSource = (typeof CLI_SOURCES)[number];

/**
 * Platforms that run ACP CLI sessions. A CLI session is a stdio child process with no GUI or CDP,
 * so headless Linux qualifies even though Linux stays a content source for IDE control.
 * win32 is out: the spawn path relies on POSIX process groups and `:`-joined PATH.
 */
export const CLI_PLATFORMS = ['darwin', 'linux'] as const;
export type CliPlatform = (typeof CLI_PLATFORMS)[number];

export function isCliPlatform(value: unknown): value is CliPlatform {
  return typeof value === 'string' && (CLI_PLATFORMS as readonly string[]).includes(value);
}

export const CLI_UNAVAILABLE_REASONS = ['binary-missing', 'credential-required', 'error'] as const;
export type CliUnavailableReason = (typeof CLI_UNAVAILABLE_REASONS)[number];

/** Dynamic availability. `unknown` and `ready` are not failure reasons. */
export type CliAvailability = 'unknown' | 'ready' | CliUnavailableReason;

export const CLI_SESSION_STATUSES = [
  'starting',
  'idle',
  'running',
  'waiting_approval',
  'error',
  'exited',
  'closing',
] as const;
export type CliSessionStatus = (typeof CLI_SESSION_STATUSES)[number];

export const CLI_APPROVAL_OPTION_KINDS = ['allow_once', 'allow_always', 'reject_once', 'unknown'] as const;
export type CliApprovalOptionKind = (typeof CLI_APPROVAL_OPTION_KINDS)[number];

export const CLI_APPROVAL_STATES = ['pending', 'resolving', 'resolved'] as const;
export type CliApprovalState = (typeof CLI_APPROVAL_STATES)[number];

/**
 * Wire failure codes. `wrong-target` is the IDE router's fail-closed result.
 * `busy`, `already-resolved`, and `sync-error` stay interface state and are not codes.
 */
export const COMMAND_ERROR_CODES = [
  'unsupported-platform',
  'invalid-cwd',
  'invalid-payload',
  'binary-missing',
  'binary-not-executable',
  'too-many-sessions',
  'unsupported-acp-version',
  'no-credential',
  'auth-rejected',
  'provider-timeout',
  'provider-error',
  'shutting-down',
  'cli-agent-incompatible',
  'wrong-target',
] as const;
export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number];

/** Models one catalog may carry. `cursor-agent --list-models` returned 270 rows on 2026-10-28. */
export const CLI_MODEL_LIMIT = 512;
export const CLI_THINKING_LEVEL_LIMIT = 16;
export const CLI_MODEL_ID_MAX = 200;
/** Shell line the page copies. It contains the provider session id. */
export const CLI_RESUME_COMMAND_MAX = 4000;
export const CLI_MODEL_LABEL_MAX = 200;
export const CLI_THINKING_VALUE_MAX = 64;

export interface CliTarget {
  kind: 'cli';
  source: CliSource;
  sessionId: string;
}

export interface CliApprovalOption {
  optionId: string;
  label: string;
  kind: CliApprovalOptionKind;
}

export interface CliApproval {
  approvalId: string;
  sessionId: string;
  title: string;
  options: CliApprovalOption[];
  state: CliApprovalState;
}

/** Static registration capability. Dynamic credential state lives on `cli:capabilities`. */
export interface CliAcpCapability {
  protocolVersion: 1;
  platform: CliPlatform;
  sources: Array<{ source: CliSource }>;
}

export interface CliSourceAvailability {
  source: CliSource;
  availability: CliAvailability;
  checkedAt: number;
  detail?: string;
}

export interface CliCapabilities {
  epoch: string;
  platform: CliPlatform;
  sources: CliSourceAvailability[];
}

export interface CliCatalogPayload {
  commandId: string;
  source: CliSource;
  /** Required for a CodeBuddy probe. Cursor's `--list-models` does not use it. */
  cwd?: string;
}

export interface CliStartPayload {
  commandId: string;
  source: CliSource;
  cwd: string;
  clientRequestId?: string;
  /** Model id chosen in the new-session dialog. Omitted means the CLI's own current model. */
  modelId?: string;
  /** Thinking token chosen in the new-session dialog. Omitted means the CLI's own current level. */
  thinking?: string;
}

export interface CliClosePayload {
  commandId: string;
  target: CliTarget;
}

export type CliPermissionResponse
  = | { outcome: 'selected'; optionId: string }
    | { outcome: 'cancelled' };

export interface CliPermissionResponsePayload {
  commandId: string;
  target: CliTarget;
  approvalId: string;
  response: CliPermissionResponse;
}

export interface CliSessionCreated {
  epoch: string;
  source: CliSource;
  sessionId: string;
  cwd: string;
  status: CliSessionStatus;
  seq: number;
  originCommandId?: string;
  clientRequestId?: string;
}

export interface CliModelChoice {
  id: string;
  label: string;
  /** This model's own effort list, from its catalog entry. Absent when the CLI did not name one. */
  thinking?: {
    levels: CliThinkingLevel[];
    current?: string;
  };
}

export interface CliThinkingLevel {
  value: string;
  label: string;
}

/**
 * Models and thinking levels from one ACP `session/new`.
 * `models[].thinking` is that model's own list. `thinking` is the session dial
 * for whichever model is current, and is not a list shared by every model.
 * Omitted when the CLI reported no models.
 */
export interface CliModelCatalog {
  models: CliModelChoice[];
  currentModelId?: string;
  thinking?: {
    levels: CliThinkingLevel[];
    current?: string;
  };
}

export interface CliSnapshotSession {
  source: CliSource;
  sessionId: string;
  cwd: string;
  title?: string;
  /** Label of the session's current model. */
  model?: string;
  catalog?: CliModelCatalog;
  /**
   * Shell line that resumes this session in a local terminal, including the
   * model and thinking chosen here. Contains the provider session id.
   */
  resumeCommand?: string;
  status: CliSessionStatus;
  seq: number;
  approvals: CliApproval[];
}

export interface CliSnapshot {
  epoch: string;
  snapshotId: string;
  sessions: CliSnapshotSession[];
}

export interface CliFull {
  epoch: string;
  snapshotId: string;
  source: CliSource;
  sessionId: string;
  seq: number;
  messages: ChatElement[];
  /** Set when older messages were dropped. The retained body starts at `firstRetainedFlatIndex`. */
  truncatedBefore?: true;
  firstRetainedFlatIndex?: number;
}

export interface CliAppend {
  epoch: string;
  source: CliSource;
  sessionId: string;
  seq: number;
  messages: ChatElement[];
  /** Set when older messages were dropped. The retained body starts at `firstRetainedFlatIndex`. */
  truncatedBefore?: true;
  firstRetainedFlatIndex?: number;
}

export interface CliStatus {
  epoch: string;
  source: CliSource;
  sessionId: string;
  status: CliSessionStatus;
  /** Label of the session's current model. */
  model?: string;
  catalog?: CliModelCatalog;
  /** Same shell line as `CliSnapshotSession.resumeCommand`. */
  resumeCommand?: string;
  error?: string;
}

export interface CliApprovalEvent {
  epoch: string;
  source: CliSource;
  sessionId: string;
  approval: CliApproval;
}

export interface CliApprovalResolved {
  epoch: string;
  source: CliSource;
  sessionId: string;
  approvalId: string;
  resolution: string;
}

export interface CliSessionRemoved {
  epoch: string;
  source: CliSource;
  sessionId: string;
}

export function isCliSource(raw: unknown): raw is CliSource {
  return typeof raw === 'string' && (CLI_SOURCES as readonly string[]).includes(raw);
}

export function assertCliTarget(raw: unknown): CliTarget {
  if (!isRecord(raw) || raw.kind !== 'cli')
    throw new Error('kind must be cli');
  if (!isCliSource(raw.source))
    throw new Error('unknown source');
  if (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0)
    throw new Error('missing sessionId');
  return { kind: 'cli', source: raw.source, sessionId: raw.sessionId };
}

export function assertCliCatalog(raw: unknown): CliCatalogPayload {
  if (!isRecord(raw))
    throw new Error('invalid cli_catalog');
  if (typeof raw.commandId !== 'string' || raw.commandId.length === 0)
    throw new Error('missing commandId');
  if (!isCliSource(raw.source))
    throw new Error('unknown source');
  const asked: CliCatalogPayload = { commandId: raw.commandId, source: raw.source };
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd))
      throw new Error('cwd must be an absolute path');
    asked.cwd = raw.cwd;
  }
  return asked;
}

export function assertCliStart(raw: unknown): CliStartPayload {
  if (!isRecord(raw))
    throw new Error('invalid cli_start');
  if (typeof raw.commandId !== 'string' || raw.commandId.length === 0)
    throw new Error('missing commandId');
  if (!isCliSource(raw.source))
    throw new Error('unknown source');
  if (typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd))
    throw new Error('cwd must be an absolute path');
  const started: CliStartPayload = {
    commandId: raw.commandId,
    source: raw.source,
    cwd: raw.cwd,
  };
  if (raw.clientRequestId !== undefined) {
    if (typeof raw.clientRequestId !== 'string')
      throw new Error('invalid clientRequestId');
    started.clientRequestId = raw.clientRequestId;
  }
  if (raw.modelId !== undefined) {
    if (!isBoundedText(raw.modelId, CLI_MODEL_ID_MAX))
      throw new Error('invalid modelId');
    started.modelId = raw.modelId;
  }
  if (raw.thinking !== undefined) {
    if (!isBoundedText(raw.thinking, CLI_THINKING_VALUE_MAX))
      throw new Error('invalid thinking');
    started.thinking = raw.thinking;
  }
  return started;
}

export function assertCliApproval(raw: unknown): CliApproval {
  if (!isRecord(raw))
    throw new Error('invalid approval');
  if ('selectorPath' in raw)
    throw new Error('selectorPath is not allowed');
  if (typeof raw.approvalId !== 'string' || raw.approvalId.length === 0)
    throw new Error('missing approvalId');
  if (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0)
    throw new Error('missing sessionId');
  if (typeof raw.title !== 'string')
    throw new Error('missing title');
  if (!isApprovalState(raw.state))
    throw new Error('invalid approval state');
  if (!Array.isArray(raw.options))
    throw new Error('missing options');
  return {
    approvalId: raw.approvalId,
    sessionId: raw.sessionId,
    title: raw.title,
    state: raw.state,
    options: raw.options.map(assertApprovalOption),
  };
}

export function assertCliSnapshot(raw: unknown): CliSnapshot {
  if (!isRecord(raw))
    throw new Error('invalid snapshot');
  if (typeof raw.epoch !== 'string' || raw.epoch.length === 0)
    throw new Error('missing epoch');
  if (typeof raw.snapshotId !== 'string' || raw.snapshotId.length === 0)
    throw new Error('missing snapshotId');
  if (!Array.isArray(raw.sessions))
    throw new Error('missing sessions');
  return {
    epoch: raw.epoch,
    snapshotId: raw.snapshotId,
    sessions: raw.sessions.map(assertSnapshotSession),
  };
}

function assertSnapshotSession(raw: unknown): CliSnapshotSession {
  if (!isRecord(raw))
    throw new Error('invalid snapshot session');
  if (!isCliSource(raw.source))
    throw new Error('unknown source');
  if (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0)
    throw new Error('missing sessionId');
  if (typeof raw.cwd !== 'string' || raw.cwd.length === 0)
    throw new Error('missing cwd');
  if (!isSessionStatus(raw.status))
    throw new Error(raw.status === undefined ? 'missing status' : 'invalid status');
  if (!isCheckpointSeq(raw.seq))
    throw new Error(raw.seq === undefined ? 'missing seq' : 'invalid seq');
  if (!Array.isArray(raw.approvals))
    throw new Error('missing approvals');
  const session: CliSnapshotSession = {
    source: raw.source,
    sessionId: raw.sessionId,
    cwd: raw.cwd,
    status: raw.status,
    seq: raw.seq,
    approvals: raw.approvals.map(assertCliApproval),
  };
  if (typeof raw.title === 'string')
    session.title = raw.title;
  if (typeof raw.model === 'string')
    session.model = raw.model;
  if (raw.catalog !== undefined)
    session.catalog = assertModelCatalog(raw.catalog);
  return session;
}

function assertModelCatalog(raw: unknown): CliModelCatalog {
  if (!isRecord(raw) || !Array.isArray(raw.models) || raw.models.length === 0 || raw.models.length > CLI_MODEL_LIMIT)
    throw new Error('invalid model catalog');
  const catalog: CliModelCatalog = {
    models: raw.models.map(assertModelChoice),
  };
  if (raw.currentModelId !== undefined) {
    if (!isBoundedText(raw.currentModelId, CLI_MODEL_ID_MAX))
      throw new Error('invalid currentModelId');
    catalog.currentModelId = raw.currentModelId;
  }
  if (raw.thinking !== undefined)
    catalog.thinking = assertThinking(raw.thinking);
  return catalog;
}

function assertModelChoice(raw: unknown): CliModelChoice {
  if (!isRecord(raw) || !isBoundedText(raw.id, CLI_MODEL_ID_MAX) || !isBoundedText(raw.label, CLI_MODEL_LABEL_MAX))
    throw new Error('invalid model');
  const choice: CliModelChoice = { id: raw.id, label: raw.label };
  if (raw.thinking !== undefined)
    choice.thinking = assertThinking(raw.thinking);
  return choice;
}

function assertThinking(raw: unknown): NonNullable<CliModelCatalog['thinking']> {
  if (!isRecord(raw) || !Array.isArray(raw.levels) || raw.levels.length === 0 || raw.levels.length > CLI_THINKING_LEVEL_LIMIT)
    throw new Error('invalid thinking catalog');
  const thinking: NonNullable<CliModelCatalog['thinking']> = {
    levels: raw.levels.map(assertThinkingLevel),
  };
  if (raw.current !== undefined) {
    if (!isBoundedText(raw.current, CLI_THINKING_VALUE_MAX))
      throw new Error('invalid thinking current');
    thinking.current = raw.current;
  }
  return thinking;
}

function assertThinkingLevel(raw: unknown): CliThinkingLevel {
  if (!isRecord(raw) || !isBoundedText(raw.value, CLI_THINKING_VALUE_MAX) || !isBoundedText(raw.label, CLI_MODEL_LABEL_MAX))
    throw new Error('invalid thinking level');
  return { value: raw.value, label: raw.label };
}

function isBoundedText(raw: unknown, max: number): raw is string {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= max;
}

function assertApprovalOption(raw: unknown): CliApprovalOption {
  if (!isRecord(raw))
    throw new Error('invalid approval option');
  if ('selectorPath' in raw)
    throw new Error('selectorPath is not allowed');
  if (typeof raw.optionId !== 'string' || raw.optionId.length === 0)
    throw new Error('missing optionId');
  if (typeof raw.label !== 'string')
    throw new Error('missing label');
  if (!isApprovalOptionKind(raw.kind))
    throw new Error('invalid approval option kind');
  return { optionId: raw.optionId, label: raw.label, kind: raw.kind };
}

function isCheckpointSeq(raw: unknown): raw is number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0;
}

function isSessionStatus(raw: unknown): raw is CliSessionStatus {
  return typeof raw === 'string' && (CLI_SESSION_STATUSES as readonly string[]).includes(raw);
}

function isApprovalState(raw: unknown): raw is CliApprovalState {
  return typeof raw === 'string' && (CLI_APPROVAL_STATES as readonly string[]).includes(raw);
}

function isApprovalOptionKind(raw: unknown): raw is CliApprovalOptionKind {
  return typeof raw === 'string' && (CLI_APPROVAL_OPTION_KINDS as readonly string[]).includes(raw);
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}
