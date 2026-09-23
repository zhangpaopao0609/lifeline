/**
 * Stop-button probe: start a **plain-text** long answer in CodeBuddy (don't touch code), compare the
 * composer button set frame by frame, and catch the stop button that only appears / swaps identity while "generating".
 *
 * Two usages:
 *   pnpm exec tsx scripts/probes/probe-codebuddy-stop.ts --window lifeline        # dump DOM only (default)
 *   pnpm exec tsx scripts/probes/probe-codebuddy-stop.ts --window lifeline --click  # dump, then click it and verify
 *
 * Output in three sections:
 *   1. Idle composer button snapshot
 *   2. Diff of generating vs idle — the element that swapped identity (class / aria / icon)
 *   3. Full hits of `[class*="stop"]` (production extractor criterion), annotated with visibility
 *
 * ⚠️ This **really** drives CodeBuddy: it burns quota and leaves a session/turn. By default it clicks "+" to create
 *    a draft session first, then sends, so it doesn't disturb a running session; pass `--no-new-chat` if you don't want that.
 */
import 'dotenv/config';
import { CdpClient } from '../../packages/agent/src/cdp/client.js';
import { loadConfig } from '../../packages/agent/src/config.js';
import { CodeBuddyExecutor } from '../../packages/agent/src/drivers/codebuddy/executor.js';
import { dumpCodeBuddyLive, pickCodingCopilotTarget } from '../../packages/agent/src/drivers/codebuddy/extractor.js';

const DEFAULT_PROMPT
  = '请用中文尽可能详细、尽可能长地讲解 JavaScript 事件循环，从概念到 20 个真实例子逐个分析，'
    + '总长度不少于 3000 字。只输出文字，不要使用任何工具，不要动代码。';

const POLL_MS = 120;
const CANDIDATE_WAIT_MS = 40_000;
const STOPPED_WAIT_MS = 20_000;

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  parentId?: string;
  openerId?: string;
  browserContextId?: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function flag(argv: string[], name: string): string {
  return argv.find((_, i, a) => a[i - 1] === `--${name}`) ?? '';
}

interface ButtonSnapshot {
  i: number;
  tag: string;
  class: string;
  aria: string;
  title: string;
  text: string;
  disabled: boolean;
  visible: boolean;
  rect: string;
  html: string;
}

interface SurfaceSnapshot {
  composerFound: boolean;
  buttons: ButtonSnapshot[];
  stopMatches: ButtonSnapshot[];
  stopCount: number;
  tail: Array<Record<string, unknown>>;
  composerHtml: string;
}

/**
 * Capture the composer (including buttons on both sides of the input) and all stop hits.
 * Self-contained (serialized into the webview to run); cannot close over outer variables.
 */
function snapshotSurface() {
  const shell = document.getElementById('active-frame');
  let root = document;
  try {
    const cd = shell && (shell as HTMLIFrameElement).contentDocument;
    if (cd && cd.body)
      root = cd as unknown as Document;
  }
  catch {
    /* keep document */
  }

  const describe = (el: Element, i: number) => {
    const html = el.innerHTML || '';
    let visible = false;
    let rect = '0x0';
    try {
      const r = (el as HTMLElement).getBoundingClientRect();
      rect = `${Math.round(r.width)}x${Math.round(r.height)}`;
      visible = r.width > 0 && r.height > 0;
    }
    catch {
      /* ignore */
    }
    return {
      i,
      tag: el.tagName.toLowerCase(),
      class: (el.className && el.className.toString ? el.className.toString() : '').slice(0, 160),
      aria: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      text: (`${el.textContent || ''}`).replace(/\s+/g, ' ').trim().slice(0, 40),
      disabled: (el as HTMLButtonElement).disabled === true,
      visible,
      rect,
      html: html.replace(/\s+/g, ' ').slice(0, 220),
    };
  };

  const host = root.querySelector('[class*="chat-input-module_container"]') as HTMLElement | null;
  const wrap = host
    ? ((host.closest('[class*="chat-input-module"]') as HTMLElement | null) || host)
    : null;
  const scope: Element = wrap || root;

  const buttons = Array.from(
    scope.querySelectorAll('button, [role="button"], [class*="btn"], [class*="send"], [class*="stop"]'),
  ).map((el, i) => describe(el, i));

  const stopMatches = Array.from(
    root.querySelectorAll('[class*="stop"], [aria-label*="Stop"], [aria-label*="停止"]'),
  ).map((el, i) => describe(el, i));

  // Parent chain + sibling index of the last two (withBackground): the stop button is the last one, so we need a stable locator
  const tail: Array<Record<string, unknown>> = [];
  const tailNodes = Array.from(scope.querySelectorAll('[class*="icon-button-module_withBackground"]'));
  for (const el of tailNodes.slice(-3)) {
    const chain: string[] = [];
    let cur: Element | null = el;
    for (let i = 0; i < 4 && cur; i++) {
      const parent = cur.parentElement;
      const idx = parent ? Array.from(parent.children).indexOf(cur) : -1;
      chain.push(
        `${cur.tagName.toLowerCase()}[${idx}/${parent ? parent.children.length : 0}]`
        + `.${((cur.className || '').toString().split(/\s+/)[0] || '')}`,
      );
      cur = parent;
    }
    tail.push({ class: (el.className || '').toString(), chain });
  }

  return {
    composerFound: !!wrap,
    buttons,
    stopMatches,
    stopCount: stopMatches.length,
    tail,
    composerHtml: wrap ? wrap.outerHTML.replace(/\s+/g, ' ').slice(0, 20000) : '',
  };
}

