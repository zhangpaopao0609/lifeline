import type { ContentSource } from '../packages/agent/src/sources/content-source.js';
import type { IdeKind } from '../packages/agent/src/sources/types.js';
import type { AgentSocket } from '../packages/server/src/agent-hub.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readSessionsForThisSlot } from '../packages/agent/src/drivers/index.js';
import { SessionIndexReporter } from '../packages/agent/src/session-index-reporter.js';
import { AgentDirectory } from '../packages/server/src/agent-hub.js';
import { IdentityStore } from '../packages/server/src/identity-store.js';
import { SessionStore } from '../packages/server/src/session-store.js';

/**
 * Why the first round must be **authoritative** (no `mode: 'delta'`):
 *
 * A pre-split agent labelled the VSCode plugin's sessions `codebuddy`
 * (`codebuddy-adapter` scanned both host dirs). After the split, those rows are no
 * longer in the codebuddy census — but the reporter's `reported` ledger is
 * per-process, so a delta-only first round never emits `removed` for them; the
 * server's `mergeIndex` only deletes explicit removals, so the rows stay forever,
 * labelled as a product they never were. The authoritative round rewrites the
 * slot's index, which is what deletes them.
 */
function head(ide: IdeKind, sessionId: string) {
  return {
    ref: { ide, workspaceId: 'w', sessionId },
    title: sessionId,
    createdAt: 1,
    lastUpdatedAt: 2,
    isArchived: false,
    isSubagent: false,
    status: 'idle',
    messageCount: 0,
  };
}

function stubSource(
  ide: IdeKind,
  rows: () => ReturnType<typeof head>[],
  rootPath: () => string = () => tmpdir(),
): ContentSource {
  return {
    ide,
    indexSignal: () => rows().length,
    listSessionHeads: () => rows(),
    listSessions: () => rows(),
    probe: () => ({ ok: true, rootPath: rootPath() }),
  } as unknown as ContentSource;
}

describe('SessionIndexReporter authoritative first round', () => {
  it('sends the slot\'s complete set first, then deltas', () => {
    let rows = [head('vscode', 'a')];
    const sent: Array<{ mode?: string; sessions: unknown[]; reportedIdes: IdeKind[] }> = [];
    const reporter = new SessionIndexReporter({
      sources: [stubSource('vscode', () => rows)],
      send: payload => sent.push(payload),
    });

    reporter.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.mode, undefined, '首轮必须是权威全量（不带 mode）');
    assert.equal(sent[0]!.sessions.length, 1);
    assert.deepEqual(sent[0]!.reportedIdes, ['vscode']);

    rows = [head('vscode', 'a'), head('vscode', 'b')];
    reporter.tick();
    assert.equal(sent.length, 2);
    assert.equal(sent[1]!.mode, 'delta');
    assert.equal(sent[1]!.sessions.length, 1, '第二轮只发新增');
  });

  // A plugin-only machine has a readable CodeBuddy root and **zero** `CodeBuddyIDE/`
  // rows: the empty round is the one that prunes the rows an older agent mislabelled.
  it('sends an authoritative round even when the slot has no rows', () => {
    const sent: Array<{ mode?: string; sessions: unknown[]; reportedIdes: IdeKind[] }> = [];
    const reporter = new SessionIndexReporter({
      sources: [stubSource('codebuddy', () => [])],
      send: payload => sent.push(payload),
    });

    reporter.tick();
    assert.equal(sent.length, 1, '空槽也要发一轮，否则旧行永远删不掉');
    assert.equal(sent[0]!.mode, undefined);
    assert.deepEqual(sent[0]!.sessions, []);
    assert.deepEqual(sent[0]!.reportedIdes, ['codebuddy']);
  });

  it('holds the round while the root is unreachable, then sends it once it is back', () => {
    const sent: Array<{ mode?: string; sessions: unknown[] }> = [];
    let root = '/nonexistent-lifeline-root';
    const reporter = new SessionIndexReporter({
      sources: [stubSource('vscode', () => [head('vscode', 'a')], () => root)],
      send: payload => sent.push(payload),
    });

    reporter.tick();
    assert.equal(sent.length, 0, '根读不到时不能落账（会误删整个槽）');

    root = tmpdir();
    reporter.tick();
    assert.equal(sent.length, 1, '根恢复后要重试，而不是被“指纹未变”跳过');
    assert.equal(sent[0]!.mode, undefined, '仍然是权威轮');
  });

  it('re-arms the authoritative round after reset()', () => {
    let rows = [head('vscode', 'a')];
    const sent: Array<{ mode?: string; sessions: unknown[] }> = [];
    const reporter = new SessionIndexReporter({
      sources: [stubSource('vscode', () => rows)],
      send: payload => sent.push(payload),
    });

    reporter.tick();
    rows = [head('vscode', 'a'), head('vscode', 'b')];
    reporter.tick();
    assert.equal(sent[1]!.mode, 'delta');

    // Server lost (or deleted) this machine's ledger. Nothing changed on disk since
    // the last tick, so only re-arming the authoritative round can repopulate it.
    reporter.reset();
    reporter.tick();
    assert.equal(sent[2]!.mode, undefined, 'server 丢了账本 → 下一轮重新权威上报');
    assert.equal(sent[2]!.sessions.length, 2, '权威轮发的是整槽集合，不是增量');
  });
});

