import type { SessionWatermark } from '../packages/agent/src/content-watermark.js';
import type { MessageHeader } from '../packages/protocol/src/index.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  loadWatermarks,
  mergeIde,
  parseWatermark,
  pickIde,
  pruneWatermarks,
  pruneWatermarksByIde,
  saveWatermarks,

} from '../packages/agent/src/content-watermark.js';

function wm(seq: number, updatedAt: number): SessionWatermark {
  return {
    seq,
    headers: [{ messageId: `h${seq}`, role: 'human', createdAt: 1, complete: true }],
    diskSig: `sig-${seq}`,
    updatedAt,
  };
}

describe('content watermark', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wm-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses only well-formed entries', () => {
    const parsed = parseWatermark({
      version: 1,
      sessions: {
        good: { seq: 3, headers: [{ messageId: 'h1', role: 'human', createdAt: 1, complete: true }], diskSig: 's', updatedAt: 5 },
        badSeq: { seq: '3', headers: [], diskSig: 's', updatedAt: 5 },
        badHeaders: { seq: 1, headers: 'nope', diskSig: 's', updatedAt: 5 },
        nothing: null,
      },
    });
    assert.deepEqual(Object.keys(parsed), ['good']);
  });

  it('tolerates a missing or corrupt file', () => {
    assert.deepEqual(loadWatermarks(join(dir, 'nope.json')), {});
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    assert.deepEqual(loadWatermarks(bad), {});
  });

  it('keeps the most recent sessions per call and caps headers', () => {
    const all: Record<string, SessionWatermark> = {};
    for (let i = 0; i < 8; i++) all[`s${i}`] = wm(i, i);
    const pruned = pruneWatermarks(all, 4);
    assert.deepEqual(Object.keys(pruned).sort(), ['s4', 's5', 's6', 's7']);

    const many: MessageHeader[] = Array.from({ length: 6000 }, (_, i) => ({
      messageId: `m${i}`,
      role: 'assistant',
      createdAt: i,
      complete: true,
    }));
    const capped = pruneWatermarks({ s: { ...wm(1, 1), headers: many } }, 4);
    assert.equal(capped.s.headers.length, 5000);
  });

  it('prunes each ide prefix separately so cursor and codebuddy do not evict each other', () => {
    const all: Record<string, SessionWatermark> = {};
    for (let i = 0; i < 4; i++) all[`cursor:s${i}`] = wm(i, i);
    for (let i = 0; i < 4; i++) all[`codebuddy:s${i}`] = wm(i, i + 10);
    const pruned = pruneWatermarksByIde(all, 4);
    assert.equal(Object.keys(pruned).filter(k => k.startsWith('cursor:')).length, 4);
    assert.equal(Object.keys(pruned).filter(k => k.startsWith('codebuddy:')).length, 4);
  });

  it('saves and loads atomically', () => {
    const path = join(dir, 'content-watermark.json');
    saveWatermarks({ s1: wm(1, 1) }, path);
    assert.equal(loadWatermarks(path).s1.seq, 1);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { version: number };
    assert.equal(raw.version, 1);
  });

  it('picks and merges one ide without touching the other', () => {
    const all = mergeIde(mergeIde({}, 'cursor', { s1: wm(1, 1) }), 'codebuddy', { s2: wm(2, 2) });
    assert.deepEqual(Object.keys(all).sort(), ['codebuddy:s2', 'cursor:s1']);
    assert.deepEqual(Object.keys(pickIde(all, 'cursor')), ['s1']);

    // Writing the same ide again is a replace (trimmed sessions must not linger); the other ide is left as-is
    const next = mergeIde(all, 'cursor', { s3: wm(3, 3) });
    assert.deepEqual(Object.keys(next).sort(), ['codebuddy:s2', 'cursor:s3']);
  });
});