/**
 * Walk React fiber up from the "last withBackground icon button" (= submit/stop),
 * print component names + prop keys — look for a semantic handle (onStop etc.), more stable than guessing the icon.
 * Self-contained (serialized to run).
 */
function dumpFiberChain() {
  const shell = document.getElementById('active-frame');
  let root = document;
  try {
    const cd = shell && (shell as HTMLIFrameElement).contentDocument;
    if (cd && cd.body)
      root = cd as unknown as Document;
  }
  catch {
    /* keep document */
  }
  const host = root.querySelector('[class*="chat-input-module_container"]');
  const scope: Element = host
    ? ((host.closest('[class*="chat-input-module"]') as Element | null) || host)
    : root;
  const nodes = Array.from(scope.querySelectorAll('[class*="icon-button-module_withBackground"]'));
  const btn = nodes[nodes.length - 1];
  if (!btn)
    return { error: 'no withBackground button' };
  const key = Object.keys(btn).find(k => k.startsWith('__reactFiber$'));
  if (!key)
    return { error: 'no react fiber on button' };
  const out: Array<Record<string, unknown>> = [];
  let f = (btn as unknown as Record<string, { return?: unknown; type?: unknown; memoizedProps?: unknown }>)[key];
  for (let d = 0; f && d < 40; d++) {
    const t = f.type as { displayName?: string; name?: string } | string | null;
    const name = typeof t === 'string'
      ? t
      : (t && (t.displayName || t.name)) || '?';
    const props = f.memoizedProps as Record<string, unknown> | null;
    out.push({
      depth: d,
      name: String(name).slice(0, 48),
      keys: props && typeof props === 'object' ? Object.keys(props) : [],
    });
    f = f.return as typeof f;
  }
  return { chain: out };
}

/** idle → generating: compare class / aria / icon by index, report buttons that "swapped identity". Self-contained. */
function diffButtons(before: ButtonSnapshot[], after: ButtonSnapshot[]) {
  const changed: Array<Record<string, unknown>> = [];
  const n = Math.max(before.length, after.length);
  for (let i = 0; i < n; i++) {
    const a = before[i];
    const b = after[i];
    if (!a) { changed.push({ i, kind: 'added', after: b }); continue; }
    if (!b) { changed.push({ i, kind: 'removed', before: a }); continue; }
    if (a.class !== b.class || a.aria !== b.aria || a.html !== b.html || a.disabled !== b.disabled) {
      changed.push({ i, kind: 'changed', before: a, after: b });
    }
  }
  return changed;
}

async function workbenchPages(cdpUrl: string): Promise<CDPTarget[]> {
  const resp = await fetch(`${cdpUrl}/json`, { signal: AbortSignal.timeout(5000) });
  const targets = (await resp.json()) as CDPTarget[];
  return targets.filter(t => t.type === 'page' && t.url.includes('workbench'));
}

