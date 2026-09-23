/**
 * Body watermark (a local file; never touches any of Cursor's databases).
 *
 * Stores "state at last send": seq + disk index + per-row byte fingerprints +
 * index fingerprint. With it, the first request after restart can send only a
 * diff; without it we can only re-project the whole session (today's behavior).
 * Always an optimization: parse/write failure falls back to "no watermark"
 * and does not affect correctness.
 */

import type { MessageHeader } from './sources/types.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_DIR } from '../../cli/src/config.js';

export const WATERMARK_PATH = join(CONFIG_DIR, 'content-watermark.json');

/** Keep a few sessions: only current / recently viewed; more is wasted disk writes */
export const WATERMARK_MAX_SESSIONS = 4;
/** Max index entries per session (truncating the tail is safe: fewer ids only means requesting a few extra chunks, never a miss) */
export const WATERMARK_MAX_HEADERS = 5000;

export interface SessionWatermark {
  seq: number;
  headers: MessageHeader[];
  sizes?: Record<string, number>;
  diskSig: string;
  updatedAt: number;
}

function isHeader(value: unknown): value is MessageHeader {
  const h = value as Partial<MessageHeader> | null;
  return (
    !!h
    && typeof h.messageId === 'string'
    && typeof h.role === 'string'
    && typeof h.createdAt === 'number'
    && typeof h.complete === 'boolean'
  );
}

function isWatermark(value: unknown): value is SessionWatermark {
  const w = value as Partial<SessionWatermark> | null;
  return (
    !!w
    && typeof w.seq === 'number'
    && Number.isFinite(w.seq)
    && Array.isArray(w.headers)
    && w.headers.every(isHeader)
    && typeof w.diskSig === 'string'
    && typeof w.updatedAt === 'number'
  );
}

export function parseWatermark(raw: unknown): Record<string, SessionWatermark> {
  const sessions = (raw as { sessions?: unknown } | null)?.sessions;
  if (!sessions || typeof sessions !== 'object')
    return {};
  const out: Record<string, SessionWatermark> = {};
  for (const [key, value] of Object.entries(sessions as Record<string, unknown>)) {
    if (!isWatermark(value))
      continue;
    const sizes = (value as { sizes?: unknown }).sizes;
    out[key] = {
      seq: value.seq,
      headers: value.headers,
      ...(sizes && typeof sizes === 'object' ? { sizes: sizes as Record<string, number> } : {}),
      diskSig: value.diskSig,
      updatedAt: value.updatedAt,
    };
  }
  return out;
}

export function pruneWatermarks(
  all: Record<string, SessionWatermark>,
  maxSessions = WATERMARK_MAX_SESSIONS,
): Record<string, SessionWatermark> {
  const keep = Object.entries(all)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, Math.max(1, maxSessions));
  const out: Record<string, SessionWatermark> = {};
  for (const [key, value] of keep) {
    out[key] = {
      ...value,
      headers:
        value.headers.length > WATERMARK_MAX_HEADERS
          ? value.headers.slice(-WATERMARK_MAX_HEADERS)
          : value.headers,
    };
  }
  return out;
}

/** Group by `ide:` prefix then keep WATERMARK_MAX_SESSIONS each, so two IDEs do not evict each other. */
export function pruneWatermarksByIde(
  all: Record<string, SessionWatermark>,
  maxSessions = WATERMARK_MAX_SESSIONS,
): Record<string, SessionWatermark> {
  const groups = new Map<string, Record<string, SessionWatermark>>();
  for (const [key, value] of Object.entries(all)) {
    const colon = key.indexOf(':');
    const ide = colon === -1 ? '' : key.slice(0, colon);
    const bucket = groups.get(ide) ?? {};
    bucket[key] = value;
    groups.set(ide, bucket);
  }
  const out: Record<string, SessionWatermark> = {};
  for (const bucket of groups.values()) Object.assign(out, pruneWatermarks(bucket, maxSessions));
  return out;
}

/** Pick one ide's entries from the whole file and strip the prefix (runtime only knows bare sessionId). */
export function pickIde(
  all: Record<string, SessionWatermark>,
  ide: string,
): Record<string, SessionWatermark> {
  const out: Record<string, SessionWatermark> = {};
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(`${ide}:`))
      out[key.slice(ide.length + 1)] = value;
  }
  return out;
}

/** Write one ide's snapshot back into the whole file: drop old prefixes then write (sessions trimmed off the watermark must not leave corpses). */
export function mergeIde(
  all: Record<string, SessionWatermark>,
  ide: string,
  snapshot: Record<string, SessionWatermark>,
): Record<string, SessionWatermark> {
  const next: Record<string, SessionWatermark> = {};
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(`${ide}:`))
      next[key] = value;
  }
  for (const [key, value] of Object.entries(snapshot)) next[`${ide}:${key}`] = value;
  return next;
}

export function loadWatermarks(path = WATERMARK_PATH): Record<string, SessionWatermark> {
  try {
    return parseWatermark(JSON.parse(readFileSync(path, 'utf-8')));
  }
  catch {
    return {};
  }
}

export function saveWatermarks(
  all: Record<string, SessionWatermark>,
  path = WATERMARK_PATH,
): void {
  try {
    // Prune per ide prefix; do not globally trim the whole file to 4 entries.
    const body = JSON.stringify({ version: 1, sessions: pruneWatermarksByIde(all) });
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, body, 'utf-8');
    renameSync(tmp, path);
  }
  catch {
    /* Watermark is an optimization: if we cannot write, skip it */
  }
}
