import type { IdeKind, SessionMeta } from '../packages/agent/src/sources/types.js';
import type { AssistantMessage, ChatElement, ToolCallElement } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { ContentLiveRuntime, DEFAULT_CODEBUDDY_ROOT, DEFAULT_CURSOR_VSCDB, defaultCodeBuddyRoot, defaultCursorVscdb, tryOpenCursorAdapter } from '../packages/agent/src/content-runtime.js';
import { CursorAdapter } from '../packages/agent/src/sources/cursor-adapter.js';

// Platform-specific path pure functions. Measured: Cursor's DB is under %APPDATA%, while CodeBuddy's **content root**
// is not userDataDir but %LOCALAPPDATA%\CodeBuddyExtension\Data — different layers; do not "unify" them.
describe('default content roots', () => {
  const env = { APPDATA: 'C:\\a\\Roaming', LOCALAPPDATA: 'C:\\a\\Local' };

  it('resolves Windows roots from the environment', () => {
    assert.equal(
      defaultCursorVscdb(env, 'C:\\h', 'win32'),
      'C:\\a\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb',
    );
    assert.equal(
      defaultCodeBuddyRoot(env, 'C:\\h', 'win32'),
      'C:\\a\\Local\\CodeBuddyExtension\\Data',
    );
  });

  it('keeps the macOS and Linux roots byte-identical to the old constants', () => {
    assert.equal(
      defaultCursorVscdb(env, '/Users/x', 'darwin'),
      join('/Users/x', 'Library/Application Support/Cursor/User/globalStorage/state.vscdb'),
    );
    assert.equal(
      defaultCodeBuddyRoot(env, '/Users/x', 'darwin'),
      join('/Users/x', 'Library/Application Support/CodeBuddyExtension/Data'),
    );
    assert.equal(
      defaultCursorVscdb(env, '/home/x', 'linux'),
      join('/home/x', '.config/Cursor/User/globalStorage/state.vscdb'),
    );
    assert.equal(
      defaultCodeBuddyRoot(env, '/home/x', 'linux'),
      join('/home/x', '.local/share/CodeBuddyExtension/Data'),
    );
  });

  // The constants are the production path values (they are the default args of the two `tryOpen*Adapter`s); tests always go through the functions.
  // Without this assertion, changing a constant back to a hard-code / wrong platform still greens the tests while production points at the wrong dir on Windows —
  // exactly the class of bug this change is fixing.
  it('exports constants equal to the platform function with defaults', () => {
    assert.equal(DEFAULT_CURSOR_VSCDB, defaultCursorVscdb());
    assert.equal(DEFAULT_CODEBUDDY_ROOT, defaultCodeBuddyRoot());
  });

  it('falls back under the home dir when %APPDATA% / %LOCALAPPDATA% are missing', () => {
    assert.equal(
      defaultCursorVscdb({}, 'C:\\h', 'win32'),
      'C:\\h\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb',
    );
    assert.equal(
      defaultCodeBuddyRoot({}, 'C:\\h', 'win32'),
      'C:\\h\\AppData\\Local\\CodeBuddyExtension\\Data',
    );
  });
});

let dir: string;
let dbPath: string;
let adapter: CursorAdapter;

interface Rec {
  index: SessionMeta[][];
  full: { sessionId: string; messages: ChatElement[]; ide: IdeKind; seq: number }[];
  append: { sessionId: string; messages: ChatElement[]; ide: IdeKind; seq: number }[];
  patch: { sessionId: string; messages: ChatElement[]; ide: IdeKind; seq: number }[];
  sync: { sessionId: string; ide: IdeKind; seq: number }[];
}

