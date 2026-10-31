import type { ChatElement, PlanBlock, PlanTodo, ToolCallElement } from '@lifeline/protocol';
import {
  CLI_ELEMENT_MAX_BYTES,
  CLI_SESSION_BODY_MAX_BYTES,
  CLI_SESSION_BODY_MAX_ELEMENTS,
  wireBytes,
} from '@lifeline/protocol';
import { codebuddySlashCommand } from './codebuddy-cli-transcript.js';

export interface AcpTimelineSnapshot {
  messages: ChatElement[];
  truncatedBefore: boolean;
  firstRetainedFlatIndex: number | null;
}

export interface AcpHumanInput {
  clientMessageId: string;
  text: string;
}

interface OpenSegment {
  id: string;
  /** `null` is the no-messageId fallback segment. */
  messageKey: string | null;
}

const TEXT_FIELDS = new Set([
  'text',
  'detail',
  'action',
  'details',
  'summaryText',
  'title',
  'description',
  'label',
  'filename',
  'blocked',
  'duration',
  'toolName',
]);

/**
 * Maps one ACP session's `session/update` stream onto a bounded `ChatElement` list.
 * `apply` takes the update object (`params.update`), the value `AcpClient` already emits.
 */
export class AcpTimelineAssembler {
  private replayHuman = 0;
  private readonly messages: ChatElement[] = [];
  private readonly assistantSegments = new Map<string, number>();
  private nextFlatIndex = 0;
  private thoughtCounter = 0;
  private turnId = 1;
  private truncatedBefore = false;
  private openAssistant: OpenSegment | null = null;
  private openThought: OpenSegment | null = null;

  apply(update: unknown, options?: { replayUser?: boolean }): void {
    if (!isRecord(update) || typeof update.sessionUpdate !== 'string')
      return;
    // Live `user_message_chunk` is ignored. The human element comes from
    // appendHuman. `session/load` has no local send, so replay keeps those chunks.
    const kind = update.sessionUpdate;
    if (kind === 'user_message_chunk' && options?.replayUser) {
      this.applyReplayHuman(update);
      return;
    }
    if (kind === 'agent_message_chunk')
      this.applyAssistant(update);
    else if (kind === 'agent_thought_chunk')
      this.applyThought(update);
    else if (kind === 'tool_call' || kind === 'tool_call_update')
      this.applyTool(update);
    else if (kind === 'plan')
      this.applyPlan(update);
  }

  /** A finished record from the CLI's own session file. `flatIndex` is assigned here. */
  insertPrepared(element: ChatElement): void {
    if (this.messages.some(message => message.id === element.id))
      return;
    this.boundary();
    this.place({ ...element, flatIndex: this.allocate() });
  }

  /** Fills in a tool card once its result line arrives. */
  updatePrepared(id: string, mutate: (element: ChatElement) => void): void {
    const existing = this.find(id);
    if (!existing)
      return;
    mutate(existing);
    this.refit(existing);
  }

  appendHuman(input: AcpHumanInput): void {
    const id = `human:${input.clientMessageId}`;
    const existing = this.find(id);
    if (existing?.type === 'human') {
      existing.text = input.text;
      this.refit(existing);
      return;
    }
    this.boundary();
    this.place({
      type: 'human',
      id,
      flatIndex: this.allocate(),
      text: input.text,
      mentions: [],
    });
  }

  /** Closes the open text segment and starts a new plan turn. */
  endTurn(): void {
    this.boundary();
    this.turnId += 1;
  }

  snapshot(): AcpTimelineSnapshot {
    return this.view();
  }

  /** Drops the oldest elements until the body fits the session element and byte caps. */
  trim(): AcpTimelineSnapshot {
    while (this.overBudget()) {
      const removed = this.messages.shift();
      if (!removed)
        break;
      this.truncatedBefore = true;
      if (this.openAssistant?.id === removed.id)
        this.openAssistant = null;
      if (this.openThought?.id === removed.id)
        this.openThought = null;
    }
    return this.view();
  }

  private applyReplayHuman(update: Record<string, unknown>): void {
    const raw = textFromBlock(update.content);
    if (!raw)
      return;
    const text = codebuddySlashCommand(raw) ?? raw;
    this.replayHuman += 1;
    this.appendHuman({ clientMessageId: `replay-${this.replayHuman}`, text });
  }

