import type { ZodType } from 'zod';
import { z } from 'zod';
import {
  CLI_APPROVAL_OPTION_KINDS,
  CLI_APPROVAL_STATES,
  CLI_MODEL_ID_MAX,
  CLI_MODEL_LABEL_MAX,
  CLI_MODEL_LIMIT,
  CLI_RESUME_COMMAND_MAX,
  CLI_SESSION_STATUSES,
  CLI_SOURCES,
  CLI_THINKING_LEVEL_LIMIT,
  CLI_THINKING_VALUE_MAX,
} from './cli.js';
import { COMMAND_EVENTS } from './commands.js';
import { MAX_ATTACHMENTS } from './limits.js';
import { AGENT_PLATFORMS, IDE_KINDS } from './wire.js';

const KIB = 1024;
const MIB = 1024 * KIB;

/** Single timeline element, including its own JSON envelope. */
export const CLI_ELEMENT_MAX_BYTES = MIB;
/** One `cli:append`: 256 elements or 1 MiB. */
export const CLI_APPEND_MAX_ELEMENTS = 256;
export const CLI_APPEND_MAX_BYTES = MIB;
/** One `cli:full`, including its envelope. */
export const CLI_FULL_MAX_BYTES = 8 * MIB;
/** `cli:snapshot` metadata, including its envelope. */
export const CLI_SNAPSHOT_MAX_BYTES = 256 * KIB;
/** One session body: 2000 elements or 8 MiB. */
export const CLI_SESSION_BODY_MAX_ELEMENTS = 2000;
export const CLI_SESSION_BODY_MAX_BYTES = 8 * MIB;
/** One sync: the sum of that sync's `cli:full` payloads. */
export const CLI_SYNC_MAX_BYTES = 32 * MIB;
/**
 * ACP stdout line cap. Task B enforces this on the transport;
 * this package only publishes the number.
 */
export const ACP_LINE_MAX_BYTES = 8 * MIB;
/**
 * ACP stderr ring cap. Task B owns the buffer;
 * this package only publishes the number.
 */
export const ACP_STDERR_MAX_BYTES = 64 * KIB;

/**
 * Controller-supplied cap. The design requires an options limit and does not give a number.
 */
export const CLI_APPROVAL_OPTION_LIMIT = 16;
/**
 * Controller-supplied cap. The design requires an approvals limit and does not give a number.
 */
export const CLI_SNAPSHOT_APPROVAL_LIMIT = 32;

const uuidSchema = z.uuid();
const nonNegativeSafeInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export type InboundFailure = 'invalid-payload' | 'drop-and-log' | 'reject-register' | 'fail-closed';

export type WireBudgetResult = { ok: true } | { ok: false; code: 'over-budget' };

/** UTF-8 size of `JSON.stringify(payload)`, envelope included. Not a zod parse. */
export function wireBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

/** `wireBytes(payload) > budget` is an error. Equal to the budget is accepted. */
export function checkWireBudget(payload: unknown, budget: number): WireBudgetResult {
  if (wireBytes(payload) > budget)
    return { ok: false, code: 'over-budget' };
  return { ok: true };
}

/** Sum of each full payload's wire bytes, compared with the 32 MiB sync budget. */
export function checkSyncWireBudget(payloads: readonly unknown[]): WireBudgetResult {
  let total = 0;
  for (const payload of payloads) {
    total += wireBytes(payload);
    if (total > CLI_SYNC_MAX_BYTES)
      return { ok: false, code: 'over-budget' };
  }
  return { ok: true };
}

function withinBudget(budget: number) {
  return (payload: unknown) => checkWireBudget(payload, budget).ok;
}

/** IDE enum for wire-protocol validation, derived from the source of truth (P2: adding an IDE only changes IDE_KINDS in wire.ts). */
export const ideKindSchema = z.enum(IDE_KINDS);

const cliTargetSchema = z.object({
  kind: z.literal('cli'),
  source: z.enum(CLI_SOURCES),
  sessionId: uuidSchema,
}).strict();

const cliPermissionResponseSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('selected'),
    optionId: z.string().min(1),
  }).strict(),
  z.object({
    outcome: z.literal('cancelled'),
  }).strict(),
]);

