import type { IdeKind, ToolCallElement } from '../net/protocol';

/**
 * Cursor's collapsed activity line.
 *
 * A run of tool calls becomes one sentence: "Explored 14 files, 15 searches"
 * or "Edited 4 files, explored 1 file, 2 searches, ran 1 command".
 * The verb is the action; the rest is the details. Diff totals sit after that.
 */

export interface ActivitySummary {
  action: string;
  details: string;
  additions?: number;
  deletions?: number;
}

type Bucket = 'read' | 'dir' | 'search' | 'fetch' | 'lint' | 'shell' | 'edit' | 'delete' | 'mcp' | 'task' | 'other';

function bucketOf(tool: ToolCallElement): Bucket {
  const name = (tool.toolName || tool.action || '').toLowerCase().replace(/\s+/g, '_');
  if (name.includes('lint'))
    return 'lint';
  if (name.includes('delete'))
    return 'delete';
  if (/edit|strreplace|search_replace|notebook|^write/.test(name))
    return 'edit';
  if (/terminal|shell|^bash$|run_command|command_v2/.test(name))
    return 'shell';
  if (name.includes('fetch'))
    return 'fetch';
  if (/grep|ripgrep|glob|sem_search|codebase_search|web_search|search/.test(name))
    return 'search';
  if (/list_dir|^ls$|directory/.test(name))
    return 'dir';
  if (name.includes('read'))
    return 'read';
  if (name.includes('mcp'))
    return 'mcp';
  if (/task|subagent/.test(name))
    return 'task';
  return 'other';
}

function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

interface Part {
  text: string;
}

function filePart(paths: string[], first: boolean): Part {
  if (first && paths.length === 1 && paths[0])
    return { text: baseName(paths[0]) };
  return { text: plural(paths.length, 'file', 'files') };
}

function diffTotals(items: ToolCallElement[]): { additions: number; deletions: number } | undefined {
  let additions = 0;
  let deletions = 0;
  let any = false;
  for (const tool of items) {
    if (typeof tool.additions === 'number' || typeof tool.deletions === 'number') {
      additions += tool.additions ?? 0;
      deletions += tool.deletions ?? 0;
      any = true;
      continue;
    }
    for (const line of tool.diffBlock?.diffLines ?? []) {
      if (line.kind === 'add') {
        additions += 1;
        any = true;
      }
      else if (line.kind === 'rem') {
        deletions += 1;
        any = true;
      }
    }
  }
  if (!any || (additions === 0 && deletions === 0))
    return undefined;
  return { additions, deletions };
}

export function activitySummary(items: ToolCallElement[]): ActivitySummary {
  const dirs: string[] = [];
  const readOnly: string[] = [];
  const editPaths: string[] = [];
  let searches = 0;
  let fetches = 0;
  let lints = 0;
  let commands = 0;
  let edits = 0;
  let deletes = 0;
  let mcp = 0;
  let tasks = 0;
  let other = 0;
  for (const tool of items) {
    const path = tool.filename || tool.details || '';
    switch (bucketOf(tool)) {
      case 'read':
        readOnly.push(path);
        break;
      case 'dir':
        dirs.push(path);
        break;
      case 'search':
        searches += 1;
        break;
      case 'fetch':
        fetches += 1;
        break;
      case 'lint':
        lints += 1;
        break;
      case 'shell':
        commands += 1;
        break;
      case 'edit':
        edits += 1;
        if (path)
          editPaths.push(path);
        break;
      case 'delete':
        deletes += 1;
        break;
      case 'mcp':
        mcp += 1;
        break;
      case 'task':
        tasks += 1;
        break;
      default:
        other += 1;
        break;
    }
  }

  const loading = items.some(tool => tool.status === 'loading');
  const fileChanges = edits + deletes;
  if (commands > 0 && commands === items.length) {
    return {
      action: loading ? 'Running' : 'Ran',
      details: plural(commands, 'command', 'commands'),
    };
  }

  const explore: Part[] = [];
  if (dirs.length > 0)
    explore.push({ text: plural(dirs.length, 'directory', 'directories') });
  if (readOnly.length > 0)
    explore.push(filePart(readOnly, explore.length === 0 && fileChanges === 0));
  if (searches > 0)
    explore.push({ text: plural(searches, 'search', 'searches') });
  if (fetches > 0)
    explore.push({ text: plural(fetches, 'fetch', 'fetches') });
  if (lints > 0)
    explore.push({ text: 'lints' });
  if (mcp + other > 0)
    explore.push({ text: plural(mcp + other, 'tool', 'tools') });

  const parts: string[] = [];
  if (fileChanges > 0) {
    const oneFile = fileChanges === 1 && editPaths.length === 1 ? baseName(editPaths[0]) : '';
    parts.push(oneFile || plural(fileChanges, 'file', 'files'));
    if (explore[0])
      explore[0] = { text: `explored ${explore[0].text}` };
  }
  parts.push(...explore.map(part => part.text));
  if (tasks > 0)
    parts.push(plural(tasks, 'agent', 'agents'));
  if (commands > 0)
    parts.push(`ran ${plural(commands, 'command', 'commands')}`);

  const stats = fileChanges > 0 ? diffTotals(items) : undefined;
  const action = edits === 0 && deletes > 0
    ? (loading ? 'Deleting' : 'Deleted')
    : fileChanges > 0
      ? (loading ? 'Editing' : 'Edited')
      : (loading ? 'Exploring' : 'Explored');
  return {
    action,
    details: parts.join(', '),
    additions: stats?.additions,
    deletions: stats?.deletions,
  };
}