  private applyAssistant(update: Record<string, unknown>): void {
    const text = textFromBlock(update.content);
    if (text === undefined)
      return;
    const messageKey = messageKeyOf(update);
    if (this.openAssistant?.messageKey === messageKey) {
      this.appendText(this.openAssistant.id, text);
      this.openThought = null;
      return;
    }
    const segmentKey = messageKey ?? 'fallback';
    const segment = this.assistantSegments.get(segmentKey) ?? 0;
    this.assistantSegments.set(segmentKey, segment + 1);
    const id = `assistant:${segmentKey}:${segment}`;
    this.place({
      type: 'assistant',
      id,
      flatIndex: this.allocate(),
      text,
    });
    this.openAssistant = { id, messageKey };
    this.openThought = null;
  }

  private applyThought(update: Record<string, unknown>): void {
    const text = textFromBlock(update.content);
    if (text === undefined)
      return;
    this.openAssistant = null;
    const messageKey = messageKeyOf(update);
    if (messageKey !== null) {
      const id = `thought:${messageKey}`;
      const existing = this.find(id);
      if (existing?.type === 'thought') {
        this.appendText(id, text);
        this.openThought = { id, messageKey };
        return;
      }
      this.place({
        type: 'thought',
        id,
        flatIndex: this.allocate(),
        duration: '',
        detail: text,
        thoughtKind: 'thinking_step',
      });
      this.openThought = { id, messageKey };
      return;
    }
    if (this.openThought?.messageKey === null) {
      this.appendText(this.openThought.id, text);
      return;
    }
    this.thoughtCounter += 1;
    const id = `thought:${this.thoughtCounter}`;
    this.place({
      type: 'thought',
      id,
      flatIndex: this.allocate(),
      duration: '',
      detail: text,
      thoughtKind: 'thinking_step',
    });
    this.openThought = { id, messageKey: null };
  }

  private applyTool(update: Record<string, unknown>): void {
    const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
    if (toolCallId.length === 0)
      return;
    const existing = this.find(`tool:${toolCallId}`);
    if (existing?.type === 'tool') {
      this.mergeTool(existing, update);
      return;
    }
    this.boundary();
    const tool: ToolCallElement = {
      type: 'tool',
      id: `tool:${toolCallId}`,
      flatIndex: this.allocate(),
      toolCallId,
      status: mapToolStatus(update.status) ?? 'loading',
      action: actionOf(update) ?? '',
      details: detailsFromContent(update.content) ?? '',
    };
    const toolName = toolNameOf(update);
    if (toolName)
      tool.toolName = toolName;
    const filename = filenameOf(update);
    if (filename)
      tool.filename = filename;
    this.place(tool);
  }

  private mergeTool(tool: ToolCallElement, update: Record<string, unknown>): void {
    const status = mapToolStatus(update.status);
    if (status)
      tool.status = status;
    const action = actionOf(update);
    if (action !== undefined)
      tool.action = action;
    if ('content' in update) {
      const details = detailsFromContent(update.content);
      if (details !== undefined)
        tool.details = details;
    }
    const toolName = toolNameOf(update);
    if (toolName)
      tool.toolName = toolName;
    const filename = filenameOf(update);
    if (filename)
      tool.filename = filename;
    this.refit(tool);
  }

  private applyPlan(update: Record<string, unknown>): void {
    if (!Array.isArray(update.entries))
      return;
    const todos: PlanTodo[] = [];
    for (const entry of update.entries) {
      if (!isRecord(entry) || typeof entry.content !== 'string')
        continue;
      todos.push({ text: entry.content, status: mapPlanStatus(entry.status) });
    }
    const id = `plan:${this.turnId}`;
    const existing = this.find(id);
    if (todos.length === 0 && existing?.type !== 'plan')
      return;
    const title = todos[0]?.text ?? 'Plan';
    const todosCompleted = todos.filter(todo => todo.status === 'completed').length;
    if (existing?.type === 'plan') {
      existing.label = 'Plan';
      existing.title = title;
      existing.todosCompleted = todosCompleted;
      existing.todosTotal = todos.length;
      if (todos.length > 0)
        existing.todos = todos;
      else
        delete existing.todos;
      this.refit(existing);
      return;
    }
    const plan: PlanBlock = {
      type: 'plan',
      id,
      flatIndex: this.allocate(),
      label: 'Plan',
      title,
      todosCompleted,
      todosTotal: todos.length,
    };
    if (todos.length > 0)
      plan.todos = todos;
    this.place(plan);
  }

