import type { ThoughtBlock, ToolCallElement } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tryOpenCodeBuddyAdapter } from '../packages/agent/src/content-runtime.js';
import { CodeBuddyAdapter } from '../packages/agent/src/sources/codebuddy-adapter.js';
import { projectCodeBuddy } from '../packages/agent/src/sources/codebuddy-project.js';

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/codebuddy-history',
);

describe('CodeBuddyAdapter', () => {
  it('probes the fixture root as ok', () => {
    const a = new CodeBuddyAdapter(FIXTURE_ROOT);
    const p = a.probe();
    assert.equal(p.ok, true);
    assert.equal(a.ide, 'codebuddy');
  });

  it('lists Demo and treats a missing lastMessageAt as 0', () => {
    const a = new CodeBuddyAdapter(FIXTURE_ROOT);
    const list = a.listSessions();
    const demo = list.find(s => s.ref.sessionId === 'conv1');
    assert.ok(demo);
    assert.equal(demo.title, 'Demo');
    assert.equal(demo.ref.ide, 'codebuddy');
    assert.equal(demo.mode, 'craft');
    const none = list.find(s => s.ref.sessionId === 'conv2');
    assert.ok(none);
    assert.equal(none.lastUpdatedAt, 0);
  });

  it('projects conv1 as human / thought / assistant / one tool and skips ghost', () => {
    const a = new CodeBuddyAdapter(FIXTURE_ROOT);
    const msgs = a.projectSession('conv1');
    assert.deepEqual(
      msgs.map(m => m.type),
      ['human', 'thought', 'assistant', 'tool'],
    );
    assert.equal(msgs.filter(m => m.type === 'tool').length, 1);
    assert.ok(!msgs.some(m => m.id === 'ghost' || m.id.includes('ghost')));
    assert.equal(msgs[0].id, 'u1');
    assert.equal((msgs[0] as { text: string }).text, 'hello');
    const thought = msgs[1] as ThoughtBlock;
    assert.equal(thought.id, 'a1:think');
    assert.equal(thought.detail, 'think');
    assert.equal(msgs[2].id, 'a1');
    assert.equal((msgs[2] as { text: string }).text, 'world');
    const tool = msgs[3] as ToolCallElement;
    assert.equal(tool.toolCallId, 'c1');
    assert.equal(tool.toolName, 'read_file');
    assert.equal(tool.status, 'completed');
  });

  it('projectSession omits process cards when includeProcess is false', () => {
    const a = new CodeBuddyAdapter(FIXTURE_ROOT, { includeProcess: false });
    const msgs = a.projectSession('conv1');
    assert.deepEqual(
      msgs.map(m => m.type),
      ['human', 'assistant'],
    );
  });

  it('marks helper conversations as subagent on listSessions', () => {
    const a = new CodeBuddyAdapter(FIXTURE_ROOT);
    const list = a.listSessions();
    const helper = list.find(s => s.ref.sessionId === 'conv3');
    assert.ok(helper);
    assert.equal(helper.title, 'Helper');
    assert.equal(helper.isSubagent, true);
    assert.notEqual(helper.isSubagent, false);
    const demo = list.find(s => s.ref.sessionId === 'conv1');
    assert.equal(demo?.isSubagent, false);
  });

  it('sets generating when a message is incomplete or a request is running', () => {
    const a = new CodeBuddyAdapter(FIXTURE_ROOT);
    const list = a.listSessions();
    const streaming = list.find(s => s.ref.sessionId === 'conv4');
    const running = list.find(s => s.ref.sessionId === 'conv5');
    assert.ok(streaming);
    assert.ok(running);
    assert.equal(streaming.status, 'generating');
    assert.equal(running.status, 'generating');
    assert.equal(a.enrichMeta(streaming).status, 'generating');
    assert.equal(a.enrichMeta(running).status, 'generating');
  });

  it('sets completed or idle when nothing is in flight', () => {
    const a = new CodeBuddyAdapter(FIXTURE_ROOT);
    const list = a.listSessions();
    const demo = list.find(s => s.ref.sessionId === 'conv1');
    const empty = list.find(s => s.ref.sessionId === 'conv2');
    assert.ok(demo);
    assert.ok(empty);
    assert.equal(demo.status, 'completed');
    assert.equal(empty.status, 'idle');
    assert.equal(a.enrichMeta(demo).status, 'completed');
    assert.equal(a.enrichMeta(empty).status, 'idle');
  });
});

describe('projectCodeBuddy user text', () => {
  function humanFile(id: string, text: string) {
    return {
      id,
      role: 'user',
      createdAt: '2026-01-02T00:00:00.000Z',
      message: JSON.stringify({
        role: 'user',
        content: [{ type: 'text', text }],
      }),
    };
  }

  it('keeps only user_query when additional_data is wrapped around it', () => {
    const msgs = projectCodeBuddy(
      [{ id: 'u1', role: 'user' }],
      new Map([
        [
          'u1',
          humanFile(
            'u1',
            '<additional_data>\ncurrent_Time: Saturday, September 12, 2026\n</additional_data>\n\n<user_query>\n是 9999\n</user_query>',
          ),
        ],
      ]),
    );
    assert.equal(msgs.length, 1);
    assert.equal((msgs[0] as { text: string }).text, '是 9999');
  });

  it('keeps only user_query on the first turn that also has user_info and rules', () => {
    const msgs = projectCodeBuddy(
      [{ id: 'u1', role: 'user' }],
      new Map([
        [
          'u1',
          humanFile(
            'u1',
            '<user_info>\nOS Version: darwin\n</user_info>\n\n<rules>\nDo not leak.\n</rules>\n\n<user_query>\nhello\n</user_query>',
          ),
        ],
      ]),
    );
    assert.equal((msgs[0] as { text: string }).text, 'hello');
  });

  it('leaves a plain user bubble unchanged', () => {
    const msgs = projectCodeBuddy(
      [{ id: 'u1', role: 'user' }],
      new Map([['u1', humanFile('u1', 'hello')]]),
    );
    assert.equal((msgs[0] as { text: string }).text, 'hello');
  });
});

describe('projectCodeBuddy includeProcess', () => {
  it('omits thought and tool when includeProcess is false', () => {
    const dir = join(
      FIXTURE_ROOT,
      'ws/CodeBuddyIDE/ws/history/bucket/conv1',
    );
    const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf-8')) as {
      messages: Array<{ id: string; type?: string; role?: string }>;
    };
    const files = new Map();
    for (const e of idx.messages) {
      files.set(
        e.id,
        JSON.parse(readFileSync(join(dir, 'messages', `${e.id}.json`), 'utf-8')),
      );
    }
    const msgs = projectCodeBuddy(idx.messages, files, { includeProcess: false });
    assert.deepEqual(
      msgs.map(m => m.type),
      ['human', 'assistant'],
    );
  });
});

describe('tryOpenCodeBuddyAdapter', () => {
  it('returns null and warns when the root is missing', () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const missing = join(tmpdir(), `codebuddy-missing-${process.pid}`);
      assert.equal(tryOpenCodeBuddyAdapter(missing), null);
      assert.ok(warnings.some(w => /codebuddy/i.test(w)));
    }
    finally {
      console.warn = orig;
    }
  });
});
