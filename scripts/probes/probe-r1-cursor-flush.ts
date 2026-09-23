import { homedir } from 'node:os';
import { join } from 'node:path';
/**
 * Usage: pnpm exec tsx scripts/probes/probe-r1-cursor-flush.ts
 * Then send a task in Cursor that will run at least 30s (e.g. "count to 20 and print each step").
 * The probe prints a line every 300ms: wall, data_version, lastUpdatedAt, genCount, lastId, lastTextLen, lastStatus
 */
import Database from 'better-sqlite3';

const dbPath = join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

function dataVersion(): number {
  return db.pragma('data_version', { simple: true }) as number;
}

interface HeaderRow {
  composerId: string;
  lastUpdatedAt: number;
}

function latestComposer(): HeaderRow {
  return db.prepare(
    `SELECT composerId, lastUpdatedAt FROM composerHeaders
     WHERE isSubagent = 0 ORDER BY lastUpdatedAt DESC LIMIT 1`,
  ).get() as HeaderRow;
}

function composerPayload(id: string): { lastUpdatedAt?: number; generatingBubbleIds?: string[]; fullConversationHeadersOnly?: { bubbleId: string }[] } {
  const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${id}`) as { value: string } | undefined;
  if (!row?.value)
    return {};
  return JSON.parse(row.value) as ReturnType<typeof composerPayload>;
}

function bubbleText(cid: string, bid: string): { textLen: number; status: string } {
  const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`bubbleId:${cid}:${bid}`) as { value: string } | undefined;
  if (!row?.value)
    return { textLen: 0, status: 'missing' };
  const o = JSON.parse(row.value) as { text?: string; toolFormerData?: { status?: string } };
  return { textLen: (o.text ?? '').length, status: o.toolFormerData?.status ?? (o.text ? 'text' : 'empty') };
}

console.log('wall\tdv\tlagMs\tgen\tlastId\ttextLen\tstatus');
setInterval(() => {
  const wall = Date.now();
  const dv = dataVersion();
  const head = latestComposer();
  const cd = composerPayload(head.composerId);
  const headers = cd.fullConversationHeadersOnly ?? [];
  const lastId = headers[headers.length - 1]?.bubbleId ?? '';
  const b = lastId ? bubbleText(head.composerId, lastId) : { textLen: 0, status: 'none' };
  const gen = cd.generatingBubbleIds?.length ?? 0;
  const lag = wall - (cd.lastUpdatedAt ?? head.lastUpdatedAt);
  console.log(`${wall}\t${dv}\t${lag}\t${gen}\t${lastId.slice(0, 8)}\t${b.textLen}\t${b.status}`);
}, 300);
