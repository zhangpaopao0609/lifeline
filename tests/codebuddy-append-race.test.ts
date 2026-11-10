import type { SessionMeta } from '../packages/agent/src/sources/types.js';
import type { ChatElement, IdeKind } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ContentLiveRuntime } from '../packages/agent/src/content-runtime.js';
import { CodeBuddyAdapter } from '../packages/agent/src/sources/codebuddy-adapter.js';

/**
 * The plugin writes `index.json` and `messages/<id>.json` as two separate writes. A tick that lands
 * between them sees the id in the index but cannot read the body; if that tick still advances the
 * index watermark, the row is never projected again (measured 2026-11-09 on the vscode slot: the
 * human turn sent from the web vanished after a reload, only the assistant reply survived).
 *
 * The invariant this covers: an id is "delivered" only once an element was actually emitted for it.
 */

const SESSION = 'conv-race';
const BUCKET = 'bucket';
const UID = 'uid';
const WS = 'ws';

let root: string;
let rec: Rec;

interface Rec {
  full: { sessionId: string; messages: ChatElement[]; ide: IdeKind; seq: number }[];
  append: { sessionId: string; messages: ChatElement[]; ide: IdeKind; seq: number }[];
  patch: { sessionId: string; messages: ChatElement[]; ide: IdeKind; seq: number }[];
  sync: { sessionId: string; ide: IdeKind; seq: number }[];
  index: SessionMeta[][];
  handlers: {
    onIndex: (sessions: SessionMeta[]) => void;
    onSessionFull: (sessionId: string, messages: ChatElement[], ide: IdeKind, seq: number) => void;
    onSessionAppend: (sessionId: string, messages: ChatElement[], ide: IdeKind, seq: number) => void;
    onSessionPatch: (sessionId: string, messages: ChatElement[], ide: IdeKind, seq: number) => void;
    onSessionSync: (sessionId: string, ide: IdeKind, seq: number) => void;
  };
}

function recorder(): Rec {
  const r: Rec = { full: [], append: [], patch: [], sync: [], index: [] } as unknown as Rec;
  return {
    ...r,
    handlers: {
      onIndex: sessions => r.index.push(sessions),
      onSessionFull: (sessionId, messages, ide, seq) => r.full.push({ sessionId, messages, ide, seq }),
      onSessionAppend: (sessionId, messages, ide, seq) => r.append.push({ sessionId, messages, ide, seq }),
      onSessionPatch: (sessionId, messages, ide, seq) => r.patch.push({ sessionId, messages, ide, seq }),
      onSessionSync: (sessionId, ide, seq) => r.sync.push({ sessionId, ide, seq }),
    },
  };
}

function sessionDir(): string {
  return join(root, UID, 'VSCode', WS, 'history', BUCKET, SESSION);
}

function writeBucketIndex(): void {
  writeFileSync(
    join(root, UID, 'VSCode', WS, 'history', BUCKET, 'index.json'),
    JSON.stringify({
      conversations: [{
        id: SESSION,
        name: 'Race demo',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastMessageAt: new Date().toISOString(),
      }],
    }),
  );
}

/** `complete` mirrors the plugin: user rows are complete, assistant rows stay false while streaming. */
function writeIndex(rows: { id: string; role: 'user' | 'assistant'; complete: boolean }[]): void {
  writeFileSync(
    join(sessionDir(), 'index.json'),
    JSON.stringify({
      messages: rows.map(r => ({ id: r.id, type: 'text', role: r.role, isComplete: r.complete })),
      requests: [],
    }),
  );
}

function writeMessage(id: string, role: 'user' | 'assistant', text: string): void {
  writeFileSync(
    join(sessionDir(), 'messages', `${id}.json`),
    JSON.stringify({
      role,
      message: JSON.stringify({ role, content: [{ type: 'text', text }] }),
      id,
      createdAt: new Date().toISOString(),
    }),
  );
}

/** mtime is the change signal (index + messages dir), so ticks must land on distinct ms. */
function pause(): Promise<void> {
  return new Promise(r => setTimeout(r, 20));
}

