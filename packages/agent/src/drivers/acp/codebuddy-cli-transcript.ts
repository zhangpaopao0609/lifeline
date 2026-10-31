import type { ChatElement, ToolCallElement } from '@lifeline/protocol';
import { closeSync, openSync, readSync, statSync } from 'node:fs';

/**
 * CodeBuddy CLI appends finished turns to
 * `~/.codebuddy/projects/<slug>/<providerSessionId>.jsonl`.
 * The slug is the absolute directory with the leading slash removed and `/` turned into `-`.
 * A hidden directory keeps its dot, so `/.guanlan/` becomes `-.guanlan-`.
 */
export function codebuddyProjectSlug(cwd: string): string {
  const normalized = cwd.replaceAll('\\', '/');
  const stripped = normalized.startsWith('/') ? normalized.slice(1) : normalized;
  return stripped.replaceAll('/', '-').replaceAll(':', '-');
}

export interface CodebuddyCliFollow {
  offset: number;
  remainder: Buffer;
  seen: Set<string>;
  claimed: Set<string>;
  diskTools: Map<string, string>;
  echoedCalls: Set<string>;
  nextId: number;
}

export interface CodebuddyToolPatch {
  id: string;
  status: 'completed' | 'error';
  details: string;
}

export interface CodebuddyCliProjection {
  append: ChatElement[];
  patches: CodebuddyToolPatch[];
}

export function createCodebuddyCliFollow(): CodebuddyCliFollow {
  return {
    offset: 0,
    remainder: Buffer.alloc(0),
    seen: new Set(),
    claimed: new Set(),
    diskTools: new Map(),
    echoedCalls: new Set(),
    nextId: 1,
  };
}

/**
 * Bytes appended since the last read. A missing file leaves the offset alone.
 * A shorter file is read from the start; record ids already seen stay suppressed.
 */
export function readCodebuddyCliGrowth(file: string, follow: CodebuddyCliFollow): Buffer | undefined {
  let size: number;
  try {
    size = statSync(file).size;
  }
  catch {
    return undefined;
  }
  if (size < follow.offset) {
    follow.offset = 0;
    follow.remainder = Buffer.alloc(0);
  }
  if (size === follow.offset)
    return undefined;
  const length = size - follow.offset;
  const chunk = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, chunk, 0, length, follow.offset);
  }
  finally {
    closeSync(fd);
  }
  follow.offset = size;
  return chunk;
}

/**
 * Turns complete JSONL lines into timeline elements.
 * A record whose text matches a still-unclaimed `claimable` message is the ACP echo
 * of a turn the page already shows. Each of those messages can absorb one record.
 */
export function projectCodebuddyCliGrowth(
  follow: CodebuddyCliFollow,
  chunk: Buffer,
  messages: ChatElement[],
  claimable: ReadonlySet<string>,
): CodebuddyCliProjection {
  const combined = follow.remainder.length === 0 ? chunk : Buffer.concat([follow.remainder, chunk]);
  const newline = combined.lastIndexOf(0x0A);
  if (newline < 0) {
    follow.remainder = combined;
    return { append: [], patches: [] };
  }
  follow.remainder = Buffer.from(combined.subarray(newline + 1));
  const append: ChatElement[] = [];
  const patches: CodebuddyToolPatch[] = [];
  for (const raw of combined.subarray(0, newline).toString('utf8').split('\n')) {
    if (raw.trim().length === 0)
      continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    }
    catch {
      continue;
    }
    const projected = projectRecord(follow, record, messages, claimable);
    if (!projected)
      continue;
    if (projected.kind === 'append') {
      append.push(projected.element);
      continue;
    }
    const fresh = append.find(element => element.id === projected.patch.id);
    if (fresh?.type === 'tool') {
      fresh.status = projected.patch.status;
      fresh.details = projected.patch.details;
      continue;
    }
    patches.push(projected.patch);
  }
  return { append, patches };
}

