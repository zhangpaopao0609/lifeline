/**
 * Pure mapping from Codex app-server shapes (v2 `ThreadItem`, `Model`, `Turn`) to what the Lifeline
 * ACP client renders. The web CLI timeline shows one line per tool call (the ACP `title`), so the
 * title carries the status and stays short; full output / diffs go into `content`.
 */

export type Json = Record<string, unknown>;

export const OUTPUT_TAIL = 4000;
export const DIFF_MAX = 6000;
export const TITLE_MAX = 72;
const PATH_MAX = 56;

export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const EFFORT_LABELS: Record<string, string> = {
  none: '不思考',
  minimal: '极少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
};

export type ToolStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled';
const STATUS_MARK: Record<ToolStatus, string> = { in_progress: '▸', completed: '✓', failed: '✗', cancelled: '⊘' };

export function isRecord(value: unknown): value is Json {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function head(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(text.length - max)}` : text;
}

export function oneLine(text: unknown, max = 160): string {
  return head(String(text ?? '').replace(/\s+/g, ' ').trim(), max);
}

export function textBlock(text: string): Json[] {
  return [{ type: 'content', content: { type: 'text', text } }];
}

/** Path relative to the session directory, middle-truncated so one row fits a phone. */
export function shortPath(cwd: string, path: unknown): string {
  let p = str(path);
  if (cwd && p.startsWith(`${cwd}/`))
    p = p.slice(cwd.length + 1);
  return p.length > PATH_MAX ? `…${p.slice(p.length - PATH_MAX + 1)}` : p;
}

/** `/bin/bash -lc 'git status'` → `git status`. */
export function shortCommand(command: unknown): string {
  let text = String(command ?? '').trim();
  const m = /^(?:\/usr)?(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(["'])([\s\S]*)\1$/.exec(text);
  if (m)
    text = m[2]!;
  return oneLine(text, TITLE_MAX);
}

export function toolStatus(status: unknown): ToolStatus {
  if (status === 'completed')
    return 'completed';
  if (status === 'failed')
    return 'failed';
  if (status === 'declined')
    return 'cancelled';
  return 'in_progress';
}

/** Status of an item that has finished (`item/completed`, or a replayed completed item). */
export function finalStatus(item: Json): ToolStatus {
  const status = item.status != null ? toolStatus(item.status) : (item.success === false ? 'failed' : 'completed');
  return status === 'in_progress' ? 'completed' : status;
}

function changePaths(item: Json): string[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return changes.map(c => (isRecord(c) ? str(c.path) : '')).filter(Boolean);
}

export interface ToolDescription {
  title: string;
  kind: 'execute' | 'edit' | 'read' | 'fetch' | 'other';
  locations?: Array<{ path: string }>;
}

/** Tool-like items become ACP tool calls; anything else (messages, reasoning, plan) returns null. */
export function describeTool(item: Json, cwd: string): ToolDescription | null {
  switch (item.type) {
    case 'commandExecution':
      return { title: `$ ${shortCommand(item.command)}`, kind: 'execute' };
    case 'fileChange': {
      const paths = changePaths(item);
      const first = paths[0] ? shortPath(cwd, paths[0]) : '文件';
      return {
        title: `✎ ${first}${paths.length > 1 ? ` 等 ${paths.length} 个文件` : ''}`,
        kind: 'edit',
        locations: paths.slice(0, 20).map(path => ({ path })),
      };
    }
    case 'mcpToolCall':
      return { title: oneLine(`${str(item.server)}.${str(item.tool)}`, TITLE_MAX), kind: 'other' };
    case 'dynamicToolCall':
      return { title: oneLine(`${item.namespace ? `${str(item.namespace)}.` : ''}${str(item.tool)}`, TITLE_MAX), kind: 'other' };
    case 'webSearch':
      return { title: `搜索: ${oneLine(item.query, TITLE_MAX - 4)}`, kind: 'fetch' };
    case 'collabAgentToolCall':
      return { title: oneLine(`子 Agent: ${str(item.tool)}${item.prompt ? ` · ${str(item.prompt)}` : ''}`, TITLE_MAX), kind: 'other' };
    case 'imageView':
      return { title: `查看图片 ${shortPath(cwd, item.path)}`, kind: 'read', locations: [{ path: str(item.path) }] };
    case 'imageGeneration':
      return { title: '生成图片', kind: 'other' };
    case 'contextCompaction':
      return { title: '压缩上下文', kind: 'other' };
    default:
      return null;
  }
}

/** The web CLI timeline renders only the title, so the status lives in it. */
export function toolTitle(item: Json, status: ToolStatus, cwd: string): string | undefined {
  const desc = describeTool(item, cwd);
  if (!desc)
    return undefined;
  const exit = item.type === 'commandExecution' && status === 'failed' && typeof item.exitCode === 'number' ? `（exit ${item.exitCode}）` : '';
  return `${STATUS_MARK[status]} ${desc.title}${exit}`;
}

export function changesDiff(item: Json): string {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return head(changes.map(c => (isRecord(c) ? `--- ${str(c.path)}\n${str(c.diff)}` : '')).join('\n'), DIFF_MAX);
}

export function toolContent(item: Json): Json[] | undefined {
  switch (item.type) {
    case 'commandExecution': {
      const out = tail(str(item.aggregatedOutput), OUTPUT_TAIL);
      const ms = typeof item.durationMs === 'number' ? ` · ${Math.round(item.durationMs)}ms` : '';
      const exit = typeof item.exitCode === 'number' ? `\n[exit ${item.exitCode}${ms}]` : '';
      return out || exit ? textBlock(`${out}${exit}`) : undefined;
    }
    case 'fileChange': {
      const diff = changesDiff(item);
      return diff ? textBlock(diff) : undefined;
    }
    case 'mcpToolCall': {
      if (isRecord(item.error) && item.error.message)
        return textBlock(`错误: ${str(item.error.message)}`);
      const result = isRecord(item.result) && Array.isArray(item.result.content) ? item.result.content : [];
      const text = head(result.map(c => (isRecord(c) && typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\n'), OUTPUT_TAIL);
      return text ? textBlock(text) : undefined;
    }
    default:
      return undefined;
  }
}

export function userText(item: Json): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content.filter(c => isRecord(c) && c.type === 'text').map(c => str((c as Json).text)).join('\n').trim();
}

/** One row for a finished turn in a history replay: "· 命令 5 条（失败 1），改动 3 个文件". */
export function turnSummary(items: readonly Json[], cwd: string): string {
  let commands = 0;
  let failed = 0;
  let tools = 0;
  const files = new Set<string>();
  for (const item of items) {
    if (item.type === 'commandExecution') {
      commands++;
      if (item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0))
        failed++;
    }
    else if (item.type === 'fileChange') {
      for (const path of changePaths(item))
        files.add(path);
    }
    else if (describeTool(item, cwd)) {
      tools++;
    }
  }
  const parts: string[] = [];
  if (commands)
    parts.push(`命令 ${commands} 条${failed ? `（失败 ${failed}）` : ''}`);
  if (files.size)
    parts.push(`改动 ${files.size} 个文件`);
  if (tools)
    parts.push(`其他工具 ${tools} 次`);
  return parts.length ? `· ${parts.join('，')}` : '';
}

// ---------- models ----------

export interface CodexModel {
  id: string;
  displayName: string;
  description: string;
  efforts: string[];
  defaultEffort?: string;
  isDefault?: boolean;
}

/** `model/list` rows → visible models. Hidden rows are dropped. */
export function readModels(rows: readonly unknown[]): CodexModel[] {
  const out: CodexModel[] = [];
  for (const row of rows) {
    if (!isRecord(row) || row.hidden === true)
      continue;
    const id = str(row.id) || str(row.model);
    if (!id)
      continue;
    const efforts = (Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts : [])
      .map(e => (isRecord(e) ? str(e.reasoningEffort) : ''))
      .filter(Boolean);
    out.push({
      id,
      displayName: str(row.displayName) || id,
      description: str(row.description),
      efforts,
      ...(str(row.defaultReasoningEffort) ? { defaultEffort: str(row.defaultReasoningEffort) } : {}),
      ...(row.isDefault === true ? { isDefault: true } : {}),
    });
  }
  return out;
}

export function effortLabel(value: string): string {
  return EFFORT_LABELS[value] ? `${EFFORT_LABELS[value]} (${value})` : value;
}

/** Keep `wanted` when the model allows it, else the model default. */
export function pickEffort(models: readonly CodexModel[], modelId: string | undefined, wanted: string | undefined): string | undefined {
  const model = models.find(m => m.id === modelId);
  if (!model)
    return wanted;
  if (wanted && (model.efforts.length === 0 || model.efforts.includes(wanted)))
    return wanted;
  return model.defaultEffort ?? model.efforts[0] ?? wanted;
}

/**
 * `models` + `configOptions` for `session/new` / `session/load`. The ids `model` and `thought_level`
 * (category `thought_level`) are what Lifeline's catalog reader binds to `session/set_config_option`;
 * `_meta.effortOptions` gives each model its own effort list.
 */
export function sessionModelsPayload(models: readonly CodexModel[], modelId: string | undefined, effort: string | undefined): Json {
  const union = [...new Set(models.flatMap(m => m.efforts))]
    .sort((a, b) => EFFORT_ORDER.indexOf(a as typeof EFFORT_ORDER[number]) - EFFORT_ORDER.indexOf(b as typeof EFFORT_ORDER[number]));
  const configOptions: Json[] = [{
    id: 'model',
    name: '模型',
    category: 'model',
    type: 'select',
    currentValue: modelId ?? null,
    options: models.map(m => ({ value: m.id, name: m.displayName })),
  }];
  if (union.length > 0) {
    configOptions.push({
      id: 'thought_level',
      name: '思考强度',
      category: 'thought_level',
      type: 'select',
      currentValue: effort && union.includes(effort) ? effort : union[0],
      options: union.map(v => ({ value: v, name: effortLabel(v) })),
    });
  }
  return {
    models: {
      currentModelId: modelId ?? null,
      availableModels: models.map(m => ({
        modelId: m.id,
        name: m.displayName,
        description: m.description || null,
        _meta: { effortOptions: m.efforts.map(v => ({ value: v, name: effortLabel(v) })) },
      })),
    },
    configOptions,
  };
}

// ---------- prompts ----------

/** ACP prompt content blocks → one text input for `turn/start`. */
export function promptText(blocks: unknown): string {
  const parts: string[] = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!isRecord(block))
      continue;
    if (block.type === 'text' && typeof block.text === 'string')
      parts.push(block.text);
    else if (block.type === 'resource_link' && typeof block.uri === 'string')
      parts.push(block.uri.replace(/^file:\/\//, ''));
    else if (block.type === 'resource' && isRecord(block.resource) && typeof block.resource.text === 'string')
      parts.push(block.resource.text);
  }
  return parts.join('\n');
}
