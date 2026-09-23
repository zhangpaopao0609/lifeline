import { z } from 'zod';
import { COMMAND_EVENTS } from './commands.js';
import { IDE_KINDS } from './wire.js';

/** IDE enum for wire-protocol validation, derived from the source of truth (P2: adding an IDE only changes IDE_KINDS in wire.ts). */
export const ideKindSchema = z.enum(IDE_KINDS);

export const commandPayloadSchema = z.object({
  commandId: z.string().min(1),
  type: z.string().optional(),
  text: z.string().optional(),
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
});

export const commandEventSchema = z.enum(COMMAND_EVENTS);

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

export const agentRegisterSchema = z.object({
  agentId: z.string().optional(),
  hostname: z.string().optional(),
  version: z.string().optional(),
  owner: z.string().optional(),
});

export const machineSelectSchema = z.object({
  agentId: z.string().min(1),
});

export const exchangeBodySchema = z.object({
  code: z.string().min(1),
  agentId: z.string().min(1),
  hostname: z.string().optional(),
});

export type CommandPayloadParsed = z.infer<typeof commandPayloadSchema>;
export type ExchangeBody = z.infer<typeof exchangeBodySchema>;
