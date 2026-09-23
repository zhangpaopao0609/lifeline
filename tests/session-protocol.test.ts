import type { SessionMeta } from '../packages/agent/src/sources/types.js';
import type { SessionBodyPayload } from '../packages/protocol/src/index.js';
import type { AgentSocket, SessionSyncPayload } from '../packages/server/src/agent-hub.js';
import type { ChatElement } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AgentDirectory } from '../packages/server/src/agent-hub.js';
import { IdentityStore } from '../packages/server/src/identity-store.js';
import { SessionStore } from '../packages/server/src/session-store.js';

function fakeSocket(id: string): AgentSocket & { events: Array<[string, unknown[]]> } {
  const events: Array<[string, unknown[]]> = [];
  return {
    id,
    connected: true,
    events,
    emit(event: string, ...args: unknown[]) {
      events.push([event, args]);
    },
  };
}

function sampleMeta(extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    ref: { ide: 'cursor', workspaceId: 'ws', sessionId: 's1' },
    title: 'T',
    createdAt: 1,
    lastUpdatedAt: 2,
    isArchived: false,
    isSubagent: false,
    status: 'idle',
    messageCount: 1,
    ...extra,
  };
}

describe('session protocol', () => {
  let dir: string;
  let sessions: SessionStore;
  let d: AgentDirectory;
  /**
   * **Every** `IdentityStore` created here must be closed: it is a real better-sqlite3 file handle,
   * and Windows forbids unlinking an open file (macOS/Linux allow it) → skip close and you get `EBUSY`,
   * all 18 cases in this suite fail. Production does close (`relay.ts`); only the tests leaked.
   */
  const identityStores: IdentityStore[] = [];
  const newIdentity = (name = 'identity.sqlite'): IdentityStore => {
    const created = new IdentityStore(join(dir, name));
    identityStores.push(created);
    return created;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sess-proto-'));
    sessions = new SessionStore(join(dir, 'sessions.sqlite'));
    d = new AgentDirectory(newIdentity(), {
      persistDebounceMs: 0,
      sessionStore: sessions,
    });
  });

  afterEach(() => {
    sessions.close();
    for (const s of identityStores) {
      try {
        s.close();
      }
      catch {
        /* already closed / never opened */
      }
    }
    identityStores.length = 0;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('writes sessions:index from the agent and emits it', () => {
    const agent = fakeSocket('sa');
    d.register(agent, { agentId: 'agent-a', hostname: 'A' });
    const emitted: Array<[string, { sessions: SessionMeta[] }]> = [];
    d.on('sessions:index', (agentId: string, payload: { sessions: SessionMeta[] }) => {
      emitted.push([agentId, payload]);
    });

    const index = { sessions: [sampleMeta()] };
    d.applySessionsIndex(agent, index);

    assert.equal(sessions.readIndex('agent-a')[0].title, 'T');
    assert.deepEqual(emitted[0], ['agent-a', index]);
  });

  it('writeIndex uses reportedIdes so an empty cursor tick can delete cursor rows', () => {
    const agent = fakeSocket('sa');
    d.register(agent, { agentId: 'agent-a', hostname: 'A' });
    d.applySessionsIndex(agent, {
      sessions: [
        sampleMeta({ ref: { ide: 'cursor', workspaceId: 'ws', sessionId: 'c1' } }),
        sampleMeta({ ref: { ide: 'codebuddy', workspaceId: 'ws', sessionId: 'b1' }, title: 'B' }),
      ],
    });
    d.applySessionsIndex(agent, {
      sessions: [sampleMeta({ ref: { ide: 'codebuddy', workspaceId: 'ws', sessionId: 'b1' }, title: 'B' })],
      reportedIdes: ['cursor', 'codebuddy'],
    });
    const rows = sessions.readIndex('agent-a');
    assert.equal(rows.some(r => r.ref.ide === 'cursor'), false);
    assert.equal(rows.some(r => r.ref.ide === 'codebuddy'), true);
  });

  it('差量防御：reportedIdes 之外的 IDE 删除行不认（旧 agent 跨 IDE 误删止血，2026-09-21）', () => {
    const agent = fakeSocket('sa');
    d.register(agent, { agentId: 'agent-a', hostname: 'A' });
    // Start with a dual-IDE ledger
    d.applySessionsIndex(agent, {
      sessions: [
        sampleMeta({ ref: { ide: 'cursor', workspaceId: 'ws', sessionId: 'c1' } }),
        sampleMeta({ ref: { ide: 'codebuddy', workspaceId: 'ws', sessionId: 'b1' }, title: 'B' }),
      ],
    });
    const emitted: Array<[string, unknown]> = [];
    d.on('sessions:index', (agentId: string, payload: unknown) => emitted.push([agentId, payload]));

    // Old-agent codebuddy delta: reports b2 and also falsely reports cursor's c1 as deleted
    d.applySessionsIndex(agent, {
      sessions: [sampleMeta({ ref: { ide: 'codebuddy', workspaceId: 'ws', sessionId: 'b2' }, title: 'B2' })],
      mode: 'delta',
      removed: [
        { ide: 'codebuddy', sessionId: 'b1' },
        { ide: 'cursor', sessionId: 'c1' },
      ],
      reportedIdes: ['codebuddy'],
    });

    const rows = sessions.readIndex('agent-a');
    assert.equal(
      rows.some(r => r.ref.ide === 'cursor' && r.ref.sessionId === 'c1'),
      true,
      '声明之外的 IDE 删除不能落库（cursor 的行保住）',
    );
    assert.equal(
      rows.some(r => r.ref.ide === 'codebuddy' && r.ref.sessionId === 'b1'),
      false,
      '本 IDE 的删除照常生效',
    );
    assert.equal(rows.some(r => r.ref.ide === 'codebuddy' && r.ref.sessionId === 'b2'), true);
    // The payload forwarded to the browser likewise contains only accepted deletions
    const forwarded = emitted[0][1] as { removed?: Array<{ ide: string; sessionId: string }> };
    assert.deepEqual(
      (forwarded.removed ?? []).map(r => r.ide),
      ['codebuddy'],
      '转发载荷不带被过滤掉的删除行',
    );
  });

  it('handleSessionGet returns session:full from the store', () => {
    const agent = fakeSocket('sa');
    const browser = fakeSocket('br');
    d.register(agent, { agentId: 'agent-a', hostname: 'A' });
    d.applySessionsIndex(agent, { sessions: [sampleMeta()] });
    const messages: ChatElement[] = [
      { type: 'human', id: 'h1', flatIndex: 0, text: 'hi', mentions: [] },
    ];
    d.applySessionFull(agent, { sessionId: 's1', messages });

    d.handleSessionGet('agent-a', { sessionId: 's1' }, browser);

    assert.deepEqual(browser.events.find(e => e[0] === 'session:full'), [
      'session:full',
      [{ sessionId: 's1', messages, ide: 'cursor', seq: 0 }],
    ]);
    // A DB hit still refresh-from-source once (the DB may be a stale snapshot); only once inside the cooldown
    assert.equal(agent.events.filter(e => e[0] === 'session:get').length, 1);
  });

  it('handleSessionGet with a matching sinceSeq answers session:sync without body', () => {
    const agent = fakeSocket('sa');
    const browser = fakeSocket('br');
    d.register(agent, { agentId: 'agent-a', hostname: 'A' });
    d.applySessionsIndex(agent, { sessions: [sampleMeta()] });
    const messages: ChatElement[] = [
      { type: 'human', id: 'h1', flatIndex: 0, text: 'hi', mentions: [] },
    ];
    d.applySessionFull(agent, { sessionId: 's1', messages, seq: 0 });
    d.applySessionAppend(agent, {
      sessionId: 's1',
      messages: [{ type: 'assistant', id: 'a1', flatIndex: 1, text: 'yo' }],
      seq: 1,
    });

    d.handleSessionGet('agent-a', { sessionId: 's1', sinceSeq: 1 }, browser);

    assert.deepEqual(browser.events.find(e => e[0] === 'session:sync'), [
      'session:sync',
      [{ sessionId: 's1', ide: 'cursor', seq: 1 }],
    ]);
    assert.equal(browser.events.some(e => e[0] === 'session:full'), false);
    // sync only means "do not return the body"; the content machine is still named for a refresh (same stale-snapshot issue)
    assert.equal(agent.events.filter(e => e[0] === 'session:get').length, 1);
  });

  it('handleSessionGet behind the stream seq replays a full at the stored seq', () => {
    const agent = fakeSocket('sa');
    const browser = fakeSocket('br');
    d.register(agent, { agentId: 'agent-a', hostname: 'A' });
    d.applySessionsIndex(agent, { sessions: [sampleMeta()] });
    d.applySessionFull(agent, {
      sessionId: 's1',
      messages: [{ type: 'human', id: 'h1', flatIndex: 0, text: 'hi', mentions: [] }],
      seq: 0,
    });
    d.applySessionAppend(agent, {
      sessionId: 's1',
      messages: [{ type: 'assistant', id: 'a1', flatIndex: 1, text: 'yo' }],
      seq: 1,
    });

    d.handleSessionGet('agent-a', { sessionId: 's1', sinceSeq: 0 }, browser);

    const full = browser.events.find(e => e[0] === 'session:full');
    assert.ok(full);
    const payload = (full[1] as Array<{ seq?: number; messages: ChatElement[] }>)[0];
    assert.equal(payload.seq, 1);
    assert.equal(payload.messages.length, 2);
  });

  it('applySessionSync forwards the ack to viewers', () => {
    const agent = fakeSocket('sa');
    d.register(agent, { agentId: 'agent-a', hostname: 'A' });
    const seen: Array<[string, SessionSyncPayload]> = [];
    d.on('session:sync', (agentId: string, payload: SessionSyncPayload) => {
      seen.push([agentId, payload]);
    });

    d.applySessionSync(agent, { sessionId: 's1', ide: 'cursor', seq: 7 });

    assert.deepEqual(seen, [['agent-a', { sessionId: 's1', ide: 'cursor', seq: 7 }]]);
  });

  it('handleSessionGet miss forwards session:get to the agent', () => {
    const agent = fakeSocket('sa');
    const browser = fakeSocket('br');
    d.register(agent, { agentId: 'agent-a', hostname: 'A' });

    d.handleSessionGet('agent-a', { sessionId: 'missing' }, browser);

    assert.equal(browser.events.some(e => e[0] === 'session:full'), false);
    assert.deepEqual(agent.events.find(e => e[0] === 'session:get'), [
      'session:get',
      [{ sessionId: 'missing', ide: 'cursor' }],
    ]);
  });

  it('owner 推的空正文透传（空会话直答「会话为空」），不落库；别人的空包仍被丢弃', () => {
    const owner = fakeSocket('so');
    const imposter = fakeSocket('si');
    d.register(owner, { agentId: 'agent-o', hostname: 'O' });
    d.register(imposter, { agentId: 'agent-i', hostname: 'I' });

    const seen: Array<[string, unknown]> = [];
    d.on('session:full', (agentId: string, payload: unknown) => seen.push([agentId, payload]));

    // Scene 1: nobody has reported this in the ledger yet → the owner's empty packet is still forwarded (empty session answers directly) but not persisted, to prevent a wipe
    d.applySessionFull(owner, { sessionId: 'empty-one', ide: 'codebuddy', messages: [] });
    assert.equal(seen.length, 1, '空正文转发给前端');
    assert.equal((seen[0][1] as { messages: unknown[] }).messages.length, 0);
    assert.equal(sessions.readSession('agent-o', 'empty-one', 'codebuddy'), null, '空正文不落库');

    // Scene 2: content is registered under another machine → drop the empty packet (prevent wiping the body; 2026-09-16 production issue)
    d.applySessionsIndex(owner, {
      sessions: [sampleMeta({ ref: { ide: 'codebuddy', workspaceId: 'ws', sessionId: 's2' } })],
    });
    d.applySessionFull(owner, {
      sessionId: 's2',
      ide: 'codebuddy',
      messages: [{ type: 'human', id: 'h2', flatIndex: 0, text: 'hi', mentions: [] }],
    });
    seen.length = 0;
    d.applySessionFull(imposter, { sessionId: 's2', ide: 'codebuddy', messages: [] });
    assert.equal(seen.length, 0, '别人的空包不转发');
  });

  it('agent 报告 missing 后直回 unavailable；force 可强制点名；正文到达自动撤销', () => {
    const agent = fakeSocket('sa');
    const browser = fakeSocket('br');
    d.register(agent, { agentId: 'agent-a', hostname: 'A' });

    // First request: name the agent as usual
    d.handleSessionGet('agent-a', { sessionId: 'missing' }, browser);
    assert.equal(agent.events.filter(e => e[0] === 'session:get').length, 1);

    // The agent explicitly answers "this machine does not have that session"
    d.applySessionMissing(agent, { sessionId: 'missing', ide: 'cursor' });

    // Next time: reply unavailable directly, do not name the agent in a no-op loop
    agent.events.length = 0;
    browser.events.length = 0;
    d.handleSessionGet('agent-a', { sessionId: 'missing' }, browser);
    assert.equal(agent.events.filter(e => e[0] === 'session:get').length, 0, 'missing 缓存内不点名');
    assert.deepEqual(browser.events.find(e => e[0] === 'session:unavailable'), [
      'session:unavailable',
      [{ sessionId: 'missing', ide: 'cursor' }],
    ]);

    // force (user manual retry): skip cache and cooldown, ask again
    agent.events.length = 0;
    d.handleSessionGet('agent-a', { sessionId: 'missing', force: true }, browser);
    assert.equal(agent.events.filter(e => e[0] === 'session:get').length, 1, 'force 强制点名');

    // Body arrives → drop the missing cache; later requests return full as usual
    d.applySessionFull(agent, {
      sessionId: 'missing',
      ide: 'cursor',
      messages: [{ type: 'human', id: 'h1', flatIndex: 0, text: 'hi', mentions: [] }],
    });
    browser.events.length = 0;
    d.handleSessionGet('agent-a', { sessionId: 'missing' }, browser);
    assert.equal(browser.events.some(e => e[0] === 'session:full'), true, '正文到达后恢复 full');
  });

  it('handleSessionGet miss 的重复请求被冷却闸拦住（内容源缺失不再无限点名）', () => {
    // 2026-09-20 incident: with the content source missing the frontend resent on every state push, 30 names/sec filling the event loop.
    let clock = 1_000_000;
    const gated = new AgentDirectory(newIdentity('gate-identity.sqlite'), {
      persistDebounceMs: 0,
      sessionStore: sessions,
      now: () => clock,
    });
    const agent = fakeSocket('ga');
    const browser = fakeSocket('gb');
    gated.register(agent, { agentId: 'agent-g', hostname: 'G' });

    for (let i = 0; i < 5; i += 1) {
      gated.handleSessionGet('agent-g', { sessionId: 'missing' }, browser);
    }
    assert.equal(agent.events.filter(e => e[0] === 'session:get').length, 1, '一分钟内只点名一次');

    // The same sessionId on different ides has its own name quota (the key includes ide)
    gated.handleSessionGet('agent-g', { sessionId: 'missing', ide: 'codebuddy' }, browser);
    assert.equal(agent.events.filter(e => e[0] === 'session:get').length, 2);

    // After cooldown, naming resumes — waiting a minute for content is slow, not a permanent stall
    clock += 61_000;
    gated.handleSessionGet('agent-g', { sessionId: 'missing' }, browser);
    assert.equal(agent.events.filter(e => e[0] === 'session:get').length, 3);
  });

  it('handleSessionGet keeps the same sessionId isolated per ide', () => {
    const agent = fakeSocket('sa');
    const browser = fakeSocket('br');
    d.register(agent, { agentId: 'agent-a', hostname: 'A' });
    const cursorMessages: ChatElement[] = [
      { type: 'human', id: 'h-cursor', flatIndex: 0, text: 'from-cursor', mentions: [] },
    ];
    const codebuddyMessages: ChatElement[] = [
      { type: 'human', id: 'h-cb', flatIndex: 0, text: 'from-codebuddy', mentions: [] },
    ];
    d.applySessionFull(agent, { sessionId: 's1', messages: cursorMessages, ide: 'cursor' });
    d.applySessionFull(agent, { sessionId: 's1', messages: codebuddyMessages, ide: 'codebuddy' });

    d.handleSessionGet('agent-a', { sessionId: 's1', ide: 'cursor' }, browser);
    d.handleSessionGet('agent-a', { sessionId: 's1', ide: 'codebuddy' }, browser);

    const fulls = browser.events.filter(e => e[0] === 'session:full');
    assert.deepEqual(fulls[0], [
      'session:full',
      [{ sessionId: 's1', messages: cursorMessages, ide: 'cursor', seq: 0 }],
    ]);
    assert.deepEqual(fulls[1], [
      'session:full',
      [{ sessionId: 's1', messages: codebuddyMessages, ide: 'codebuddy', seq: 0 }],
    ]);
  });

  it('handleSessionGet miss forwards session:get with ide', () => {
    const agent = fakeSocket('sa');
    const browser = fakeSocket('br');
    d.register(agent, { agentId: 'agent-a', hostname: 'A' });

    d.handleSessionGet('agent-a', { sessionId: 'missing', ide: 'codebuddy' }, browser);

    assert.equal(browser.events.some(e => e[0] === 'session:full'), false);
    assert.deepEqual(agent.events.find(e => e[0] === 'session:get'), [
      'session:get',
      [{ sessionId: 'missing', ide: 'codebuddy' }],
    ]);
  });

  it('handleSessionGet with only tabTitle forwards to the agent', () => {
    const agent = fakeSocket('sa');
    const browser = fakeSocket('br');
    d.register(agent, { agentId: 'agent-a', hostname: 'A' });

    d.handleSessionGet('agent-a', { tabTitle: 'This chat', ide: 'cursor' }, browser);

    assert.equal(browser.events.some(e => e[0] === 'session:full'), false);
    assert.deepEqual(agent.events.find(e => e[0] === 'session:get'), [
      'session:get',
      [{ tabTitle: 'This chat', ide: 'cursor' }],
    ]);
  });

  it('answers session:get with the tail page when the body is longer than a page', () => {
    const remote = fakeSocket('s-remote');
    d.register(remote, { agentId: 'agent-r', hostname: 'sandbox' });
    d.applySessionsIndex(remote, { sessions: [sampleMeta()] });
    const body: ChatElement[] = Array.from({ length: 450 }, (_, i) => ({
      type: 'assistant',
      id: `a${i}`,
      flatIndex: i,
      text: `${i}`,
    }));
    d.applySessionFull(remote, { sessionId: 's1', messages: body, seq: 7 });

    const browser = fakeSocket('br');
    d.handleSessionGet('agent-r', { sessionId: 's1', limit: 200 }, browser);
    const page = browser.events.find(e => e[0] === 'session:full')![1][0] as SessionBodyPayload;
    assert.equal(page.isPage, true);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextBefore, 250);
    assert.equal(page.before, undefined, '尾页不带 before');
    assert.equal(page.messages.length, 200);
    assert.equal(page.messages[199].id, 'a449');
    assert.equal(page.seq, 7);

    // The mirror is still the whole session: a previous-page request can still be answered
    browser.events.length = 0;
    d.handleSessionGet('agent-r', { sessionId: 's1', limit: 200, before: 250 }, browser);
    const prev = browser.events.find(e => e[0] === 'session:full')![1][0] as SessionBodyPayload;
    assert.equal(prev.isPage, true);
    assert.equal(prev.before, 250);
    assert.equal(prev.messages[0].id, 'a51');
    assert.equal(prev.messages[prev.messages.length - 1].id, 'a250');
    assert.equal(prev.nextBefore, 51);
    assert.equal(sessions.readSession('agent-r', 's1', 'cursor')?.length, 450, '库里一行不少');

    // The first page of the session: hasMore=false but it is still a page; must not treat it as an authoritative full and wipe the tail
    browser.events.length = 0;
    d.handleSessionGet('agent-r', { sessionId: 's1', limit: 200, before: 51 }, browser);
    const first = browser.events.find(e => e[0] === 'session:full')![1][0] as SessionBodyPayload;
    assert.equal(first.isPage, true, '有 before 即使 !hasMore 也是页');
    assert.equal(first.hasMore, false);
    assert.equal(first.before, 51);
    assert.equal(first.messages[0].id, 'a0');
  });

  it('points the content machine at the mirror seq so it can answer with a patch', () => {
    const remote = fakeSocket('s-remote');
    d.register(remote, { agentId: 'agent-r', hostname: 'sandbox' });
    d.applySessionsIndex(remote, { sessions: [sampleMeta()] });
    d.applySessionFull(remote, {
      sessionId: 's1',
      messages: [{ type: 'human', id: 'h1', flatIndex: 0, text: 'hi', mentions: [] }],
      seq: 4,
    });
    remote.events.length = 0;

    const browser = fakeSocket('br');
    d.handleSessionGet('agent-r', { sessionId: 's1' }, browser);

    assert.deepEqual(remote.events.find(e => e[0] === 'session:get'), [
      'session:get',
      [{ sessionId: 's1', ide: 'cursor', sinceSeq: 4 }],
    ]);
  });

  it('slices the agent full before viewers see it, and keeps the mirror whole', () => {
    const remote = fakeSocket('s-remote');
    d.register(remote, { agentId: 'agent-r', hostname: 'sandbox' });
    const relayed: Array<[string, SessionBodyPayload]> = [];
    d.on('session:full', (agentId: string, payload: SessionBodyPayload) => relayed.push([agentId, payload]));
    const body: ChatElement[] = Array.from({ length: 450 }, (_, i) => ({
      type: 'assistant',
      id: `a${i}`,
      flatIndex: i,
      text: `${i}`,
    }));

    d.applySessionFull(remote, { sessionId: 's1', messages: body, seq: 3 });

    assert.equal(sessions.readSession('agent-r', 's1', 'cursor')?.length, 450, '镜像整份');
    const payload = relayed[0][1];
    assert.equal(payload.isPage, true);
    assert.equal(payload.hasMore, true);
    assert.equal(payload.nextBefore, 250);
    assert.equal(payload.messages.length, 200);
    assert.equal(payload.messages[199].id, 'a449');
    assert.equal(payload.before, undefined, '转发的是尾页');
    assert.equal(payload.seq, 3);
  });

  it('short bodies still relay as an authoritative full', () => {
    const remote = fakeSocket('s-remote');
    d.register(remote, { agentId: 'agent-r', hostname: 'sandbox' });
    const relayed: Array<[string, SessionBodyPayload]> = [];
    d.on('session:full', (agentId: string, payload: SessionBodyPayload) => relayed.push([agentId, payload]));
    d.applySessionFull(remote, {
      sessionId: 's1',
      messages: [{ type: 'human', id: 'h1', flatIndex: 0, text: 'hi', mentions: [] }],
    });
    assert.equal(relayed[0][1].isPage, undefined);
    assert.equal(relayed[0][1].hasMore, undefined);
  });

  it('applySessionPatch upserts the delta, advances the seq, and relays it', () => {
    const remote = fakeSocket('s-remote');
    d.register(remote, { agentId: 'agent-r', hostname: 'sandbox' });
    d.applySessionsIndex(remote, { sessions: [sampleMeta()] });
    d.applySessionFull(remote, {
      sessionId: 's1',
      messages: [{ type: 'human', id: 'h1', flatIndex: 0, text: 'hi', mentions: [] }],
      seq: 0,
    });
    const seen: Array<[string, { seq: number; messages: ChatElement[] }]> = [];
    d.on('session:patch', (agentId: string, payload: { seq: number; messages: ChatElement[] }) => {
      seen.push([agentId, payload]);
    });

    d.applySessionPatch(remote, {
      sessionId: 's1',
      seq: 2,
      messages: [{ type: 'assistant', id: 'a1', flatIndex: 1, text: 'yo' }],
    });

    assert.equal(sessions.readSessionSeq('agent-r', 's1', 'cursor'), 2);
    assert.equal(sessions.readSession('agent-r', 's1', 'cursor')?.length, 2, '第一页还在，delta 接在后面');
    assert.deepEqual(seen, [['agent-r', {
      sessionId: 's1',
      ide: 'cursor',
      seq: 2,
      messages: [{ type: 'assistant', id: 'a1', flatIndex: 1, text: 'yo' }],
    }]]);

    // A large patch (the patch-all path) forwarded to viewers is also only the tail page: a phone must not haul the whole session for one catch-up
    const big: ChatElement[] = Array.from({ length: 450 }, (_, i) => ({
      type: 'assistant',
      id: `b${i}`,
      flatIndex: i,
      text: `${i}`,
    }));
    seen.length = 0;
    d.applySessionPatch(remote, { sessionId: 's1', seq: 3, messages: big });
    assert.equal(sessions.readSession('agent-r', 's1', 'cursor')?.length, 452, '镜像吃整份（h1 + a1 + 450）');
    const relayed = seen[0][1] as { messages: ChatElement[]; isPage?: boolean; nextBefore?: number };
    assert.equal(relayed.isPage, true);
    assert.equal(relayed.messages.length, 200);
    assert.equal(relayed.nextBefore, 250);
  });

  it('drops a patch when the mirror has no baseline and asks for a full instead', () => {
    const remote = fakeSocket('s-remote');
    d.register(remote, { agentId: 'agent-r', hostname: 'sandbox' });
    remote.events.length = 0;
    const seen: unknown[] = [];
    d.on('session:patch', (_agentId: string, payload: unknown) => seen.push(payload));

    d.applySessionPatch(remote, {
      sessionId: 'ghost',
      seq: 5,
      messages: [{ type: 'assistant', id: 'a1', flatIndex: 0, text: 'x' }],
    });

    assert.equal(seen.length, 0, '没有基线，patch 落不了库也不许转发');
    assert.equal(sessions.readSession('agent-r', 'ghost', 'cursor')?.length ?? 0, 0);
    assert.deepEqual(remote.events.find(e => e[0] === 'session:get'), [
      'session:get',
      [{ sessionId: 'ghost', ide: 'cursor' }],
    ]);
  });
});