export const commandPayloadSchema = z.object({
  commandId: z.string().min(1),
  type: z.string().optional(),
  text: z.string().optional(),
  /** Composer attachments (base64 bodies): the agent writes them to disk and types their paths. */
  attachments: z
    .array(z.object({ name: z.string().min(1), size: z.number().nonnegative(), data: z.string().min(1) }))
    .max(MAX_ATTACHMENTS)
    .optional(),
  approvalId: z.string().optional(),
  actionType: z.string().optional(),
  selectorPath: z.string().optional(),
  actionLabel: z.string().optional(),
  composerId: z.string().optional(),
  modeId: z.string().optional(),
  modelId: z.string().optional(),
  planLabel: z.string().optional(),
  planModelId: z.string().optional(),
  tabTitle: z.string().optional(),
  windowId: z.string().optional(),
  sameTitleIndex: z.number().optional(),
  section: z.string().optional(),
  ide: ideKindSchema.optional(),
  target: cliTargetSchema.optional(),
  source: z.enum(CLI_SOURCES).optional(),
  clientMessageId: z.string().min(1).optional(),
  optionId: z.string().min(1).optional(),
  response: cliPermissionResponseSchema.optional(),
  // cli_start carries these. Absolute-path checks stay on assertCliStart.
  cwd: z.string().optional(),
  clientRequestId: z.string().optional(),
  /** New-session thinking token. `modelId` above is the matching model choice. */
  thinking: z.string().min(1).max(CLI_THINKING_VALUE_MAX).optional(),
}).strict().superRefine((payload, ctx) => {
  if (!payload.target || payload.approvalId === undefined)
    return;
  if (!uuidSchema.safeParse(payload.approvalId).success) {
    ctx.addIssue({
      code: 'custom',
      path: ['approvalId'],
      message: 'approvalId must be a uuid when target is set',
    });
  }
});

export const commandEventSchema = z.enum(COMMAND_EVENTS);

/**
 * Server → agent resync. `AgentHub.emitCliSync` emits the event name alone,
 * so both a missing payload and `{}` are valid. No other fields are required.
 */
export const cliSyncSchema = z.object({}).strict().optional();

export const sessionBodySchema = z.object({
  sessionId: z.string().min(1),
  messages: z.array(z.unknown()),
  ide: ideKindSchema.optional(),
  seq: z.number().optional(),
});

export const sessionSyncSchema = z.object({
  sessionId: z.string().min(1),
  ide: ideKindSchema.optional(),
  seq: z.number(),
});

const cliAcpCapabilitySchema = z.object({
  protocolVersion: z.literal(1),
  platform: z.literal('darwin'),
  sources: z.array(z.object({
    source: z.enum(CLI_SOURCES),
  }).strict()),
}).strict();

export const agentRegisterSchema = z.object({
  agentId: z.string().optional(),
  hostname: z.string().optional(),
  version: z.string().optional(),
  owner: z.string().optional(),
  liveIdes: z.array(ideKindSchema).optional(),
  contentSource: z.boolean().optional(),
  platform: z.enum(AGENT_PLATFORMS).optional(),
  instanceId: z.string().min(1).optional(),
  cliAcp: cliAcpCapabilitySchema.optional(),
}).strict();

export const machineSelectSchema = z.object({
  agentId: z.string().min(1),
});

export const exchangeBodySchema = z.object({
  code: z.string().min(1),
  agentId: z.string().min(1),
  hostname: z.string().optional(),
});

const cliApprovalOptionSchema = z.object({
  optionId: z.string().min(1),
  label: z.string(),
  kind: z.enum(CLI_APPROVAL_OPTION_KINDS),
}).strict();

const cliApprovalSchema = z.object({
  approvalId: uuidSchema,
  sessionId: uuidSchema,
  title: z.string(),
  options: z.array(cliApprovalOptionSchema).max(CLI_APPROVAL_OPTION_LIMIT),
  state: z.enum(CLI_APPROVAL_STATES),
}).strict();

const cliThinkingLevelSchema = z.object({
  value: z.string().min(1).max(CLI_THINKING_VALUE_MAX),
  label: z.string().min(1).max(CLI_MODEL_LABEL_MAX),
}).strict();

const cliThinkingSchema = z.object({
  levels: z.array(cliThinkingLevelSchema).min(1).max(CLI_THINKING_LEVEL_LIMIT),
  current: z.string().min(1).max(CLI_THINKING_VALUE_MAX).optional(),
}).strict();

const cliModelChoiceSchema = z.object({
  id: z.string().min(1).max(CLI_MODEL_ID_MAX),
  label: z.string().min(1).max(CLI_MODEL_LABEL_MAX),
  thinking: cliThinkingSchema.optional(),
}).strict();

const cliModelCatalogSchema = z.object({
  models: z.array(cliModelChoiceSchema).min(1).max(CLI_MODEL_LIMIT),
  currentModelId: z.string().min(1).max(CLI_MODEL_ID_MAX).optional(),
  thinking: cliThinkingSchema.optional(),
}).strict();

