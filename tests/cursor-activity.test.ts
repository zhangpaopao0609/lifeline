import type { ToolCallElement } from '../packages/web/src/net/protocol.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activitySummary, formatWorkDuration, markWork } from '../packages/web/src/lib/cursor-activity.ts';

function tool(id: string, toolName: string, extra: Partial<ToolCallElement> = {}): ToolCallElement {
  return {
    type: 'tool',
    id,
    flatIndex: 0,
    toolCallId: id,
    status: 'completed',
    action: toolName,
    toolName,
    details: '',
    ...extra,
  };
}

describe('cursor activity summary', () => {
  it('summarizes reads and searches the way Cursor does', () => {
    const items = [
      ...Array.from({ length: 14 }, (_, i) => tool(`r${i}`, 'read_file_v2', { filename: `f${i}.ts` })),
      ...Array.from({ length: 15 }, (_, i) => tool(`s${i}`, 'ripgrep_raw_search')),
    ];
    const summary = activitySummary(items);
    assert.equal(summary.action, 'Explored');
    assert.equal(summary.details, '14 files, 15 searches');
  });

  it('puts edits first, then explored files, searches, and the command', () => {
    const items = [
      ...Array.from({ length: 4 }, (_, i) => tool(`e${i}`, 'edit_file_v2', { filename: `a${i}.ts`, additions: i === 0 ? 67 : 0, deletions: i === 0 ? 36 : 0 })),
      tool('r', 'read_file_v2', { filename: 'funded_user.ts' }),
      tool('s1', 'ripgrep_raw_search'),
      tool('s2', 'ripgrep_raw_search'),
      tool('c', 'run_terminal_command_v2'),
    ];
    const summary = activitySummary(items);
    assert.equal(summary.action, 'Edited');
    assert.equal(summary.details, '4 files, explored 1 file, 2 searches, ran 1 command');
    assert.equal(summary.additions, 67);
    assert.equal(summary.deletions, 36);
  });

  it('uses the filename when a group touches one file', () => {
    const summary = activitySummary([
      tool('r', 'read_file_v2', { filename: 'docs/SKILL.md' }),
      tool('s', 'ripgrep_raw_search'),
      tool('f', 'web_fetch'),
      tool('c', 'run_terminal_command_v2'),
    ]);
    assert.equal(summary.action, 'Explored');
    assert.equal(summary.details, 'SKILL.md, 1 search, 1 fetch, ran 1 command');
  });

  it('labels a shell-only group as Ran', () => {
    const summary = activitySummary([
      tool('c1', 'run_terminal_command_v2'),
      tool('c2', 'run_terminal_command_v2'),
    ]);
    assert.equal(summary.action, 'Ran');
    assert.equal(summary.details, '2 commands');
  });
});

describe('worked-for fold', () => {
  it('formats the turn clock like Cursor', () => {
    assert.equal(formatWorkDuration(18 * 60 * 1000), '18m');
    assert.equal(formatWorkDuration(21 * 60 * 1000 + 35 * 1000), '21m 35s');
    assert.equal(formatWorkDuration(10 * 1000), '10s');
    assert.equal(formatWorkDuration(324_380), '5m 25s');
  });

  it('folds the process and leaves the final answer and trailing edits outside', () => {
    const start = 1_700_000_000_000;
    const marks = markWork([
      { kind: 'single', key: 'h', el: { type: 'human', createdAt: start } },
      { kind: 'single', key: 't', el: { type: 'thought', createdAt: start } },
      { kind: 'single', key: 'a1', el: { type: 'assistant', createdAt: start + 2000 } },
      { kind: 'tools', key: 'g1', items: [{ status: 'completed', createdAt: start + 18 * 60 * 1000 }] },
      { kind: 'single', key: 'a2', el: { type: 'assistant', createdAt: start + 18 * 60 * 1000 + 30_000 } },
      { kind: 'tools', key: 'g2', items: [{ status: 'completed', createdAt: start + 19 * 60 * 1000 }] },
    ], 'cursor');
    assert.equal(marks[0], undefined);
    assert.equal(marks[1]?.head?.id, 'work:t');
    assert.equal(formatWorkDuration(marks[1]?.head?.durationMs ?? 0), '18m');
    assert.equal(marks[2]?.groupId, 'work:t');
    assert.equal(marks[2]?.head, undefined);
    assert.equal(marks[3]?.groupId, 'work:t');
    assert.equal(marks[4], undefined);
    assert.equal(marks[5], undefined);
  });

  it('hides earlier replies and leaves only the last message outside', () => {
    const marks = markWork([
      { kind: 'single', key: 'h', el: { type: 'human' } },
      { kind: 'single', key: 'a1', el: { type: 'assistant' } },
      { kind: 'single', key: 'a2', el: { type: 'assistant' } },
    ], 'cursor');
    assert.equal(marks[1]?.head?.id, 'work:a1');
    assert.equal(marks[2], undefined);
  });

  it('leaves CodeBuddy turns flat — its transcript has no "Worked for" row', () => {
    const marks = markWork([
      { kind: 'single', key: 'h', el: { type: 'human' } },
      { kind: 'single', key: 't', el: { type: 'thought' } },
      { kind: 'single', key: 'a1', el: { type: 'assistant' } },
      { kind: 'tools', key: 'g1', items: [{ status: 'completed' }] },
      { kind: 'single', key: 'a2', el: { type: 'assistant' } },
    ], 'codebuddy');
    assert.deepEqual(marks, [undefined, undefined, undefined, undefined, undefined]);
  });
});
