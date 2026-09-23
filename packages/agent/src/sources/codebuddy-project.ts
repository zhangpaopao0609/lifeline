/**
 * CodeBuddy disk projection: index + message files → ChatElement[].
 * Pure function: no IO, no markdown rendering.
 *
 * Index-driven: files whose id is not in the conversation index are ghosts
 * and must be skipped. One toolCallId → one tool card.
 */

import type {
  AssistantMessage,
  ChatElement,
  HumanMessage,
  ThoughtBlock,
  ToolCallElement,
} from '../types.js';

export interface CodeBuddyIndexEntry {
  id: string;
  type?: string;
  role?: string;
  isComplete?: boolean;
}

export interface CodeBuddyContentBlock {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

export interface CodeBuddyMessageBody {
  role?: string;
  content?: CodeBuddyContentBlock[];
}

export interface CodeBuddyMessageFile {
  id?: string;
  role?: string;
  createdAt?: string | number;
  message?: string | CodeBuddyMessageBody;
  extra?: string | Record<string, unknown>;
}

interface ParsedMessage {
  id: string;
  role: string;
  createdAt: number;
  complete: boolean;
  blocks: CodeBuddyContentBlock[];
  extra: Record<string, unknown>;
}

interface ToolAcc {
  toolCallId: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  extraStatus?: string;
  isError?: boolean;
}

type ToolStatus = ToolCallElement['status'];

const TOOL_LABELS: Record<string, string> = {
  read_file: 'Read file',
  read_file_v2: 'Read file',
  edit_file: 'Edit file',
  write_file: 'Write file',
  grep_search: 'Search',
  glob_file_search: 'Find files',
  run_command: 'Run command',
  web_search: 'Web search',
};

export function parseTs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v))
    return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

export function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (raw == null)
    return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw) as unknown;
      return p && typeof p === 'object' && !Array.isArray(p)
        ? (p as Record<string, unknown>)
        : {};
    }
    catch {
      return {};
    }
  }
  return {};
}

function parseBody(message: unknown): CodeBuddyMessageBody {
  let body: unknown = message;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body) as unknown;
    }
    catch {
      return {};
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return {};
  return body as CodeBuddyMessageBody;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** CodeBuddy stores the prompt envelope; the IDE bubble is only <user_query>. */
export function visibleCodeBuddyUserText(text: string): string {
  const query = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (query)
    return query[1].trim();
  return text
    .replace(/<user_info>[\s\S]*?<\/user_info>/g, '')
    .replace(/<rules>[\s\S]*?<\/rules>/g, '')
    .replace(/<additional_data>[\s\S]*?<\/additional_data>/g, '')
    .trim();
}

function pickCommand(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    return undefined;
  const a = args as Record<string, unknown>;
  return str(a.command) ?? str(a.query) ?? str(a.targetFile);
}

function pickFilename(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    return undefined;
  const a = args as Record<string, unknown>;
  return (
    str(a.path)
    ?? str(a.filePath)
    ?? str(a.targetFile)
    ?? str(a.relativeWorkspacePath)
  );
}

function mapToolStatus(t: ToolAcc): ToolStatus {
  const s = (t.extraStatus ?? '').toLowerCase();
  if (s === 'executed' || s === 'success' || s === 'completed')
    return 'completed';
  if (s === 'error' || s === 'failed')
    return 'error';
  if (s === 'cancelled' || s === 'canceled')
    return 'cancelled';
  if (s === 'loading' || s === 'pending' || s === 'running')
    return 'loading';
  if (t.isError)
    return 'error';
  if (t.result != null)
    return 'completed';
  return 'loading';
}

function toTool(t: ToolAcc, flatIndex: number): ToolCallElement {
  const name = t.toolName ?? 'tool';
  const filename = pickFilename(t.args);
  return {
    type: 'tool',
    id: t.toolCallId,
    flatIndex,
    toolCallId: t.toolCallId,
    status: mapToolStatus(t),
    action: TOOL_LABELS[name] ?? name,
    toolName: name,
    details: filename ?? '',
    filename,
    summaryText: filename ?? pickCommand(t.args) ?? (TOOL_LABELS[name] ?? name),
  };
}

function parseIndexed(
  index: CodeBuddyIndexEntry[],
  files: Map<string, CodeBuddyMessageFile>,
): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  for (const h of index) {
    const f = files.get(h.id);
    if (!f)
      continue;
    const body = parseBody(f.message);
    const role = f.role ?? h.role ?? body.role ?? '';
    out.push({
      id: h.id,
      role,
      createdAt: parseTs(f.createdAt),
      complete: h.isComplete !== false,
      blocks: Array.isArray(body.content) ? body.content : [],
      extra: parseJsonObject(f.extra),
    });
  }
  return out;
}