function appendedIds(): string[] {
  return rec.append.flatMap(a => a.messages.map(m => m.id));
}

describe('codebuddy content runtime: row indexed before its body is readable', () => {
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'cb-append-race-'));
    mkdirSync(join(sessionDir(), 'messages'), { recursive: true });
    writeBucketIndex();
    writeIndex([
      { id: 'u1', role: 'user', complete: true },
      { id: 'a1', role: 'assistant', complete: true },
    ]);
    writeMessage('u1', 'user', '第一句');
    writeMessage('a1', 'assistant', '第一答');
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('still emits that row once its body lands', async () => {
    const adapter = new CodeBuddyAdapter(root, { ide: 'vscode', includeProcess: false });
    rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);
    rt.setActiveSession(SESSION);

    rt.tick();
    assert.equal(rec.full.length, 1);
    assert.deepEqual(rec.full[0].messages.map(m => m.id), ['u1', 'a1']);

    // 1) index lists the new human turn, body not written yet (the plugin's two writes race).
    await pause();
    writeIndex([
      { id: 'u1', role: 'user', complete: true },
      { id: 'a1', role: 'assistant', complete: true },
      { id: 'u2', role: 'user', complete: true },
    ]);
    rt.tick();
    assert.deepEqual(appendedIds(), [], 'nothing to append: the body is not readable yet');

    // 2) body + the assistant reply land together (what the real session did 14:32:32 → 14:32:36).
    await pause();
    writeIndex([
      { id: 'u1', role: 'user', complete: true },
      { id: 'a1', role: 'assistant', complete: true },
      { id: 'u2', role: 'user', complete: true },
      { id: 'a2', role: 'assistant', complete: false },
    ]);
    writeMessage('u2', 'user', '第二句');
    writeMessage('a2', 'assistant', '第二答');
    rt.tick();

    assert.ok(
      appendedIds().includes('u2'),
      `the row indexed while its body was unreadable must still be emitted; got ${JSON.stringify(appendedIds())}`,
    );
    assert.ok(appendedIds().includes('a2'));

    // 3) quiet disk + a later change must not re-send rows that were already delivered.
    await pause();
    writeMessage('a2', 'assistant', '第二答（续）');
    rt.tick();
    assert.equal(
      appendedIds().filter(id => id === 'u2').length,
      1,
      'delivered rows are not append again',
    );
  });
});