  private appendText(id: string, extra: string): void {
    const message = this.find(id);
    if (!message)
      return;
    if (message.type === 'assistant')
      message.text += extra;
    else if (message.type === 'thought')
      message.detail = `${message.detail ?? ''}${extra}`;
    else
      return;
    this.refit(message);
  }

  private boundary(): void {
    this.openAssistant = null;
    this.openThought = null;
  }

  private allocate(): number {
    const flatIndex = this.nextFlatIndex;
    this.nextFlatIndex += 1;
    return flatIndex;
  }

  private find(id: string): ChatElement | undefined {
    return this.messages.find(message => message.id === id);
  }

  private place(element: ChatElement): void {
    const fitted = shrinkElement(element);
    if (fitted)
      this.messages.push(fitted);
  }

  private refit(message: ChatElement): void {
    const index = this.messages.findIndex(item => item.id === message.id);
    if (index < 0)
      return;
    const fitted = shrinkElement(message);
    if (!fitted) {
      this.messages.splice(index, 1);
      if (this.openAssistant?.id === message.id)
        this.openAssistant = null;
      if (this.openThought?.id === message.id)
        this.openThought = null;
      return;
    }
    this.messages[index] = fitted;
  }

  private overBudget(): boolean {
    if (this.messages.length > CLI_SESSION_BODY_MAX_ELEMENTS)
      return true;
    return this.messages.length > 0 && wireBytes(this.messages) > CLI_SESSION_BODY_MAX_BYTES;
  }

  private view(): AcpTimelineSnapshot {
    const first = this.messages[0];
    return {
      messages: structuredClone(this.messages),
      truncatedBefore: this.truncatedBefore,
      firstRetainedFlatIndex: first ? first.flatIndex : null,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageKeyOf(update: Record<string, unknown>): string | null {
  return typeof update.messageId === 'string' && update.messageId.length > 0
    ? update.messageId
    : null;
}

function textFromBlock(content: unknown): string | undefined {
  if (!isRecord(content) || content.type !== 'text' || typeof content.text !== 'string')
    return undefined;
  return content.text;
}

function mapToolStatus(status: unknown): ToolCallElement['status'] | undefined {
  switch (status) {
    case 'pending':
    case 'in_progress':
      return 'loading';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'error';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return undefined;
  }
}

function mapPlanStatus(status: unknown): PlanTodo['status'] {
  if (status === 'completed' || status === 'in_progress' || status === 'pending')
    return status;
  return 'pending';
}

function actionOf(update: Record<string, unknown>): string | undefined {
  if (typeof update.title === 'string')
    return update.title;
  if (typeof update.kind === 'string' && update.kind.length > 0)
    return update.kind;
  return undefined;
}

function toolNameOf(update: Record<string, unknown>): string | undefined {
  return typeof update.name === 'string' && update.name.length > 0 ? update.name : undefined;
}

function filenameOf(update: Record<string, unknown>): string | undefined {
  if (!Array.isArray(update.locations))
    return undefined;
  const first = update.locations[0];
  if (!isRecord(first) || typeof first.path !== 'string' || first.path.length === 0)
    return undefined;
  return first.path;
}

function detailsFromContent(content: unknown): string | undefined {
  if (content === null)
    return '';
  if (!Array.isArray(content))
    return undefined;
  let text = '';
  for (const item of content) {
    if (!isRecord(item) || item.type !== 'content')
      continue;
    const part = textFromBlock(item.content);
    if (part)
      text += part;
  }
  return text;
}

interface TextLoc {
  parent: Record<string, unknown>;
  key: string;
  value: string;
}

function collectText(value: unknown, out: TextLoc[]): void {
  if (Array.isArray(value)) {
    for (const item of value)
      collectText(item, out);
    return;
  }
  if (!isRecord(value))
    return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') {
      if (TEXT_FIELDS.has(key))
        out.push({ parent: value, key, value: child });
      continue;
    }
    collectText(child, out);
  }
}

function alignCut(text: string, index: number): number {
  if (index <= 0)
    return 0;
  if (index >= text.length)
    return text.length;
  const code = text.charCodeAt(index);
  if (code >= 0xDC00 && code <= 0xDFFF)
    return index + 1;
  return index;
}

/**
 * Every text field that had content keeps a code-point-aligned suffix.
 * The shared suffix length is the longest one that still fits the element budget,
 * so one field is not emptied to preserve another.
 * If identity fields alone still exceed the cap, the element is omitted.
 */
function shrinkElement(element: ChatElement): ChatElement | undefined {
  if (wireBytes(element) <= CLI_ELEMENT_MAX_BYTES)
    return element;
  const current = structuredClone(element);
  const filled: TextLoc[] = [];
  collectText(current, filled);
  const originals = filled.filter(field => field.value.length > 0);
  if (originals.length > 0 && keepSharedSuffix(current, originals))
    return current;
  blankUntilFit(current);
  if (wireBytes(current) <= CLI_ELEMENT_MAX_BYTES)
    return current;
  const minimal = minimalElement(element);
  if (wireBytes(minimal) <= CLI_ELEMENT_MAX_BYTES)
    return minimal;
  return undefined;
}

function keepSharedSuffix(current: ChatElement, fields: TextLoc[]): boolean {
  if (!fitsWithSuffix(current, fields, 1))
    return false;
  let low = 1;
  let high = 0;
  for (const field of fields)
    high = Math.max(high, field.value.length);
  let best = 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (fitsWithSuffix(current, fields, mid)) {
      best = mid;
      low = mid + 1;
    }
    else {
      high = mid - 1;
    }
  }
  applySuffixes(fields, best);
  return wireBytes(current) <= CLI_ELEMENT_MAX_BYTES;
}