type Projected
  = | { kind: 'append'; element: ChatElement }
    | { kind: 'patch'; patch: CodebuddyToolPatch };

function projectRecord(
  follow: CodebuddyCliFollow,
  record: unknown,
  messages: ChatElement[],
  claimable: ReadonlySet<string>,
): Projected | undefined {
  if (!isRecord(record) || typeof record.type !== 'string' || typeof record.id !== 'string')
    return undefined;
  const key = `${record.type}:${record.id}`;
  if (follow.seen.has(key))
    return undefined;
  if (record.type === 'message' && record.role === 'user') {
    const text = codebuddyDiskUserText(record, blockText(record.content, new Set(['input_text', 'text'])));
    if (!text)
      return undefined;
    follow.seen.add(key);
    if (claimText(follow, messages, claimable, message => message.type === 'human' && message.text.trim() === text))
      return undefined;
    return { kind: 'append', element: humanElement(follow, text, timestampOf(record)) };
  }
  if (record.type === 'message' && record.role === 'assistant') {
    if (record.status !== 'completed')
      return undefined;
    const text = blockText(record.content, new Set(['output_text', 'text']));
    if (!text)
      return undefined;
    follow.seen.add(key);
    if (claimText(follow, messages, claimable, message => message.type === 'assistant' && message.text.trim() === text))
      return undefined;
    return { kind: 'append', element: assistantElement(follow, text, timestampOf(record)) };
  }
  if (record.type === 'reasoning') {
    const text = reasoningText(record);
    if (!text)
      return undefined;
    follow.seen.add(key);
    if (claimText(follow, messages, claimable, message => message.type === 'thought' && (message.detail ?? '').trim() === text))
      return undefined;
    return { kind: 'append', element: thoughtElement(follow, text, timestampOf(record)) };
  }
  if (record.type === 'function_call') {
    const callId = typeof record.callId === 'string' ? record.callId : '';
    const name = typeof record.name === 'string' ? record.name : '';
    if (!callId || !name)
      return undefined;
    follow.seen.add(key);
    const described = describeTool(name, record.arguments);
    if (claimText(follow, messages, claimable, message => message.type === 'tool' && sameTool(message, callId, name, described.action))) {
      follow.echoedCalls.add(callId);
      return undefined;
    }
    const element = toolElement(follow, described, timestampOf(record));
    follow.diskTools.set(callId, element.id);
    return { kind: 'append', element };
  }
  if (record.type === 'function_call_result') {
    const callId = typeof record.callId === 'string' ? record.callId : '';
    if (!callId)
      return undefined;
    follow.seen.add(key);
    if (follow.echoedCalls.has(callId))
      return undefined;
    const id = follow.diskTools.get(callId);
    if (!id)
      return undefined;
    return {
      kind: 'patch',
      patch: {
        id,
        status: record.status === 'completed' ? 'completed' : 'error',
        details: outputText(record.output),
      },
    };
  }
  return undefined;
}

function claimText(
  follow: CodebuddyCliFollow,
  messages: ChatElement[],
  claimable: ReadonlySet<string>,
  matches: (message: ChatElement) => boolean,
): boolean {
  for (const message of messages) {
    if (!claimable.has(message.id) || follow.claimed.has(message.id) || message.id.startsWith('disk-'))
      continue;
    if (!matches(message))
      continue;
    follow.claimed.add(message.id);
    return true;
  }
  return false;
}

function sameTool(message: ToolCallElement, callId: string, name: string, action: string): boolean {
  if (message.toolCallId === callId || message.id === `tool:${callId}`)
    return true;
  return message.toolName === name && message.action === action;
}

interface DescribedTool {
  action: string;
  details: string;
  filename?: string;
  toolName: string;
}

