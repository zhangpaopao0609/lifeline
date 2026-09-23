/**
 * Read-only regression probe for the `No Repo` (`workspace:home`) mixed-bucket rule — does not click any button.
 *
 * Rule (set 2026-09-17):
 *   · **Cloud rows** in the bucket (name hits `cloudAgentRepository`, not archived) must not enter the list;
 *   · **Local rows** in the bucket (numeric fake-workspace "no-folder window" sessions) must still enter the list;
 *   · When the current agent is cloud (`data-composer-id` has `bc-` prefix): live id empty, input unavailable,
 *     window-level status `idle`, pending approvals 0 (an invisible session must not get remote decisions);
 *   · When the cloud list cannot be read (null), take the conservative branch: drop the whole section (local rows also disappear; not an error).
 *
 * The new-chat path is not verified here: after the draft is created, `agentsRunOnLocalJS()` flips Run on to This Mac
 * (errors if it cannot); the real check is `probe-agents-new-chat-local.ts`.
 *
 * Usage: pnpm exec tsx scripts/probes/probe-agents-cloud-guard.ts [--json]
 * Exit code: 0 = rule holds; 2 = rule broken.
 */
import 'dotenv/config';
import type { AgentsWindowDump } from '../packages/agent/src/drivers/cursor/agents-window.js';
import { CdpClient } from '../packages/agent/src/cdp/client.js';
import { loadConfig } from '../packages/agent/src/config.js';
import {
  AGENTS_DUMP_TIMEOUT_MS,

  dumpAgentsWindow,
  isCloudAgentId,
  isCloudSectionId,
  mapAgentsWindowDump,
} from '../packages/agent/src/drivers/cursor/agents-window.js';
import { agentsRunOnLocalJS } from '../packages/agent/src/drivers/cursor/executor.js';
import { listCloudAgentNames } from '../packages/agent/src/drivers/cursor/tab-identity.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const argv = process.argv.slice(2);
const wantJson = argv.includes('--json');
const key = (s: string): string => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