describe('content vs control gate', () => {
  it('keeps a slot that has a disk shard even when its host is not installed', () => {
    const shardOnly = { isEnabled: () => false, hasContent: () => true };
    const installed = { isEnabled: () => true, hasContent: () => false };
    const neither = { isEnabled: () => false, hasContent: () => false };
    assert.equal(readSessionsForThisSlot(shardOnly as never), true);
    assert.equal(readSessionsForThisSlot(installed as never), true);
    assert.equal(readSessionsForThisSlot(neither as never), false);
    // No gates at all (cursor / codebuddy): always a content source.
    assert.equal(readSessionsForThisSlot({} as never), true);
  });
});

describe('authoritative round cleans the mislabelled ledger rows', () => {
  let dir: string;
  let store: IdentityStore;
  let sessionStore: SessionStore;
  let d: AgentDirectory;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'auth-'));
    store = new IdentityStore(join(dir, 'identity.sqlite'));
    sessionStore = new SessionStore(join(dir, 'sessions.sqlite'));
    d = new AgentDirectory(store, { persistDebounceMs: 0, now: () => 50, sessionStore });
  });

  afterEach(() => {
    sessionStore.close();
    try {
      store.close();
    }
    catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // The migration case this whole change exists for: a slot that now reports **nothing**
  // must still prune the rows a pre-split agent filed under it.
  it('prunes a slot that reports an empty authoritative round', () => {
    const agent = {} as AgentSocket;
    Object.assign(agent, {
      id: 'agent-empty',
      connected: true,
      events: [] as Array<[string, unknown[]]>,
      emit(event: string, ...args: unknown[]) {
        (this as unknown as { events: Array<[string, unknown[]]> }).events.push([event, args]);
      },
    });
    d.register(agent, { agentId: 'm2', hostname: 'h', slots: ['cursor', 'codebuddy'] });

    d.applySessionsIndex(agent, {
      sessions: [head('codebuddy', 'ghost-1'), head('codebuddy', 'ghost-2')] as never,
      mode: 'delta',
    });
    assert.equal(d.readSessionIndex('m2').length, 2);

    d.applySessionsIndex(agent, { sessions: [], reportedIdes: ['codebuddy'] });
    assert.deepEqual(d.readSessionIndex('m2'), []);
  });

  it('deletes rows the slot no longer reports', () => {
    const agent = {} as AgentSocket;
    Object.assign(agent, {
      id: 'agent',
      connected: true,
      events: [] as Array<[string, unknown[]]>,
      emit(event: string, ...args: unknown[]) {
        (this as unknown as { events: Array<[string, unknown[]]> }).events.push([event, args]);
      },
    });
    d.register(agent, { agentId: 'm1', hostname: 'h', slots: ['cursor', 'codebuddy'] });

    // Pre-split ledger: the VSCode session is mislabelled `codebuddy`.
    d.applySessionsIndex(agent, {
      sessions: [head('codebuddy', 'ide-only'), head('codebuddy', 'vscode-session')] as never,
      mode: 'delta',
    });
    assert.equal(d.readSessionIndex('m1').length, 2);

    // First round after the split: authoritative for `codebuddy`, which now holds
    // only the standalone IDE's sessions.
    d.applySessionsIndex(agent, {
      sessions: [head('codebuddy', 'ide-only')] as never,
      reportedIdes: ['codebuddy'],
    });

    assert.deepEqual(d.readSessionIndex('m1').map(row => row.ref.sessionId), ['ide-only']);
  });
});