function fitsWithSuffix(current: ChatElement, fields: TextLoc[], maxChars: number): boolean {
  applySuffixes(fields, maxChars);
  return wireBytes(current) <= CLI_ELEMENT_MAX_BYTES;
}

function applySuffixes(fields: TextLoc[], maxChars: number): void {
  for (const field of fields)
    field.parent[field.key] = suffixOf(field.value, maxChars);
}

function suffixOf(text: string, maxChars: number): string {
  if (maxChars >= text.length)
    return text;
  if (maxChars <= 0)
    return '';
  return text.slice(alignCut(text, text.length - maxChars));
}

/** Last resort when one non-empty suffix per field cannot fit. */
function blankUntilFit(current: ChatElement): void {
  while (wireBytes(current) > CLI_ELEMENT_MAX_BYTES) {
    const locs: TextLoc[] = [];
    collectText(current, locs);
    let target: TextLoc | undefined;
    for (const loc of locs) {
      if (!target || loc.value.length > target.value.length)
        target = loc;
    }
    if (!target || target.value.length === 0)
      break;
    const original = target.value;
    let low = 0;
    let high = original.length;
    let best = original.length;
    while (low <= high) {
      const mid = (low + high) >> 1;
      target.parent[target.key] = original.slice(alignCut(original, mid));
      if (wireBytes(current) <= CLI_ELEMENT_MAX_BYTES) {
        best = mid;
        high = mid - 1;
      }
      else {
        low = mid + 1;
      }
    }
    const next = original.slice(alignCut(original, best));
    if (next.length >= original.length)
      break;
    target.parent[target.key] = next;
  }
}

function minimalElement(element: ChatElement): ChatElement {
  switch (element.type) {
    case 'human':
      return { type: 'human', id: element.id, flatIndex: element.flatIndex, text: '', mentions: [] };
    case 'assistant':
      return { type: 'assistant', id: element.id, flatIndex: element.flatIndex, text: '' };
    case 'tool':
      return {
        type: 'tool',
        id: element.id,
        flatIndex: element.flatIndex,
        toolCallId: element.toolCallId,
        status: element.status,
        action: '',
        details: '',
      };
    case 'thought':
      return { type: 'thought', id: element.id, flatIndex: element.flatIndex, duration: '' };
    case 'plan':
      return {
        type: 'plan',
        id: element.id,
        flatIndex: element.flatIndex,
        label: '',
        title: '',
        todosCompleted: 0,
        todosTotal: 0,
      };
    default:
      return element;
  }
}