async function main(): Promise<void> {
  const config = loadConfig();
  const targets = (await (await fetch(`${config.cdpUrl}/json`, { signal: AbortSignal.timeout(5000) })).json()) as CDPTarget[];
  const page = targets.find(t => t.type === 'page' && t.title === 'Cursor Agents');
  if (!page?.webSocketDebuggerUrl) {
    console.error('[cloud-guard] 没找到 `Cursor Agents` 页（先打开 Cursor 的 Agents 窗口）');
    process.exit(1);
  }

  const cloudNames = listCloudAgentNames();
  const cloudKeys = cloudNames ? new Set(cloudNames.map(key)) : null;

  const client = new CdpClient();
  await client.connect(page.webSocketDebuggerUrl);
  try {
    const dump = await client.callFunctionWithTimeout(
      dumpAgentsWindow as (...args: never[]) => unknown,
      [],
      AGENTS_DUMP_TIMEOUT_MS,
    ) as AgentsWindowDump | null;
    if (!dump) {
      console.error('[cloud-guard] dump 返回 null');
      process.exit(1);
    }

    const mapped = mapAgentsWindowDump(dump, { windowId: 'w-agents' });
    const tabs = mapped.chatTabs ?? [];
    const activeIsCloud = isCloudAgentId(dump.activeComposerId);

    // Bidirectional assertions (all sections): cloud rows must not enter the list; non-cloud rows must not be swallowed
    // (cloud rows theoretically live only in No Repo, but "Run on: Cloud" can be created into a repo section — see agents-window.ts)
    const domRows = dump.sections.flatMap(s => s.rows.map(r => r.title)).filter(t => key(t));
    const expectedLocalRows = cloudKeys ? domRows.filter(title => !cloudKeys.has(key(title))) : [];
    const tabKeys = new Set(tabs.map(t => key(t.title)));
    const leakedCloudTitles = cloudKeys
      ? tabs.filter(t => cloudKeys.has(key(t.title))).map(t => t.title)
      : [];
    const missingLocalTitles = expectedLocalRows.filter(title => !tabKeys.has(key(title)));

    // The new-chat path no longer relies on "refuse": after the draft is created, agentsRunOnLocalJS() flips Run on to This Mac
    // (errors if it cannot). This is only a static check; the real verification is in probe-agents-new-chat-local.ts.
    const runOnJs = agentsRunOnLocalJS();

    const report = {
      云名单: cloudNames === null ? '(读不到)' : cloudNames,
      小节数: dump.sections.length,
      云小节: dump.sections.filter(s => isCloudSectionId(s.id)).map(s => `${s.id}(${s.rows.length} 行)`),
      映射后行数: tabs.length,
      云行漏出: leakedCloudTitles,
      本机行被吞: missingLocalTitles,
      云小节里的本机行: tabs
        .filter(t => !!t.sectionId && isCloudSectionId(t.sectionId))
        .map(t => `${t.title} → ${t.composerId}${t.composerIdSource ? `(${t.composerIdSource})` : '(占位)'}`),
      当前agent: dump.activeComposerId,
      映射后activeComposerId: mapped.activeComposerId,
      映射后inputAvailable: mapped.inputAvailable,
      映射后agentStatus: mapped.agentStatus,
      映射后待审批: mapped.pendingApprovals?.length ?? 0,
      新建路径: runOnJs.includes('ui-select-trigger') && /this mac/i.test(runOnJs) ? '草稿 → Run on=This Mac' : '❓ JS 里没有扳开关的逻辑',
    };

    if (wantJson) {
      console.log(JSON.stringify(report, null, 2));
    }
    else {
      console.log(`云名单: ${cloudNames === null ? '(读不到 → 保守整节丢)' : cloudNames.join(' , ') || '(空)'}`);
      console.log(`小节 ${report.小节数} 个，其中云小节: ${report.云小节.join(' , ') || '(无)'}；映射后共 ${report.映射后行数} 行`);
      console.log(`云行漏出: ${leakedCloudTitles.length ? leakedCloudTitles.join(' , ') : '无'}；本机行被吞: ${missingLocalTitles.length ? missingLocalTitles.join(' , ') : '无'}`);
      if (report.云小节里的本机行.length)
        console.log(`No Repo 里的本机行: ${report.云小节里的本机行.join(' | ')}`);
      console.log(`当前 agent ${dump.activeComposerId || '(空)'}${activeIsCloud ? '（云）' : ''} → activeComposerId=${JSON.stringify(mapped.activeComposerId)} inputAvailable=${mapped.inputAvailable} agentStatus=${mapped.agentStatus} 待审批=${report.映射后待审批}`);
      console.log(`新建路径: ${report.新建路径}（真验见 probe-agents-new-chat-local.ts）`);
    }

    const problems: string[] = [];
    if (leakedCloudTitles.length)
      problems.push(`云行进列表（${leakedCloudTitles.join(' / ')}）`);
    if (missingLocalTitles.length)
      problems.push(`No Repo 的本机行被吞（${missingLocalTitles.join(' / ')}）`);
    if (activeIsCloud && (mapped.activeComposerId || mapped.inputAvailable)) {
      problems.push('停在云 agent 上却报了活态 id / 输入可用');
    }
    if (activeIsCloud && ((mapped.pendingApprovals?.length ?? 0) > 0 || mapped.agentStatus !== 'idle')) {
      problems.push('云 agent 的待审批卡 / 窗口级状态漏出来了');
    }
    if (!activeIsCloud && dump.approvals.length > 0 && (mapped.pendingApprovals?.length ?? 0) === 0) {
      problems.push('本机会话的待审批卡被误吞（当前 agent 不是云，应当照常透传）');
    }
    if (report.新建路径.startsWith('❓'))
      problems.push('新建路径里没有扳 Run on 的逻辑');

    if (problems.length) {
      console.error(`\n[cloud-guard] FAIL: ${problems.join('; ')}`);
      process.exit(2);
    }
    console.log('\n[cloud-guard] OK');
  }
  finally {
    client.disconnect();
  }
}

main().catch((err: unknown) => { console.error('[cloud-guard] Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
