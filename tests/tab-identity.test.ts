import type { ComposerMeta } from '../packages/agent/src/drivers/cursor/tab-identity.ts';
import type { ChatTab, CursorState } from '../packages/server/src/types.ts';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import {
  applyTabIdentities,
  cloudAgentNamesFromRecords,

  cursorVscdbCandidates,
  resolveRowIdentities,
  selectCloudAgentRecords,
  setComposerHeaderReader,
} from '../packages/agent/src/drivers/cursor/tab-identity.ts';

// Fold in the "second source of truth": the Windows entry must go through win-paths (read `%APPDATA%`).
// It used to be hardcoded `home/AppData/Roaming` — on machines where `%APPDATA%` is redirected, that
// and `content-runtime`'s `DEFAULT_CURSOR_VSCDB` point at different places: two truths on one machine.
describe('cursorVscdbCandidates', () => {
  it('reads %APPDATA% for the Windows entry instead of hard-coding AppData/Roaming', () => {
    const list = cursorVscdbCandidates('C:\\u', { APPDATA: 'D:\\Roaming' });
    assert.equal(list[1], 'D:\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb');
  });

  it('falls back under the home dir when %APPDATA% is missing', () => {
    const list = cursorVscdbCandidates('C:\\u', {});
    assert.equal(list[1], 'C:\\u\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb');
  });

  it('keeps the macOS and Linux entries byte-identical', () => {
    const list = cursorVscdbCandidates('/Users/x', {});
    assert.equal(list.length, 3);
    assert.equal(
      list[0],
      join('/Users/x', 'Library/Application Support/Cursor/User/globalStorage/state.vscdb'),
    );
    assert.equal(list[2], join('/Users/x', '.config/Cursor/User/globalStorage/state.vscdb'));
  });
});

/**
 * 2026-09-15 feedback: Cursor sidebar rows have no data-composer-id; clicking any of four
 * same-titled sessions always landed on the first row.
 *
 * Identity rule: the editor Chat tab / composer bar is the live authoritative id; remaining
 * rows are mapped by anchoring "same-name sequence in the DB (recency desc) ⊕ same-name
 * order in the sidebar"; unmatched rows keep a placeholder id.
 */

afterEach(() => setComposerHeaderReader(null, null));

function meta(name: string, composerId: string, recency: number, workspaceId = 'w'): ComposerMeta {
  return { composerId, name, recency, workspaceId };
}

/** Four same-named pnpm sessions, recency-desc in the DB; the sidebar is in that same order. */
const FOUR = [
  meta('pnpm installation request', 'id-437b', 4000),
  meta('pnpm installation request', 'id-8cb8', 3000),
  meta('pnpm installation request', 'id-c2bc', 2000),
  meta('pnpm installation request', 'id-e587', 1000),
  meta('Remote IDE control tool', 'id-ec48', 900),
  meta('UI/UX front-end reconstruction', 'id-b92b', 800),
];

