/**
 * Cursor stop-button probe (project window / Agents overview, two shapes).
 *
 * Usage:
 *   pnpm exec tsx scripts/probes/probe-cursor-stop.ts --snapshot-only            # read-only: dump both windows
 *   pnpm exec tsx scripts/probes/probe-cursor-stop.ts --window lifeline --send    # send a long task, catch the "generating" identity-swap button
 *   pnpm exec tsx scripts/probes/probe-cursor-stop.ts --window agents  --send --click
 *
 * ⚠️ `--send` **really** sends a plain-text long task in Cursor (burns quota); by default it creates a new session first.
 */
import 'dotenv/config';
import { isCursorAgentsWindow } from '../../packages/agent/src/cdp/bridge.js';
import { CdpClient } from '../../packages/agent/src/cdp/client.js';
import { loadConfig, loadSelectors } from '../../packages/agent/src/config.js';
import { CommandExecutor } from '../../packages/agent/src/drivers/cursor/executor.js';

const DEFAULT_PROMPT
  = '请用中文尽可能详细、尽可能长地讲解浏览器事件循环与任务队列，从概念到 20 个例子逐个分析，'
    + '总长度不少于 3000 字。只输出文字，不要使用任何工具，不要改代码。';

const POLL_MS = 120;
const WAIT_MS = 40_000;

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function flag(argv: string[], name: string): string {
  return argv.find((_, i, a) => a[i - 1] === `--${name}`) ?? '';
}

const COMPOSER_SCOPE_PROJECT = [
  '#workbench\\.parts\\.auxiliarybar',
  '[class*="composer-bar"]',
  '[class*="composer-panel"]',
  '[class*="chat-widget"]',
];

const COMPOSER_SCOPE_AGENTS = [
  '.ui-prompt-input',
  '[class*="prompt-input"]',
  '[class*="glass-sidebar"]',
];

