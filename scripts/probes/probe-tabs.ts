/**
 * Session-row probe: list a window's sidebar session rows + editor chat tabs, tagged "running / waiting for confirm".
 *
 * Use:
 *   · Confirm where a session lives (same-titled sessions are distinguished by composerId)
 *   · Find "sessions waiting for confirm" — the mark is on the editor chat tab's codicon-question
 *     (the sidebar leading icon is only a spinner, so you cannot tell running vs waiting)
 *   · Confirm data-composer-id / data-resource-name exist (switching sessions and matching by id both depend on them)
 *
 * Usage: pnpm exec tsx scripts/probes/probe-tabs.ts [--window demo-repo]
 */
import 'dotenv/config';
import { CdpClient } from '../packages/agent/src/cdp/client.js';
import { loadConfig } from '../packages/agent/src/config.js';

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
  const picked = filter
    ? pages.filter(p => p.title.toLowerCase().includes(filter.toLowerCase()))
    : pages;

  for (const page of picked) {
    if (!page.webSocketDebuggerUrl)
      continue;
    console.log(`\n========== ${page.title} ==========`);
    const client = new CdpClient();
    await client.connect(page.webSocketDebuggerUrl);
    try {
      const out = await client.evaluate(`(() => {
        const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        const sidebarRows = Array.from(document.querySelectorAll('.agent-sidebar-list .agent-sidebar-cell')).map((el) => ({
          title: clean(el.querySelector('.agent-sidebar-cell-text')?.textContent),
          composerId: el.getAttribute('data-composer-id') || el.closest('[data-composer-id]')?.getAttribute('data-composer-id') || '',
          running: !!el.querySelector('.spinning-loader') || !!el.querySelector('.cursor-icon-modifier-spin'),
          question: !!el.querySelector('.codicon-question'),
          unread: !!el.querySelector('.agent-sidebar-cell-unread-indicator'),
        }));
        const editorTabs = Array.from(document.querySelectorAll('.tabs-container .tab[role="tab"]')).map((el) => {
          const icon = el.querySelector('.monaco-icon-label');
          const iconClasses = icon ? String(icon.className) : '';
          return {
            title: clean(el.querySelector('.monaco-highlighted-label')?.textContent || el.getAttribute('aria-label')),
            composerId: el.getAttribute('data-resource-name') || '',
            awaiting: iconClasses.includes('codicon-question'),
            icon: (iconClasses.match(/codicon-[a-z-]+/) || [''])[0],
          };
        });
        return {
          activeComposerId: document.querySelector('div.composer-bar.editor[data-composer-id]')?.getAttribute('data-composer-id') || '',
          sidebarRows,
          editorTabs,
        };
      })()`) as Record<string, unknown>;
      console.log(JSON.stringify(out, null, 2));
    }
    finally {
      client.disconnect();
    }
  }
}

main().catch((err: unknown) => {
  console.error('[probe] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
