import type { SessionsIndexDelta } from '../packages/agent/src/session-index-reporter.js';
import type { ContentSource } from '../packages/agent/src/sources/content-source.js';
import type {
  IdeKind,
  MessageHeader,
  SessionMeta,
  SourceProbe,
} from '../packages/agent/src/sources/types.js';
import type { ChatElement } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SessionIndexReporter,

} from '../packages/agent/src/session-index-reporter.js';

function meta(sessionId: string, title: string, lastUpdatedAt: number, ide: IdeKind = 'codebuddy'): SessionMeta {
  return {
    ref: { ide, workspaceId: 'ws1', sessionId },
    title,
    createdAt: 1,
    lastUpdatedAt,
    isArchived: false,
    isSubagent: false,
    status: 'idle',
    messageCount: 0,
  };
}

class FakeSource implements ContentSource {
  readonly ide: IdeKind;
  signal = 1;
  heads: SessionMeta[] = [];
  headCalls = 0;
  fullCalls = 0;

  constructor(ide: IdeKind = 'codebuddy') {
    this.ide = ide;
  }

  probe(): SourceProbe {
    return { ok: true, rootPath: '/fake' };
  }

  changeSignal(): number {
    return this.signal;
  }

  indexSignal(): number {
    return this.signal;
  }

  listSessions(): SessionMeta[] {
    this.fullCalls += 1;
    return this.heads;
  }

  listSessionHeads(): SessionMeta[] {
    this.headCalls += 1;
    return this.heads;
  }

  enrichMeta(m: SessionMeta): SessionMeta {
    return m;
  }

  readIndex(): MessageHeader[] {
    return [];
  }

  projectSession(): ChatElement[] {
    return [];
  }
}

function makeReporter(source: ContentSource): { sent: SessionsIndexDelta[]; reporter: SessionIndexReporter } {
  const sent: SessionsIndexDelta[] = [];
  const reporter = new SessionIndexReporter({
    sources: [source],
    send: payload => sent.push(payload),
    intervalMs: 999_999,
  });
  return { sent, reporter };
}

describe('SessionIndexReporter', () => {
  it('报一次全量差量，指纹不变时连清单都不扫', () => {
    const source = new FakeSource();
    source.heads = [meta('s1', 'A', 10), meta('s2', 'B', 20)];
    const { sent, reporter } = makeReporter(source);

    reporter.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].mode, 'delta');
    assert.deepEqual(sent[0].sessions.map(s => s.ref.sessionId), ['s1', 's2']);
    assert.deepEqual(sent[0].removed, []);
    assert.equal(source.headCalls, 1);
    assert.equal(source.fullCalls, 0, '不能走会读消息文件的 listSessions');

    const calls = source.headCalls;
    reporter.tick();
    assert.equal(sent.length, 1, '指纹没变 → 不发');
    assert.equal(source.headCalls, calls, '指纹没变 → 不扫清单');
    reporter.stop();
  });

  it('指纹变了只发增量：新增/更新/删除', () => {
    const source = new FakeSource();
    source.heads = [meta('s1', 'A', 10), meta('s2', 'B', 20)];
    const { sent, reporter } = makeReporter(source);
    reporter.tick();

    source.signal = 2;
    source.heads = [meta('s2', 'B renamed', 30), meta('s3', 'C', 40)];
    reporter.tick();

    assert.equal(sent.length, 2);
    assert.deepEqual(
      sent[1].sessions.map(s => s.ref.sessionId),
      ['s2', 's3'],
      '只有变化的条目',
    );
    assert.deepEqual(sent[1].removed, [{ ide: 'codebuddy', sessionId: 's1' }]);
    reporter.stop();
  });

  it('清单没变化时（指纹变了但内容一样）不发消息', () => {
    const source = new FakeSource();
    source.heads = [meta('s1', 'A', 10)];
    const { sent, reporter } = makeReporter(source);
    reporter.tick();

    source.signal = 3;
    reporter.tick();
    assert.equal(sent.length, 1, '同样一份清单不该重复上报');
    reporter.stop();
  });

  it('reset 后整份重报（服务端换了一本新账）', () => {
    const source = new FakeSource();
    source.heads = [meta('s1', 'A', 10), meta('s2', 'B', 20)];
    const { sent, reporter } = makeReporter(source);
    reporter.tick();
    reporter.tick();
    assert.equal(sent.length, 1, '指纹没变 → 不重复上报');

    reporter.reset();
    reporter.tick();
    assert.equal(sent.length, 2, 'reset 之后要整份重报');
    assert.deepEqual(sent[1].sessions.map(s => s.ref.sessionId), ['s1', 's2']);
    assert.deepEqual(sent[1].removed, [], 'reset 不该报删除');
    reporter.stop();
  });

  it('双 IDE 并存：一个 IDE 的 tick 不能把另一个 IDE 的上报当删除（2026-09-21 线上实测 codebuddy: +572 -1007）', () => {
    const cursor = new FakeSource('cursor');
    cursor.heads = [meta('c1', 'C1', 10, 'cursor'), meta('c2', 'C2', 20, 'cursor')];
    const codebuddy = new FakeSource('codebuddy');
    codebuddy.heads = [meta('b1', 'B1', 30)];
    const sent: SessionsIndexDelta[] = [];
    const reporter = new SessionIndexReporter({
      sources: [cursor, codebuddy],
      send: payload => sent.push(payload),
      intervalMs: 999_999,
    });

    reporter.tick();
    assert.equal(sent.length, 2, '两个源各报一次');
    assert.deepEqual(sent[0].sessions.map(s => s.ref.sessionId), ['c1', 'c2']);
    assert.deepEqual(sent[0].removed, []);
    // Critical: this codebuddy round must not treat cursor's just-reported c1/c2 as deletions
    assert.deepEqual(sent[1].sessions.map(s => s.ref.sessionId), ['b1']);
    assert.deepEqual(sent[1].removed, [], '别的 IDE 的账不归这轮管');

    // The reverse also holds: cursor's next round must not delete codebuddy's b1
    cursor.signal = 2;
    cursor.heads = [meta('c1', 'C1', 10, 'cursor')];
    reporter.tick();
    const last = sent[sent.length - 1];
    assert.equal(last.reportedIdes[0], 'cursor');
    assert.deepEqual(last.removed, [{ ide: 'cursor', sessionId: 'c2' }], '只删自己 IDE 的 c2');
    reporter.stop();
  });
});
