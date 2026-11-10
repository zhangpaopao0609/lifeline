import type { AgentSocket } from '../packages/server/src/agent-hub.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AgentDirectory } from '../packages/server/src/agent-hub.js';
import { IdentityStore } from '../packages/server/src/identity-store.js';
import { SessionStore } from '../packages/server/src/session-store.js';

/**
 * Routing capability gate (`slots`).
 *
 * What it exists for: `command:*` is validated on the agent side with `.strict()` +
 * `z.enum(IDE_KINDS)`, so an unknown value is refused — but an **absent** `ide`
 * passes (it is `.optional()`), and `parseIde(undefined)` is `cursor`, which every
 * agent has. `session:get` is not validated at all. So a slot the agent cannot
 * answer must never be asked about, and an IDE command must never be forwarded
 * without an explicit `ide`.
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

function firstArg<T>(events: Array<[string, unknown[]]>, name: string): T | undefined {
  const hit = events.find(([event]) => event === name);
  return hit?.[1][0] as T | undefined;
}

describe('slots capability gate', () => {
  let dir: string;
  let store: IdentityStore;
  let sessionStore: SessionStore;
  let d: AgentDirectory;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gate-'));
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

  it('refuses a command for a slot the agent never reported', () => {
    const agent = fakeSocket('agent');
    d.register(agent, { agentId: 'm1', hostname: 'h', slots: ['cursor', 'codebuddy'] });
    const reply = fakeSocket('web');

    d.ingestBrowserCommand('m1', 'command:send_message', { commandId: 'c1', ide: 'vscode', text: 'hi' }, reply);

    assert.equal(firstArg<{ errorCode?: string }>(reply.events, 'command:result')?.errorCode, 'ide-agent-incompatible');
    assert.equal(agent.events.filter(([event]) => event.startsWith('command:')).length, 0, '不能发给 agent');
  });

  it('forwards an ide-less IDE command with an explicit cursor target', () => {
    const agent = fakeSocket('agent');
    d.register(agent, { agentId: 'm1', hostname: 'h', slots: ['cursor', 'codebuddy'] });
    const reply = fakeSocket('web');

    d.ingestBrowserCommand('m1', 'command:send_message', { commandId: 'c2', text: 'hi' }, reply);

    const forwarded = firstArg<{ ide?: string }>(agent.events, 'command:send_message');
    assert.equal(forwarded?.ide, 'cursor', '缺省必须补成显式 cursor，不能让 agent 的 parseIde 决定目标');
  });

  it('treats an agent that predates the declaration as cursor + codebuddy', () => {
    const agent = fakeSocket('agent');
    d.register(agent, { agentId: 'm1', hostname: 'h' });
    const reply = fakeSocket('web');

    d.ingestBrowserCommand('m1', 'command:send_message', { commandId: 'c3', ide: 'vscode', text: 'hi' }, reply);

    assert.equal(firstArg<{ errorCode?: string }>(reply.events, 'command:result')?.errorCode, 'ide-agent-incompatible');
  });

  it('closes session:get when the receiving agent lacks the slot', () => {
    const agent = fakeSocket('agent');
    d.register(agent, { agentId: 'm1', hostname: 'h', slots: ['cursor', 'codebuddy'] });

    // `session:patch` without a baseline asks the same machine for a full body.
    d.applySessionPatch(agent, { sessionId: 's1', messages: [], seq: 1, ide: 'vscode' });

    assert.equal(agent.events.filter(([event]) => event === 'session:get').length, 0, '不能向没有该槽的 agent 要正文');
  });

  // A refused poke must produce a terminal answer: the web has no timeout, so silence
  // leaves the page on a skeleton forever.
  it('answers session:unavailable when the receiving agent cannot serve the slot', () => {
    const agent = fakeSocket('agent');
    d.register(agent, { agentId: 'm1', hostname: 'h', slots: ['cursor', 'codebuddy'] });
    const reply = fakeSocket('web');

    d.handleSessionGet('m1', { sessionId: 's1', ide: 'vscode' }, reply);

    assert.equal(firstArg<{ sessionId?: string }>(reply.events, 'session:unavailable')?.sessionId, 's1');
    assert.equal(agent.events.filter(([event]) => event === 'session:get').length, 0);
  });

  it('emits session:get when the agent does report the slot', () => {
    const agent = fakeSocket('agent');
    d.register(agent, { agentId: 'm1', hostname: 'h', slots: ['cursor', 'codebuddy', 'vscode'] });

    d.applySessionPatch(agent, { sessionId: 's1', messages: [], seq: 1, ide: 'vscode' });

    assert.equal(firstArg<{ ide?: string }>(agent.events, 'session:get')?.ide, 'vscode');
  });
});