/** Composer surface of one window. Self-contained (serialized into the page to run). */
function snapshotComposer(args: { scopeSelectors: string[] }) {
  let scope: Element | null = null;
  let scopeSel = '';
  for (const sel of args.scopeSelectors) {
    try {
      const el = document.querySelector(sel);
      if (el) { scope = el; scopeSel = sel; break; }
    }
    catch { /* bad selector */ }
  }
  const root: Element = scope || document.body;

  const describe = (el: Element, i: number) => {
    const html = el.innerHTML || '';
    let visible = false;
    let rect = '0x0';
    try {
      const r = (el as HTMLElement).getBoundingClientRect();
      rect = `${Math.round(r.width)}x${Math.round(r.height)}`;
      visible = r.width > 0 && r.height > 0;
    }
    catch { /* ignore */ }
    return {
      i,
      tag: el.tagName.toLowerCase(),
      class: (el.className && el.className.toString ? el.className.toString() : '').slice(0, 200),
      aria: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      text: (`${el.textContent || ''}`).replace(/\s+/g, ' ').trim().slice(0, 40),
      disabled: (el as HTMLButtonElement).disabled === true,
      visible,
      rect,
      html: html.replace(/\s+/g, ' ').slice(0, 200),
    };
  };

  const nodes = Array.from(root.querySelectorAll(
    'button, [role="button"], [class*="submit"], [class*="send"], [class*="stop"], [class*="icon"]',
  ));
  const all = nodes.map((el, i) => describe(el, i));
  const interesting = all.filter(b =>
    /stop|send|submit|arrow|cancel|interrupt|voice|microphone/i.test(`${b.class} ${b.aria} ${b.title}`),
  );

  /** Submit-key candidates (class names differ per window): whole fiber chain + onClick source, to see if it is "one button, two identities" */
  const deep: Array<Record<string, unknown>> = [];
  const seeds = Array.from(root.querySelectorAll('[class*="send-with-mode"], [class*="submit-button"]'));
  const deepNodes: Element[] = [];
  for (const seed of seeds.slice(0, 4)) {
    deepNodes.push(seed);
    deepNodes.push(...Array.from(seed.querySelectorAll('*')).slice(0, 4));
  }
  for (const el of deepNodes.slice(0, 12)) {
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    const chain: Array<Record<string, unknown>> = [];
    let onClickSrc = '';
    if (key) {
      let fiber = (el as unknown as Record<string, unknown>)[key] as
        | { return?: unknown; type?: unknown; memoizedProps?: unknown }
        | undefined;
      for (let d = 0; fiber && d < 22; d++) {
        const t = fiber.type as { displayName?: string; name?: string } | string | null;
        const name = typeof t === 'string' ? t : (t && (t.displayName || t.name)) || '?';
        const props = fiber.memoizedProps as Record<string, unknown> | null;
        const keys = props && typeof props === 'object' ? Object.keys(props) : [];
        if (!onClickSrc && props && typeof props.onClick === 'function') {
          onClickSrc = String(props.onClick).replace(/\s+/g, ' ').slice(0, 300);
        }
        chain.push({ depth: d, name: String(name).slice(0, 36), keys });
        fiber = fiber.return as typeof fiber;
      }
    }
    deep.push({
      ...describe(el, 0),
      html: (`${el.innerHTML || ''}`).replace(/\s+/g, ' ').slice(0, 400),
      onClick: onClickSrc,
      chain,
    });
  }

  // Walk fiber up from every "interesting" button, print component name + prop keys: look for handles like onSend/onCancel/onStop
  const fibers: Array<Record<string, unknown>> = [];
  for (const el of nodes) {
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    if (!key)
      continue;
    let fiber = (el as unknown as Record<string, unknown>)[key] as
      | { return?: unknown; type?: unknown; memoizedProps?: unknown }
      | undefined;
    const chain: Array<Record<string, unknown>> = [];
    for (let d = 0; fiber && d < 14; d++) {
      const t = fiber.type as { displayName?: string; name?: string } | string | null;
      const name = typeof t === 'string' ? t : (t && (t.displayName || t.name)) || '?';
      const props = fiber.memoizedProps as Record<string, unknown> | null;
      const keys = props && typeof props === 'object' ? Object.keys(props) : [];
      chain.push({ depth: d, name: String(name).slice(0, 40), keys });
      fiber = fiber.return as typeof fiber;
    }
    const hit = chain.find(c =>
      (c.keys as string[]).some(k => /^on(Send|Cancel|Stop|Submit|Interrupt)/.test(k)),
    );
    if (hit) {
      fibers.push({ class: (el.className || '').toString().slice(0, 120), chain: chain.slice(0, 12) });
    }
  }

  return { scopeSel, scopeFound: !!scope, total: all.length, all, interesting, fibers, deep };
}

interface Surface {
  scopeSel: string;
  scopeFound: boolean;
  total: number;
  deep: Array<Record<string, unknown>>;
  all: Array<Record<string, unknown>>;
  interesting: Array<Record<string, unknown>>;
  fibers: Array<Record<string, unknown>>;
}

