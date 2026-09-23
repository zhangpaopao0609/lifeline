/**
 * Approval-shape probe: dump all "approval-flavored" DOM in the window — hit counts of current selectors,
 * every button in the container, class names containing approv/confirm/pending/allowlist/…, tool-call card status.
 *
 * Use it to feel out the structure when "a new Cursor version changed the approval DOM"; once class names are confirmed, go back
 * to the extract path in `src/server/dom-extractor.ts` and change selectors.
 * Read-only; does not click anything.
 *
 * Usage:
 *   pnpm exec tsx scripts/probes/probe-approvals.ts
 *   pnpm exec tsx scripts/probes/probe-approvals.ts --window demo-repo
 */
import 'dotenv/config';
import { CdpClient } from '../../packages/agent/src/cdp/client.js';
// The path is `../../packages/…`: this file lives in `scripts/probes/`; one fewer `../` would resolve to `scripts/packages/…`
// (does not exist) and throw ERR_MODULE_NOT_FOUND — that fails on **every platform**, not a Windows issue.
// A batch of older probes in the same directory still use `../packages/…` and are equally broken; this file only fixes its own import path.
import { loadConfig } from '../../packages/agent/src/config.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

function windowFilter(argv: string[]): string {
  return argv.find((_, i, a) => a[i - 1] === '--window') ?? '';
}

async function main(): Promise<void> {
  const config = loadConfig();
  const filter = windowFilter(process.argv.slice(2));

  const resp = await fetch(`${config.cdpUrl}/json`, { signal: AbortSignal.timeout(5000) });
  const targets = (await resp.json()) as CDPTarget[];
  const pages = targets.filter(t => t.type === 'page' && t.url.includes('workbench'));
  const page = filter
    ? pages.find(p => p.title.toLowerCase().includes(filter.toLowerCase()))
    : pages[0];
  if (!page?.webSocketDebuggerUrl) {
    console.error(`[probe] no window${filter ? ` matching "${filter}"` : ''} (found: ${pages.map(p => p.title).join(' | ')})`);
    process.exit(1);
  }
  console.log(`[probe] window: ${page.title}`);

  const client = new CdpClient();
  await client.connect(page.webSocketDebuggerUrl);

  const out = await client.evaluate(`(() => {
    const textOf = (el) => ((el && el.textContent) || '').replace(/\\s+/g, ' ').trim();
    const cls = (el) => (typeof el.className === 'string' ? el.className : String(el.getAttribute('class') || ''));
    const brief = (el) => ({
      tag: el.tagName.toLowerCase(),
      cls: cls(el).substring(0, 140),
      text: textOf(el).substring(0, 70),
      aria: (el.getAttribute('aria-label') || '').substring(0, 50),
      inTranscript: !!el.closest('[data-flat-index], [data-message-index], [data-message-role]'),
      inGate: !!el.closest('[data-tool-approval-gate]'),
      toolCallId: el.closest('[data-tool-call-id]')?.getAttribute('data-tool-call-id')?.substring(0, 40) || '',
    });

    const containerSel = [
      '#workbench\\\\.parts\\\\.auxiliarybar',
      'div.composer-bar.editor',
      "[class*='composer-bar']",
      "[class*='composer-panel']",
    ];
    let container = null;
    let matchedSel = '';
    for (const sel of containerSel) {
      try {
        const el = document.querySelector(sel);
        if (el) { container = el; matchedSel = sel; break; }
      } catch { /* skip */ }
    }
    if (!container) container = document.body;

    const hit = (sel, root) => { try { return root.querySelectorAll(sel).length; } catch { return -1; } };
    const result = {
      containerSelector: matchedSel,
      containerClass: cls(container).substring(0, 120),
      composerId: document.querySelector('div.composer-bar.editor[data-composer-id]')?.getAttribute('data-composer-id') || '',
      pathHits: {
        pendingShellCards: hit('.ui-shell-tool-call--pending', container),
        legacyCards: hit('.ui-tool-call-card', container),
        approvalRow: hit('.ui-shell-tool-call__approval-row', container),
        runBtn: hit('button.ui-shell-tool-call__run-btn', container),
        allowlistWrapper: hit('.ui-shell-tool-call__allowlist-button-wrapper button', container),
        skipBtn: hit('button.ui-shell-tool-call__skip-btn', container),
        gates: hit('[data-tool-approval-gate]', container),
        switchModeAccents: hit('[data-switch-mode-accent]', container),
        questionnaireToolbar: hit('.composer-questionnaire-toolbar', document),
      },
      containerButtons: Array.from(container.querySelectorAll('button')).slice(0, 60).map(brief),
      approvalishClassTokens: (() => {
        const re = /approv|confirm|pending|allowlist|deny|reject|skip|accept|interrupt|questionnaire|keep|undo/i;
        const set = new Set();
        for (const el of Array.from(document.querySelectorAll('*'))) {
          for (const token of cls(el).split(/\\s+/)) if (token && re.test(token)) set.add(token);
        }
        return Array.from(set).sort().slice(0, 120);
      })(),
      toolCalls: Array.from(document.querySelectorAll('[data-tool-call-id]')).slice(0, 30).map((c) => ({
        id: c.getAttribute('data-tool-call-id')?.substring(0, 50),
        status: c.getAttribute('data-tool-status'),
        text: textOf(c).substring(0, 80),
      })),
    };
    return result;
  })()`);

  console.log(JSON.stringify(out, null, 2));
  client.disconnect();
}

main().catch((err: unknown) => {
  console.error('[probe] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
