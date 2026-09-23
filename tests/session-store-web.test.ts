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