const cliSnapshotSessionSchema = z.object({
  source: z.enum(CLI_SOURCES),
  sessionId: uuidSchema,
  cwd: z.string().min(1),
  title: z.string().optional(),
  model: z.string().optional(),
  catalog: cliModelCatalogSchema.optional(),
  resumeCommand: z.string().min(1).max(CLI_RESUME_COMMAND_MAX).optional(),
  status: z.enum(CLI_SESSION_STATUSES),
  seq: nonNegativeSafeInt,
  approvals: z.array(cliApprovalSchema).max(CLI_SNAPSHOT_APPROVAL_LIMIT),
}).strict();

export const cliSnapshotSchema = z.object({
  epoch: uuidSchema,
  snapshotId: uuidSchema,
  sessions: z.array(cliSnapshotSessionSchema),
  agentId: z.string().min(1).optional(),
}).strict().refine(withinBudget(CLI_SNAPSHOT_MAX_BYTES));

const mentionSchema = z.object({
  name: z.string(),
  mentionType: z.string(),
}).strict();

const runActionSchema = z.object({
  label: z.string(),
  type: z.enum(['run', 'skip', 'allow']),
  selectorPath: z.string(),
}).strict();

const planTodoSchema = z.object({
  text: z.string(),
  status: z.enum(['pending', 'completed', 'in_progress']),
}).strict();

const planActionSchema = z.object({
  label: z.string(),
  type: z.enum(['view_plan', 'build']),
  selectorPath: z.string(),
}).strict();

const codeBlockSchema = z.object({
  blockKind: z.enum(['code', 'diff']),
  filename: z.string().optional(),
  language: z.string().optional(),
  code: z.string(),
  diffLines: z.array(z.object({
    kind: z.enum(['add', 'rem', 'ctx', 'meta', 'hunk']),
    text: z.string(),
  }).strict()).optional(),
}).strict();

const elementId = z.string().min(1);

const humanElementSchema = z.object({
  type: z.literal('human'),
  id: elementId,
  flatIndex: nonNegativeSafeInt,
  text: z.string(),
  mentions: z.array(mentionSchema),
  quoted: z.object({ text: z.string() }).strict().optional(),
  pending: z.boolean().optional(),
  createdAt: z.number().optional(),
}).strict();

const assistantElementSchema = z.object({
  type: z.literal('assistant'),
  id: elementId,
  flatIndex: nonNegativeSafeInt,
  text: z.string(),
  createdAt: z.number().optional(),
}).strict();

const toolElementSchema = z.object({
  type: z.literal('tool'),
  id: elementId,
  flatIndex: nonNegativeSafeInt,
  toolCallId: z.string().min(1),
  status: z.enum(['loading', 'completed', 'error', 'cancelled']),
  action: z.string(),
  toolName: z.string().optional(),
  details: z.string(),
  filename: z.string().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  summaryText: z.string().optional(),
  actions: z.array(runActionSchema).optional(),
  blocked: z.string().optional(),
  diffBlock: codeBlockSchema.optional(),
  createdAt: z.number().optional(),
}).strict();

const thoughtElementSchema = z.object({
  type: z.literal('thought'),
  id: elementId,
  flatIndex: nonNegativeSafeInt,
  duration: z.string(),
  action: z.string().optional(),
  detail: z.string().optional(),
  thoughtKind: z.enum(['step_summary', 'thinking_step']).optional(),
  createdAt: z.number().optional(),
}).strict();

const planElementSchema = z.object({
  type: z.literal('plan'),
  id: elementId,
  flatIndex: nonNegativeSafeInt,
  label: z.string(),
  title: z.string(),
  todosCompleted: z.number(),
  todosTotal: z.number(),
  description: z.string().optional(),
  todos: z.array(planTodoSchema).optional(),
  todosMoreCount: z.number().optional(),
  model: z.string().optional(),
  modelDropdownSelectorPath: z.string().optional(),
  actions: z.array(planActionSchema).optional(),
}).strict();

const todoListElementSchema = z.object({
  type: z.literal('todo_list'),
  id: elementId,
  flatIndex: nonNegativeSafeInt,
  title: z.string(),
  todosCompleted: z.number(),
  todosTotal: z.number(),
  todos: z.array(planTodoSchema),
}).strict();

const runCommandElementSchema = z.object({
  type: z.literal('run_command'),
  id: elementId,
  flatIndex: nonNegativeSafeInt,
  toolCallId: z.string().min(1),
  description: z.string(),
  candidates: z.string(),
  command: z.string(),
  actions: z.array(runActionSchema),
}).strict();

const loadingElementSchema = z.object({
  type: z.literal('loading'),
  id: elementId,
  flatIndex: nonNegativeSafeInt,
  text: z.string().optional(),
}).strict();

