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
      {
        bubbleId: 'n1',
        type: 1,
        createdAt: '2026-01-01T00:00:00.500Z',
        grouping: {
          isRenderable: true,
          isSimulatedMsg: true,
          simulatedMessageMetadataTitle: 'Background task',
          backgroundTaskCompletionKind: 'subagent',
        },
      },
      {
        bubbleId: 'n2',
        type: 1,
        createdAt: '2026-01-01T00:00:00.600Z',
        grouping: {
          isRenderable: true,
          isSimulatedMsg: true,
          simulatedMsgReason: 3,
          simulatedMessageMetadataTitle: 'Rerun the full check',
        },
      },
      {
        bubbleId: 'n3',
        type: 1,
        createdAt: '2026-01-01T00:00:00.700Z',
        grouping: {
          isRenderable: true,
          isSimulatedMsg: true,
          simulatedMsgReason: 3,
          simulatedMessageMetadataTitle: 'hidden completion',
          simulatedMessageMetadataSuppressUIDisplay: true,
        },
      },
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
    'bubbleId:cid1:n1',
    JSON.stringify({ type: 1, bubbleId: 'n1', text: '<task>\nstatus: success\n</task>', createdAt: 1.5 }),
  );
  db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(
    'bubbleId:cid1:n2',
    JSON.stringify({
      type: 1,
      bubbleId: 'n2',
      text: '<system_notification><task>status: success</task></system_notification><user_query>Perform any necessary follow-up actions</user_query>',
      createdAt: 1.6,
    }),
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
    assert.deepEqual(idx.map(h => h.messageId), ['h1', 'n1', 'n2', 'a1', 'e1']);
    assert.equal(idx[1].notificationTitle, 'Background task');
    assert.equal(idx[2].notificationTitle, 'Rerun the full check');
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
    assert.ok(!ids.includes('n3'));
    const n2 = a.projectSession('cid1').find(m => m.id === 'n2');
    assert.equal(n2?.type, 'notification');
    assert.equal(n2 && 'title' in n2 ? n2.title : '', 'Rerun the full check');
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

/**
 * Cursor's Agents Window (seen 2026-10-31, `_v: 18`) leaves `composerData.fullConversationHeadersOnly` empty and
 * writes the headers to `composerConvHeaders:<composerId>:<chunk>` instead, with `composerData.headerLog` naming
 * the chunk count. The list still enumerates the chat, so a header index read from the inline array alone shows
 * "session is empty" while the bubble bodies are all still on disk.
 */
describe('CursorAdapter chunked conversation headers', () => {
  let chunkDir: string;
  let chunkDb: string;

  const header = (bubbleId: string, type: number): Record<string, unknown> =>
    ({ bubbleId, type, createdAt: '2026-10-31T12:00:00.000Z', grouping: { isRenderable: true } });

  const putKv = (db: Database.Database, key: string, value: unknown): unknown =>
    db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(key, JSON.stringify(value));

  const head = (composerId: string): Record<string, unknown> => ({
    _v: 18,
    composerId,
    name: 'Agents window',
    status: 'completed',
    generatingBubbleIds: [],
    fullConversationHeadersOnly: [],
    conversationMap: {},
  });

  beforeEach(() => {
    chunkDir = mkdtempSync(join(tmpdir(), 'vscdb-chunks-'));
    chunkDb = join(chunkDir, 'state.vscdb');
    const db = new Database(chunkDb);
    db.exec(`
      CREATE TABLE composerHeaders (
        composerId TEXT PRIMARY KEY, workspaceId TEXT,
        createdAt INTEGER, lastUpdatedAt INTEGER,
        isArchived INTEGER, isSubagent INTEGER, value TEXT
      );
      CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);
    `);
    for (const id of ['cid2', 'cid3', 'cid4', 'cid5'])
      db.prepare('INSERT INTO composerHeaders VALUES (?,?,?,?,?,?,?)').run(id, 'ws1', 1, 2, 0, 0, JSON.stringify({ name: 'Agents window' }));

    // cid2: the shape measured on disk — empty inline array, two chunks, slash-suffixed bubble ids.
    putKv(db, 'composerData:cid2', {
      ...head('cid2'),
      headerLog: { chunkSize: 2, chunkCount: 2, count: 3, generation: 'g1' },
      conversationState: 'binary-blob',
      blobEncryptionKey: 'key',
    });
    putKv(db, 'composerConvHeaders:cid2:000000', [header('h1', 1), header('h1/s:0', 2)]);
    putKv(db, 'composerConvHeaders:cid2:000001', [header('h1/s:1', 2)]);
    putKv(db, 'bubbleId:cid2:h1', { bubbleId: 'h1', type: 1, text: '问题', createdAt: 1 });
    putKv(db, 'bubbleId:cid2:h1/s:0', {
      bubbleId: 'h1/s:0',
      type: 2,
      text: '',
      createdAt: 2,
      toolFormerData: { name: 'read_file_v2', status: 'completed', params: '{"path":"a.md"}' },
    });
    putKv(db, 'bubbleId:cid2:h1/s:1', { bubbleId: 'h1/s:1', type: 2, text: '回答', createdAt: 3 });

    // cid3: chunks written before headerLog (no headerLog on the row yet).
    putKv(db, 'composerData:cid3', head('cid3'));
    putKv(db, 'composerConvHeaders:cid3:000000', [header('x1', 1)]);
    putKv(db, 'bubbleId:cid3:x1', { bubbleId: 'x1', type: 1, text: 'hi', createdAt: 1 });

    // cid4: headerLog points at chunks that are not there (torn write) — the inline array is still usable.
    putKv(db, 'composerData:cid4', {
      ...head('cid4'),
      fullConversationHeadersOnly: [header('y1', 1), header('y2', 2)],
      headerLog: { chunkSize: 2, chunkCount: 1, count: 2, generation: 'g4' },
    });
    putKv(db, 'bubbleId:cid4:y1', { bubbleId: 'y1', type: 1, text: 'hi', createdAt: 1 });
    putKv(db, 'bubbleId:cid4:y2', { bubbleId: 'y2', type: 2, text: 'ok', createdAt: 2 });

    // cid5: inline-only row (older Cursor, or a chunked row after a downgrade) with a stranded chunk beside it.
    putKv(db, 'composerData:cid5', {
      ...head('cid5'),
      fullConversationHeadersOnly: [header('z1', 1), header('z2', 2)],
    });
    putKv(db, 'composerConvHeaders:cid5:000000', [header('stale', 1)]);
    putKv(db, 'bubbleId:cid5:z1', { bubbleId: 'z1', type: 1, text: 'hi', createdAt: 1 });
    putKv(db, 'bubbleId:cid5:z2', { bubbleId: 'z2', type: 2, text: 'ok', createdAt: 2 });
    db.close();
  });
  afterEach(() => rmSync(chunkDir, { recursive: true, force: true }));

  it('readIndex reads headers from composerConvHeaders chunks', () => {
    const a = new CursorAdapter(chunkDb);
    assert.deepEqual(a.readIndex('cid2').map(h => h.messageId), ['h1', 'h1/s:0', 'h1/s:1']);
    a.close();
  });

  it('projectSession projects a chunked session instead of an empty body', () => {
    const a = new CursorAdapter(chunkDb);
    assert.deepEqual(a.projectSession('cid2').map(m => m.id), ['h1', 'h1/s:0', 'h1/s:1']);
    a.close();
  });

  it('enrichMeta counts chunked headers', () => {
    const a = new CursorAdapter(chunkDb);
    const meta = a.listSessions().find(s => s.ref.sessionId === 'cid2')!;
    assert.equal(a.enrichMeta(meta).messageCount, 3);
    a.close();
  });

  it('readIndex ignores chunks past headerLog.chunkCount', () => {
    const db = new Database(chunkDb);
    putKv(db, 'composerConvHeaders:cid2:000002', [header('gone', 2)]);
    db.close();
    const a = new CursorAdapter(chunkDb);
    assert.deepEqual(a.readIndex('cid2').map(h => h.messageId), ['h1', 'h1/s:0', 'h1/s:1']);
    a.close();
  });

  it('readIndex reads chunks even when headerLog is missing', () => {
    const a = new CursorAdapter(chunkDb);
    assert.deepEqual(a.readIndex('cid3').map(h => h.messageId), ['x1']);
    a.close();
  });

  it('readIndex falls back to the inline array when the chunks are gone', () => {
    const a = new CursorAdapter(chunkDb);
    assert.deepEqual(a.readIndex('cid4').map(h => h.messageId), ['y1', 'y2']);
    a.close();
  });

  it('readIndex keeps the inline array for older Cursor even if a chunk is stranded next to it', () => {
    const a = new CursorAdapter(chunkDb);
    assert.deepEqual(a.readIndex('cid5').map(h => h.messageId), ['z1', 'z2']);
    a.close();
  });
});