describe('resolveRowIdentities', () => {
  it('同名行按 recency 序列一一对应，活跃行用 composer bar 的 id', () => {
    const rows = [
      { title: 'pnpm installation request', isActive: false },
      { title: 'pnpm installation request', isActive: false },
      { title: 'pnpm installation request', isActive: false },
      { title: 'pnpm installation request', isActive: false },
    ];
    const ids = resolveRowIdentities(rows, { activeComposerId: 'id-8cb8', headers: FOUR });
    assert.equal(ids[0]?.composerId, 'id-437b');
    assert.equal(ids[1]?.composerId, 'id-8cb8');
    assert.equal(ids[2]?.composerId, 'id-c2bc');
    assert.equal(ids[3]?.composerId, 'id-e587');
  });

  it('侧栏过滤掉同名行时用锚点校正偏移（不是简单按下标对齐）', () => {
    // 4 in the DB, the sidebar only shows 2 of them (3rd and 4th); the active one is the 3rd
    const rows = [
      { title: 'pnpm installation request', isActive: true },
      { title: 'pnpm installation request', isActive: false },
    ];
    const ids = resolveRowIdentities(rows, { activeComposerId: 'id-c2bc', headers: FOUR });
    assert.equal(ids[0]?.composerId, 'id-c2bc');
    assert.equal(ids[1]?.composerId, 'id-e587');
  });

  it('同名多行时编辑器标签不能按名字认（会认错），只认标题唯一的那条', () => {
    const rows = [
      { title: 'pnpm installation request', isActive: false },
      { title: 'pnpm installation request', isActive: false },
      { title: 'Remote IDE control tool', isActive: false },
    ];
    const ids = resolveRowIdentities(rows, {
      editorChatTabs: [
        { title: 'pnpm installation request', composerId: 'id-e587' },
        { title: 'Remote IDE control tool', composerId: 'id-ec48' },
      ],
      headers: FOUR,
    });
    // The two same-named rows must not be overwritten by the tab's id (cannot tell which row)
    assert.equal(ids[0]?.source, 'db');
    assert.equal(ids[1]?.source, 'db');
    assert.equal(ids[2]?.composerId, 'id-ec48');
    assert.equal(ids[2]?.source, 'dom');
  });

  it('库读不到时全部留空（保留占位 id，不瞎猜）', () => {
    const rows = [
      { title: 'pnpm installation request', isActive: false },
      { title: 'pnpm installation request', isActive: false },
    ];
    const ids = resolveRowIdentities(rows, { headers: [] });
    assert.deepEqual(ids, [null, null]);
  });

  it('同名行比库里多时，多出来的行留空', () => {
    const rows = [
      { title: 'pnpm installation request', isActive: false },
      { title: 'pnpm installation request', isActive: false },
      { title: 'pnpm installation request', isActive: false },
      { title: 'pnpm installation request', isActive: false },
      { title: 'pnpm installation request', isActive: false },
    ];
    const ids = resolveRowIdentities(rows, { headers: FOUR });
    assert.equal(ids[3]?.composerId, 'id-e587');
    assert.equal(ids[4], null);
  });

  it('会话改名后照样对齐：只按「同名组 + 顺序」认，名字只是分组键', () => {
    const renamed = [
      meta('装依赖', 'id-437b', 4000),
      meta('装依赖', 'id-8cb8', 3000),
    ];
    const rows = [
      { title: '装依赖', isActive: true },
      { title: '装依赖', isActive: false },
    ];
    const ids = resolveRowIdentities(rows, { activeComposerId: 'id-437b', headers: renamed });
    assert.equal(ids[0]?.composerId, 'id-437b');
    assert.equal(ids[1]?.composerId, 'id-8cb8');
  });
});

function tab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    composerId: 'tab-0',
    title: 'pnpm installation request',
    isActive: false,
    status: 'idle',
    selectorPath: '',
    ...overrides,
  };
}

function stateWith(tabs: ChatTab[], extras: Partial<CursorState> = {}): CursorState {
  return {
    chatTabs: tabs,
    activeComposerId: '',
    activeWindowId: 'w1',
    _rawSignals: undefined,
    ...extras,
  } as CursorState;
}