const notificationElementSchema = z.object({
  type: z.literal('notification'),
  id: elementId,
  flatIndex: nonNegativeSafeInt,
  title: z.string(),
  status: z.enum(['success', 'error']),
  createdAt: z.number().optional(),
}).strict();

export const chatElementSchema = z.discriminatedUnion('type', [
  humanElementSchema,
  assistantElementSchema,
  toolElementSchema,
  thoughtElementSchema,
  planElementSchema,
  todoListElementSchema,
  runCommandElementSchema,
  loadingElementSchema,
  notificationElementSchema,
]);

/**
 * Append is hot: strict envelope plus a shallow element (`id` / `type` / `flatIndex` and the
 * per-element byte cap). Extra element fields are kept. Deep `ChatElement` parsing is `cli:full` only.
 */
const cliAppendElementSchema = z.looseObject({
  id: elementId,
  type: z.string().min(1),
  flatIndex: nonNegativeSafeInt,
}).refine(withinBudget(CLI_ELEMENT_MAX_BYTES));

export const cliAppendSchema = z.object({
  epoch: uuidSchema,
  source: z.enum(CLI_SOURCES),
  sessionId: uuidSchema,
  seq: nonNegativeSafeInt,
  messages: z.array(cliAppendElementSchema).max(CLI_APPEND_MAX_ELEMENTS),
  truncatedBefore: z.literal(true).optional(),
  firstRetainedFlatIndex: nonNegativeSafeInt.optional(),
  agentId: z.string().min(1).optional(),
}).strict().refine(withinBudget(CLI_APPEND_MAX_BYTES));

const boundedChatElementSchema = chatElementSchema.refine(withinBudget(CLI_ELEMENT_MAX_BYTES));

export const cliFullSchema = z.object({
  epoch: uuidSchema,
  snapshotId: uuidSchema,
  source: z.enum(CLI_SOURCES),
  sessionId: uuidSchema,
  seq: nonNegativeSafeInt,
  messages: z.array(boundedChatElementSchema).max(CLI_SESSION_BODY_MAX_ELEMENTS),
  truncatedBefore: z.literal(true).optional(),
  firstRetainedFlatIndex: nonNegativeSafeInt.optional(),
  agentId: z.string().min(1).optional(),
}).strict().refine(withinBudget(CLI_FULL_MAX_BYTES));

const cliAgentId = z.string().min(1).optional();

export const cliSessionCreatedSchema = z.object({
  epoch: uuidSchema,
  source: z.enum(CLI_SOURCES),
  sessionId: uuidSchema,
  cwd: z.string().min(1),
  status: z.enum(CLI_SESSION_STATUSES),
  seq: nonNegativeSafeInt,
  originCommandId: z.string().min(1).optional(),
  clientRequestId: z.string().optional(),
  agentId: cliAgentId,
}).strict();

export const cliStatusSchema = z.object({
  epoch: uuidSchema,
  source: z.enum(CLI_SOURCES),
  sessionId: uuidSchema,
  status: z.enum(CLI_SESSION_STATUSES),
  model: z.string().optional(),
  catalog: cliModelCatalogSchema.optional(),
  resumeCommand: z.string().min(1).max(CLI_RESUME_COMMAND_MAX).optional(),
  error: z.string().optional(),
  agentId: cliAgentId,
}).strict();

export const cliApprovalEventSchema = z.object({
  epoch: uuidSchema,
  source: z.enum(CLI_SOURCES),
  sessionId: uuidSchema,
  approval: cliApprovalSchema,
  agentId: cliAgentId,
}).strict();

export const cliApprovalResolvedSchema = z.object({
  epoch: uuidSchema,
  source: z.enum(CLI_SOURCES),
  sessionId: uuidSchema,
  approvalId: uuidSchema,
  resolution: z.string().min(1),
  agentId: cliAgentId,
}).strict();

export const cliSessionRemovedSchema = z.object({
  epoch: uuidSchema,
  source: z.enum(CLI_SOURCES),
  sessionId: uuidSchema,
  agentId: cliAgentId,
}).strict();

export type InboundResult<T> = { ok: true; data: T } | { ok: false; code: InboundFailure };

/** Shared gate for the five inbound boundaries. Failure is a code, not a throw. */
export function validateInbound<T>(
  schema: ZodType<T>,
  payload: unknown,
  failure: InboundFailure,
): InboundResult<T> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success)
    return { ok: false, code: failure };
  return { ok: true, data: parsed.data };
}

export type CommandPayloadParsed = z.infer<typeof commandPayloadSchema>;
export type ExchangeBody = z.infer<typeof exchangeBodySchema>;
