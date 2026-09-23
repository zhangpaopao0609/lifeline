/**
 * CDP-path probe: §6.2 P1–P8 — empty window, foreign workbench, port occupied, and similar classifications.
 *
 * P1–P3, P7, P8 are fully automatic against ephemeral local HTTP; P4–P6 need a real Cursor/CodeBuddy,
 * press Enter after closing/opening windows (skip P4–P6 when not a TTY or `--auto`).
 *
 * Usage:
 *   pnpm exec tsx scripts/probes/probe-cdp-issue.ts
 *   pnpm exec tsx scripts/probes/probe-cdp-issue.ts --auto
 */
import 'dotenv/config';
import type { Server } from 'node:http';
import type { CdpPageTarget } from '../../packages/agent/src/cdp/bridge.js';
import type { ProbeResult } from '../../packages/agent/src/cdp/probe.js';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import * as readline from 'node:readline';
import {

  isAgentsDashboardPage,
  isWorkbenchPage,
} from '../../packages/agent/src/cdp/bridge.js';
import {
  describePortOccupant,
  probeCdpEndpoint,

} from '../../packages/agent/src/cdp/probe.js';
import { loadConfig } from '../../packages/agent/src/config.js';

const CURSOR_UA = 'Mozilla/5.0 Chrome/148.0.7778.280 Cursor/3.20.21';
const CHROME_UA = 'Mozilla/5.0 Chrome/148.0.0.0 Safari/537.36';
const VSCODE_UA = 'Mozilla/5.0 Electron/37.0.0 Code/1.96.0';
const WB = 'vscode-file://vscode-app/x/out/vs/code/electron-sandbox/workbench/workbench.html';

interface Row {
  label: string;
  expect: string;
  actual: string;
  pass: boolean;
  detail: string;
  extra?: string;
}

const rows: Row[] = [];
const autoOnly = process.argv.includes('--auto') || !process.stdin.isTTY;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function cdpUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function record(label: string, expect: string, probed: ProbeResult, extra?: string): boolean {
  const actual = probed.kind;
  const pass = actual === expect;
  rows.push({ label, expect, actual, pass, detail: probed.detail, extra });
  console.log(`${pass ? ' PASS' : '*FAIL'}  ${label.padEnd(36)} 期望 ${expect.padEnd(14)} 实得 ${actual}`);
  console.log(`        detail  : ${probed.detail}`);
  if (probed.notCdpCause)
    console.log(`        cause   : ${probed.notCdpCause}`);
  if (probed.occupant)
    console.log(`        occupant: ${probed.occupant}`);
  if (probed.browser)
    console.log(`        browser : ${probed.browser}`);
  if (extra)
    console.log(`        note    : ${extra}`);
  return pass;
}

function fakeCdpHandler(
  routes: Record<string, unknown>,
): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void {
  return (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(routes.json ?? []));
      return;
    }
    if (path === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(routes.version ?? {}));
      return;
    }
    res.writeHead(404);
    res.end('nope');
  };
}

async function tryWebSocket(url: string, timeoutMs = 2000): Promise<'opened' | 'failed' | 'timeout'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const done = (v: 'opened' | 'failed' | 'timeout') => {
      try { ws.close(); }
      catch { /* ignore */ }
      resolve(v);
    };
    ws.onerror = () => done('failed');
    ws.onopen = () => done('opened');
    setTimeout(done, timeoutMs, 'timeout');
  });
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: '127.0.0.1' });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 600);
  });
}

async function fetchRawJson(url: string): Promise<string> {
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/json`, { signal: AbortSignal.timeout(5000) });
    const text = await r.text();
    return `HTTP ${r.status}\n${text}`;
  }
  catch (err) {
    return `fetch error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function summarizePages(targets: CdpPageTarget[]): string {
  const pages = targets.filter(t => t.type === 'page');
  if (pages.length === 0)
    return '(no page targets)';
  return pages
    .map((p) => {
      const wb = isWorkbenchPage(p) ? 'YES' : 'NO';
      const agents = isAgentsDashboardPage(p) ? 'YES' : 'NO';
      return `"${p.title}" workbench=${wb} agents=${agents} ws=${p.webSocketDebuggerUrl ? 'YES' : 'NO'}`;
    })
    .join('\n        ');
}

async function waitEnter(hint: string): Promise<void> {
  console.log(`\n>>> ${hint}`);
  console.log('    完成后按 Enter 继续…');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.once('line', () => {
      rl.close();
      resolve();
    });
  });
}

