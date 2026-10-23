import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  parseWorkBuddyJsonl,
  WorkBuddyJsonlAdapter,
} from '../packages/agent/src/sources/workbuddy-adapter.js';

let dir: string;
let projectsRoot: string;

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

function seedJsonl(): void {
  const projDir = join(projectsRoot, 'c-Users-demo-proj');
  mkdirSync(projDir, { recursive: true });
  const lines = [
    { type: 'session-meta', timestamp: 1000 },
    { type: 'ai-title', aiTitle: '修复 lifeline 补丁', timestamp: 1001 },
    {
      type: 'message',
      role: 'user',
      id: 'u1',
      timestamp: 1002,
      content: [{ type: 'input_text', text: '<user_info>x</user_info><user_query>帮我看看这个 bug</user_query>' }],
    },
    {
      type: 'reasoning',
      id: 'r1',
      timestamp: 1003,
      rawContent: [{ type: 'reasoning_text', text: '先分析根因' }],
    },
    {
      type: 'function_call',
      id: 'f1',
      callId: 'call-1',
      name: 'read_file',
      arguments: '{"path":"a.ts"}',
      timestamp: 1004,
    },
    {
      type: 'function_call_result',
      callId: 'call-1',
      status: 'completed',
      output: { type: 'text', text: 'file body' },
      timestamp: 1005,
    },
    {
      type: 'message',
      role: 'assistant',
      id: 'a1',
      status: 'completed',
      timestamp: 1006,
      providerData: { model: 'kimi-k3' },
      content: [{ type: 'output_text', text: '**结论**：是存储格式迁移' }],
    },
  ];
  writeFileSync(
    join(projDir, `${SESSION_ID}.jsonl`),
    `${lines.map(l => JSON.stringify(l)).join('\n')}\n`,
  );
}

describe('parseWorkBuddyJsonl', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wb-jsonl-'));
    projectsRoot = join(dir, 'projects');
    seedJsonl();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('parses title, timeline and folds tool results into calls', () => {
    const p = parseWorkBuddyJsonl(join(projectsRoot, 'c-Users-demo-proj', `${SESSION_ID}.jsonl`));
    assert.ok(p);
    assert.equal(p.title, '修复 lifeline 补丁');
    assert.equal(p.modelName, 'kimi-k3');
    assert.equal(p.status, 'completed');
    assert.deepEqual(p.entries.map(e => e.kind), ['human', 'reasoning', 'tool', 'assistant']);
    const tool = p.entries.find(e => e.kind === 'tool');
    assert.equal(tool?.complete, true);
    assert.equal(tool?.tool?.result, 'file body');
    // user envelope stripped to the visible query
    assert.equal(p.entries[0].text, '帮我看看这个 bug');
  });

  it('falls back to the first user message when ai-title is absent', () => {
    const projDir = join(projectsRoot, 'c-Users-demo-proj');
    writeFileSync(
      join(projDir, '22222222-2222-3333-4444-555555555555.jsonl'),
      `${JSON.stringify({
        type: 'message',
        role: 'user',
        id: 'u1',
        timestamp: 1,
        content: [{ type: 'input_text', text: '没有标题的会话' }],
      })}\n`,
    );
    const p = parseWorkBuddyJsonl(join(projDir, '22222222-2222-3333-4444-555555555555.jsonl'));
    assert.equal(p?.title, '没有标题的会话');
  });
});

describe('WorkBuddyJsonlAdapter', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wb-jsonl-'));
    projectsRoot = join(dir, 'projects');
    seedJsonl();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('probes the projects root', () => {
    const a = new WorkBuddyJsonlAdapter(projectsRoot);
    const p = a.probe();
    assert.equal(p.ok, true);
    a.close();
  });

  it('probe fails on a missing root', () => {
    const a = new WorkBuddyJsonlAdapter(join(dir, 'nope'));
    assert.equal(a.probe().ok, false);
    a.close();
  });

  it('lists sessions with title and model', () => {
    const a = new WorkBuddyJsonlAdapter(projectsRoot);
    const list = a.listSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0].ref.sessionId, SESSION_ID);
    assert.equal(list[0].title, '修复 lifeline 补丁');
    assert.equal(list[0].modelName, 'kimi-k3');
    a.close();
  });

  it('projects messages; includeProcess=false drops reasoning and tools', () => {
    const a = new WorkBuddyJsonlAdapter(projectsRoot, { includeProcess: false });
    const msgs = a.projectSession(SESSION_ID);
    assert.deepEqual(msgs.map(m => m.type), ['human', 'assistant']);
    const full = new WorkBuddyJsonlAdapter(projectsRoot);
    const types = full.projectSession(SESSION_ID).map(m => m.type);
    assert.deepEqual(types, ['human', 'thought', 'tool', 'assistant']);
    a.close();
    full.close();
  });

  it('resolves a webview tab id to a disk session via tab-title alias', () => {
    const a = new WorkBuddyJsonlAdapter(projectsRoot);
    a.setTabAliases([{ composerId: 'abcd1234abcd1234abcd1234abcd1234', title: '修复 lifeline 补丁' }]);
    assert.equal(a.hasSession('abcd1234abcd1234abcd1234abcd1234'), true);
    const msgs = a.projectSession('abcd1234abcd1234abcd1234abcd1234');
    assert.ok(msgs.some(m => m.type === 'assistant'));
    a.close();
  });

  it('synthesizes live DOM sessions for remote workspaces', () => {
    const a = new WorkBuddyJsonlAdapter(projectsRoot);
    a.setTabAliases([{ composerId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', title: '远端会话' }]);
    a.setLiveMessages('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', [
      { role: 'user', id: 'dom-u1', text: '在远端跑一下' },
      { role: 'assistant', id: 'dom-a1', text: '| 列 | 值 |\n| --- | --- |\n| a | 1 |' },
    ], 'idle');
    assert.equal(a.hasSession('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'), true);
    const idx = a.readIndex('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    assert.deepEqual(idx.map(h => h.role), ['human', 'assistant']);
    const msgs = a.projectSession('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    assert.equal(msgs.length, 2);
    // listSessions shows both the disk session and the live one
    const list = a.listSessions();
    assert.equal(list.length, 2);
    assert.ok(list.some(s => s.ref.workspaceId === 'live-dom'));
    a.close();
  });

  it('does not duplicate a live session whose title matches a disk session', () => {
    const a = new WorkBuddyJsonlAdapter(projectsRoot);
    a.setTabAliases([{ composerId: 'abcd1234abcd1234abcd1234abcd1234', title: '修复 lifeline 补丁' }]);
    a.setLiveMessages('abcd1234abcd1234abcd1234abcd1234', [
      { role: 'user', id: 'dom-u1', text: '帮我看看这个 bug' },
    ], 'idle');
    const list = a.listSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0].ref.sessionId, SESSION_ID);
    a.close();
  });
});
