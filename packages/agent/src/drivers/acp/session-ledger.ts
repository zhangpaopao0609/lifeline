import type { CliSource } from '@lifeline/protocol';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { CLI_MODEL_ID_MAX, CLI_SOURCES, CLI_THINKING_VALUE_MAX } from '@lifeline/protocol';
import { cursorCliModelId } from './session-catalog.js';

const PROVIDER_ID_MAX = 200;

/**
 * CLI session ids that can be loaded again after this agent process exits.
 * `modelId` and `thinking` are the choice made in Lifeline, not the CLI user's default.
 */
export interface CliSessionRecord {
  source: CliSource;
  cwd: string;
  providerSessionId: string;
  modelId?: string;
  /** CodeBuddy effort. Cursor keeps effort inside `modelId`. */
  thinking?: string;
}

export function cliSessionLedgerPath(home: string = homedir()): string {
  return join(home, '.lifeline', 'cli-sessions.json');
}

export function readCliSessionLedger(path: string): CliSessionRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  }
  catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  }
  catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.sessions))
    return [];
  const records: CliSessionRecord[] = [];
  for (const row of parsed.sessions) {
    const record = readRecord(row);
    if (record)
      records.push(record);
  }
  return records;
}

export function writeCliSessionLedger(path: string, records: readonly CliSessionRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify({ sessions: records })}\n`;
  writeFileSync(path, body, 'utf8');
}

/**
 * One shell line for the machine's terminal. CodeBuddy gets `--model` and
 * `--effort`. Cursor gets `--model` with the effort already in the id.
 */
export function cliResumeCommand(record: CliSessionRecord, platform: NodeJS.Platform = process.platform): string {
  const quote = platform === 'win32' ? cmdQuote : posixQuote;
  const cd = platform === 'win32' ? `cd /d ${quote(record.cwd)}` : `cd ${quote(record.cwd)}`;
  const args = record.source === 'cursor-cli'
    ? ['cursor-agent', '--resume', quote(record.providerSessionId)]
    : ['codebuddy', '--resume', quote(record.providerSessionId)];
  if (record.modelId) {
    const modelId = record.source === 'cursor-cli' ? cursorCliModelId(record.modelId) : record.modelId;
    args.push('--model', quote(modelId));
  }
  if (record.source === 'codebuddy-cli' && record.thinking)
    args.push('--effort', quote(record.thinking));
  return `${cd} && ${args.join(' ')}`;
}

function readRecord(raw: unknown): CliSessionRecord | undefined {
  if (!isRecord(raw))
    return undefined;
  const { source, cwd, providerSessionId } = raw;
  if (!isCliSource(source) || typeof cwd !== 'string' || !isAbsolute(cwd) || !isProviderId(providerSessionId))
    return undefined;
  const record: CliSessionRecord = { source, cwd, providerSessionId };
  if (isBoundedToken(raw.modelId, CLI_MODEL_ID_MAX))
    record.modelId = raw.modelId;
  if (isBoundedToken(raw.thinking, CLI_THINKING_VALUE_MAX))
    record.thinking = raw.thinking;
  return record;
}

function posixQuote(value: string): string {
  return `'${value.replaceAll('\'', `'\\''`)}'`;
}

function cmdQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function isCliSource(value: unknown): value is CliSource {
  return typeof value === 'string' && (CLI_SOURCES as readonly string[]).includes(value);
}

function isProviderId(value: unknown): value is string {
  return isBoundedToken(value, PROVIDER_ID_MAX);
}

function isBoundedToken(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001F]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
