import type { CliApproval, CliApprovalOptionKind, CliModelCatalog, CliPermissionResponse, CliSource } from '@lifeline/protocol';
import type { CursorParameterState } from './session-catalog.js';

export interface AcpEnvInput {
  apiKey?: string;
  environment?: string;
  base?: NodeJS.ProcessEnv;
}

export interface AcpProfile {
  readonly source: CliSource;
  readonly command: string;
  readonly args: readonly string[];
  mapOptionKind: (kind: string) => CliApprovalOptionKind;
  /**
   * `approvalId` and `sessionId` are caller-supplied Lifeline ids.
   * A provider session id inside `raw` is not copied onto the approval.
   */
  toCliApproval: (raw: unknown, approvalId: string, sessionId: string) => CliApproval;
  childEnv: (input?: AcpEnvInput) => NodeJS.ProcessEnv;
}

export interface AcpSessionNewResult {
  sessionId: string;
  models: unknown[];
  modes: unknown[];
  /** Present when `session/new` named at least one model. */
  catalog?: CliModelCatalog;
  /** `session/set_config_option` id for the model dial, when the response had one. */
  modelConfigId?: string;
  /** `session/set_config_option` id for the thinking dial, when the response had one. */
  thinkingConfigId?: string;
  /** Cursor family name plus effort / speed dials. Absent for CodeBuddy. */
  cursorParameters?: CursorParameterState;
}

export interface AcpInitializeResult {
  protocolVersion: number;
}

export interface AcpPromptResult {
  stopReason: string;
}

/** ACP `session/request_permission` result. One object, no follow-up request. */
export type AcpPermissionWireResult
  = | { outcome: { outcome: 'selected'; optionId: string } }
    | { outcome: { outcome: 'cancelled' } };

export type AcpPermissionRespondResult
  = | { ok: true }
    | { ok: false; state: 'unsupported-permission-option' };

export interface AcpPermissionEvent {
  type: 'permission';
  raw: unknown;
  respond: (response: CliPermissionResponse) => Promise<AcpPermissionRespondResult>;
}

export type AcpClientEvent
  = | { type: 'update'; update: unknown }
    | AcpPermissionEvent
    | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null };

export interface AcpClientOptions {
  profile: AcpProfile;
  command?: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  apiKey?: string;
  environment?: string;
  killGraceMs?: number;
  onEvent?: (event: AcpClientEvent) => void;
}
