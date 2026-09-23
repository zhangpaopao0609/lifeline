import type { AgentsIdentityDeps, AgentsWindowDump, AgentsWindowRow } from '../packages/agent/src/drivers/cursor/agents-window.js';
import type { ComposerMeta } from '../packages/agent/src/drivers/cursor/tab-identity.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {

  agentStatusFromComposerStatus,

  alignAgentsSectionIds,
  isCloudAgentId,
  isCloudSectionId,
  isDraftRow,
  mapAgentsWindowDump,
  resetAgentsIdentityForTest,
  rowStatusOf,
  workspaceIdFromSectionId,
} from '../packages/agent/src/drivers/cursor/agents-window.js';

/**
 * This set of cases pins the shape measured on 2026-09-16:
 *   - Row-level status dots: needs-attention / done-unseen / draft (no dot = idle; the active row is separate)
 *   - Draft rows (New Agent) have an empty name in the DB → filtered out by readWorkspaceComposers and do not occupy a sequence slot
 *   - Row ids can only be pushed by aligning "group → workspace session sequence": direct lookup / anchor / unique sequence; leave empty on mismatch
 */

function row(overrides: Partial<AgentsWindowRow> = {}): AgentsWindowRow {
  return { title: '会话', time: '1h', active: false, unread: false, dot: '', ...overrides };
}

function deps(
  lists: Record<string, Array<[string, string]>>,
  cloudNames: string[] | null = [],
): AgentsIdentityDeps {
  const byWorkspace = new Map<string, ComposerMeta[]>();
  for (const [wid, rows] of Object.entries(lists)) {
    byWorkspace.set(
      wid,
      rows.map(([composerId, name], i) => ({ composerId, workspaceId: wid, name, recency: 10_000 - i })),
    );
  }
  return {
    readWorkspaceComposers: wid => byWorkspace.get(wid) ?? [],
    workspaceIdOf: (composerId) => {
      for (const [wid, rows] of byWorkspace) {
        if (rows.some(r => r.composerId === composerId))
          return wid;
      }
      return '';
    },
    listWorkspaceIds: () => [...byWorkspace.keys()],
    listCloudAgentNames: () => cloudNames,
  };
}

beforeEach(() => resetAgentsIdentityForTest());

describe('rowStatusOf', () => {
  it('maps the status dot / unread / active flags', () => {
    assert.equal(rowStatusOf(row({ dot: 'needs-attention' })), 'waiting_approval');
    assert.equal(rowStatusOf(row({ dot: 'done-unseen' })), 'unread');
    assert.equal(rowStatusOf(row({ unread: true })), 'unread');
    assert.equal(rowStatusOf(row({ dot: 'draft' })), 'draft');
    assert.equal(rowStatusOf(row({ active: true })), 'active');
    assert.equal(rowStatusOf(row()), 'idle');
  });

  it('在跑（.ui-dot-grid-loader）算 generating，压过 active', () => {
    // 2026-09-17 probe: a running row's status slot is ui-dot-grid-loader (sine_3x3), not a dot
    assert.equal(rowStatusOf(row({ running: true, active: true })), 'generating');
    assert.equal(rowStatusOf(row({ running: true, unread: true })), 'generating');
    assert.equal(rowStatusOf(row({ running: true, active: true, dot: 'draft' })), 'generating');
  });

  it('keeps 等审批 优先于 在跑 / 跑完未看 / active', () => {
    assert.equal(
      rowStatusOf(row({ dot: 'needs-attention', running: true, unread: true, active: true })),
      'waiting_approval',
    );
  });
});

describe('isDraftRow', () => {
  it('recognizes a New Agent draft by dot or title (库里的 name 是空，不在序列里)', () => {
    assert.equal(isDraftRow(row({ dot: 'draft' })), true);
    assert.equal(isDraftRow(row({ title: 'New Agent' })), true);
    assert.equal(isDraftRow(row({ title: 'new agent' })), true);
    assert.equal(isDraftRow(row({ title: 'Design plan discussion' })), false);
  });
});

describe('workspaceIdFromSectionId / agentStatusFromComposerStatus', () => {
  it('reads workspace: ids and rejects repo:/home', () => {
    assert.equal(workspaceIdFromSectionId('workspace:dcd611009a2467ecc71682cd02c2423e'), 'dcd611009a2467ecc71682cd02c2423e');
    assert.equal(workspaceIdFromSectionId('workspace:home'), '');
    assert.equal(workspaceIdFromSectionId('repo:git.example.com/acme/demo-repo'), '');
  });

  it('maps data-composer-status', () => {
    assert.equal(agentStatusFromComposerStatus('needs_attention'), 'waiting_approval');
    assert.equal(agentStatusFromComposerStatus('in_progress'), 'generating');
    assert.equal(agentStatusFromComposerStatus('cancelled'), 'idle');
    assert.equal(agentStatusFromComposerStatus(''), 'idle');
  });
});

