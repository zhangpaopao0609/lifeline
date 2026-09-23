import type { PlanTodo } from '../../types.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export interface PlanFileData {
  todos: PlanTodo[];
  body: string;
}

export function readPlanFile(label: string): PlanFileData | null {
  const planPath = resolve(homedir(), '.cursor', 'plans', label);
  try {
    const raw = readFileSync(planPath, 'utf-8');
    return parsePlanMd(raw);
  }
  catch {
    return null;
  }
}

export function parsePlanMd(raw: string): PlanFileData {
  const todos: PlanTodo[] = [];
  let body = raw;

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (fmMatch) {
    body = raw.slice(fmMatch[0].length);
    const fm = fmMatch[1];
    const todoRe = /- id:\s*\S+\n\s+content:\s*["']?(.*?)["']?[\t\v\f\r \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*\n\s+status:\s*(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = todoRe.exec(fm)) !== null) {
      const status = m[2] as PlanTodo['status'];
      todos.push({ text: m[1], status });
    }
  }

  return { todos, body: body.trim() };
}
