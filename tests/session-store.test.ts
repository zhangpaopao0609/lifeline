import type { SessionMeta } from '../packages/agent/src/sources/types.js';
import type { ChatElement } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SessionStore } from '../packages/server/src/session-store.js';

function meta(agentExtra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    ref: { ide: 'cursor', workspaceId: 'ws', sessionId: 's1' },
    title: 'T',
    createdAt: 1,
    lastUpdatedAt: 2,
    isArchived: false,
    isSubagent: false,
    status: 'idle',
    messageCount: 1,
    ...agentExtra,
  };
}

describe('SessionStore', () => {
  let dir: string;
  let store: SessionStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sess-'));
    store = new SessionStore(join(dir, 'sessions.sqlite'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts composers with null lastUpdatedAt instead of crashing', () => {
    store.writeIndex('agent-a', [
      meta({ lastUpdatedAt: undefined as unknown as number, createdAt: 9 }),
      meta({
        ref: { ide: 'cursor', workspaceId: 'ws', sessionId: 's2' },
        lastUpdatedAt: null as unknown as number,
        createdAt: null as unknown as number,
      }),
    ]);
    const rows = store.readIndex('agent-a');
    assert.equal(rows.length, 2);
    assert.equal(rows.some(r => r.ref.sessionId === 's1'), true);
    assert.equal(rows.some(r => r.ref.sessionId === 's2'), true);
  });

  it('round-trips index and session body', () => {
    store.writeIndex('agent-a', [meta()]);
    assert.equal(store.readIndex('agent-a')[0].title, 'T');
    const messages: ChatElement[] = [
      { type: 'human', id: 'h1', flatIndex: 0, text: 'hi', mentions: [] },
    ];
    store.writeSession('agent-a', 's1', messages, 'cursor');
    assert.equal(store.readSession('agent-a', 's1', 'cursor')?.[0].id, 'h1');
  });

  it('keeps two machines with the same session_id apart', () => {
    store.writeIndex('agent-a', [meta()]);
    store.writeIndex('agent-b', [meta({ title: 'Other' })]);
    store.writeSession('agent-a', 's1', [
      { type: 'human', id: 'h1', flatIndex: 0, text: 'a', mentions: [] },
    ], 'cursor');
    store.writeSession('agent-b', 's1', [
      { type: 'human', id: 'h1', flatIndex: 0, text: 'b', mentions: [] },
    ], 'cursor');
    assert.equal((store.readSession('agent-a', 's1', 'cursor')?.[0] as { text: string }).text, 'a');
    assert.equal((store.readSession('agent-b', 's1', 'cursor')?.[0] as { text: string }).text, 'b');
    assert.equal(store.readIndex('agent-a')[0].title, 'T');
    assert.equal(store.readIndex('agent-b')[0].title, 'Other');
  });

  it('append overlays by id and strips actions', () => {
    store.writeSession('agent-a', 's1', [
      { type: 'tool', id: 't1', flatIndex: 0, toolCallId: 'c1', status: 'loading', action: 'Read', details: '' },
    ], 'cursor');
    const merged = store.appendSession('agent-a', 's1', [
      {
        type: 'tool',
        id: 't1',
        flatIndex: 0,
        toolCallId: 'c1',
        status: 'completed',
        action: 'Read',
        details: '',
        actions: [{ label: 'Run', type: 'run', selectorPath: 'secret' }],
      } as ChatElement,
    ], 'cursor');
    const tool = merged[0] as { status: string; actions?: unknown };
    assert.equal(tool.status, 'completed');
    assert.equal(tool.actions, undefined);
  });

  it('keeps the body stream seq per session (full resets, append advances)', () => {
    const appendMessage: ChatElement = { type: 'assistant', id: 'a1', flatIndex: 1, text: 'yo' };
    store.writeSession(
      'agent-a',
      's1',
      [{ type: 'human', id: 'h1', flatIndex: 0, text: 'hi', mentions: [] }],
      'cursor',
      0,
    );
    assert.equal(store.readSessionSeq('agent-a', 's1', 'cursor'), 0);
    store.appendSession('agent-a', 's1', [appendMessage], 'cursor', 1);
    assert.equal(store.readSessionSeq('agent-a', 's1', 'cursor'), 1);
    // append without seq (old agent): keep the last known value, do not rewind
    store.appendSession('agent-a', 's1', [{ ...appendMessage, flatIndex: 2 }], 'cursor');
    assert.equal(store.readSessionSeq('agent-a', 's1', 'cursor'), 1);
    // full resets to zero
    store.writeSession('agent-a', 's1', [], 'cursor', 0);
    assert.equal(store.readSessionSeq('agent-a', 's1', 'cursor'), 0);
    // Unknown session / the other ide do not leak across
    assert.equal(store.readSessionSeq('agent-a', 'nope', 'cursor'), null);
    assert.equal(store.readSessionSeq('agent-a', 's1', 'codebuddy'), null);
  });

  it('keeps the same sessionId on two ides apart', () => {
    store.writeIndex('agent-a', [
      meta({ ref: { ide: 'cursor', workspaceId: 'ws', sessionId: 's1' }, title: 'C' }),
      meta({ ref: { ide: 'codebuddy', workspaceId: 'ws', sessionId: 's1' }, title: 'B' }),
    ]);
    const rows = store.readIndex('agent-a');
    assert.equal(rows.find(r => r.ref.ide === 'cursor')?.title, 'C');
    assert.equal(rows.find(r => r.ref.ide === 'codebuddy')?.title, 'B');
    store.writeSession('agent-a', 's1', [
      { type: 'human', id: 'h1', flatIndex: 0, text: 'c', mentions: [] },
    ], 'cursor');
    store.writeSession('agent-a', 's1', [
      { type: 'human', id: 'h1', flatIndex: 0, text: 'b', mentions: [] },
    ], 'codebuddy');
    assert.equal((store.readSession('agent-a', 's1', 'cursor')?.[0] as { text: string }).text, 'c');
    assert.equal((store.readSession('agent-a', 's1', 'codebuddy')?.[0] as { text: string }).text, 'b');
  });

  it('cursor-only writeIndex does not delete codebuddy rows', () => {
    store.writeIndex('agent-a', [
      meta({ ref: { ide: 'cursor', workspaceId: 'ws', sessionId: 'c1' } }),
      meta({ ref: { ide: 'codebuddy', workspaceId: 'ws', sessionId: 'b1' }, title: 'Keep' }),
    ]);
    store.writeIndex('agent-a', [
      meta({ ref: { ide: 'cursor', workspaceId: 'ws', sessionId: 'c2' }, title: 'NewC' }),
    ]);
    const rows = store.readIndex('agent-a');
    assert.equal(rows.some(r => r.ref.ide === 'codebuddy' && r.ref.sessionId === 'b1'), true);
    assert.equal(rows.some(r => r.ref.ide === 'cursor' && r.ref.sessionId === 'c1'), false);
    assert.equal(rows.some(r => r.ref.sessionId === 'c2'), true);
  });

  it('deletes cursor rows when reportedIdes includes an empty cursor tick', () => {
    store.writeIndex('agent-a', [
      meta({ ref: { ide: 'cursor', workspaceId: 'ws', sessionId: 'c1' } }),
      meta({ ref: { ide: 'codebuddy', workspaceId: 'ws', sessionId: 'b1' }, title: 'Keep' }),
    ]);
    store.writeIndex(
      'agent-a',
      [meta({ ref: { ide: 'codebuddy', workspaceId: 'ws', sessionId: 'b1' }, title: 'Keep' })],
      ['cursor', 'codebuddy'],
    );
    const rows = store.readIndex('agent-a');
    assert.equal(rows.some(r => r.ref.ide === 'cursor'), false);
    assert.equal(rows.some(r => r.ref.ide === 'codebuddy' && r.ref.sessionId === 'b1'), true);
  });

  it('migrates a pre-ide database to ide=cursor', async () => {
    store.close();
    const Database = (await import('better-sqlite3')).default;
    const dbPath = join(dir, 'legacy.sqlite');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
        meta_json TEXT NOT NULL, last_updated_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, session_id)
      );
      CREATE TABLE messages (
        agent_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
        flat_index INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (agent_id, session_id, message_id)
      );
    `);
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(
      'agent-a',
      's1',
      JSON.stringify(meta()),
      2,
    );
    db.close();
    store = new SessionStore(dbPath);
    const rows = store.readIndex('agent-a');
    assert.equal(rows[0].ref.sessionId, 's1');
    store.writeSession('agent-a', 's1', [
      { type: 'human', id: 'h2', flatIndex: 0, text: 'b', mentions: [] },
    ], 'codebuddy');
    assert.equal(store.readSession('agent-a', 's1', 'cursor'), null);
  });

  it('pages a session body tail-first with nextBefore', () => {
    const body: ChatElement[] = Array.from({ length: 450 }, (_, i) => ({
      type: 'assistant',
      id: `a${i}`,
      flatIndex: i,
      text: `${i}`,
    }));
    store.writeSession('agent-a', 's1', body, 'cursor');

    const tail = store.readSessionPage('agent-a', 's1', 'cursor', { limit: 200 });
    assert.equal(tail?.messages.length, 200);
    assert.equal(tail?.messages[0].id, 'a250');
    assert.equal(tail?.messages[199].id, 'a449');
    assert.equal(tail?.hasMore, true);
    assert.equal(tail?.nextBefore, 250);

    const prev = store.readSessionPage('agent-a', 's1', 'cursor', { before: tail!.nextBefore, limit: 200 });
    assert.equal(prev?.messages[0].id, 'a51');
    assert.equal(prev?.messages[prev.messages.length - 1].id, 'a250', '页尾是 overlap token = 尾页首条');
    assert.equal(prev?.hasMore, true);
    assert.equal(prev?.nextBefore, 51);

    const first = store.readSessionPage('agent-a', 's1', 'cursor', { before: prev!.nextBefore, limit: 200 });
    assert.equal(first?.messages[0].id, 'a0');
    assert.equal(first?.messages[first.messages.length - 1].id, 'a51');
    assert.equal(first?.hasMore, false);
    assert.equal(first?.nextBefore, undefined);

    assert.equal(store.readSessionPage('agent-a', 's1', 'cursor', { before: -1, limit: 200 }), null);
    assert.equal(store.readSessionPage('agent-a', 's1', 'cursor', { before: 0, limit: 200 })?.messages[0].id, 'a0', 'lte(0) 是 overlap 那一条，不是空');
    assert.equal(store.readSessionPage('agent-a', 's1', 'cursor', { before: 0, limit: 200 })?.hasMore, false);
    assert.equal(store.readSessionPage('agent-a', 'nope', 'cursor', { limit: 200 }), null);
  });

  it('clamps the page limit and keeps two ides apart', () => {
    const body: ChatElement[] = Array.from({ length: 10 }, (_, i) => ({
      type: 'assistant',
      id: `a${i}`,
      flatIndex: i,
      text: `${i}`,
    }));
    store.writeSession('agent-a', 's1', body, 'cursor');
    store.writeSession('agent-a', 's1', body.slice(0, 4), 'codebuddy');

    const page = store.readSessionPage('agent-a', 's1', 'cursor', { limit: 100_000 });
    assert.equal(page?.messages.length, 10, 'limit 被夹到 SESSION_PAGE_ITEMS，但会话本来就短');
    assert.equal(store.readSessionPage('agent-a', 's1', 'codebuddy', { limit: 200 })?.messages.length, 4);
    assert.equal(store.readSessionPage('agent-a', 's1', 'cursor', { limit: 0 })?.messages.length, 1, 'limit 下限 1');
  });
});
