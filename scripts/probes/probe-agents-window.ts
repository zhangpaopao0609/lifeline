/**
 * Agents-window probe: list groups / rows / status dots of Cursor's Agents window (global agent list),
 * plus the **offline-resolved composerId** (alignment logic in src/server/agents-window.ts).
 *
 * Use:
 *   · See the real shape: group ids (`workspace:` / `repo:` / `home`), row-level dots, draft rows
 *   · Verify row → id alignment: `--verify <row number>` actually clicks that row, reads back the composer-bar
 *     `data-composer-id` against the resolved value, then clicks back to the original row (briefly changes the window's current agent)
 *
 * Usage: pnpm exec tsx scripts/probes/probe-agents-window.ts [--verify 3] [--json]
 */
import 'dotenv/config';
import type { AgentsWindowDump } from '../packages/agent/src/drivers/cursor/agents-window.js';
import { CdpClient } from '../packages/agent/src/cdp/client.js';
import { loadConfig } from '../packages/agent/src/config.js';
import {
  AGENTS_DUMP_TIMEOUT_MS,

  dumpAgentsWindow,
  mapAgentsWindowDump,
} from '../packages/agent/src/drivers/cursor/agents-window.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const argv = process.argv.slice(2);
const jsonOut = argv.includes('--json');
const verifyArg = argv.find((_, i, a) => a[i - 1] === '--verify');
const verifyIndex = verifyArg === undefined ? -1 : Number(verifyArg);

async function main(): Promise<void> {
  const config = loadConfig();
  const resp = await fetch(`${config.cdpUrl}/json`, { signal: AbortSignal.timeout(5000) });
  const targets = (await resp.json()) as CDPTarget[];
  const page = targets.find(t => t.type === 'page' && t.title === 'Cursor Agents');
  if (!page?.webSocketDebuggerUrl) {
    console.error('没找到 Agents 窗口（CDP 标题 "Cursor Agents"）——它开着吗？');
    process.exit(1);
  }

  const client = new CdpClient();
  await client.connect(page.webSocketDebuggerUrl);
  try {
    const dump = await client.callFunctionWithTimeout(
      dumpAgentsWindow as (...args: never[]) => unknown,
      [],
      AGENTS_DUMP_TIMEOUT_MS,
    ) as AgentsWindowDump | null;
    if (!dump) {
      console.error('dump 返回空');
      process.exit(1);
    }
    const mapped = mapAgentsWindowDump(dump, { windowId: page.id });
    const tabs = mapped.chatTabs ?? [];

    if (jsonOut) {
      console.log(JSON.stringify({ dump, tabs, activeComposerId: mapped.activeComposerId }, null, 1));
      return;
    }

    console.log(`窗口: "${page.title}"  行数 ${tabs.length}  当前 agent: ${mapped.activeComposerId || '(无)'}  composerStatus=${dump.composerStatus || '(无)'}`);
    let rowIndex = 0;
    for (const section of dump.sections) {
      console.log(`\n## ${section.title || '(无标题分组)'}  [${section.id}]  ${section.expanded ? '展开' : '收起'}`);
      for (const row of section.rows) {
        const tab = tabs[rowIndex];
        const flag = [
          row.active ? '*active' : '',
          row.dot,
          row.unread ? 'unread' : '',
        ].filter(Boolean).join(',');
        const id = tab?.composerId ?? '';
        const kind = tab?.composerIdSource === 'db' ? 'db' : '占位';
        console.log(
          `  ${String(rowIndex).padStart(3)} ${row.title.slice(0, 34).padEnd(36)} ${row.time.padEnd(7)} ${flag.padEnd(18)} ${kind}:${id}`,
        );
        rowIndex++;
      }
    }

    if (verifyIndex >= 0) {
      const tab = tabs[verifyIndex];
      if (!tab) {
        console.error(`\n没有第 ${verifyIndex} 行`);
        return;
      }
      const before = mapped.activeComposerId;
      console.log(`\n--- 校验第 ${verifyIndex} 行「${tab.title}」${tab.section ? `（${tab.section}）` : ''}：解析值 ${tab.composerId}`);
      const clicked = await client.evaluate(`(() => {
        const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        const rows = Array.from(document.querySelectorAll('.ui-sidebar-menu-button[aria-id="glass-sidebar-agent-row"]'));
        const el = rows[${verifyIndex}];
        if (!el) return 'row-not-found';
        el.scrollIntoView({ block: 'center' });
        el.click();
        return 'clicked:' + clean(el.querySelector('.ui-sidebar-menu-button-label')?.textContent);
      })()`);
      await new Promise(r => setTimeout(r, 2000));
      const landed = await client.evaluate(
        `document.querySelector('div.composer-bar.editor[data-composer-id]')?.getAttribute('data-composer-id') || null`,
      ) as string | null;
      console.log(`点击: ${clicked}`);
      console.log(`回读 composerId: ${landed}  ${landed === tab.composerId ? 'OK 与解析值一致' : 'MISMATCH 不一致（对齐要修）'}`);

      // Click back to the original row: many rows share a title, so try by index until the read-back id matches the original
      const original = tabs.find(t => t.composerId === before);
      if (original) {
        for (let attempt = 0; attempt < 5; attempt++) {
          const res = await client.evaluate(`(() => {
            const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
            const rows = Array.from(document.querySelectorAll('.ui-sidebar-menu-button[aria-id="glass-sidebar-agent-row"]'));
            const hits = rows.filter((r) => clean(r.querySelector('.ui-sidebar-menu-button-label')?.textContent) === ${JSON.stringify(original.title)});
            const el = hits[${attempt}];
            if (!el) return 'no-more';
            el.scrollIntoView({ block: 'center' });
            el.click();
            return 'clicked';
          })()`);
          if (res === 'no-more')
            break;
          await new Promise(r => setTimeout(r, 1200));
          const back = await client.evaluate(
            `document.querySelector('div.composer-bar.editor[data-composer-id]')?.getAttribute('data-composer-id') || null`,
          ) as string | null;
          if (back === before) {
            console.log(`点回原 agent: ${back}  OK`);
            break;
          }
        }
      }
    }
  }
  finally {
    client.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('[probe] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