function recorder(): Rec & {
  handlers: {
    onIndex: (sessions: SessionMeta[]) => void;
    onSessionFull: (sessionId: string, messages: ChatElement[], ide: IdeKind, seq: number) => void;
    onSessionAppend: (sessionId: string, messages: ChatElement[], ide: IdeKind, seq: number) => void;
    onSessionPatch: (sessionId: string, messages: ChatElement[], ide: IdeKind, seq: number) => void;
    onSessionSync: (sessionId: string, ide: IdeKind, seq: number) => void;
  };
} {
  const rec: Rec = { index: [], full: [], append: [], patch: [], sync: [] };
  return {
    ...rec,
    handlers: {
      onIndex: sessions => rec.index.push(sessions),
      onSessionFull: (sessionId, messages, ide, seq) => rec.full.push({ sessionId, messages, ide, seq }),
      onSessionAppend: (sessionId, messages, ide, seq) =>
        rec.append.push({ sessionId, messages, ide, seq }),
      onSessionPatch: (sessionId, messages, ide, seq) =>
        rec.patch.push({ sessionId, messages, ide, seq }),
      onSessionSync: (sessionId, ide, seq) => rec.sync.push({ sessionId, ide, seq }),
    },
  };
}

function seed(opts?: {
  subagent?: boolean;
  generatingIds?: string[];
  loadingTool?: boolean;
}): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY, workspaceId TEXT,
      createdAt INTEGER, lastUpdatedAt INTEGER,
      isArchived INTEGER, isSubagent INTEGER, value TEXT
    );
    CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare(`INSERT INTO composerHeaders VALUES (?,?,?,?,?,?,?)`).run(
    'cid1',
    'ws1',
    1,
    2,
    0,
    0,
    JSON.stringify({ name: 'Demo', unifiedMode: 'agent' }),
  );
  if (opts?.subagent) {
    db.prepare(`INSERT INTO composerHeaders VALUES (?,?,?,?,?,?,?)`).run(
      'cid-sub',
      'ws1',
      1,
      3,
      0,
      1,
      JSON.stringify({ name: 'Child' }),
    );
  }
  const headers: unknown[] = [
    {
      bubbleId: 'h1',
      type: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      grouping: { isRenderable: true, textPreview: 'hi' },
    },
    { bubbleId: 'skip', type: 2, grouping: { isRenderable: false } },
    {
      bubbleId: 'a1',
      type: 2,
      createdAt: '2026-01-01T00:00:01.000Z',
      grouping: { isRenderable: true },
    },
  ];
  if (opts?.loadingTool) {
    headers.push({
      bubbleId: 't1',
      type: 2,
      createdAt: '2026-01-01T00:00:02.000Z',
      grouping: { isRenderable: true },
    });
  }
  const composerData = {
    _v: 18,
    name: 'Demo',
    status: 'none',
    generatingBubbleIds: opts?.generatingIds ?? [],
    fullConversationHeadersOnly: headers,
  };
  db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(
    'composerData:cid1',
    JSON.stringify(composerData),
  );
  db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(
    'bubbleId:cid1:h1',
    JSON.stringify({ type: 1, bubbleId: 'h1', text: 'hi', createdAt: 1 }),
  );
  db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(
    'bubbleId:cid1:ghost',
    JSON.stringify({ type: 2, bubbleId: 'ghost', text: 'should not index', createdAt: 1 }),
  );
  db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(
    'bubbleId:cid1:a1',
    JSON.stringify({ type: 2, bubbleId: 'a1', text: 'ok', createdAt: 2 }),
  );
  if (opts?.loadingTool) {
    db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(
      'bubbleId:cid1:t1',
      JSON.stringify({
        type: 2,
        bubbleId: 't1',
        text: '',
        createdAt: 3,
        toolFormerData: {
          toolCallId: 'tc1',
          name: 'read_file_v2',
          status: 'loading',
          params: '{"relativeWorkspacePath":"a.ts"}',
        },
      }),
    );
  }
  db.close();
}