describe('applyTabIdentities', () => {
  it('四个同名行各自拿到真 id，并补上同名序号', () => {
    setComposerHeaderReader(() => FOUR, () => 'w');
    const state = stateWith(
      [
        tab({ isActive: true, status: 'active' }),
        tab(),
        tab(),
        tab(),
      ],
      { activeComposerId: 'id-437b' },
    );
    const out = applyTabIdentities(state);
    assert.deepEqual(out.chatTabs.map(t => t.composerId), ['id-437b', 'id-8cb8', 'id-c2bc', 'id-e587']);
    assert.deepEqual(out.chatTabs.map(t => t.sameTitleIndex), [0, 1, 2, 3]);
    assert.equal(out.chatTabs[0].composerIdSource, 'dom');
    assert.equal(out.chatTabs[1].composerIdSource, 'db');
  });

  it('等审批按 id 判定：只给命中那行挂角标（同名行不再一起挂）', () => {
    setComposerHeaderReader(() => FOUR, () => 'w');
    const state = stateWith(
      [tab(), tab(), tab(), tab()],
      {
        activeComposerId: 'id-437b',
        _rawSignals: {
          shimmer: [],
          loadingIndicator: false,
          elements: [],
          orphanIndicators: [],
          editorChatTabs: [{ title: 'pnpm installation request', composerId: 'id-e587', awaiting: true }],
        },
      } as Partial<CursorState>,
    );
    const out = applyTabIdentities(state);
    assert.deepEqual(out.chatTabs.map(t => t.status), ['idle', 'idle', 'idle', 'waiting_approval']);
  });

  it('id 一条都没命中时才退回标题匹配（老环境不丢角标）', () => {
    setComposerHeaderReader(null, null); // DB unavailable → all placeholder ids
    const state = stateWith(
      [tab(), tab({ title: 'Remote IDE control tool' })],
      {
        _rawSignals: {
          shimmer: [],
          loadingIndicator: false,
          elements: [],
          orphanIndicators: [],
          editorChatTabs: [{ title: 'pnpm installation request', composerId: 'id-e587', awaiting: true }],
        },
      } as Partial<CursorState>,
    );
    const out = applyTabIdentities(state);
    assert.equal(out.chatTabs[0].status, 'waiting_approval');
    assert.equal(out.chatTabs[1].status, 'idle');
  });

  it('没有编辑器标签信息时不改 status（CodeBuddy / 老抽取不误伤）', () => {
    const state = stateWith([tab({ status: 'generating' })], { activeComposerId: 'id-437b' });
    const out = applyTabIdentities(state);
    assert.equal(out.chatTabs[0].status, 'generating');
  });

  it('无 chatTabs 时原样返回（不打库）', () => {
    const state = stateWith([], { activeComposerId: 'id-437b' });
    assert.equal(applyTabIdentities(state), state);
  });
});

/**
 * Cloud-agent roster: `ItemTable` values at `cloudAgentRepository.agents.*` are **arrays**,
 * so expand and take `$.name` of each element — taking `$.name` on the array itself silently
 * returns NULL (roster always empty, so local rows get hidden as cloud rows). Pin that pitfall with an in-memory DB.
 */
describe('云 agent 名单（cloudAgentRepository）', () => {
  function memoryDb(): Database.Database {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    return db;
  }

  it('展开数组取元素名字；归档的、没名字的都不算', () => {
    const db = memoryDb();
    try {
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        'cloudAgentRepository.agents.auth0%7Cuser_01KT',
        JSON.stringify([
          { bcId: 'bc-1', name: '活着的云 agent' },
          { bcId: 'bc-2', name: '已归档的云 agent', isArchived: 1 },
          { bcId: 'bc-3', name: '' },
        ]),
      );
      const rows = selectCloudAgentRecords(db);
      assert.equal(rows.length, 3, '三个元素都要展开出来');
      assert.deepEqual(cloudAgentNamesFromRecords(rows), ['活着的云 agent']);
    }
    finally {
      db.close();
    }
  });

  it('多个账号的记录合并；没有这个 key 时返回空', () => {
    const db = memoryDb();
    try {
      const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
      insert.run('cloudAgentRepository.agents.auth0%7Cuser_a', JSON.stringify([{ bcId: 'bc-a', name: 'A 的云 agent' }]));
      insert.run('cloudAgentRepository.agents.auth0%7Cuser_b', JSON.stringify([{ bcId: 'bc-b', name: 'B 的云 agent', isArchived: 1 }]));
      assert.deepEqual(cloudAgentNamesFromRecords(selectCloudAgentRecords(db)), ['A 的云 agent']);
      db.exec('DELETE FROM ItemTable');
      assert.deepEqual(cloudAgentNamesFromRecords(selectCloudAgentRecords(db)), []);
    }
    finally {
      db.close();
    }
  });
});