async function pickWorkbench(cdpUrl: string, filter: string): Promise<CDPTarget | undefined> {
  const pages = await workbenchPages(cdpUrl);
  console.log(`[probe] ${pages.length} workbench window(s):`);
  for (const p of pages) console.log(`  - ${p.title} (${p.id})`);
  if (filter)
    return pages.find(p => p.title.toLowerCase().includes(filter.toLowerCase()));
  for (const p of pages) {
    if (!p.webSocketDebuggerUrl)
      continue;
    const client = new CdpClient();
    try {
      await client.connect(p.webSocketDebuggerUrl);
      const focused = (await client.evaluate('document.hasFocus()')) === true;
      client.disconnect();
      if (focused)
        return p;
    }
    catch {
      client.disconnect();
    }
  }
  return pages[0];
}

function fmt(records: Array<Record<string, unknown>>): string {
  return JSON.stringify(records, null, 2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const config = loadConfig();
  const filter = flag(argv, 'window');
  const text = flag(argv, 'text') || DEFAULT_PROMPT;
  const doClick = argv.includes('--click');
  const noNewChat = argv.includes('--no-new-chat');

  const page = await pickWorkbench(config.codebuddyCdpUrl, filter);
  if (!page?.webSocketDebuggerUrl) {
    console.error(`[probe] no workbench window${filter ? ` matching "${filter}"` : ''}`);
    process.exit(1);
  }
  console.log(`\n[probe] window: ${page.title} (${page.id})`);

  const allTargets = (await (await fetch(`${config.codebuddyCdpUrl}/json`, {
    signal: AbortSignal.timeout(5000),
  })).json()) as CDPTarget[];
  const copilot = pickCodingCopilotTarget(allTargets, { workbenchId: page.id });
  if (!copilot?.webSocketDebuggerUrl) {
    console.error('[probe] no coding-copilot webview bound to this window');
    process.exit(1);
  }
  console.log(`[probe] coding-copilot target: ${copilot.id}`);

  const workbench = new CdpClient();
  await workbench.connect(page.webSocketDebuggerUrl);
  const webview = new CdpClient();
  await webview.connect(copilot.webSocketDebuggerUrl);

  const exec = new CodeBuddyExecutor();
  exec.setClient(webview);
  exec.setWorkbenchClient(workbench);

  const snap = async (): Promise<SurfaceSnapshot> =>
    (await webview.callFunction(snapshotSurface as () => unknown)) as SurfaceSnapshot;

  /** Production extractor's view: web "running" criterion (row-level spinner) + agentStatus, once before stop and once after. */
  const liveStatus = async (): Promise<string> => {
    const dump = (await webview.callFunctionWithTimeout(
      dumpCodeBuddyLive as (...a: never[]) => unknown,
      [],
      12000,
    )) as {
      agentStatus?: string;
      agentActivityText?: string | null;
      chatTabs?: Array<{ title: string; isActive: boolean; running?: boolean }>;
    } | null;
    if (!dump)
      return 'dump=null';
    const tabs = dump.chatTabs ?? [];
    const active = tabs.find(t => t.isActive);
    const running = tabs.filter(t => t.running).map(t => t.title);
    return `agentStatus=${dump.agentStatus} activity=${JSON.stringify(dump.agentActivityText)}`
      + ` active=${JSON.stringify(active?.title ?? '')} runningTabs=${JSON.stringify(running)}`;
  };

  // Read-only: don't create a session, don't send a message; dump composer structure and buttons as-is
  if (argv.includes('--snapshot-only')) {
    const surface = await snap();
    console.log(`\n--- composer=${surface.composerFound} buttons=${surface.buttons.length} stopMatches=${surface.stopCount} ---`);
    console.log(fmt(surface.buttons as unknown as Array<Record<string, unknown>>));
    console.log('\n--- 末尾 withBackground 按钮的父链 ---');
    console.log(fmt(surface.tail));
    const fiber = await webview.callFunction(dumpFiberChain as () => unknown);
    console.log('\n--- 提交按钮的 fiber 链（组件名 + props 键） ---');
    console.log(fmt([fiber as Record<string, unknown>]));
    console.log('\n--- composer HTML ---');
    console.log(surface.composerHtml || '(没找到 composer 容器)');
    webview.disconnect();
    workbench.disconnect();
    return;
  }

  if (!noNewChat) {
    const created = await exec.newChat('probe-stop-new');
    console.log(`[probe] newChat    : ${JSON.stringify(created)}`);
    await sleep(1200);
  }

  const idle = await snap();
  console.log(`\n--- idle: composer=${idle.composerFound} buttons=${idle.buttons.length} stopMatches=${idle.stopCount} ---`);
  console.log(fmt(idle.buttons as unknown as Array<Record<string, unknown>>));
  console.log('--- idle: stopMatches（生产抽取器的判据，含不可见） ---');
  console.log(fmt(idle.stopMatches as unknown as Array<Record<string, unknown>>));

  const sent = await exec.sendMessage('probe-stop-send', text);
  console.log(`\n[probe] sendMessage: ${JSON.stringify(sent)}`);
  if (!sent.ok) {
    webview.disconnect();
    workbench.disconnect();
    process.exit(1);
  }

  console.log(`[probe] polling every ${POLL_MS}ms for up to ${CANDIDATE_WAIT_MS / 1000}s…`);
  const started = Date.now();
  let sawGenerating = false;
  let generatingAt = 0;
  let backToIdleAt = 0;

  while (Date.now() - started < CANDIDATE_WAIT_MS) {
    await sleep(POLL_MS);
    const now = await snap();
    const diff = diffButtons(idle.buttons, now.buttons);
    const stopChanged = now.stopCount !== idle.stopCount
      || JSON.stringify(now.stopMatches) !== JSON.stringify(idle.stopMatches);
    if (!sawGenerating && (diff.length > 0 || stopChanged)) {
      sawGenerating = true;
      generatingAt = Date.now() - started;
      console.log(`\n=== 换身份了（+${generatingAt}ms）===\n${fmt(diff)}`);
      console.log('--- 此刻的 stopMatches ---');
      console.log(fmt(now.stopMatches as unknown as Array<Record<string, unknown>>));
      break;
    }
  }

  if (!sawGenerating) {
    console.log('\n[probe] 40s 内按钮集合没有任何变化（生成太快或没跑起来）。');
    webview.disconnect();
    workbench.disconnect();
    return;
  }

  // Click verify: call production stop() while generating, then watch whether composer returns to idle
  if (doClick) {
    console.log('\n[probe] --click：趁生成中调生产 CodeBuddyExecutor.stop()…');
    console.log(`[probe] live before: ${await liveStatus()}`);
    const clickStarted = Date.now();
    const stopped = await exec.stop('probe-stop-click');
    console.log(`[probe] stop()     : ${JSON.stringify(stopped)}`);

    const stopDeadline = Date.now() + STOPPED_WAIT_MS;
    let stoppedAt = 0;
    while (Date.now() < stopDeadline) {
      await sleep(POLL_MS);
      const now = await snap();
      if (diffButtons(idle.buttons, now.buttons).length === 0 && now.stopCount === idle.stopCount) {
        stoppedAt = Date.now() - clickStarted;
        break;
      }
    }
    console.log(`[probe] live after : ${await liveStatus()}`);
    console.log(
      stoppedAt
        ? `[probe] result     : OK 停止生效（${stoppedAt}ms 后提交键回到纸飞机）`
        : `[probe] result     : FAILED 停止后 ${STOPPED_WAIT_MS / 1000}s 仍在生成`,
    );
    webview.disconnect();
    workbench.disconnect();
    return;
  }

  // Don't click: watch until it returns to idle on its own, to see how long this generation lasted (also a baseline for "stop ≤ generate")
  const backDeadline = Date.now() + CANDIDATE_WAIT_MS;
  while (Date.now() - started < CANDIDATE_WAIT_MS && Date.now() < backDeadline) {
    await sleep(POLL_MS);
    const now = await snap();
    const diff = diffButtons(idle.buttons, now.buttons);
    if (diff.length === 0 && now.stopCount === idle.stopCount) {
      backToIdleAt = Date.now() - started;
      console.log(`\n[probe] 回到 idle（+${backToIdleAt}ms）—— 这轮生成持续约 ${backToIdleAt - generatingAt}ms`);
      break;
    }
  }
  if (!backToIdleAt)
    console.log('\n[probe] 40s 内没回到 idle（生成还在跑，或判据不对）。');
  console.log(`[probe] live       : ${await liveStatus()}`);
  console.log('\n[probe] 只抓 DOM，不点。加 --click 可在生成中真停一次。');

  webview.disconnect();
  workbench.disconnect();
}

main().catch((err: unknown) => {
  console.error('[probe] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
