/**
 * `No Repo` new-chat = end-to-end verification of a local agent (goes through the **production code path**).
 *
 * Assertion chain:
 *   1. `CommandExecutor.newChat(section='No Repo')` → ok, and returns `data.runOn === 'This Mac'`
 *      (after the draft is created, `agentsRunOnLocalJS()` flips Run on from Cloud to This Mac);
 *   2. with `--send`, `sendMessage()` actually sends one, then wait for the turn to finish;
 *   3. Judge "this one is local": the `cloudAgentRepository` list **did not grow**, and local `state.vscdb`
 *      `composerData:<composerId>` has messages (bubble count > 0) — a cloud agent's body lives on the cloud VM, local count is 0;
 *   4. Cleanup: `--send` ones are archived with inline `Archive`; unsent drafts are thrown away with `Discard`.
 *
 * Usage: pnpm exec tsx scripts/probes/probe-agents-new-chat-local.ts [--dry]
 *   --dry only creates a draft + verifies Run on is already local + Discard (does not create a real session)
 * Exit code: 0 = pass; 2 = rule broken; 1 = environment / precondition failure.
 */
import 'dotenv/config';
import type { SelectorConfig } from '../packages/server/src/types.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CdpClient } from '../packages/agent/src/cdp/client.js';
import { loadConfig } from '../packages/agent/src/config.js';
import { agentsRunOnLocalJS, agentsSetRunOnJS, CommandExecutor } from '../packages/agent/src/drivers/cursor/executor.js';
import { listCloudAgentNames } from '../packages/agent/src/drivers/cursor/tab-identity.js';

interface CDPTarget { id: string; type: string; title: string; url: string; webSocketDebuggerUrl?: string }

const DB = join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const NO_REPO_ROWS_JS = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const sec = Array.from(document.querySelectorAll('.ui-sidebar-section')).find(
    (s) => (s.getAttribute('data-agent-drop-section-id') || '') === 'workspace:home');
  if (!sec) return [];
  return Array.from(sec.querySelectorAll('.ui-sidebar-menu-button[aria-id="glass-sidebar-agent-row"]'))
    .map((r) => clean(r.querySelector('.ui-sidebar-menu-button-label')?.textContent));
})()`;

const COMPOSER_JS = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const bar = document.querySelector('div.composer-bar.editor[data-composer-id]');
  const chip = Array.from(document.querySelectorAll('button.ui-select-trigger'))
    .find((b) => /^(this mac|cloud|remote machines)/i.test(clean(b.textContent)));
  return { composerId: bar?.getAttribute('data-composer-id') ?? null, composerStatus: bar?.getAttribute('data-composer-status') ?? null, chip: chip ? clean(chip.textContent) : null };
})()`;

function localBubbles(composerId: string): number {
  const db = new Database(DB, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM cursorDiskKV WHERE key LIKE ?').get(`bubbleId:${composerId}:%`) as { n: number };
    return row?.n ?? 0;
  }
  finally {
    db.close();
  }
}

function noRepoRowActionJs(label: string): string {
  return `(() => {
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const rows = Array.from(document.querySelectorAll('.ui-sidebar-menu-button[aria-id="glass-sidebar-agent-row"]'));
    const row = ${label === 'Discard'
      ? `rows.find((r) => /new agent/i.test(clean(r.querySelector('.ui-sidebar-menu-button-label')?.textContent)))`
      : `rows.find((r) => r.hasAttribute('data-active')) ?? rows[0]`};
    if (!row) return 'no-row';
    const btn = Array.from(row.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '') === ${JSON.stringify(label)});
    if (!btn) return 'no-' + ${JSON.stringify(label)} + '-button:' + JSON.stringify(Array.from(row.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') || clean(b.textContent)));
    btn.click();
    return 'clicked';
  })()`;
}

