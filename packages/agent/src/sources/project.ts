/**
 * Content-live projection: disk bubbles → ChatElement[].
 * Pure function: no IO, no markdown rendering.
 *
 * Index-driven: only bubbles listed in the conversation header index are
 * emitted. Extra bubbles in the map are ghosts and must be skipped.
 */

import type {
  AssistantMessage,
  ChatElement,
  CodeBlockItem,
  HumanMessage,
  PlanTodo,
  ThoughtBlock,
  TodoListBlock,
  ToolCallElement,
} from '../types.js';
import type { Bubble } from './cursor-adapter.js';
import type { MessageHeader } from './types.js';

type ToolStatus = ToolCallElement['status'];

/** Tool name → human-readable label. */
const TOOL_LABELS: Record<string, string> = {
  read_file_v2: 'Read file',
  edit_file_v2: 'Edit file',
  ripgrep_raw_search: 'Search',
  run_terminal_command_v2: 'Run command',
  todo_write: 'Update todos',
  glob_file_search: 'Find files',
  task_v2: 'Subagent task',
  switch_mode: 'Switch mode',
  create_plan: 'Create plan',
  delete_file: 'Delete file',
  web_search: 'Web search',
  read_lints: 'Read lints',
  web_fetch: 'Fetch URL',
  await: 'Await',
  get_mcp_tools: 'Get MCP tools',
};

/**
 * Params are a JSON string or an object depending on the tool.
 * Normalize once; do not branch on tool name.
 */
