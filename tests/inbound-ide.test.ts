import type { AgentSocket } from '../packages/server/src/agent-hub.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AgentDirectory, readInboundIde } from '../packages/server/src/agent-hub.js';
import { IdentityStore } from '../packages/server/src/identity-store.js';
import { SessionStore } from '../packages/server/src/session-store.js';

/**
 * Inbound `ide` rules (agent → server).
 *
 * They must cover **every** unvalidated entry, not just the session body events:
 * `state:patch`, `sessions:index`, `connection:status`, `session:sync`,
 * `session:missing`, `session:get` all reach `parseIde`-style folding otherwise, and
 * folding writes another product's state/ledger into the cursor slot silently.
 */
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

function meta(sessionId: string, ide: unknown) {
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

describe('readInboundIde', () => {
  it('accepts a known kind and drops an unknown one', () => {
    assert.equal(readInboundIde(undefined, 'codebuddy', 't'), 'codebuddy');
    assert.equal(readInboundIde(undefined, 'vscode', 't'), 'vscode');
    assert.equal(readInboundIde(undefined, 'nope', 't'), null);
    assert.equal(readInboundIde(undefined, 42, 't'), null);
  });

  it('falls back to cursor only for a connection that declared no slots', () => {
    assert.equal(readInboundIde(undefined, undefined, 't'), 'cursor');
    assert.equal(readInboundIde({}, null, 't'), 'cursor');
    assert.equal(readInboundIde({ slots: ['cursor'] }, '', 't'), 'cursor');
    assert.equal(readInboundIde({ slots: ['cursor', 'codebuddy'] }, undefined, 't'), null);
    assert.equal(readInboundIde({ slots: ['cursor', 'codebuddy', 'vscode'] }, undefined, 't'), null);
  });
});

describe('inbound strictness through AgentDirectory', () => {
  let dir: string;
  let store: IdentityStore;
  let sessionStore: SessionStore;
  let d: AgentDirectory;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inbound-'));
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

  it('drops unknown-ide rows from sessions:index instead of writing them to cursor', () => {
    const agent = fakeSocket('agent');
    d.register(agent, { agentId: 'm1', hostname: 'h', slots: ['cursor', 'codebuddy'] });

    d.applySessionsIndex(agent, {
      sessions: [meta('s-unknown', 'nope'), meta('s-cursor', 'cursor')] as never,
      reportedIdes: ['nope', 'cursor'] as never,
      mode: 'delta',
    });

    const ids = d.readSessionIndex('m1').map(row => row.ref.sessionId);
    assert.deepEqual(ids, ['s-cursor']);
    assert.equal(d.getCursorState('m1').chatTabs?.length ?? 0, 0);
  });

  it('drops an ide-less sessions:index from a multi-slot agent but keeps it for an old one', () => {
    const modern = fakeSocket('m2');
    d.register(modern, { agentId: 'm2', hostname: 'h', slots: ['cursor', 'codebuddy'] });
    d.applySessionsIndex(modern, { sessions: [meta('s-none', undefined)] as never, mode: 'delta' });
    assert.equal(d.readSessionIndex('m2').length, 0);

    const legacy = fakeSocket('m3');
    d.register(legacy, { agentId: 'm3', hostname: 'h' });
    d.applySessionsIndex(legacy, { sessions: [meta('s-legacy', undefined)] as never, mode: 'delta' });
    assert.deepEqual(d.readSessionIndex('m3').map(row => row.ref.sessionId), ['s-legacy']);
  });

  it('drops an unknown ide on connection:status and on state:patch', () => {
    const agent = fakeSocket('agent');
    d.register(agent, { agentId: 'm1', hostname: 'h', slots: ['cursor', 'codebuddy'] });

    d.applyConnection(agent, { ide: 'nope' as never, connected: true });
    d.applyPatch(agent, { ide: 'nope', patch: { agentStatus: 'generating' } });

    const cursor = d.getCursorState('m1');
    assert.equal(cursor.connected, false);
    assert.notEqual(cursor.agentStatus, 'generating');
  });

  it('keeps the legacy cursor fallback for a connection that declared nothing', () => {
    const agent = fakeSocket('agent');
    d.register(agent, { agentId: 'm1', hostname: 'h' });

    d.applyConnection(agent, { connected: true });
    d.applyPatch(agent, { agentStatus: 'generating' });

    const cursor = d.getCursorState('m1');
    assert.equal(cursor.connected, true);
    assert.equal(cursor.agentStatus, 'generating');
  });
});