/** Cursor's "Worked for" clock: ceil to seconds, then 1s / Ns / Nm / Nm Ys / Nh / Nh Ym. */
export function formatWorkDuration(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms <= 0)
    return undefined;
  const seconds = Math.ceil(ms / 1000);
  if (ms < 1000)
    return '1s';
  if (seconds < 60)
    return `${seconds}s`;
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function asMs(value: number): number {
  return value < 1e12 ? value * 1000 : value;
}

export interface WorkSegment {
  kind: string;
  key: string;
  el?: { type: string; createdAt?: number };
  items?: Array<{ status?: string; createdAt?: number }>;
}

export interface WorkHead {
  id: string;
  durationMs?: number;
  active: boolean;
}

/** Parallel to the segment list. `head` is the first row of a folded turn. */
export interface WorkMark {
  groupId: string;
  head?: WorkHead;
}

function isHuman(seg: WorkSegment): boolean {
  return seg.kind === 'single' && seg.el?.type === 'human';
}

function isAssistant(seg: WorkSegment): boolean {
  return seg.kind === 'single' && seg.el?.type === 'assistant';
}

function timesOf(seg: WorkSegment): number[] {
  const out: number[] = [];
  if (typeof seg.el?.createdAt === 'number' && seg.el.createdAt > 0)
    out.push(asMs(seg.el.createdAt));
  for (const item of seg.items ?? []) {
    if (typeof item.createdAt === 'number' && item.createdAt > 0)
      out.push(asMs(item.createdAt));
  }
  return out;
}

function turnDuration(turn: WorkSegment[]): number | undefined {
  const times = turn.flatMap(timesOf);
  if (times.length < 2)
    return undefined;
  const span = Math.max(...times) - Math.min(...times);
  return span > 0 ? span : undefined;
}

function turnActive(turn: WorkSegment[]): boolean {
  for (const seg of turn) {
    if (seg.kind === 'single' && seg.el?.type === 'loading')
      return true;
    if (seg.items?.some(item => item.status === 'loading'))
      return true;
  }
  return false;
}

/**
 * Fold one agent turn the way Cursor does.
 * The last assistant message stays outside, and so does anything after it.
 * Every earlier reply, thought, and tool in the turn collapses under "Worked for".
 * The clock is that folded span, not the final answer.
 */
function foldTurn(turn: WorkSegment[], marks: Array<WorkMark | undefined>, offset: number): void {
  let lastAssistant = -1;
  for (let i = turn.length - 1; i >= 0; i--) {
    if (isAssistant(turn[i])) {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant <= 0)
    return;
  const inside = turn.slice(0, lastAssistant);
  const id = `work:${inside[0].key}`;
  const durationMs = turnDuration(inside);
  const active = turnActive(turn);
  for (let i = 0; i < inside.length; i++) {
    marks[offset + i] = i === 0
      ? { groupId: id, head: { id, durationMs, active } }
      : { groupId: id };
  }
}

/**
 * One mark per segment. Undefined = render the segment on its own.
 * The fold is Cursor's: its transcript shows "Worked for 18m". CodeBuddy has no such row, so its
 * turns stay flat — a header there would be invented, not mirrored.
 */
export function markWork(segments: WorkSegment[], ide: IdeKind): Array<WorkMark | undefined> {
  const marks: Array<WorkMark | undefined> = segments.map(() => undefined);
  if (ide !== 'cursor')
    return marks;
  let i = 0;
  while (i < segments.length) {
    if (!isHuman(segments[i])) {
      i += 1;
      continue;
    }
    i += 1;
    const start = i;
    while (i < segments.length && !isHuman(segments[i]))
      i += 1;
    foldTurn(segments.slice(start, i), marks, start);
  }
  return marks;
}