async function runAuto(): Promise<void> {
  console.log('\n===== CDP issue 探针：自动段 P1/P2/P3/P7/P8 =====\n');

  // P1 bind then close → no-listener
  {
    const port = await freePort();
    const r = await probeCdpEndpoint(cdpUrl(port), 'cursor');
    record('P1 bind 后 close', 'no-listener', r);
  }

  // P2 always 404 → not-cdp http + occupant is this process
  {
    const srv = createServer((_req, res) => {
      res.writeHead(404);
      res.end('nope');
    });
    const port = await listen(srv);
    const url = cdpUrl(port);
    const r = await probeCdpEndpoint(url, 'cursor', { lookupOccupant: describePortOccupant });
    const occ = r.occupant ?? '';
    const occOk = /node/i.test(occ);
    const pass = r.kind === 'not-cdp' && r.notCdpCause === 'http' && occOk;
    rows.push({
      label: 'P2 恒 404',
      expect: 'not-cdp http+node',
      actual: `${r.kind}${r.notCdpCause ? `/${r.notCdpCause}` : ''}`,
      pass,
      detail: r.detail,
      extra: occOk ? undefined : `occupant 期望含 node，实得 ${occ || '(空)'}`,
    });
    console.log(`${pass ? ' PASS' : '*FAIL'}  P2 恒 404                             期望 not-cdp http+node  实得 ${r.kind}/${r.notCdpCause ?? '-'}`);
    console.log(`        detail  : ${r.detail}`);
    console.log(`        occupant: ${occ || '(空)'}`);
    await closeServer(srv);
  }

  // P3 fake workbench + Cursor UA + dead ws → probe ok; connecting ws failed
  {
    const deadPort = await freePort();
    const srv = createServer(
      fakeCdpHandler({
        json: [{
          id: 'FAKE',
          type: 'page',
          title: 'fake-workbench',
          url: WB,
          webSocketDebuggerUrl: `ws://127.0.0.1:${deadPort}/devtools/page/FAKE`,
        }],
        version: { 'Browser': 'Chrome/148', 'User-Agent': CURSOR_UA },
      }),
    );
    const port = await listen(srv);
    const url = cdpUrl(port);
    const r = await probeCdpEndpoint(url, 'cursor');
    const probePass = record('P3 探针层（假 workbench + Cursor UA）', 'ok', r);
    const deadClosed = !(await portOpen(deadPort));
    console.log(`        dead ws 端口 ${deadPort} 不可连: ${deadClosed ? 'OK' : 'FAIL（构造有误）'}`);
    let wsResult = 'no-target';
    if (r.target?.webSocketDebuggerUrl) {
      wsResult = await tryWebSocket(r.target.webSocketDebuggerUrl);
      console.log(`        connect 层 ws: ${wsResult} ${wsResult === 'failed' || wsResult === 'timeout' ? '→ attach-failed OK' : '→ 期望 failed'}`);
    }
    const connectOk = wsResult === 'failed' || wsResult === 'timeout';
    if (probePass && connectOk) {
      rows.push({
        label: 'P3 connect 层',
        expect: 'ws-failed',
        actual: wsResult,
        pass: true,
        detail: '探针 ok 后 ws 握手失败',
      });
    }
    else if (!connectOk) {
      rows.push({
        label: 'P3 connect 层',
        expect: 'ws-failed',
        actual: wsResult,
        pass: false,
        detail: 'ws 意外连上',
      });
    }
    await closeServer(srv);
  }

  // P7 fake [] + Chrome UA → not-cdp foreign
  {
    const srv = createServer(
      fakeCdpHandler({
        json: [],
        version: { 'Browser': 'Chrome/148', 'User-Agent': CHROME_UA },
      }),
    );
    const port = await listen(srv);
    const r = await probeCdpEndpoint(cdpUrl(port), 'cursor');
    const pass = r.kind === 'not-cdp' && r.notCdpCause === 'foreign';
    rows.push({
      label: 'P7 假 [] + Chrome UA',
      expect: 'not-cdp foreign',
      actual: `${r.kind}/${r.notCdpCause ?? '-'}`,
      pass,
      detail: r.detail,
    });
    console.log(`${pass ? ' PASS' : '*FAIL'}  P7 假 [] + Chrome UA                   期望 not-cdp foreign  实得 ${r.kind}/${r.notCdpCause ?? '-'}`);
    console.log(`        detail  : ${r.detail}`);
    await closeServer(srv);
  }

  // P8 VS Code workbench + no Cursor/ → not-cdp foreign (not ok)
  {
    const srv = createServer(
      fakeCdpHandler({
        json: [{
          id: 't1',
          type: 'page',
          title: 'vscode',
          url: WB,
          webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/page/t1',
        }],
        version: { 'Browser': 'Chrome/148', 'User-Agent': VSCODE_UA },
      }),
    );
    const port = await listen(srv);
    const r = await probeCdpEndpoint(cdpUrl(port), 'cursor');
    const pass = r.kind === 'not-cdp' && r.notCdpCause === 'foreign';
    rows.push({
      label: 'P8 VS Code workbench 无 Cursor/',
      expect: 'not-cdp foreign',
      actual: `${r.kind}/${r.notCdpCause ?? '-'}`,
      pass,
      detail: r.detail,
      extra: r.kind === 'ok' ? '形态像 workbench 但 UA 不对，绝不能 ok' : undefined,
    });
    console.log(`${pass ? ' PASS' : '*FAIL'}  P8 VS Code workbench 无 Cursor/        期望 not-cdp foreign  实得 ${r.kind}/${r.notCdpCause ?? '-'}`);
    console.log(`        detail  : ${r.detail}`);
    await closeServer(srv);
  }
}