describe('alignAgentsSectionIds', () => {
  it('直查 workspace：同名行按序列逐个对上（含 5 条同名）', () => {
    const list = deps({
      w1: [
        ['c1', 'Design plan discussion'],
        ['c2', 'Design plan discussion'],
        ['c3', 'Design plan discussion'],
        ['c4', 'Model inquiry'],
        ['c5', 'Playwright mobile validation'],
      ],
    });
    const section = {
      id: 'workspace:w1',
      title: 'demo-repo',
      expanded: true,
      rows: [
        row({ title: 'Design plan discussion', active: true }),
        row({ title: 'Design plan discussion' }),
        row({ title: 'Design plan discussion' }),
        row({ title: 'Model inquiry' }),
        row({ title: 'Playwright mobile validation' }),
      ],
    };
    assert.deepEqual(alignAgentsSectionIds(section, 'c1', list), ['c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('草稿行没有 id，也不占序列位（库里那条 name 空的行本来就被过滤掉）', () => {
    const list = deps({
      w1: [
        ['c1', 'Design plan discussion'],
        ['c2', 'Model inquiry'],
      ],
    });
    const section = {
      id: 'workspace:w1',
      title: 'demo-repo',
      expanded: true,
      rows: [
        row({ title: 'New Agent', dot: 'draft', active: true }),
        row({ title: 'Design plan discussion' }),
        row({ title: 'Model inquiry' }),
      ],
    };
    assert.deepEqual(alignAgentsSectionIds(section, '', list), ['', 'c1', 'c2']);
  });

  it('repo: 分组用整段序列唯一匹配 workspace', () => {
    const list = deps({
      other: [['x1', 'Something else'], ['x2', 'Another chat']],
      w2: [['c1', 'Lifeline Remote implementation'], ['c2', 'Remote cursor integration options']],
    });
    const section = {
      id: 'repo:git.example.com/acme/demo-repo',
      title: 'acme/demo-repo',
      expanded: true,
      rows: [
        row({ title: 'Lifeline Remote implementation', active: true }),
        row({ title: 'Remote cursor integration options' }),
      ],
    };
    assert.deepEqual(alignAgentsSectionIds(section, 'c1', list), ['c1', 'c2']);
  });

  it('两个 workspace 一样像时不猜（留空）', () => {
    const list = deps({
      wa: [['a1', 'Same title']],
      wb: [['b1', 'Same title']],
    });
    const section = {
      id: 'repo:example.com/dup/repo',
      title: 'dup',
      expanded: true,
      rows: [row({ title: 'Same title', active: true })],
    };
    // No anchor → two candidates tied → no id
    assert.deepEqual(alignAgentsSectionIds(section, '', list), ['']);
    // With an anchor → land on the matching workspace via the anchor
    assert.deepEqual(alignAgentsSectionIds(section, 'b1', list), ['b1']);
  });

  it('断链之后就停止（不猜后面的行）', () => {
    const list = deps({ w1: [['c1', 'A'], ['c2', 'B']] });
    const section = {
      id: 'workspace:w1',
      title: 'x',
      expanded: true,
      rows: [row({ title: 'A' }), row({ title: '不在库里' }), row({ title: 'B' })],
    };
    assert.deepEqual(alignAgentsSectionIds(section, '', list), ['c1', '', '']);
  });

  it('workspace:home（No Repo）走全库唯一匹配；对不上留空', () => {
    const list = deps({ 1787716961878: [['c1', 'A']] });
    // No Repo rows hang under a numeric pseudo-workspace in the DB — accept on a unique match
    assert.deepEqual(
      alignAgentsSectionIds({ id: 'workspace:home', title: 'No Repo', expanded: true, rows: [row({ title: 'A' })] }, '', list),
      ['c1'],
    );
    assert.deepEqual(
      alignAgentsSectionIds({ id: 'workspace:home', title: 'No Repo', expanded: true, rows: [row({ title: '查无此名' })] }, '', list),
      [''],
    );
    assert.deepEqual(alignAgentsSectionIds({ id: 'workspace:w1', title: 'x', expanded: true, rows: [] }, '', list), []);
  });
});

describe('mapAgentsWindowDump', () => {
  function dump(): AgentsWindowDump {
    return {
      sections: [
        {
          id: 'workspace:dcd611009a2467ecc71682cd02c2423e',
          title: 'acme/demo-repo',
          expanded: true,
          rows: [
            row({ title: 'Design plan discussion', dot: 'needs-attention', active: true }),
            row({ title: 'Design plan discussion', dot: 'done-unseen', unread: true }),
            row({ title: 'New Agent', dot: 'draft' }),
          ],
        },
        {
          id: 'workspace:other',
          title: 'workspace.json',
          expanded: true,
          rows: [row({ title: 'FinishedNickname API logic', time: '6d' })],
        },
      ],
      activeComposerId: 'c1',
      composerStatus: 'needs_attention',
      inputAvailable: true,
      approvals: [
        {
          description: 'rm -rf /tmp/x',
          actions: [{ label: 'Run ⌘⏎', type: 'approve', selectorPath: 'button:nth-child(1)' }],
        },
      ],
      questionnaire: null,
    };
  }

  function mapDeps(): AgentsIdentityDeps {
    return deps({
      dcd611009a2467ecc71682cd02c2423e: [
        ['c1', 'Design plan discussion'],
        ['c2', 'Design plan discussion'],
      ],
      other: [['c9', 'FinishedNickname API logic']],
    });
  }

  it('maps sections/rows into chatTabs with section + status + sameTitleIndex', () => {
    const mapped = mapAgentsWindowDump(dump(), { windowId: 'w-agents', deps: mapDeps() });
    const tabs = mapped.chatTabs ?? [];
    assert.equal(tabs.length, 4);
    assert.deepEqual(
      tabs.map(t => [t.title, t.section, t.status, t.composerId]),
      [
        ['Design plan discussion', 'acme/demo-repo', 'waiting_approval', 'c1'],
        ['Design plan discussion', 'acme/demo-repo', 'unread', 'c2'],
        ['New Agent', 'acme/demo-repo', 'draft', 'tab-2'],
        ['FinishedNickname API logic', 'workspace.json', 'idle', 'c9'],
      ],
    );
    assert.equal(tabs[0].isActive, true);
    assert.equal(tabs[0].windowId, 'w-agents');
    assert.equal(tabs[0].sameTitleIndex, 0);
    assert.equal(tabs[1].sameTitleIndex, 1);
    assert.equal(tabs[0].composerIdSource, 'db');
    assert.equal(tabs[2].composerIdSource, undefined);
    assert.equal(mapped.activeComposerId, 'c1');
    assert.equal(mapped.inputAvailable, true);
    assert.equal(mapped.agentStatus, 'waiting_approval');
    assert.equal(mapped.pendingApprovals?.length, 1);
    // Strip the approval-button shortcut glyph (⌘⏎)
    assert.equal(mapped.pendingApprovals?.[0].actions[0].label, 'Run');
  });

  it('resolveIds=false 时全走占位 id（DOM-only 模式）', () => {
    const mapped = mapAgentsWindowDump(dump(), { windowId: 'w', resolveIds: false });
    assert.deepEqual((mapped.chatTabs ?? []).map(t => t.composerId), ['tab-0', 'tab-1', 'tab-2', 'tab-3']);
  });
});

/**
 * Draft (created via ＋ / New Agent, first message not yet sent): there is no body yet; the text lives in the IDE composer.
 * 2026-09-18 feedback: a session newly created in the Agents window still showed the previous session's body on the web;
 * and a draft that "already has text" only showed it as a flattened sidebar title, so it could not be sent as-is.
 * Therefore: (1) draft rows carry `isDraft` (the web UI then does not overlay the previous session's body);
 *            (2) only the **currently selected** draft carries composer source `draftText` (text that can be sent).
 */
describe('草稿行：isDraft + composer 原文', () => {
  function draftDump(overrides: Partial<AgentsWindowDump> = {}): AgentsWindowDump {
    return {
      sections: [
        {
          id: 'workspace:w1',
          title: 'lifeline',
          expanded: true,
          rows: [
            row({ title: 'New Agent', dot: 'draft', active: true }),
            row({ title: '谢谢', dot: 'draft' }),
            row({ title: 'Design plan discussion' }),
          ],
        },
      ],
      activeComposerId: '',
      composerStatus: '',
      inputAvailable: true,
      inputText: '',
      approvals: [],
      questionnaire: null,
      ...overrides,
    };
  }

  const draftDeps = () => deps({ w1: [['c1', 'Design plan discussion']] });

  it('选中的草稿带 composer 原文（换行保留），没选中的草稿只有 isDraft', () => {
    const text = '帮我改一下：\n\n1. 第一件事\n2. 第二件事';
    const mapped = mapAgentsWindowDump(draftDump({ inputText: text }), { windowId: 'w', deps: draftDeps() });
    const tabs = mapped.chatTabs ?? [];

    assert.deepEqual(
      tabs.map(t => [t.title, t.isDraft === true, t.draftText]),
      [
        ['New Agent', true, text],
        ['谢谢', true, undefined],
        ['Design plan discussion', false, undefined],
      ],
    );
  });

  it('不是草稿的行不带草稿字段（普通会话 composer 里的字不当草稿塞给网页）', () => {
    const mapped = mapAgentsWindowDump(
      draftDump({
        inputText: '打了一半的话',
        sections: [
          {
            id: 'workspace:w1',
            title: 'lifeline',
            expanded: true,
            rows: [row({ title: 'Design plan discussion', active: true })],
          },
        ],
      }),
      { windowId: 'w', deps: draftDeps() },
    );
    const tabs = mapped.chatTabs ?? [];
    assert.equal(tabs[0].composerId, 'c1');
    assert.equal(tabs[0].isDraft, undefined);
    assert.equal(tabs[0].draftText, undefined);
  });

  it('老 dump 不带 inputText：草稿照旧只带 isDraft（不炸、也不塞空文字）', () => {
    const dumpWithoutText = draftDump();
    delete dumpWithoutText.inputText;
    const tabs = mapAgentsWindowDump(dumpWithoutText, { windowId: 'w', deps: draftDeps() }).chatTabs ?? [];
    assert.equal(tabs[0].isDraft, true);
    assert.equal(tabs[0].draftText, undefined);
  });
});

/**
 * 2026-09-17 probe: `No Repo` (`workspace:home`) is a mixed bucket of "no local project ownership" —
 * cloud agents and local "no-folder window" sessions both live in it and cannot be told apart in the DOM.
 * Decision: **drop only cloud rows** (match names against the cloudAgentRepository roster); local rows stay; the whole section forbids remote new-chat.
 */
describe('云 agent 行（No Repo 里的混合桶）', () => {
  const CLOUD_ID = 'bc-29ffb1e4-699a-4b49-ad23-cda97b252d03';

  it('识别云分组 / 云 agent id', () => {
    assert.equal(isCloudSectionId('workspace:home'), true);
    assert.equal(isCloudSectionId('workspace:dcd611009a2467ecc71682cd02c2423e'), false);
    assert.equal(isCloudSectionId('repo:git.example.com/acme/demo-repo'), false);
    assert.equal(isCloudAgentId('bc-29ffb1e4-699a-4b49-ad23-cda97b252d03'), true);
    assert.equal(isCloudAgentId('6aba1586-8648-452a-886c-c74d292fd820'), false);
    assert.equal(isCloudAgentId('tab-2'), false);
  });

  it('只丢云行：云行进不了列表，同小节的本机行照常（含按全库唯一匹配对齐出 id）', () => {
    const homeDump: AgentsWindowDump = {
      sections: [
        {
          id: 'workspace:home',
          title: 'No Repo',
          expanded: true,
          rows: [
            row({ title: 'Lifeline-forensics ack 回复', dot: 'done-unseen', unread: true, active: true }),
            row({ title: '空操作', dot: 'done-unseen', unread: true }),
            row({ title: 'WeCube protocol permissions', time: '13d' }),
          ],
        },
        {
          id: 'workspace:w1',
          title: 'demo-repo',
          expanded: true,
          rows: [row({ title: 'Design plan discussion' })],
        },
      ],
      activeComposerId: CLOUD_ID,
      composerStatus: 'completed',
      inputAvailable: true,
      approvals: [],
      questionnaire: null,
    };
    const mapped = mapAgentsWindowDump(homeDump, {
      windowId: 'w-agents',
      deps: deps(
        {
          w1: [['c1', 'Design plan discussion']],
          1787716961878: [['h1', 'WeCube protocol permissions']],
        },
        ['Lifeline-forensics ack 回复', '空操作'],
      ),
    });
    assert.deepEqual(
      (mapped.chatTabs ?? []).map(t => [t.title, t.section, t.composerId, t.status]),
      [
        ['WeCube protocol permissions', 'No Repo', 'h1', 'idle'],
        ['Design plan discussion', 'demo-repo', 'c1', 'idle'],
      ],
    );
    // Current agent is cloud: there is no projectable composer; do not treat it as live
    assert.equal(mapped.activeComposerId, '');
    assert.equal(mapped.inputAvailable, false);
    assert.equal(mapped.agentStatus, 'idle');
  });

  it('No Repo 里的本机行当当前行时：活态 id / 输入可用 / 状态照常透传', () => {
    const localActiveDump: AgentsWindowDump = {
      sections: [
        {
          id: 'workspace:home',
          title: 'No Repo',
          expanded: true,
          rows: [
            row({ title: '云会话', dot: 'done-unseen' }),
            row({ title: 'WeCube protocol permissions', active: true }),
          ],
        },
      ],
      activeComposerId: 'h1',
      composerStatus: 'in_progress',
      inputAvailable: true,
      approvals: [],
      questionnaire: null,
    };
    const mapped = mapAgentsWindowDump(localActiveDump, {
      deps: deps({ 1787716961878: [['h1', 'WeCube protocol permissions']] }, ['云会话']),
    });
    const tabs = mapped.chatTabs ?? [];
    assert.deepEqual(tabs.map(t => [t.title, t.composerId, t.isActive]), [['WeCube protocol permissions', 'h1', true]]);
    assert.equal(mapped.activeComposerId, 'h1');
    assert.equal(mapped.inputAvailable, true);
    assert.equal(mapped.agentStatus, 'generating');
  });

  it('云名单读不到（null）→ 整节丢（保守：宁可少显示，也不显示点不开的行）', () => {
    const homeDump: AgentsWindowDump = {
      sections: [
        { id: 'workspace:home', title: 'No Repo', expanded: true, rows: [row({ title: 'WeCube protocol permissions' })] },
        { id: 'workspace:w1', title: 'demo-repo', expanded: true, rows: [row({ title: 'Design plan discussion' })] },
      ],
      activeComposerId: 'c1',
      composerStatus: 'completed',
      inputAvailable: true,
      approvals: [],
      questionnaire: null,
    };
    const mapped = mapAgentsWindowDump(homeDump, {
      deps: deps(
        { w1: [['c1', 'Design plan discussion']], 1787716961878: [['h1', 'WeCube protocol permissions']] },
        null,
      ),
    });
    assert.deepEqual((mapped.chatTabs ?? []).map(t => t.title), ['Design plan discussion']);
  });

  it('云行进仓库小节也照样丢（Run on: Cloud 建在仓库上的情况），后面的本机行不断链', () => {
    const projectDump: AgentsWindowDump = {
      sections: [
        {
          id: 'workspace:w1',
          title: 'demo-repo',
          expanded: true,
          rows: [
            row({ title: '云会话', dot: 'done-unseen' }),
            row({ title: 'Design plan discussion' }),
          ],
        },
      ],
      activeComposerId: 'c1',
      composerStatus: 'completed',
      inputAvailable: true,
      approvals: [],
      questionnaire: null,
    };
    const mapped = mapAgentsWindowDump(projectDump, {
      deps: deps({ w1: [['c1', 'Design plan discussion']] }, ['云会话']),
    });
    // If the cloud row stayed, the direct-lookup sequence would break there → the following local row would get no id (placeholder tab-0)
    assert.deepEqual(
      (mapped.chatTabs ?? []).map(t => [t.title, t.composerId, t.composerIdSource]),
      [['Design plan discussion', 'c1', 'db']],
    );
  });

  it('云 agent 的待审批卡 / 窗口级状态一并丢掉（看不见的会话不给远程决策）', () => {
    const cloudDump: AgentsWindowDump = {
      sections: [
        { id: 'workspace:home', title: 'No Repo', expanded: true, rows: [row({ title: '云会话', active: true })] },
      ],
      activeComposerId: CLOUD_ID,
      composerStatus: 'needs_attention',
      inputAvailable: true,
      approvals: [
        {
          description: 'Run rm -rf /tmp/x',
          actions: [{ label: 'Run ⌘⏎', type: 'approve', selectorPath: 'button:nth-child(1)' }],
        },
      ],
    };
    const mapped = mapAgentsWindowDump(cloudDump, { deps: deps({}, ['云会话']) });
    assert.deepEqual(mapped.pendingApprovals, []);
    assert.equal(mapped.inputAvailable, false);
    // Even if data-composer-status is needs_attention it must not surface: with no current row, reporting "waiting for approval" would disagree with the top bar
    assert.equal(mapped.agentStatus, 'idle');
    assert.deepEqual(mapped.chatTabs, []);
  });
});
