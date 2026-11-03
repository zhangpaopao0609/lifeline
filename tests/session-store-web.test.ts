import type { ChatElement, SessionBodyPayload } from '../packages/web/src/net/protocol.ts';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { sessionBodyKey, useSessionsStore } from '../packages/web/src/store/sessions.ts';

function a(id: string, flatIndex: number, text = id): ChatElement {
  return { type: 'assistant', id, flatIndex, text };
}

function page(messages: ChatElement[], extra: Partial<SessionBodyPayload> = {}): SessionBodyPayload {
  return { sessionId: 's1', messages, ...extra };
}

const KEY = sessionBodyKey('s1', 'cursor');

describe('sessions store paging', () => {
  beforeEach(() => {
    useSessionsStore.getState().clearBodies();
  });

  it('keeps the older prefix when a tail page arrives and records hasMore', () => {
    useSessionsStore.getState().applySessionFull(page([a('a1', 0), a('a2', 1)]), '');
    useSessionsStore.getState().applySessionFull(
      page([a('a2', 1, 'A2new'), a('a3', 2)], { isPage: true, hasMore: true, nextBefore: 1, seq: 3 }),
      '',
    );
    const body = useSessionsStore.getState().bodies[KEY];
    assert.deepEqual(body.map(m => m.id), ['a1', 'a2', 'a3']);
    assert.equal((body[1] as { text: string }).text, 'A2new');
    assert.deepEqual(useSessionsStore.getState().pageMeta[KEY], {
      hasMore: true,
      nextBefore: 1,
      loadingAt: 0,
    });
    assert.equal(useSessionsStore.getState().bodySeq[KEY], 3);
  });

  it('prepends an earlier page and counts what was added', () => {
    useSessionsStore.getState().applySessionFull(
      page([a('a3', 2), a('a4', 3)], { isPage: true, hasMore: true, nextBefore: 2 }),
      '',
    );
    useSessionsStore.getState().applySessionFull(
      page([a('a1', 0), a('a2', 1), a('a3', 2)], { isPage: true, hasMore: false, before: 2 }),
      '',
    );
    assert.deepEqual(useSessionsStore.getState().bodies[KEY].map(m => m.id), ['a1', 'a2', 'a3', 'a4']);
    assert.equal(useSessionsStore.getState().prependedItems[KEY], 2);
    assert.equal(useSessionsStore.getState().pageMeta[KEY].hasMore, false);
  });

  it('drops an earlier page that does not touch the local body', () => {
    useSessionsStore.getState().applySessionFull(
      page([a('a5', 4)], { isPage: true, hasMore: true, nextBefore: 4 }),
      '',
    );
    useSessionsStore.getState().applySessionFull(
      page([a('a1', 0), a('a2', 1)], { isPage: true, hasMore: true, before: 4, nextBefore: 0 }),
      '',
    );
    assert.deepEqual(useSessionsStore.getState().bodies[KEY].map(m => m.id), ['a5']);
    assert.equal(useSessionsStore.getState().prependedItems[KEY], undefined, '没插进去就不动窗口');
    assert.equal(useSessionsStore.getState().pageMeta[KEY].nextBefore, 4, '游标不拨走，下次还用 4');
  });

  it('an authoritative full still replaces and clears hasMore', () => {
    useSessionsStore.getState().applySessionFull(
      page([a('a1', 0), a('a2', 1)], { isPage: true, hasMore: true, nextBefore: 1 }),
      '',
    );
    useSessionsStore.getState().applySessionFull(page([a('a9', 8)]), '');
    assert.deepEqual(useSessionsStore.getState().bodies[KEY].map(m => m.id), ['a9']);
    assert.equal(useSessionsStore.getState().pageMeta[KEY], undefined);
    assert.equal(useSessionsStore.getState().prependedItems[KEY], undefined);
  });

  it('merges a patch by id and jumps the checkpoint', () => {
    useSessionsStore.getState().applySessionFull(page([a('a1', 0)], { seq: 0 }), '');
    useSessionsStore.getState().applySessionPatch(
      { sessionId: 's1', seq: 5, messages: [a('a2', 1), a('a1', 0, 'A1new')] },
      '',
    );
    const body = useSessionsStore.getState().bodies[KEY];
    assert.deepEqual(body.map(m => m.id), ['a1', 'a2']);
    assert.equal((body[0] as { text: string }).text, 'A1new');
    assert.equal(useSessionsStore.getState().bodySeq[KEY], 5);
  });

  it('beginEarlier hands out nextBefore once and blocks repeats', () => {
    useSessionsStore.getState().applySessionFull(
      page([a('a2', 1)], { isPage: true, hasMore: true, nextBefore: 1 }),
      '',
    );
    assert.deepEqual(useSessionsStore.getState().beginEarlier(KEY), { before: 1 });
    assert.equal(useSessionsStore.getState().beginEarlier(KEY), null, '在飞时不重复要');
    useSessionsStore.getState().applySessionFull(
      page([a('a1', 0), a('a2', 1)], { isPage: true, hasMore: true, before: 1, nextBefore: 0 }),
      '',
    );
    assert.deepEqual(useSessionsStore.getState().beginEarlier(KEY), { before: 0 }, '页到了就放行下一次');
  });

  it('beginEarlier stays quiet when there is nothing earlier', () => {
    useSessionsStore.getState().applySessionFull(page([a('a1', 0)], { isPage: true, hasMore: false }), '');
    assert.equal(useSessionsStore.getState().beginEarlier(KEY), null);
    assert.equal(useSessionsStore.getState().beginEarlier('cursor:nope'), null);
  });
});

