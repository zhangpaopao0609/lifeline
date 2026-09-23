/**
 * Live-extract probe: run the **real** extractionFunction against a given Cursor window, print
 * agentStatus / pendingApprovals / questionnaire / the active session, then dump DOM cards that
 * "might be an approval" (shell card / ToolApprovalGate / mode-switch card / questionnaire) as-is.
 *
 * Run this first when debugging "the approval vanished from the web page": you can tell at a glance whether extract missed it, or the DOM never had it
 * (window occluded / session is not the current one / approval already resolved).
 *
 * Usage:
 *   pnpm exec tsx scripts/probes/probe-live-extract.ts
 *   pnpm exec tsx scripts/probes/probe-live-extract.ts --window demo-repo
 */
import 'dotenv/config';
import { CdpClient } from '../packages/agent/src/cdp/client.js';
import { loadConfig, loadSelectors } from '../packages/agent/src/config.js';
import { extractionFunction } from '../packages/agent/src/drivers/cursor/extractor.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** Same argv convention as scripts/probe-cdp.ts: --window <title keyword> */
function windowFilter(argv: string[]): string {
  return argv.find((_, i, a) => a[i - 1] === '--window') ?? '';
}

async function workbenchPages(cdpUrl: string): Promise<CDPTarget[]> {
  const resp = await fetch(`${cdpUrl}/json`, { signal: AbortSignal.timeout(5000) });
  const targets = (await resp.json()) as CDPTarget[];
  return targets.filter(t => t.type === 'page' && t.url.includes('workbench'));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const selectors = loadSelectors(config);
  const filter = windowFilter(process.argv.slice(2));

  const pages = await workbenchPages(config.cdpUrl);
  console.log(`[probe] ${pages.length} workbench window(s):`);
  for (const p of pages) console.log(`  - ${p.title}`);
  const page = filter
    ? pages.find(p => p.title.toLowerCase().includes(filter.toLowerCase()))
    : pages[0];
  if (!page?.webSocketDebuggerUrl) {
    console.error(`[probe] no window${filter ? ` matching "${filter}"` : ''}`);
    process.exit(1);
  }
  console.log(`\n[probe] window: ${page.title}`);

  const client = new CdpClient();
  await client.connect(page.webSocketDebuggerUrl);

  const args = [
    selectors.chatContainer.strategies,
    selectors.approveButton.strategies,
    selectors.approveButton.textMatch ?? [],
    selectors.rejectButton.strategies,
    selectors.rejectButton.textMatch ?? [],
    selectors.chatInput.strategies,
    selectors.agentStatus.strategies,
    selectors.chatTabList?.strategies ?? [],
    selectors.modeDropdown?.strategies ?? [],
    selectors.modelDropdown?.strategies ?? [],
    page.title,
  ];

  const state = (await client.callFunctionWithTimeout(
    extractionFunction as (...a: never[]) => unknown,
    args,
    12000,
  )) as Record<string, unknown> | null;

  console.log('\n--- extracted ---');
  if (!state) {
    console.log('extractionFunction returned NULL（容器找不到 → 窗口多半被遮挡/最小化）');
  }
  else {
    const tabs = state.chatTabs as Array<Record<string, unknown>> | undefined;
    console.log('agentStatus      :', state.agentStatus);
    console.log('activeComposerId :', state.activeComposerId);
    console.log('activeTab        :', JSON.stringify(tabs?.find(t => t.isActive) ?? null));
    console.log('tabCount         :', tabs?.length);
    console.log('inputAvailable   :', state.inputAvailable);
    console.log('pendingApprovals :', JSON.stringify(state.pendingApprovals, null, 2));
    console.log('questionnaire    :', JSON.stringify(state.questionnaire, null, 2));
  }

  const dump = (await client.evaluate(`(() => {
    const out = [];
    for (const card of Array.from(document.querySelectorAll('.ui-shell-tool-call--pending, .ui-tool-call-card'))) {
      out.push({ selector: 'shell-card: ' + String(card.className).substring(0, 60), html: card.outerHTML.substring(0, 6000) });
    }
    for (const gate of Array.from(document.querySelectorAll('[data-tool-approval-gate]'))) {
      out.push({ selector: 'tool-approval-gate: ' + String(gate.className).substring(0, 60), html: gate.outerHTML.substring(0, 6000) });
    }
    const seen = new Set();
    for (const accent of Array.from(document.querySelectorAll('[data-switch-mode-accent]'))) {
      const card = accent.closest('[data-tool-call-id], [data-message-role], [data-flat-index]') || accent.parentElement;
      if (!card || seen.has(card)) continue;
      seen.add(card);
      out.push({ selector: 'switch-mode-card', html: card.outerHTML.substring(0, 6000) });
    }
    const q = document.querySelector('.composer-questionnaire-toolbar');
    if (q) out.push({ selector: 'questionnaire', html: q.outerHTML.substring(0, 4000) });
    return out;
  })()`)) as Array<{ selector: string; html: string }>;

  console.log('\n--- approval-ish DOM ---');
  if (!dump || dump.length === 0) {
    console.log('(DOM 里没有待审批卡 / 问卷)');
  }
  else {
    for (const d of dump) console.log(`\n### ${d.selector}\n${d.html}`);
  }

  client.disconnect();
}

main().catch((err: unknown) => {
  console.error('[probe] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