async function main(): Promise<void> {
  const cloudBefore = listCloudAgentNames() ?? [];
  console.log(`基线：云 agent 名单 [${cloudBefore.join(' , ') || '空'}]；模式 = ${dry ? '--dry（不发消息）' : '真发一条'}`);

  const config = loadConfig();
  const targets = (await (await fetch(`${config.cdpUrl}/json`, { signal: AbortSignal.timeout(5000) })).json()) as CDPTarget[];
  const page = targets.find(t => t.type === 'page' && t.title === 'Cursor Agents');
  if (!page?.webSocketDebuggerUrl) { console.error('[new-chat-local] 没找到 `Cursor Agents` 页'); process.exit(1); }

  const client = new CdpClient();
  await client.connect(page.webSocketDebuggerUrl);
  const executor = new CommandExecutor({} as SelectorConfig);
  executor.setClient(client);
  executor.setWindowKindProvider(() => 'agents');

  const problems: string[] = [];
  try {
    const rowsBefore = await client.evaluate(NO_REPO_ROWS_JS) as string[];
    console.log(`No Repo 现有行: ${rowsBefore.join(' | ') || '(空)'}`);

    const created = await executor.newChat('probe-new-local', { section: 'No Repo' });
    console.log(`newChat → ok=${created.ok}${created.ok ? ` runOn=${JSON.stringify((created.data as { runOn?: string })?.runOn)}` : ` error=${created.error}`}`);
    if (!created.ok) { problems.push(`newChat 失败: ${created.error}`); }
    else if ((created.data as { runOn?: string })?.runOn !== 'This Mac') {
      problems.push(`runOn 不是 This Mac（拿到 ${JSON.stringify((created.data as { runOn?: string })?.runOn)}）`);
    }

    await sleep(800);
    const draft = await client.evaluate(COMPOSER_JS) as { composerId: string | null; chip: string | null };
    console.log(`草稿态: composerId=${draft.composerId ?? '(无，正确)'} chip=${draft.chip ?? '(无)'}`);
    if (draft.composerId)
      problems.push('草稿态不该有 composerId');
    if (!/^this mac$/i.test(draft.chip ?? ''))
      problems.push(`草稿的 Run on 不是 This Mac（${draft.chip}）`);

    // Bidirectional check: flip to Cloud with **production JS**, then flip back to This Mac with the same production JS
    // (the chip has sticky memory; without this we never exercise the "switch back from Cloud" path).
    // Production JS already has the state machine (close menu first, click only, read-back check), so we don't write another copy here.
    const toCloud = await client.evaluate(agentsSetRunOnJS('Cloud')) as { ok: boolean; after?: string; error?: string };
    console.log(`生产 JS 扳到 Cloud: ${toCloud.ok ? `芯片「${toCloud.after}」` : `${toCloud.error}（芯片「${toCloud.after ?? '?'}」）`}`);

    const flipped = toCloud.ok && /^cloud$/i.test(toCloud.after ?? '');
    if (flipped) {
      const back = await client.evaluate(agentsRunOnLocalJS()) as { ok: boolean; before?: string; after?: string; changed?: boolean; error?: string } | null;
      console.log(`生产 JS 扳回本机: ok=${back?.ok} ${back?.before} → ${back?.after}${back?.changed ? '（真的切了）' : '（本来就是）'}${back?.error ? ` error=${back.error}` : ''}`);
      if (!back?.ok || !/^this mac$/i.test(back.after ?? ''))
        problems.push(`从 Cloud 扳回 This Mac 失败（${back?.error ?? back?.after}）`);
      if (!back?.changed)
        problems.push('双向验证没生效（changed=false）');
    }
    else if (dry) {
      problems.push('无法把芯片扳到 Cloud（双向验证不成立）');
    }
    else {
      // In send mode the bidirectional check is extra credit: the chip is sticky; skip if we cannot flip (this round's conclusion comes from "local bubble > 0")
      console.log('⚠️ 双向验证跳过：这次没把芯片扳到 Cloud（不影响本轮结论）');
    }

    if (dry) {
      // Hard path: set memory to Cloud in the draft (it survives Discard) → then let the **production path** flip back to local
      const setCloud = await client.evaluate(agentsSetRunOnJS('Cloud')) as { ok: boolean; after?: string };
      console.log(`   把记忆设成 Cloud: ok=${setCloud.ok} after=${setCloud.after ?? '?'}`);
      console.log(`   Discard 第一个草稿: ${await client.evaluate(noRepoRowActionJs('Discard'))}`);
      await sleep(900);
      if (setCloud.ok) {
        const again = await executor.newChat('probe-new-local-2', { section: 'No Repo' });
        const runOn2 = (again.data as { runOn?: string })?.runOn;
        console.log(`   第二次 newChat（须把 Cloud 扳回本机）→ ok=${again.ok} runOn=${JSON.stringify(runOn2)}${again.ok ? '' : ` error=${again.error}`}`);
        if (!again.ok)
          problems.push(`第二次 newChat 失败（难路径）: ${again.error}`);
        else if (runOn2 !== 'This Mac')
          problems.push(`难路径没把 Run on 扳回 This Mac（拿到 ${JSON.stringify(runOn2)}）`);
        await sleep(500);
        const chip2 = await client.evaluate(COMPOSER_JS) as { chip: string | null };
        console.log(`   第二个草稿的芯片 = ${chip2.chip}`);
        if (!/^this mac$/i.test(chip2.chip ?? ''))
          problems.push(`难路径后芯片不是 This Mac（${chip2.chip}）`);
      }

      const discard = await client.evaluate(noRepoRowActionJs('Discard')) as string;
      console.log(`收尾（Discard）: ${discard}`);
      await sleep(600);
      const rowsAfter = await client.evaluate(NO_REPO_ROWS_JS) as string[];
      const leaked = rowsAfter.filter(t => !rowsBefore.includes(t));
      console.log(`No Repo 之后: ${rowsAfter.join(' | ') || '(空)'}${leaked.length ? `  ⚠️ 多出: ${leaked.join(' , ')}` : ''}`);
      if (leaked.length)
        problems.push(`草稿没收干净: ${leaked.join(' , ')}`);
    }
    else {
      const sent = await executor.sendMessage('probe-new-local-msg', '只回复 ok，不要做别的。');
      console.log(`sendMessage → ok=${sent.ok}${sent.ok ? '' : ` error=${sent.error}`}`);
      if (!sent.ok)
        problems.push(`sendMessage 失败: ${sent.error}`);

      // Wait for the turn to finish (draft gets a composerId + status is no longer in progress)
      let composerId: string | null = null;
      let status = '';
      for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const st = await client.evaluate(COMPOSER_JS) as { composerId: string | null; composerStatus: string | null };
        composerId = st.composerId;
        status = st.composerStatus ?? '';
        if (composerId && !['in_progress', 'generating', 'draft'].includes(status))
          break;
      }
      console.log(`回合结束: composerId=${composerId} status=${status}`);
      if (!composerId)
        problems.push('发完之后仍拿不到 composerId');

      const cloudAfter = listCloudAgentNames() ?? [];
      const newCloud = cloudAfter.filter(n => !cloudBefore.includes(n));
      console.log(`云名单: [${cloudBefore.join(' , ')}] → [${cloudAfter.join(' , ')}]${newCloud.length ? `  ⚠️ 新增: ${newCloud.join(' , ')}` : '  （没新增 ✓）'}`);
      if (newCloud.length)
        problems.push(`建出了云 agent: ${newCloud.join(' , ')}`);

      if (composerId) {
        const bubbles = localBubbles(composerId);
        console.log(`本地正文: composerData/bubbleId:${composerId.slice(0, 8)}… → ${bubbles} 条 bubble${bubbles > 0 ? ' ✓' : '  ✗（云 agent 才会是 0）'}`);
        if (bubbles === 0)
          problems.push(`本地读不到这条会话的正文（bubble=0）→ 可能跑在云上`);
      }

      const archived = await client.evaluate(noRepoRowActionJs('Archive')) as string;
      console.log(`收尾（Archive）: ${archived}`);
      await sleep(700);
      const rowsAfter = await client.evaluate(NO_REPO_ROWS_JS) as string[];
      console.log(`No Repo 之后: ${rowsAfter.join(' | ') || '(空)'}`);
    }
  }
  finally {
    client.disconnect();
  }

  if (problems.length) {
    console.error(`\n[new-chat-local] FAIL: ${problems.join('; ')}`);
    process.exit(2);
  }
  console.log('\n[new-chat-local] OK：No Repo 新建走的是本机路径');
}

main().catch((err: unknown) => { console.error('[new-chat-local] Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