function parseParams(raw: unknown): Record<string, unknown> {
  if (raw == null)
    return {};
  if (typeof raw === 'object')
    return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
    }
    catch {
      return {};
    }
  }
  return {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function pickFilename(params: Record<string, unknown>): string | undefined {
  return (
    str(params.relativeWorkspacePath)
    ?? str(params.targetFile)
    ?? str(params.filePath)
    ?? str(params.path)
    ?? str(params.effectiveUri)
    ?? str(params.targetDirectory)
  );
}

function pickOutput(result: unknown): string | undefined {
  if (result == null)
    return undefined;
  if (typeof result === 'string')
    return result || undefined;
  if (typeof result !== 'object')
    return undefined;
  const r = result as Record<string, unknown>;
  return (
    str(r.output)
    ?? str(r.contents)
    ?? str(r.stdout)
    ?? str(r.text)
    ?? str(r.content)
  );
}

function mapStatus(s: string | undefined): ToolStatus {
  switch (s) {
    case 'loading':
      return 'loading';
    case 'error':
      return 'error';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'completed';
  }
}

function summarize(
  name: string,
  params: Record<string, unknown>,
  filename?: string,
): string {
  switch (name) {
    case 'run_terminal_command_v2':
      return str(params.command) ?? '';
    case 'ripgrep_raw_search':
      return str(params.pattern) ?? '';
    case 'glob_file_search':
      return str(params.globPattern) ?? '';
    case 'web_search':
      return str(params.query) ?? '';
    case 'web_fetch':
      return str(params.url) ?? '';
    case 'task_v2':
      return str(params.description) ?? '';
    case 'switch_mode':
      return str(params.toModeId) ?? '';
    default:
      return filename ?? '';
  }
}

function parseTodos(raw: unknown): PlanTodo[] {
  if (!Array.isArray(raw))
    return [];
  return raw
    .map((t) => {
      if (!t || typeof t !== 'object')
        return null;
      const o = t as Record<string, unknown>;
      const text = str(o.content) ?? str(o.text);
      if (!text)
        return null;
      const s = str(o.status) ?? 'pending';
      const status: PlanTodo['status']
        = s === 'completed' || s === 'in_progress' ? s : 'pending';
      return { text, status };
    })
    .filter((t): t is PlanTodo => t !== null);
}

export interface ProjectOpts {
  /** Default true. false skips thought + tool (todo_list stays). */
  includeProcess?: boolean;
}

export interface ProjectResult {
  messages: ChatElement[];
  stats: {
    human: number;
    assistant: number;
    tool: number;
    thought: number;
    todo: number;
    /** Index entry with no matching bubble. */
    missing: number;
    /** Index entry whose bubble produced nothing renderable. */
    empty: number;
    withDiff: number;
    withOutput: number;
    toolNames: Record<string, number>;
  };
}

export function project(
  index: MessageHeader[],
  bubbles: Bubble[],
  diffs: Map<string, CodeBlockItem> = new Map(),
  opts?: ProjectOpts,
): ProjectResult {
  const includeProcess = opts?.includeProcess !== false;
  const byId = new Map(bubbles.map(b => [b.bubbleId, b]));
  const messages: ChatElement[] = [];
  const stats: ProjectResult['stats'] = {
    human: 0,
    assistant: 0,
    tool: 0,
    thought: 0,
    todo: 0,
    missing: 0,
    empty: 0,
    withDiff: 0,
    withOutput: 0,
    toolNames: {},
  };

  let flatIndex = 0;

  for (const h of index) {
    const b = byId.get(h.messageId);
    if (!b) {
      stats.missing++;
      continue;
    }

    if (h.role === 'human') {
      const text = (b.text || '').trim();
      if (!text) {
        stats.empty++;
        continue;
      }
      const msg: HumanMessage = {
        type: 'human',
        id: b.bubbleId,
        flatIndex: flatIndex++,
        text,
        mentions: [],
      };
      messages.push(msg);
      stats.human++;
      continue;
    }

    let emitted = false;

    const thinking = b.thinking?.trim();
    if (includeProcess && thinking) {
      const thought: ThoughtBlock = {
        type: 'thought',
        id: `${b.bubbleId}:think`,
        flatIndex: flatIndex++,
        duration: b.thinkingDurationMs ? `${b.thinkingDurationMs}ms` : '',
        detail: thinking,
        thoughtKind: 'thinking_step',
      };
      messages.push(thought);
      stats.thought++;
      emitted = true;
    }

    const tfd = b.toolFormerData;
    if (tfd?.name) {
      const name = tfd.name;
      stats.toolNames[name] = (stats.toolNames[name] ?? 0) + 1;
      const params = parseParams(tfd.params);
      const filename = pickFilename(params);

      if (name === 'todo_write') {
        const todos = parseTodos(params.todos);
        if (todos.length > 0) {
          const block: TodoListBlock = {
            type: 'todo_list',
            id: b.bubbleId,
            flatIndex: flatIndex++,
            title: 'To-dos',
            todosCompleted: todos.filter(t => t.status === 'completed').length,
            todosTotal: todos.length,
            todos,
          };
          messages.push(block);
          stats.todo++;
          emitted = true;
        }
      }
      else if (includeProcess) {
        const output = pickOutput(tfd.result);
        if (output)
          stats.withOutput++;
        const diffBlock = diffs.get(b.bubbleId);
        if (diffBlock)
          stats.withDiff++;

        const tool: ToolCallElement = {
          type: 'tool',
          id: b.bubbleId,
          flatIndex: flatIndex++,
          toolCallId: tfd.toolCallId ?? b.bubbleId,
          status: mapStatus(tfd.status),
          action: TOOL_LABELS[name] ?? name,
          toolName: name,
          details: filename ?? '',
          filename,
          summaryText: summarize(name, params, filename),
          diffBlock,
        };
        messages.push(tool);
        stats.tool++;
        emitted = true;
      }
    }

    const text = (b.text || '').trim();
    if (text) {
      const msg: AssistantMessage = {
        type: 'assistant',
        id: b.bubbleId,
        flatIndex: flatIndex++,
        text: b.text,
      };
      messages.push(msg);
      stats.assistant++;
      emitted = true;
    }

    if (!emitted)
      stats.empty++;
  }

  return { messages, stats };
}
