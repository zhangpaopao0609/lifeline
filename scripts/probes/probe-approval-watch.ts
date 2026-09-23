/**
 * Approval watchdog: poll extract, print + dump card DOM when pendingApprovals appear;
 * `--click` can also click once via the extracted selectorPath, verifying the "click approval from the web page" chain (the click path
 * matches command-executor.clickApproval: querySelector(selectorPath) → click).
 *
 * Default poll is 400ms. **Mode-switch cards only live 15s** (Cursor times them out itself, then they become
 * "Skipped switch to …"); catching them requires millisecond-level polling — do not slow this down.
 *
 * Usage:
 *   pnpm exec tsx scripts/probes/probe-approval-watch.ts
 *   pnpm exec tsx scripts/probes/probe-approval-watch.ts --window demo-repo --seconds 200
 *   pnpm exec tsx scripts/probes/probe-approval-watch.ts --click switch     # click Switch once caught
 *   pnpm exec tsx scripts/probes/probe-approval-watch.ts --out temp/approval.txt
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { CdpClient } from '../../packages/agent/src/cdp/client.js';
import { loadConfig, loadSelectors } from '../../packages/agent/src/config.js';
import { extractionFunction } from '../../packages/agent/src/drivers/cursor/extractor.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

function flag(argv: string[], name: string): string {
  return argv.find((_, i, a) => a[i - 1] === `--${name}`) ?? '';
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const config = loadConfig();
  const selectors = loadSelectors(config);
  const filter = flag(argv, 'window');
  const seconds = parseInt(flag(argv, 'seconds') || '120', 10);
  const click = flag(argv, 'click').toLowerCase();
  const outFile = flag(argv, 'out');

  const resp = await fetch(`${config.cdpUrl}/json`, { signal: AbortSignal.timeout(5000) });
  const targets = (await resp.json()) as CDPTarget[];
  const pages = targets.filter(t => t.type === 'page' && t.url.includes('workbench'));
  const page = filter
    ? pages.find(p => p.title.toLowerCase().includes(filter.toLowerCase()))
    : pages[0];
  if (!page?.webSocketDebuggerUrl) {
    console.error(`[watch] no window${filter ? ` matching "${filter}"` : ''}`);
    process.exit(1);
  }
  console.log(`[watch] window: ${page.title}，${seconds}s 内轮询`);

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
  type State = Record<string, unknown> | null;
  const extract = () =>
    client.callFunctionWithTimeout(
      extractionFunction as (...a: never[]) => unknown,
      args,
      12000,
    ) as Promise<State>;

  const dumpCards = () =>
    client.evaluate(`(() => {
      const out = [];
      for (const card of Array.from(document.querySelectorAll('.ui-shell-tool-call--pending, .ui-tool-call-card'))) {
        out.push({ kind: 'shell-card', html: card.outerHTML.substring(0, 5000) });
      }
      for (const gate of Array.from(document.querySelectorAll('[data-tool-approval-gate]'))) {
        out.push({ kind: 'tool-approval-gate', html: gate.outerHTML.substring(0, 5000) });
      }
      const seen = new Set();
      for (const accent of Array.from(document.querySelectorAll('[data-switch-mode-accent]'))) {
        const card = accent.closest('[data-tool-call-id], [data-message-role], [data-flat-index]') || accent.parentElement;
        if (!card || seen.has(card)) continue;
        seen.add(card);
        out.push({ kind: 'switch-mode-card', html: card.outerHTML.substring(0, 5000) });
      }
      return out;
    })()`) as Promise<Array<{ kind: string; html: string }>>;

  const deadline = Date.now() + seconds * 1000;
  let lastSig = '';
  let clicked = false;

  while (Date.now() < deadline) {
    await sleep(400);
    const state = await extract();
    const approvals = ((state?.pendingApprovals ?? []) as Array<Record<string, unknown>>).map(a => ({
      id: a.id,
      description: String(a.description),
      actions: (a.actions as Array<Record<string, unknown>>).map(x => `${x.type}:${x.label}`),
    }));
    const sig = JSON.stringify(approvals);

    if (approvals.length === 0) {
      if (lastSig !== '') {
        lastSig = '';
        console.log('[watch] approvals cleared');
      }
      continue;
    }
    if (sig === lastSig)
      continue;
    lastSig = sig;

    console.log(`\n[watch] ${new Date().toISOString()} status=${state?.agentStatus}`);
    console.log(JSON.stringify(approvals, null, 2));
    const cards = await dumpCards();
    console.log(`[watch] DOM cards: ${(cards ?? []).map(c => c.kind).join(', ') || '(none)'}`);
    for (const c of cards ?? []) console.log(`\n--- ${c.kind} ---\n${c.html}`);
    if (outFile) {
      writeFileSync(
        outFile,
        `${JSON.stringify(approvals, null, 2)}\n\n${(cards ?? []).map(c => `--- ${c.kind} ---\n${c.html}`).join('\n\n')}`,
      );
      console.log(`[watch] saved → ${outFile}`);
    }

    // --click <approve|reject|switch|label substring>
    if (click && !clicked) {
      const actions = (state?.pendingApprovals as Array<Record<string, unknown>>)
        .flatMap(a => a.actions as Array<Record<string, unknown>>);
      const target
        = click === 'approve' || click === 'reject'
          ? actions.find(x => x.type === click)
          : actions.find(x => String(x.label).toLowerCase().includes(click));
      if (target) {
        clicked = true;
        console.log(`[watch] --> clicking "${target.label}" (${target.type})`);
        await client.click(String(target.selectorPath));
        await sleep(1000);
        const after = await extract();
        console.log(
          `[watch] after click: status=${after?.agentStatus} approvals=${(after?.pendingApprovals as unknown[] | undefined)?.length ?? 'n/a'}`,
        );
      }
      else {
        console.log(`[watch] --click ${click}: 抽到的动作里没有匹配项`);
      }
    }
  }

  console.log('[watch] done');
  client.disconnect();
}

main().catch((err: unknown) => {
  console.error('[watch] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