function addAssistant(id: string, text: string): void {
  const db = new Database(dbPath);
  const row = db
    .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
    .get('composerData:cid1') as { value: string };
  const cd = JSON.parse(row.value) as {
    fullConversationHeadersOnly: unknown[];
  };
  cd.fullConversationHeadersOnly.push({
    bubbleId: id,
    type: 2,
    createdAt: '2026-01-01T00:00:03.000Z',
    grouping: { isRenderable: true },
  });
  db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(
    JSON.stringify(cd),
    'composerData:cid1',
  );
  db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(
    `bubbleId:cid1:${id}`,
    JSON.stringify({ type: 2, bubbleId: id, text, createdAt: 4 }),
  );
  db.close();
}

function addOtherComposer(): void {
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO composerHeaders VALUES (?,?,?,?,?,?,?)`).run(
    'cid-other',
    'ws1',
    1,
    9,
    0,
    0,
    JSON.stringify({ name: 'Other' }),
  );
  db.close();
}

function enrichToolWithDiff(): void {
  const db = new Database(dbPath);
  db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(
    'composer.content.aaa',
    'before\n',
  );
  db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(
    'composer.content.bbb',
    'after\n',
  );
  const row = db
    .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
    .get('bubbleId:cid1:t1') as { value: string };
  const bubble = JSON.parse(row.value) as {
    toolFormerData: {
      name: string;
      status: string;
      result?: unknown;
    };
  };
  bubble.toolFormerData.name = 'edit_file_v2';
  bubble.toolFormerData.status = 'completed';
  bubble.toolFormerData.result = {
    beforeContentId: 'composer.content.aaa',
    afterContentId: 'composer.content.bbb',
  };
  db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(
    JSON.stringify(bubble),
    'bubbleId:cid1:t1',
  );
  db.close();
}

describe('ContentLiveRuntime', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vscdb-rt-'));
    dbPath = join(dir, 'state.vscdb');
  });
  afterEach(() => {
    adapter?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('first tick does not list all disk sessions; active session full has h1 not ghost/skip; unchanged dataVersion does not emit again', () => {
    seed({ subagent: true });
    adapter = new CursorAdapter(dbPath);
    let listed = 0;
    const origList = adapter.listSessions.bind(adapter);
    adapter.listSessions = () => {
      listed += 1;
      return origList();
    };
    const rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);

    rt.tick();
    assert.equal(listed, 0, 'must not scan every composer for the web');
    assert.equal(rec.index.length, 0);
    assert.equal(rec.full.length, 0);

    rt.setActiveSession('cid1');
    rt.tick();
    assert.equal(rec.full.length, 1, 'active tick calls onSessionFull');
    assert.equal(rec.full[0].sessionId, 'cid1');
    assert.equal(rec.full[0].ide, 'cursor');
    const ids = rec.full[0].messages.map(m => m.id);
    assert.ok(ids.includes('h1'));
    assert.ok(!ids.includes('ghost'));
    assert.ok(!ids.includes('skip'));
    assert.equal(rec.index.length, 0);

    rt.tick();
    assert.equal(rec.full.length, 1, 'unchanged dataVersion does not onSessionFull again');
    assert.equal(rec.index.length, 0);
    assert.equal(listed, 0);
    assert.equal(rec.append.length, 0);
  });

  it('does not re-project the active session when another composer bumps data_version', () => {
    seed();
    adapter = new CursorAdapter(dbPath);
    let projects = 0;
    const orig = adapter.projectSession.bind(adapter);
    adapter.projectSession = (sessionId: string) => {
      projects += 1;
      return orig(sessionId);
    };
    const rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);
    rt.setActiveSession('cid1');
    rt.tick();
    assert.equal(projects, 1);
    assert.equal(rec.full.length, 1);

    addOtherComposer();
    rt.tick();
    assert.equal(projects, 1, 'cid1 index unchanged — skip projectSession');
    assert.equal(rec.full.length, 1);
    assert.equal(rec.append.length, 0);
  });

  it('skips ticks while paused so a command is not blocked by projection', () => {
    seed();
    adapter = new CursorAdapter(dbPath);
    const rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);
    rt.setActiveSession('cid1');
    rt.pauseTicks();
    rt.tick();
    assert.equal(rec.full.length, 0);
    rt.resumeTicks();
    rt.tick();
    assert.equal(rec.full.length, 1);
  });

  it('requestSession always emits onSessionFull', () => {
    seed();
    adapter = new CursorAdapter(dbPath);
    const rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);
    rt.tick();
    rt.requestSession('cid1');
    assert.equal(rec.full.length, 1);
    const ids = rec.full[0].messages.map(m => m.id);
    assert.ok(ids.includes('h1'));
    rt.requestSession('cid1');
    assert.equal(rec.full.length, 2);
  });

  it('stays silent for a session that is not on this machine', () => {
    seed();
    adapter = new CursorAdapter(dbPath);
    const rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);

    // Cross-machine: the active session in the DOM belongs on the remote dev machine's disk — this machine must not answer an empty full,
    // or it would wipe the body the content machine pushed.
    rt.setActiveSession('cid-remote-only');
    rt.tick();
    rt.tick();
    assert.equal(rec.full.length, 0, '本地没有的会话不投影');
    assert.equal(rec.append.length, 0);

    rt.requestSession('cid-remote-only');
    assert.equal(rec.full.length, 0, '点名要也不答');

    // Local sessions that actually exist stay as they were
    rt.requestSession('cid1');
    assert.equal(rec.full.length, 1);
    assert.equal(rec.full[0].sessionId, 'cid1');
  });

  it('full resets the stream seq, appends advance it, and a sinceSeq hit answers sync only', () => {
    seed();
    adapter = new CursorAdapter(dbPath);
    const rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);
    rt.setActiveSession('cid1');
    rt.tick();
    assert.equal(rec.full.length, 1);
    assert.equal(rec.full[0].seq, 0, 'full 是基准重置，恒为 0');

    addAssistant('a2', 'later');
    rt.tick();
    assert.equal(rec.append.length, 1);
    assert.equal(rec.append[0].seq, 1);

    addAssistant('a3', 'even later');
    rt.tick();
    assert.equal(rec.append.length, 2);
    assert.equal(rec.append[1].seq, 2);

    // Match: do not re-project, only reply sync
    rt.requestSession('cid1', 2);
    assert.deepEqual(rec.sync, [{ sessionId: 'cid1', ide: 'cursor', seq: 2 }]);
    assert.equal(rec.full.length, 1);

    // Mismatch (a packet was missed) with a baseline: reply the current full projection as a patch; not a writeSession-style full, and not empty-diff→sync
    rt.requestSession('cid1', 1);
    assert.equal(rec.full.length, 1, '有基准就不再 full');
    assert.equal(rec.patch.length, 1);
    assert.equal(rec.sync.length, 1, '前面 seq 对上的那次 sync 还在；这次落后不许再 sync');
    assert.ok(rec.patch[0].messages.some(m => m.id === 'a3'), '整份投影里必须带上缺口之后的内容');
    assert.equal(rec.patch[0].seq, 2, 'patch 把对账点推到当前 seq');
  });

  it('answers a stale sinceSeq with the current projection as a patch', () => {
    seed();
    adapter = new CursorAdapter(dbPath);
    const rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);
    rt.setActiveSession('cid1');
    rt.tick();
    assert.equal(rec.full[0].seq, 0);

    addAssistant('a2', 'later');
    rt.tick();
    assert.equal(rec.append[0].seq, 1);

    addAssistant('a3', 'even later');
    rt.tick();
    rt.requestSession('cid1', 0);
    assert.equal(rec.full.length, 1, '不重投影整份权威 full');
    assert.equal(rec.patch.length, 1, '回的是 patch');
    const ids = rec.patch[0].messages.map(m => m.id);
    assert.ok(ids.includes('a2') && ids.includes('a3'), 'seq 落后时发整份投影，不只 lastEmitted 之后那一条');
    assert.equal(rec.patch[0].seq, 2, 'patch 把对账点推到当前 seq');
    assert.equal(rec.sync.filter(s => s.seq === 2).length, 0, '落后不许空 sync');
  });

  it('does not answer sync when the disk changed since the last emit', () => {
    seed();
    adapter = new CursorAdapter(dbPath);
    const rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);
    rt.setActiveSession('cid1');
    rt.tick();
    assert.equal(rec.full[0].seq, 0);

    addAssistant('a2', 'later');
    // seq is still 0 but the disk changed (e.g. the daemon was not following just now): must not reply only sync and drop the new content
    rt.requestSession('cid1', 0);
    assert.equal(rec.sync.length, 0);
    assert.equal(rec.patch.length, 1);
    assert.deepEqual(rec.patch[0].messages.map(m => m.id), ['a2']);
  });

  it('answers sync from a restored watermark without a fresh full', () => {
    seed();
    adapter = new CursorAdapter(dbPath);
    const rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);
    rt.setActiveSession('cid1');
    rt.tick();
    const snapshot = rt.watermarkSnapshot();
    assert.equal(snapshot.cid1.seq, 0);
    assert.equal(snapshot.cid1.headers.length > 0, true);

    // New process: only the on-disk watermark (memory is empty)
    const rec2 = recorder();
    const rt2 = new ContentLiveRuntime(adapter, rec2.handlers, { watermark: snapshot });
    rt2.requestSession('cid1', 0);
    assert.deepEqual(rec2.sync, [{ sessionId: 'cid1', ide: 'cursor', seq: 0 }]);
    assert.equal(rec2.full.length, 0, '重启后不再整份重投影');
    assert.equal(rec2.patch.length, 0);
  });

  it('sends only the delta when the disk moved while the process was down', () => {
    seed();
    adapter = new CursorAdapter(dbPath);
    const rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);
    rt.setActiveSession('cid1');
    rt.tick();
    const snapshot = rt.watermarkSnapshot();

    addAssistant('a9', 'written while we were down');

    const rec2 = recorder();
    const rt2 = new ContentLiveRuntime(adapter, rec2.handlers, { watermark: snapshot });
    rt2.requestSession('cid1', 0);
    assert.equal(rec2.full.length, 0);
    assert.equal(rec2.sync.length, 0, '盘变了，不能只回 sync');
    assert.deepEqual(rec2.patch[0].messages.map(m => m.id), ['a9']);
  });

  it('appends new ids after disk change', () => {
    seed();
    adapter = new CursorAdapter(dbPath);
    const rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);
    rt.setActiveSession('cid1');
    rt.tick();
    assert.equal(rec.full.length, 1);

    addAssistant('a2', 'later');
    rt.tick();
    assert.equal(rec.full.length, 1);
    assert.equal(rec.append.length, 1);
    assert.equal(rec.append[0].sessionId, 'cid1');
    assert.equal(rec.append[0].ide, 'cursor');
    assert.ok(rec.append[0].messages.some(m => m.id === 'a2'));
  });

  it('overlays liveTail on last assistant when disk text is shorter', () => {
    seed();
    adapter = new CursorAdapter(dbPath);
    const rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);
    rt.setActiveSession('cid1');
    rt.tick({ liveTail: { sessionId: 'cid1', text: 'ok from the live DOM' } });
    const asst = rec.full[0].messages.find(m => m.type === 'assistant') as AssistantMessage;
    assert.equal(asst.text, 'ok from the live DOM');

    rt.tick({ liveTail: { sessionId: 'cid1', text: 'ok from the live DOM plus more' } });
    assert.equal(rec.full.length, 1);
    assert.equal(rec.index.length, 0);
    assert.equal(rec.append.length, 1);
    const overlay = rec.append[0].messages.find(m => m.type === 'assistant') as AssistantMessage;
    assert.equal(overlay.text, 'ok from the live DOM plus more');
  });

  it('does not overlay liveTail for another session or shorter text', () => {
    seed();
    adapter = new CursorAdapter(dbPath);
    const rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);
    rt.setActiveSession('cid1');
    rt.tick({ liveTail: { sessionId: 'other', text: 'much longer than disk' } });
    const asst = rec.full[0].messages.find(m => m.type === 'assistant') as AssistantMessage;
    assert.equal(asst.text, 'ok');

    rt.tick({ liveTail: { sessionId: 'cid1', text: 'o' } });
    assert.equal(rec.append.length, 0);
  });

  it('rewrites loading tools to completed when generatingBubbleIds is empty', () => {
    seed({ loadingTool: true });
    adapter = new CursorAdapter(dbPath);
    const rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);
    rt.setActiveSession('cid1');
    rt.tick();
    const tool = rec.full[0].messages.find(m => m.type === 'tool') as ToolCallElement;
    assert.equal(tool.status, 'completed');
    assert.equal(rec.index.length, 0);
  });

  it('keeps loading tools while generatingBubbleIds is non-empty', () => {
    seed({ loadingTool: true, generatingIds: ['t1'] });
    adapter = new CursorAdapter(dbPath);
    const rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);
    rt.setActiveSession('cid1');
    rt.tick();
    const tool = rec.full[0].messages.find(m => m.type === 'tool') as ToolCallElement;
    assert.equal(tool.status, 'loading');
    assert.equal(rec.index.length, 0);
  });

  it('appends same-id tool when payload gains diff after fake-completed first tick', () => {
    seed({ loadingTool: true });
    adapter = new CursorAdapter(dbPath);
    const rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);
    rt.setActiveSession('cid1');
    rt.tick();
    const first = rec.full[0].messages.find(m => m.type === 'tool') as ToolCallElement;
    assert.equal(first.status, 'completed');
    assert.equal(first.diffBlock, undefined);
    assert.equal(rec.append.length, 0);

    enrichToolWithDiff();
    rt.tick();
    assert.equal(rec.append.length, 1);
    const appended = rec.append[0].messages.find(m => m.id === 't1') as ToolCallElement;
    assert.ok(appended, 'onSessionAppend should include the same-id tool');
    assert.equal(appended.status, 'completed');
    assert.equal(appended.diffBlock?.blockKind, 'diff');
  });

  it('does not overlay liveTail onto an earlier assistant when last element is a tool', () => {
    seed({ loadingTool: true });
    adapter = new CursorAdapter(dbPath);
    const rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);
    rt.setActiveSession('cid1');
    rt.tick({ liveTail: { sessionId: 'cid1', text: 'ok from the live DOM plus extra' } });
    const last = rec.full[0].messages[rec.full[0].messages.length - 1];
    assert.equal(last.type, 'tool');
    const asst = rec.full[0].messages.find(m => m.type === 'assistant') as AssistantMessage;
    assert.equal(asst.text, 'ok');
    assert.equal(rec.append.length, 0);
  });

  it('tick does not throw when adapter.changeSignal fails', () => {
    seed();
    adapter = new CursorAdapter(dbPath);
    const rec = recorder();
    const rt = new ContentLiveRuntime(adapter, rec.handlers);
    adapter.changeSignal = () => {
      throw new Error('SQLITE_BUSY: database is locked');
    };
    assert.doesNotThrow(() => rt.tick());
    assert.equal(rec.index.length, 0);
    assert.equal(rec.full.length, 0);
  });

  it('tryOpenCursorAdapter forwards includeProcess false', () => {
    seed({ loadingTool: true });
    const a = tryOpenCursorAdapter(dbPath, { includeProcess: false });
    assert.ok(a);
    const msgs = a.projectSession('cid1');
    assert.equal(msgs.some(m => m.type === 'tool' || m.type === 'thought'), false);
    a.close();
  });
});
