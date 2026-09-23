import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { CursorAdapter } from '../packages/agent/src/sources/cursor-adapter.js';

let dir: string;
let dbPath: string;

function seed(): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY, workspaceId TEXT,
      createdAt INTEGER, lastUpdatedAt INTEGER,
      isArchived INTEGER, isSubagent INTEGER, value TEXT
    );
    CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare(
    `INSERT INTO composerHeaders VALUES (?,?,?,?,?,?,?)`,
  ).run('cid1', 'ws1', 1, 2, 0, 0, JSON.stringify({ name: 'Demo', unifiedMode: 'agent' }));
  const composerData = {
    _v: 18,
    name: 'Demo',
    status: 'none',
    generatingBubbleIds: [],
    fullConversationHeadersOnly: [
      { bubbleId: 'h1', type: 1, createdAt: '2026-01-01T00:00:00.000Z', grouping: { isRenderable: true, textPreview: 'hi' } },
      { bubbleId: 'skip', type: 2, grouping: { isRenderable: false } },
      { bubbleId: 'a1', type: 2, createdAt: '2026-01-01T00:00:01.000Z', grouping: { isRenderable: true } },
      { bubbleId: 'e1', type: 2, createdAt: '2026-01-01T00:00:02.000Z', grouping: { isRenderable: true } },
    ],
  };
  db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run('composerData:cid1', JSON.stringify(composerData));
  db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(
    'bubbleId:cid1:h1',
    JSON.stringify({ type: 1, bubbleId: 'h1', text: 'hi', createdAt: 1 }),
  );
  db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(
    'bubbleId:cid1:ghost',
    JSON.stringify({ type: 2, bubbleId: 'ghost', text: 'should not index', createdAt: 1 }),
  );
  db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(
    'bubbleId:cid1:a1',
    JSON.stringify({ type: 2, bubbleId: 'a1', text: 'ok', createdAt: 2 }),
  );
  db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(
    'composer.content.aaa',
    'before\n',
  );
  db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(
    'composer.content.bbb',
    'after\n',
  );
  db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(
    'bubbleId:cid1:e1',
    JSON.stringify({
      type: 2,
      bubbleId: 'e1',
      text: '',
      createdAt: 3,
      toolFormerData: {
        name: 'edit_file_v2',
        status: 'completed',
        params: '{"relativeWorkspacePath":"f.md"}',
        result: { beforeContentId: 'composer.content.aaa', afterContentId: 'composer.content.bbb' },
      },
    }),
  );
  db.close();
}

describe('CursorAdapter', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vscdb-'));
    dbPath = join(dir, 'state.vscdb');
    seed();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('probes v18 without versionMismatch', () => {
    const a = new CursorAdapter(dbPath);
    const p = a.probe();
    assert.equal(p.ok, true);
    assert.equal(p.schemaVersion, 18);
    assert.equal(p.versionMismatch, false);
    a.close();
  });

  it('lists sessions from composerHeaders', () => {
    const a = new CursorAdapter(dbPath);
    const list = a.listSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'Demo');
    assert.equal(list[0].ref.sessionId, 'cid1');
    a.close();
  });

  it('readBubbles with ids loads only those keys', () => {
    const a = new CursorAdapter(dbPath);
    const bubbles = a.readBubbles('cid1', ['h1']);
    assert.deepEqual(bubbles.map(b => b.bubbleId), ['h1']);
    a.close();
  });

  it('readIndex drops isRenderable false', () => {
    const a = new CursorAdapter(dbPath);
    const idx = a.readIndex('cid1');
    assert.deepEqual(idx.map(h => h.messageId), ['h1', 'a1', 'e1']);
    a.close();
  });

  it('readDiffs uses composer.content snapshots', () => {
    const a = new CursorAdapter(dbPath);
    const bubbles = a.readBubbles('cid1');
    const diffs = a.readDiffs(bubbles);
    assert.equal(diffs.get('e1')?.blockKind, 'diff');
    a.close();
  });

  it('implements ContentSource ide and changeSignal from dataVersion', () => {
    const a = new CursorAdapter(dbPath);
    assert.equal(a.ide, 'cursor');
    assert.equal(a.changeSignal(), a.dataVersion());
    a.close();
  });

  it('projectSession follows index and skips ghosts', () => {
    const a = new CursorAdapter(dbPath);
    const ids = a.projectSession('cid1').map(m => m.id);
    assert.ok(ids.includes('h1'));
    assert.ok(!ids.includes('ghost'));
    assert.ok(!ids.includes('skip'));
    a.close();
  });

  it('projectSession omits tools when includeProcess is false', () => {
    const a = new CursorAdapter(dbPath, { includeProcess: false });
    const msgs = a.projectSession('cid1');
    assert.equal(msgs.some(m => m.type === 'tool'), false);
    assert.equal(msgs.some(m => m.type === 'thought'), false);
    assert.ok(msgs.some(m => m.id === 'h1'));
    a.close();
  });
});