async function runInteractive(): Promise<void> {
  const config = loadConfig();
  const cursorUrl = config.cdpUrl;
  console.log('\n===== CDP issue 探针：真机段 P4/P5/P6 =====');
  console.log(`    Cursor CDP: ${cursorUrl}`);
  console.log(`    CodeBuddy CDP: ${config.codebuddyCdpUrl}`);
  console.log('    不要占用 9222/9223；P4/P5 共用 Cursor 端口。\n');

  await waitEnter('P4：关掉 Cursor 的全部窗口（进程可仍在 Dock）');
  const p4Raw = await fetchRawJson(cursorUrl);
  const p4 = await probeCdpEndpoint(cursorUrl, 'cursor', { lookupOccupant: describePortOccupant });
  record('P4 真机关窗', 'no-window', p4);

  await waitEnter('P5：打开至少一个 Cursor 窗口（建议含 Agents 或项目窗）');
  const p5Raw = await fetchRawJson(cursorUrl);
  const p5 = await probeCdpEndpoint(cursorUrl, 'cursor', { lookupOccupant: describePortOccupant });

  console.log('\n--- P4 / P5 原始 /json 并列 ---');
  console.log('[P4 no-window 轮]');
  console.log(p4Raw.split('\n').map(l => `  ${l}`).join('\n'));
  console.log('[P5 ok 轮]');
  console.log(p5Raw.split('\n').map(l => `  ${l}`).join('\n'));

  let p5Pages = '';
  try {
    const list = JSON.parse(p5Raw.split('\n').slice(1).join('\n')) as CdpPageTarget[];
    p5Pages = summarizePages(list);
  }
  catch {
    p5Pages = '(无法解析 JSON)';
  }
  console.log(`        P5 page 摘要:\n        ${p5Pages}`);

  const p5Pass = p5.kind === 'ok';
  rows.push({
    label: 'P5 真机开窗',
    expect: 'ok',
    actual: p5.kind,
    pass: p5Pass,
    detail: p5.detail,
    extra: p5Pages,
  });
  console.log(`${p5Pass ? ' PASS' : '*FAIL'}  P5 真机开窗                             期望 ok              实得 ${p5.kind}`);

  if (p4.kind === 'no-window' && p5.kind === 'ok' && p4.port === p5.port) {
    console.log('\n结论: 同一端口、UA 为 Cursor、P4 无窗口 / P5 有 workbench —— no-window 与 ok 仅差「有没有窗口」。');
  }

  await waitEnter('P6：确保 CodeBuddy 至少有一个窗口打开');
  const p6 = await probeCdpEndpoint(config.codebuddyCdpUrl, 'codebuddy', {
    lookupOccupant: describePortOccupant,
  });
  let p6Extra = '';
  try {
    const r = await fetch(`${config.codebuddyCdpUrl.replace(/\/$/, '')}/json`, {
      signal: AbortSignal.timeout(5000),
    });
    const list = (await r.json()) as CdpPageTarget[];
    p6Extra = summarizePages(list);
    console.log(`        P6 page 摘要:\n        ${p6Extra}`);
  }
  catch { /* ignore */ }
  record('P6 CodeBuddy 开窗', 'ok', p6, p6Extra);
}

async function main(): Promise<void> {
  await runAuto();
  if (autoOnly) {
    console.log('\n（非 TTY 或 --auto：跳过 P4–P6 真机段）');
  }
  else {
    await runInteractive();
  }

  console.log('\n===== 汇总 =====');
  const judged = rows.filter(r => r.label.startsWith('P'));
  let fails = 0;
  for (const r of judged) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label} → ${r.actual}${r.extra ? ` (${r.extra})` : ''}`);
    if (!r.pass)
      fails += 1;
  }
  console.log(`\n自动+真机判定: ${judged.length - fails}/${judged.length} 通过`);
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('[probe] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