function fmt(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

/**
 * Sidebar "running" rows — ground truth of running **independent of the stop key** (the spinner the IDE draws itself).
 * Project window `.agent-sidebar-cell-icon .spinning-loader` (or `cursor-icon-modifier-spin`);
 * Agents window `.ui-sidebar-menu-button-status-icon .ui-dot-grid-loader`.
 * Self-contained (serialized into the page to run).
 */
function runningRows() {
  const rows = Array.from(document.querySelectorAll(
    '.agent-sidebar-cell, .ui-sidebar-menu-button[aria-id="glass-sidebar-agent-row"]',
  ));
  const running = rows.filter(r =>
    r.querySelector('.agent-sidebar-cell-icon .spinning-loader')
    || r.querySelector('.cursor-icon-modifier-spin')
    || r.querySelector('.ui-sidebar-menu-button-status-icon .ui-dot-grid-loader'),
  );
  const titleOf = (r: Element): string =>
    ((r.querySelector('.ui-sidebar-menu-button-label, .agent-sidebar-cell-title') || r).textContent || '')
      .trim()
      .slice(0, 40);
  return { count: running.length, titles: running.map(titleOf) };
}

async function workbenchPages(cdpUrl: string): Promise<CDPTarget[]> {
  const resp = await fetch(`${cdpUrl}/json`, { signal: AbortSignal.timeout(5000) });
  const targets = (await resp.json()) as CDPTarget[];
  return targets.filter(t => t.type === 'page' && t.url.includes('workbench'));
}

async function connect(page: CDPTarget): Promise<CdpClient> {
  const client = new CdpClient();
  await client.connect(page.webSocketDebuggerUrl!);
  return client;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const config = loadConfig();
  const selectors = loadSelectors(config);
  const filter = flag(argv, 'window');
  const text = flag(argv, 'text') || DEFAULT_PROMPT;
  const doSend = argv.includes('--send');
  const doClick = argv.includes('--click');
  const noNewChat = argv.includes('--no-new-chat');

  const pages = await workbenchPages(config.cdpUrl);
  console.log(`[probe] ${pages.length} workbench window(s):`);
  for (const p of pages) {
    console.log(`  - ${p.title} (${p.id}) kind=${isCursorAgentsWindow(p) ? 'agents' : 'project'}`);
  }

  // Read-only mode: dump matching windows (default: all)
  if (!doSend) {
    const targets = filter
      ? pages.filter(p => p.title.toLowerCase().includes(filter.toLowerCase()))
      : pages;
    for (const page of targets) {
      const kind = isCursorAgentsWindow(page) ? 'agents' : 'project';
      console.log(`\n========== ${page.title} (${kind}) ==========`);
      const client = await connect(page);
      const surface = (await client.callFunction(
        snapshotComposer as unknown as () => unknown,
        { scopeSelectors: kind === 'agents' ? COMPOSER_SCOPE_AGENTS : COMPOSER_SCOPE_PROJECT },
      )) as Surface;
      console.log(`scope=${surface.scopeSel} found=${surface.scopeFound} nodes=${surface.total}`);
      console.log('--- interesting（stop/send/submit/arrow…） ---');
      console.log(fmt(surface.interesting));
      console.log('--- 提交键候选（send-with-mode / submit-button）：fiber 链 + onClick 源码 ---');
      console.log(fmt(surface.deep));
      console.log('--- 带 onSend/onCancel/onStop 语义把手的 fiber 链 ---');
      console.log(fmt(surface.fibers));
      client.disconnect();
    }
    return;
  }

  const page = filter
    ? pages.find(p => p.title.toLowerCase().includes(filter.toLowerCase()))
    : pages.find(p => !isCursorAgentsWindow(p));
  if (!page?.webSocketDebuggerUrl) {
    console.error(`[probe] no window${filter ? ` matching "${filter}"` : ''}`);
    process.exit(1);
  }
  const kind = isCursorAgentsWindow(page) ? 'agents' : 'project';
  console.log(`\n[probe] window: ${page.title} (${kind})`);

  const client = await connect(page);
  const exec = new CommandExecutor(selectors);
  exec.setClient(client);
  exec.setWindowKindProvider(() => kind);

  const scopeSelectors = kind === 'agents' ? COMPOSER_SCOPE_AGENTS : COMPOSER_SCOPE_PROJECT;
  const snap = async (): Promise<Surface> =>
    (await client.callFunction(snapshotComposer as unknown as () => unknown, { scopeSelectors })) as Surface;

  if (!noNewChat) {
    const created = await exec.newChat('probe-cursor-stop-new');
    console.log(`[probe] newChat    : ${JSON.stringify(created)}`);
    await sleep(1200);
  }

  const idle = await snap();
  const runningIdle = (await client.callFunction(runningRows as () => unknown)) as { count: number };
  console.log(`\n--- idle: scope=${idle.scopeSel} nodes=${idle.total} runningRows=${runningIdle.count} ---`);
  console.log(fmt(idle.interesting));
  console.log('--- idle: 语义把手 fiber ---');
  console.log(fmt(idle.fibers));

  const sent = await exec.sendMessage('probe-cursor-stop-send', text);
  console.log(`\n[probe] sendMessage: ${JSON.stringify(sent)}`);
  if (!sent.ok) {
    client.disconnect();
    process.exit(1);
  }

  console.log(`[probe] polling every ${POLL_MS}ms for up to ${WAIT_MS / 1000}s…`);

  /** Compare two snapshots by index (class / aria / icon html). */
  const diffLists = (
    a: Array<Record<string, unknown>>,
    b: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> => {
    const out: Array<Record<string, unknown>> = [];
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const before = a[i];
      const after = b[i];
      if (!before) { out.push({ i, kind: 'added', after }); continue; }
      if (!after) { out.push({ i, kind: 'removed', before }); continue; }
      if (before.class !== after.class || before.aria !== after.aria || before.html !== after.html) {
        out.push({ i, kind: 'changed', before, after });
      }
    }
    return out;
  };

  const started = Date.now();
  let changedAt = 0;
  let changed: Array<Record<string, unknown>> = [];
  let generating: Surface | null = null;
  while (Date.now() - started < WAIT_MS) {
    await sleep(POLL_MS);
    const now = await snap();
    // Identity-swap location differs: project window is the submit-area subtree (deep); Agents is the submit-button itself
    const diff = [
      ...diffLists(idle.deep, now.deep).map(d => ({ ...d, list: 'deep' })),
      ...diffLists(idle.interesting, now.interesting).map(d => ({ ...d, list: 'interesting' })),
    ];
    if (diff.length > 0) {
      changedAt = Date.now() - started;
      changed = diff;
      generating = now;
      break;
    }
  }

  if (!generating) {
    console.log('\n[probe] 40s 内没有换身份的按钮（生成太快 / 判据不对）。');
    console.log(`[probe] now: ${fmt((await snap()).interesting)}`);
    client.disconnect();
    return;
  }

  console.log(`\n=== 换身份了（+${changedAt}ms）===\n${fmt(changed)}`);
  console.log('--- 此刻的语义把手 fiber ---');
  console.log(fmt(generating.fibers));

  if (!doClick) {
    console.log('\n[probe] 只抓 DOM，不点。加 --click 会在生成中调生产 stop()。');
    client.disconnect();
    return;
  }

  console.log('\n[probe] --click：调生产 CommandExecutor.stop()…');
  console.log(`[probe] running before: ${JSON.stringify(await client.callFunction(runningRows as () => unknown))}`);
  const stopCalledAt = Date.now();
  const clicked = await exec.stop('probe-cursor-stop-click');
  console.log(`[probe] stop()     : ${JSON.stringify(clicked)}`);
  // Independent criterion: sidebar spinner back to the "before send" watermark = really stopped (the composer button does not go back to
  // mic after send, so using it as baseline false-reports FAILED — hit 2026-09-18).
  const deadline = Date.now() + 20_000;
  let stoppedAt = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const now = (await client.callFunction(runningRows as () => unknown)) as { count: number };
    if (now.count <= runningIdle.count) { stoppedAt = Date.now() - stopCalledAt; break; }
  }
  console.log(`[probe] running after : ${JSON.stringify(await client.callFunction(runningRows as () => unknown))}`);
  console.log(
    stoppedAt
      ? `[probe] result     : OK 停止生效（${stoppedAt}ms 后侧栏转圈回到发消息前水位）`
      : `[probe] result     : FAILED 停止后 ${20}s 还在跑`,
  );
  client.disconnect();
}

main().catch((err: unknown) => {
  console.error('[probe] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