/**
 * The retry rule must converge. A row that will never produce an element of its own (a tool header is
 * indexed under the message id, its card carries the toolCallId; compaction rows emit nothing) must not
 * be fetched on every changed tick — that also re-projects its siblings, which can push a delivered card
 * back to loading.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/codebuddy-history');

describe('codebuddy content runtime: unresolved retries are bounded', () => {
  it('stops re-reading a row that can never be emitted and never rewrites delivered elements', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cb-pin-'));
    cpSync(FIXTURE, root, { recursive: true });
    const dir = join(root, 'ws/CodeBuddyIDE/ws/history/bucket/conv1');
    const adapter = new CodeBuddyAdapter(root); // includeProcess defaults true → index keeps the tool row
    const fetches: (string[] | null)[] = [];
    const orig = adapter.projectSession.bind(adapter);
    adapter.projectSession = (sessionId: string, ids?: string[]) => {
      fetches.push(ids ?? null);
      return orig(sessionId, ids);
    };
    const appends: string[][] = [];
    const rt = new ContentLiveRuntime(adapter, {
      onIndex: () => {},
      onSessionFull: () => {},
      onSessionPatch: () => {},
      onSessionSync: () => {},
      onSessionAppend: (_sid, msgs) => appends.push(msgs.map(m => m.id)),
    });
    rt.setActiveSession('conv1');
    rt.tick();
    assert.equal(fetches.length, 1, 'first tick is the full projection');
    assert.equal(fetches[0], null);

    // The tool header has no element of its own, so it is retried — but only for a bounded number of
    // ticks. After that it is abandoned and the fetch set returns to the normal path.
    const perTick: string[][] = [];
    const appendsPerTick: string[][] = [];
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 25));
      writeFileSync(join(dir, 'index.json'), readFileSync(join(dir, 'index.json'), 'utf8')); // mtime = changed
      fetches.length = 0;
      const before = appends.length;
      rt.tick();
      perTick.push((fetches[0] ?? []) as string[]);
      appendsPerTick.push(appends.slice(before).flat());
    }
    // Repair ticks (fetch set pinned to a header that has no element) must not append anything: they
    // re-read a subset, and a renumbered flatIndex would otherwise churn a delivered card.
    perTick.forEach((ids, i) => {
      const pinned = ids.length === 1 && ids[0] === 't1';
      if (pinned)
        assert.deepEqual(appendsPerTick[i], [], `repair tick ${i + 1} must not append`);
    });
    // "Pinned" = the fetch set is *only* that header. After the budget the whole-index fallback runs
    // again (the header is still in the index), which is the pre-existing read shape, not a retry.
    const pinnedTicks = perTick.filter(ids => ids.length === 1 && ids[0] === 't1').length;
    assert.ok(pinnedTicks > 0, 'the unaccounted tool header is retried at least once');
    assert.ok(pinnedTicks <= 4, `pinned retries must be bounded, got ${pinnedTicks} ticks`);
    assert.ok(
      perTick[perTick.length - 1]!.includes('u1'),
      `after the budget the fetch set is normal again: ${JSON.stringify(perTick)}`,
    );
    assert.equal(
      appends.flat().some(id => id === 'u1' || id === 'a1'),
      false,
      'rows that already have elements are never re-appended on a quiet disk',
    );
    rmSync(root, { recursive: true, force: true });
  });

  // The production shape (2026-11-09): the agent restarts, the plugin has already indexed the human row
  // but its body is still being written, so the FULL projection remembers 12 headers and emits 11. The
  // header is then neither "new" nor "incomplete" and the turn is lost for good unless the runtime
  // notices that it never produced an element.
  it('delivers a row whose body landed after the full projection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cb-full-race-'));
    const dir = join(root, 'uid/VSCode/ws/history/bucket/s2');
    mkdirSync(join(dir, 'messages'), { recursive: true });
    writeFileSync(
      join(root, 'uid/VSCode/ws/history/bucket/index.json'),
      JSON.stringify({ conversations: [{ id: 's2', name: 'Full race', lastMessageAt: new Date().toISOString() }] }),
    );
    writeFileSync(
      join(dir, 'index.json'),
      JSON.stringify({
        messages: [
          { id: 'u1', type: 'text', role: 'user', isComplete: true },
          { id: 'a1', type: 'text', role: 'assistant', isComplete: true },
          { id: 'u2', type: 'text', role: 'user', isComplete: true },
        ],
        requests: [],
      }),
    );
    const writeMsg = (id: string, role: 'user' | 'assistant', text: string): void => {
      writeFileSync(
        join(dir, 'messages', `${id}.json`),
        JSON.stringify({ role, message: JSON.stringify({ role, content: [{ type: 'text', text }] }), id, createdAt: new Date().toISOString() }),
      );
    };
    writeMsg('u1', 'user', '第一句');
    writeMsg('a1', 'assistant', '第一答');
    // u2 is indexed but its body is not on disk yet.

    const adapter = new CodeBuddyAdapter(root, { ide: 'vscode', includeProcess: false });
    const appends: string[][] = [];
    const rt = new ContentLiveRuntime(adapter, {
      onIndex: () => {},
      onSessionFull: () => {},
      onSessionPatch: () => {},
      onSessionSync: () => {},
      onSessionAppend: (_sid, msgs) => appends.push(msgs.map(m => m.id)),
    });
    rt.setActiveSession('s2');
    rt.tick(); // full — u2 body missing, so it cannot be emitted
    assert.deepEqual(appends, [], 'nothing to append on the full tick');

    writeMsg('u2', 'user', '第二句'); // body lands
    await new Promise(r => setTimeout(r, 25));
    writeFileSync(join(dir, 'index.json'), readFileSync(join(dir, 'index.json'), 'utf8'));
    rt.tick();
    assert.ok(
      appends.flat().includes('u2'),
      `the row that missed the full projection must still be delivered; got ${JSON.stringify(appends)}`,
    );
    rmSync(root, { recursive: true, force: true });
  });

  // A body that never shows up must not freeze the session: bounded retries, then move on. Before this,
  // the counter was dropped at the limit and restarted on the following tick, so `degraded` stayed true
  // forever and replacements were never allowed again.
  it('gives up on a body that never appears and keeps the session flowing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cb-giveup-'));
    const dir = join(root, 'uid/VSCode/ws/history/bucket/s1');
    mkdirSync(join(dir, 'messages'), { recursive: true });
    writeFileSync(
      join(root, 'uid/VSCode/ws/history/bucket/index.json'),
      JSON.stringify({ conversations: [{ id: 's1', name: 'Give up', lastMessageAt: new Date().toISOString() }] }),
    );
    const writeIdx = (rows: { id: string; role: 'user' | 'assistant'; complete: boolean }[]): void => {
      writeFileSync(
        join(dir, 'index.json'),
        JSON.stringify({ messages: rows.map(r => ({ id: r.id, type: 'text', role: r.role, isComplete: r.complete })), requests: [] }),
      );
    };
    const writeMsg = (id: string, role: 'user' | 'assistant', text: string): void => {
      writeFileSync(
        join(dir, 'messages', `${id}.json`),
        JSON.stringify({ role, message: JSON.stringify({ role, content: [{ type: 'text', text }] }), id, createdAt: new Date().toISOString() }),
      );
    };
    writeIdx([{ id: 'u1', role: 'user', complete: true }, { id: 'a1', role: 'assistant', complete: true }]);
    writeMsg('u1', 'user', '第一句');
    writeMsg('a1', 'assistant', '第一答');

    const adapter = new CodeBuddyAdapter(root, { ide: 'vscode', includeProcess: false });
    const fetches: (string[] | null)[] = [];
    const orig = adapter.projectSession.bind(adapter);
    adapter.projectSession = (sessionId: string, ids?: string[]) => {
      fetches.push(ids ?? null);
      return orig(sessionId, ids);
    };
    const appends: string[][] = [];
    const rt = new ContentLiveRuntime(adapter, {
      onIndex: () => {},
      onSessionFull: () => {},
      onSessionPatch: () => {},
      onSessionSync: () => {},
      onSessionAppend: (_sid, msgs) => appends.push(msgs.map(m => m.id)),
    });
    rt.setActiveSession('s1');
    rt.tick(); // full
    fetches.length = 0;

    // u2 is indexed but its body never lands. Each changed tick retries it…
    writeIdx([{ id: 'u1', role: 'user', complete: true }, { id: 'a1', role: 'assistant', complete: true }, { id: 'u2', role: 'user', complete: true }]);
    let askedU2 = 0;
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, 'index.json'), readFileSync(join(dir, 'index.json'), 'utf8')); // mtime = changed
      fetches.length = 0;
      await new Promise(r => setTimeout(r, 20));
      rt.tick();
      if (fetches.flat().includes('u2'))
        askedU2 += 1;
    }
    assert.ok(askedU2 > 0, 'the unreadable body is retried');
    assert.ok(askedU2 <= 4, `retries must be bounded (asked ${askedU2} times in 5 ticks)`);

    // …and the session still takes new rows afterwards (no permanent freeze).
    await new Promise(r => setTimeout(r, 20));
    writeIdx([
      { id: 'u1', role: 'user', complete: true },
      { id: 'a1', role: 'assistant', complete: true },
      { id: 'u2', role: 'user', complete: true },
      { id: 'u3', role: 'user', complete: true },
    ]);
    writeMsg('u3', 'user', '第三句');
    rt.tick();
    assert.ok(appendedIdsOf(appends).includes('u3'), 'later rows must still be delivered');
    rmSync(root, { recursive: true, force: true });
  });
});

function appendedIdsOf(appends: string[][]): string[] {
  return appends.flat();
}
