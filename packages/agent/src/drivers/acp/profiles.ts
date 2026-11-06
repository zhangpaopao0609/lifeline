import type { CliApproval, CliApprovalOptionKind, CliSource } from '@lifeline/protocol';
import type { AcpEnvInput, AcpProfile } from './types.js';

const CURSOR_KINDS = new Map<string, CliApprovalOptionKind>([
  ['allow-once', 'allow_once'],
  ['allow-always', 'allow_always'],
  ['reject-once', 'reject_once'],
]);

const CODEBUDDY_KINDS = new Map<string, CliApprovalOptionKind>([
  ['allow_always', 'allow_always'],
  ['allow', 'allow_once'],
  ['reject', 'reject_once'],
]);

export type { AcpProfile } from './types.js';

export const cursorAcpProfile: AcpProfile = {
  source: 'cursor-cli',
  command: 'cursor-agent',
  args: ['acp'],
  mapOptionKind(kind) {
    return mapKind(CURSOR_KINDS, kind);
  },
  toCliApproval(raw, approvalId, sessionId) {
    return buildCliApproval(CURSOR_KINDS, raw, approvalId, sessionId);
  },
  childEnv(input) {
    return omitCodebuddyEnv(input?.base);
  },
};

export const codebuddyAcpProfile: AcpProfile = {
  source: 'codebuddy-cli',
  command: 'codebuddy',
  args: ['--acp'],
  mapOptionKind(kind) {
    return mapKind(CODEBUDDY_KINDS, kind);
  },
  toCliApproval(raw, approvalId, sessionId) {
    return buildCliApproval(CODEBUDDY_KINDS, raw, approvalId, sessionId);
  },
  childEnv(input) {
    return codebuddyEnv(input);
  },
};

const CODEX_KINDS = new Map<string, CliApprovalOptionKind>([
  ['allow_once', 'allow_once'],
  ['reject_once', 'reject_once'],
]);

/** Spawn and normalized approval metadata; CodexClient speaks native app-server. */
export const codexCliProfile: AcpProfile = {
  source: 'codex-cli',
  command: 'codex',
  args: ['app-server', '--listen', 'stdio://'],
  mapOptionKind: kind => mapKind(CODEX_KINDS, kind),
  toCliApproval: (raw, approvalId, sessionId) => buildCliApproval(CODEX_KINDS, raw, approvalId, sessionId),
  childEnv(input) {
    const env = omitCodebuddyEnv(input?.base);
    delete env.DEEPSEEK_API_KEY;
    return env;
  },
};

const CLI_PROFILES: Record<CliSource, AcpProfile> = {
  'cursor-cli': cursorAcpProfile,
  'codebuddy-cli': codebuddyAcpProfile,
  'codex-cli': codexCliProfile,
};

export function acpProfileFor(source: CliSource): AcpProfile {
  return CLI_PROFILES[source];
}

function mapKind(table: ReadonlyMap<string, CliApprovalOptionKind>, kind: string): CliApprovalOptionKind {
  return table.get(kind) ?? 'unknown';
}

/**
 * Empty or missing `rawInput` uses `toolCall.title` verbatim.
 * A missing title falls through to the ACP tool kind string.
 * Non-empty rawInput is left unparsed; a present title still wins, so tool
 * arguments are not stringified onto the card.
 */
function approvalTitle(toolCall: Record<string, unknown>): string {
  const title = typeof toolCall.title === 'string' ? toolCall.title : '';
  if (title.length > 0)
    return title;
  return typeof toolCall.kind === 'string' ? toolCall.kind : '';
}

function optionLabel(option: Record<string, unknown>): string {
  if (typeof option.name === 'string')
    return option.name;
  if (typeof option.label === 'string')
    return option.label;
  return '';
}

function buildCliApproval(
  table: ReadonlyMap<string, CliApprovalOptionKind>,
  raw: unknown,
  approvalId: string,
  sessionId: string,
): CliApproval {
  const record = isRecord(raw) ? raw : {};
  const toolCall = isRecord(record.toolCall) ? record.toolCall : {};
  const options = Array.isArray(record.options) ? record.options : [];
  return {
    approvalId,
    sessionId,
    title: approvalTitle(toolCall),
    state: 'pending',
    options: options.map((option) => {
      const item = isRecord(option) ? option : {};
      const kind = typeof item.kind === 'string' ? item.kind : '';
      return {
        optionId: typeof item.optionId === 'string' ? item.optionId : '',
        label: optionLabel(item),
        kind: mapKind(table, kind),
      };
    }),
  };
}

function omitCodebuddyEnv(base: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.CODEBUDDY_API_KEY;
  delete env.CODEBUDDY_INTERNET_ENVIRONMENT;
  return env;
}

function codebuddyEnv(input: AcpEnvInput | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...input?.base };
  if (typeof input?.apiKey === 'string' && input.apiKey.length > 0)
    env.CODEBUDDY_API_KEY = input.apiKey;
  if (typeof input?.environment === 'string' && input.environment.length > 0)
    env.CODEBUDDY_INTERNET_ENVIRONMENT = input.environment;
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