function describeTool(name: string, argsJson: unknown): DescribedTool {
  const args = parseArgs(argsJson);
  const query = stringField(args, 'query');
  const file = stringField(args, 'file_path', 'path', 'file', 'filename');
  const command = stringField(args, 'command', 'cmd');
  if (name === 'WebSearch' || name === 'web_search') {
    return { action: query ? `Search(${clip(query, 80)})` : 'Search', details: '', toolName: name };
  }
  if (file)
    return { action: `${name} ${file.split('/').at(-1) ?? file}`, details: '', filename: file, toolName: name };
  if (command)
    return { action: clip(command, 80), details: command, toolName: name };
  return { action: name, details: '', toolName: name };
}

function humanElement(follow: CodebuddyCliFollow, text: string, createdAt: number | undefined): ChatElement {
  return {
    type: 'human',
    id: nextDiskId(follow, 'h'),
    flatIndex: 0,
    text,
    mentions: [],
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

function assistantElement(follow: CodebuddyCliFollow, text: string, createdAt: number | undefined): ChatElement {
  return {
    type: 'assistant',
    id: nextDiskId(follow, 'a'),
    flatIndex: 0,
    text,
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

function thoughtElement(follow: CodebuddyCliFollow, text: string, createdAt: number | undefined): ChatElement {
  return {
    type: 'thought',
    id: nextDiskId(follow, 't'),
    flatIndex: 0,
    duration: '',
    detail: text,
    thoughtKind: 'thinking_step',
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

function toolElement(follow: CodebuddyCliFollow, described: DescribedTool, createdAt: number | undefined): ToolCallElement {
  const id = nextDiskId(follow, 'tool');
  return {
    type: 'tool',
    id,
    flatIndex: 0,
    toolCallId: id,
    status: 'loading',
    action: described.action,
    summaryText: described.action,
    details: described.details,
    toolName: described.toolName,
    ...(described.filename ? { filename: described.filename } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

function nextDiskId(follow: CodebuddyCliFollow, kind: string): string {
  const id = `disk-${kind}-${follow.nextId}`;
  follow.nextId += 1;
  return id;
}

/**
 * A local slash command is stored as a command envelope. Anything else on the
 * disk log is shown only when CodeBuddy marked it as typed locally.
 */
export function codebuddySlashCommand(text: string): string | undefined {
  const named = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim();
  const labeled = text.match(/<command-message>([\s\S]*?)<\/command-message>/)?.[1]?.trim();
  const name = named || labeled;
  if (!name)
    return undefined;
  const command = name.startsWith('/') ? name : `/${name}`;
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
  return args ? `${command} ${args}` : command;
}

function codebuddyDiskUserText(record: Record<string, unknown>, text: string): string | undefined {
  if (!text)
    return undefined;
  const command = codebuddySlashCommand(text);
  if (command)
    return command;
  if (record.__codebuddyLocal === true)
    return text;
  return undefined;
}

function reasoningText(record: Record<string, unknown>): string {
  const raw = blockText(record.rawContent, new Set(['reasoning_text', 'text']));
  if (raw)
    return raw;
  return blockText(record.content, new Set(['reasoning_text', 'text']));
}

function blockText(content: unknown, types: Set<string>): string {
  if (!Array.isArray(content))
    return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item) || typeof item.text !== 'string' || !types.has(String(item.type)))
      continue;
    if (item.text.trim().length > 0)
      parts.push(item.text);
  }
  return parts.join('\n').trim();
}

function outputText(output: unknown): string {
  if (typeof output === 'string')
    return output;
  if (isRecord(output) && typeof output.text === 'string')
    return output.text;
  return '';
}

function parseArgs(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value))
    return value;
  if (typeof value !== 'string')
    return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  }
  catch {
    return undefined;
  }
}

function stringField(args: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!args)
    return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0)
      return value.trim();
  }
  return undefined;
}

function timestampOf(record: Record<string, unknown>): number | undefined {
  return typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
    ? record.timestamp
    : undefined;
}

function clip(text: string, max: number): string {
  if (text.length <= max)
    return text;
  return `${text.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