function collectTools(parsed: ParsedMessage[]): Map<string, ToolAcc> {
  const tools = new Map<string, ToolAcc>();
  const acc = (id: string): ToolAcc => {
    let t = tools.get(id);
    if (!t) {
      t = { toolCallId: id };
      tools.set(id, t);
    }
    return t;
  };

  for (const p of parsed) {
    const toolStatus = p.extra.toolStatus;
    if (toolStatus && typeof toolStatus === 'object' && !Array.isArray(toolStatus)) {
      for (const [cid, st] of Object.entries(
        toolStatus as Record<string, { status?: string }>,
      )) {
        if (st && typeof st === 'object' && st.status) {
          acc(cid).extraStatus = st.status;
        }
      }
    }
    for (const b of p.blocks) {
      if (b.type === 'tool-call' && b.toolCallId) {
        const t = acc(b.toolCallId);
        t.toolName = b.toolName ?? t.toolName;
        t.args = b.args ?? t.args;
      }
      if (b.type === 'tool-result' && b.toolCallId) {
        const t = acc(b.toolCallId);
        t.toolName = b.toolName ?? t.toolName;
        t.result = b.result ?? t.result;
        if (b.isError)
          t.isError = true;
      }
    }
  }
  return tools;
}

export interface CodeBuddyProjectOpts {
  includeProcess?: boolean;
}

export function projectCodeBuddy(
  index: CodeBuddyIndexEntry[],
  files: Map<string, CodeBuddyMessageFile>,
  opts?: CodeBuddyProjectOpts,
): ChatElement[] {
  const includeProcess = opts?.includeProcess !== false;
  const parsed = parseIndexed(index, files);
  const tools = collectTools(parsed);
  const emittedTools = new Set<string>();
  const messages: ChatElement[] = [];
  let flatIndex = 0;

  const emitTool = (toolCallId: string): void => {
    if (!includeProcess)
      return;
    if (emittedTools.has(toolCallId))
      return;
    const t = tools.get(toolCallId);
    if (!t)
      return;
    emittedTools.add(toolCallId);
    messages.push(toTool(t, flatIndex++));
  };

  for (const p of parsed) {
    if (p.role === 'user') {
      const text = visibleCodeBuddyUserText(
        p.blocks
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text as string)
          .join('\n'),
      );
      if (!text)
        continue;
      const msg: HumanMessage = {
        type: 'human',
        id: p.id,
        flatIndex: flatIndex++,
        text,
        mentions: [],
      };
      messages.push(msg);
      continue;
    }

    if (p.role === 'assistant') {
      for (const b of p.blocks) {
        if (includeProcess && b.type === 'reasoning' && b.text?.trim()) {
          const id = `${p.id}:think`;
          const prev = messages.find(m => m.id === id);
          if (prev && prev.type === 'thought') {
            prev.detail = [prev.detail, b.text].filter(Boolean).join('\n');
            continue;
          }
          const thought: ThoughtBlock = {
            type: 'thought',
            id,
            flatIndex: flatIndex++,
            duration: '',
            detail: b.text,
            thoughtKind: 'thinking_step',
          };
          messages.push(thought);
        }
        else if (b.type === 'text' && b.text?.trim()) {
          const prev = messages.find(m => m.id === p.id && m.type === 'assistant');
          if (prev && prev.type === 'assistant') {
            prev.text = [prev.text, b.text].filter(Boolean).join('\n');
            continue;
          }
          const msg: AssistantMessage = {
            type: 'assistant',
            id: p.id,
            flatIndex: flatIndex++,
            text: b.text,
          };
          messages.push(msg);
        }
        else if (b.type === 'tool-call' && b.toolCallId) {
          emitTool(b.toolCallId);
        }
      }
      continue;
    }

    if (p.role === 'tool') {
      for (const b of p.blocks) {
        if (b.type === 'tool-result' && b.toolCallId)
          emitTool(b.toolCallId);
      }
    }
  }

  return messages;
}
