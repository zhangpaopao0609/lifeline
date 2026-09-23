/**
 * Session-stream probe (read-only): read Cursor's state.vscdb directly.
 *
 * Uses the system `sqlite3` CLI and **does not touch node-side better-sqlite3** — when pnpm's install did not compile the .node,
 * every adapter test fails dlopen (see CLAUDE.md item 9); this probe still works.
 *
 * Common:
 *   --list [--limit N]     recently updated sessions (title / id / time)
 *   --session <keyword>    a session's tool calls (name/status/params) and trailing bubbles
 *   --switches             switch_mode / mcp calls and status in recent sessions
 *                          (tell whether an approval "popped then timed out" vs "never popped")
 *   --modes                look up autoRejectedModeTransitions (mode-switch pairs the user permanently rejected)
 *
 * Usage:
 *   pnpm exec tsx scripts/probes/probe-session-db.ts --list
 *   pnpm exec tsx scripts/probes/probe-session-db.ts --session "server code redesign"
 *   pnpm exec tsx scripts/probes/probe-session-db.ts --switches
 */
import { execFileSync } from 'node:child_process';
import { DEFAULT_CURSOR_VSCDB } from '../packages/agent/src/content-runtime.js';

interface Row {
  [column: string]: string | number | null;
}

function flag(argv: string[], name: string): string {
  return argv.find((_, i, a) => a[i - 1] === `--${name}`) ?? '';
}

function query(sql: string): Row[] {
  let out = '';
  try {
    out = execFileSync('sqlite3', ['-json', DEFAULT_CURSOR_VSCDB, sql], { maxBuffer: 1 << 30 }).toString();
  }
  catch (err) {
    console.error(`[db] sqlite3 读取失败：${err instanceof Error ? err.message : err}`);
    console.error(`[db] 依赖系统 sqlite3 CLI；库路径 ${DEFAULT_CURSOR_VSCDB}`);
    process.exit(1);
  }
  return out.trim() ? (JSON.parse(out) as Row[]) : [];
}

interface SessionHead {
  id: string;
  title: string;
  updated: number;
}

function recentSessions(limit: number): SessionHead[] {
  return query(
    `SELECT composerId, value, lastUpdatedAt FROM composerHeaders ORDER BY lastUpdatedAt DESC LIMIT ${limit}`,
  ).map((r) => {
    let title = '(untitled)';
    try {
      title = (JSON.parse(String(r.value ?? '{}')) as { name?: string }).name || title;
    }
    catch { /* ignore */ }
    return { id: String(r.composerId), title, updated: Number(r.lastUpdatedAt ?? 0) };
  });
}

/**
 * createdAt has two shapes: old bubbles are epoch ms, new bubbles (_v:3) are ISO strings,
 * and some are simply missing — always normalize to ms so new Date() does not throw Invalid time value.
 */
function tsOf(value: unknown): number {
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0)
      return n;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function iso(ms: number): string {
  return ms > 0 ? new Date(ms).toISOString() : '(no ts)';
}

function bubblesOf(sessionId: string): Array<{ createdAt: number; value: Row }> {
  return query(`SELECT value FROM cursorDiskKV WHERE key LIKE 'bubbleId:${sessionId}:%'`)
    .map((r) => {
      let value: Row = {};
      try {
        value = JSON.parse(String(r.value ?? '{}')) as Row;
      }
      catch { /* ignore */ }
      return { createdAt: tsOf(value.createdAt), value };
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

function toolLines(sessionId: string, filter: RegExp = /./): string[] {
  const lines: string[] = [];
  for (const b of bubblesOf(sessionId)) {
    const tfd = b.value.toolFormerData as Row | undefined;
    if (!tfd)
      continue;
    const name = String(tfd.name ?? '?');
    if (!filter.test(name))
      continue;
    lines.push(
      `  ${iso(b.createdAt)}  ${name.padEnd(34)} ${String(tfd.status ?? '').padEnd(10)} ${JSON.stringify(tfd.params ?? '').substring(0, 100)}`,
    );
  }
  return lines;
}

function main(): void {
  const argv = process.argv.slice(2);
  const limit = parseInt(flag(argv, 'limit') || '12', 10);

  if (argv.includes('--list')) {
    console.log(`db: ${DEFAULT_CURSOR_VSCDB}\n`);
    for (const s of recentSessions(limit)) {
      console.log(`  ${new Date(s.updated).toISOString()}  ${s.title.padEnd(42)} ${s.id}`);
    }
    return;
  }

  if (argv.includes('--switches')) {
    console.log('=== 最近会话里的 switch_mode / mcp 调用 ===');
    for (const s of recentSessions(limit)) {
      const rows = toolLines(s.id, /switch_mode|mcp|run_terminal/i);
      if (rows.length === 0)
        continue;
      console.log(`\n=== ${s.title}  (${s.id})  updated=${new Date(s.updated).toISOString()}`);
      for (const r of rows) console.log(r);
    }
    return;
  }

  if (argv.includes('--modes')) {
    const keys = query('SELECT key FROM cursorDiskKV WHERE value LIKE \'%autoRejectedModeTransitions%\'');
    if (keys.length === 0) {
      console.log('autoRejectedModeTransitions: (无 —— 没有模式切换被永久拒过)');
      return;
    }
    for (const k of keys) {
      const value = query(`SELECT value FROM cursorDiskKV WHERE key = '${String(k.key).replace(/'/g, '\'\'')}'`)[0]?.value ?? '';
      const text = String(value);
      const i = text.indexOf('autoRejectedModeTransitions');
      console.log(`key=${k.key}\n  ${text.substring(Math.max(0, i - 60), i + 200)}`);
    }
    return;
  }

  const needle = flag(argv, 'session');
  if (!needle) {
    console.log('用法：--list | --session <关键字> | --switches | --modes');
    process.exit(1);
  }
  const target = recentSessions(200).find(s => s.title.toLowerCase().includes(needle.toLowerCase()));
  if (!target) {
    console.error(`[db] 没有标题含 "${needle}" 的会话`);
    process.exit(1);
  }
  console.log(`=== ${target.title}  (${target.id})  updated=${new Date(target.updated).toISOString()}`);
  console.log('\n-- tool calls --');
  for (const line of toolLines(target.id)) console.log(line);
  console.log('\n-- 尾部 15 个气泡 --');
  const bubbles = bubblesOf(target.id).slice(-15);
  for (const b of bubbles) {
    const tfd = b.value.toolFormerData as Row | undefined;
    const text = String((tfd ? `[tool] ${tfd.name} ${tfd.status}` : b.value.text) ?? '').replace(/\s+/g, ' ').substring(0, 110);
    console.log(`  ${iso(b.createdAt)}  type=${String(b.value.type ?? '')}  ${text}`);
  }
}

main();