function h(id: string, flatIndex: number, text = id): ChatElement {
  return { type: 'human', id, flatIndex, text, mentions: [] };
}

describe('sessions store pending send reconcile', () => {
  beforeEach(() => {
    useSessionsStore.getState().clearBodies();
  });

  it('pops the optimistic bubble even when the twin lands before this session is live', () => {
    // The reported ghost (2026-10-31): first message of a new session. The disk twin lands while the IDE state
    // still reports a draft, i.e. liveKey is still '' — the pop used to be gated on `key === liveKey` and was
    // never retried, leaving a second ✓-less copy of the sent text underneath the optimistic one.
    const s = useSessionsStore.getState();
    s.echoPendingSend('我是跑跑', 'c1', KEY);
    useSessionsStore.getState().applySessionAppend(page([h('h1', 0, '我是跑跑')], { seq: 1 }));
    assert.deepEqual(useSessionsStore.getState().bodies[KEY].map(m => m.id), ['h1']);
    assert.deepEqual(Object.keys(useSessionsStore.getState().pendingSends), [], 'meta 一起回收');
  });

  it('pops on a patch as well', () => {
    const s = useSessionsStore.getState();
    s.applySessionFull(page([a('a1', 0)], { seq: 0 }), '');
    s.echoPendingSend('继续', 'c2', KEY);
    useSessionsStore.getState().applySessionPatch({ sessionId: 's1', seq: 1, messages: [h('h1', 1, '继续')] });
    assert.deepEqual(useSessionsStore.getState().bodies[KEY].map(m => m.id), ['a1', 'h1']);
  });

  it('an older identical message does not pop a fresh bubble', () => {
    const s = useSessionsStore.getState();
    s.applySessionFull(page([h('h0', 0, '好')], { seq: 0 }), '');
    s.echoPendingSend('好', 'c3', KEY);
    useSessionsStore.getState().applySessionAppend(page([a('a1', 1)], { seq: 1 }));
    assert.deepEqual(
      useSessionsStore.getState().bodies[KEY].map(m => m.id),
      ['h0', 'pending-send:c3', 'a1'],
      '历史里的“好”在气泡之前，不算这条的落盘',
    );
  });

  it('the same text sent twice pops one bubble per landed message', () => {
    const s = useSessionsStore.getState();
    s.echoPendingSend('好', 'c4', KEY);
    s.echoPendingSend('好', 'c5', KEY);
    useSessionsStore.getState().applySessionAppend(page([h('h1', 0, '好')], { seq: 1 }));
    const pendingIds = (): string[] => {
      const ids = useSessionsStore.getState().bodies[KEY].map(m => m.id);
      return ids.filter(id => id.startsWith('pending-send:'));
    };
    assert.equal(pendingIds().length, 1, '只落一条，就只弹一个（另一个别闪没）');
    useSessionsStore.getState().applySessionAppend(page([h('h2', 1, '好')], { seq: 2 }));
    assert.deepEqual(pendingIds(), []);
    assert.deepEqual(useSessionsStore.getState().bodies[KEY].map(m => m.id), ['h1', 'h2']);
  });
});
