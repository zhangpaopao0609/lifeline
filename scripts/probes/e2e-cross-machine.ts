import type { ChildProcess } from 'node:child_process';
/**
 * Throwaway end-to-end probe: simulate "two machines" on this host (content is remote, the IDE is elsewhere) and verify cross-machine content routing.
 * Discard after use.
 *
 * Path: content agent (real adapter reads local CodeBuddy data + registers) → server ledger
 *       browser client selects the "IDE-only" machine → session:get
 *       → server names the content agent → content agent projects → server forwards → client receives session:full
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { enrollAgentToken, TEST_AUTH_HEADER, TEST_OWNER, userHeaders } from '../../tests/relay-auth-helpers.js';
import { emptyCursorState } from '../packages/server/src/pages/empty-state.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const PORT = 18799;
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION_ID = process.env.E2E_SESSION_ID ?? 'f608f00e02a14b4190712a9255db96cc';

const log = (...args: unknown[]): void => console.log('[e2e]', ...args);

async function waitFor(
  check: () => Promise<boolean> | boolean,
  opts: { timeoutMs: number; label: string },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (await check())
      return;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${opts.label}`);
}

async function main(): Promise<void> {
  const children: ChildProcess[] = [];
  const spawnScript = (entry: string, env: Record<string, string>, label: string): void => {
    const child = spawn('npx', ['tsx', entry], {
      cwd: REPO,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[${label}] ${d}`));
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[${label}] ${d}`));
    children.push(child);
  };

  let mac: ReturnType<typeof io> | null = null;
  let browser: ReturnType<typeof io> | null = null;
  try {
    // Production: the start script creates these two dirs (the server opens the session DB under data/).
    // Wipe data/ every round: otherwise the server DB still has last round's body and takes the "fast path" to answer,
    // so we never exercise the "name the content agent + follow the session" path.
    rmSync(join(REPO, 'data'), { recursive: true, force: true });
    mkdirSync(join(REPO, 'data'), { recursive: true });
    mkdirSync(join(REPO, 'temp'), { recursive: true });

    // 1) Server (MODE=server: serve the browser only + wait for agents to connect)
    spawnScript(
      'packages/server/src/index.ts',
      {
        MODE: 'server',
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: String(PORT),
        // loopback + AUTH_HEADER = trusted-header (the header is identity; cheapest real auth)
        AUTH_HEADER: TEST_AUTH_HEADER,
      },
      'server',
    );
    await waitFor(
      async () => {
        try {
          const res = await fetch(`${BASE}/healthz`);
          return res.ok;
        }
        catch {
          return false;
        }
      },
      { timeoutMs: 25_000, label: 'server /healthz' },
    );
    log('服务端已就绪');

    // 1.5) Enroll: each machine gets a token bound to its agentId (same path as `lifeline setup`)
    const contentToken = await enrollAgentToken(BASE, undefined, 'agent-content');
    const macToken = await enrollAgentToken(BASE, undefined, 'agent-mac');

    // 2) Content agent: read real local CodeBuddy data (no IDE/GUI)
    spawnScript(
      'packages/agent/src/index.ts',
      { REMOTE_URL: BASE, AGENT_TOKEN: contentToken, AGENT_ID: 'agent-content' },
      'content',
    );

    // 3) Simulate a Mac that "has only the IDE, no session data"
    mac = io(`${BASE}/agent`, {
      path: '/agent-io',
      auth: { agentToken: macToken },
      transports: ['websocket'],
    });
    mac.on('connect', () => {
      mac?.emit('agent:register', { agentId: 'agent-mac', hostname: 'MBP' });
      mac?.emit('state:full', {
        ides: { codebuddy: { ...emptyCursorState(), connected: true } },
      });
      log('模拟 Mac 已注册（codebuddy 活态 ✓、无内容）');
    });

    // 4) Browser client (with identity headers); pick a machine + request a session the way the web page does
    browser = io(BASE, {
      transports: ['websocket'],
      extraHeaders: userHeaders(TEST_OWNER),
    });

    let selected = false;
    browser.on('machines:list', (payload: { machines?: Array<{ agentId: string; contentOnly?: boolean; contentIdes?: string[] }> }) => {
      const rows = payload?.machines ?? [];
      log('machines:list →', JSON.stringify(rows.map(m => ({
        agentId: m.agentId,
        contentIdes: m.contentIdes,
        contentOnly: m.contentOnly,
      }))));
      if (!selected && rows.some(m => m.agentId === 'agent-mac')) {
        selected = true;
        browser?.emit('machine:select', { agentId: 'agent-mac' });
        log('已选中 agent-mac（模拟 Mac 视图）');
      }
    });

    const replies: Array<{ source: string; messages: unknown[] }> = [];
    browser.on('session:full', (payload: { sessionId?: string; messages?: unknown[] }) => {
      replies.push({ source: payload?.sessionId ?? '?', messages: payload?.messages ?? [] });
    });
    let appends = 0;
    browser.on('session:append', (payload: { messages?: unknown[] }) => {
      appends += 1;
      log(`⬆️ 收到 session:append #${appends}：${payload?.messages?.length ?? 0} 个元素`);
    });

    // Wait until the browser has the machine list and has selected the simulated Mac
    await waitFor(() => selected, { timeoutMs: 25_000, label: 'machines:list 含 agent-mac' });
    // Ownership exists only after the content agent has registered; give it a moment before session:get
    await new Promise(r => setTimeout(r, 4000));
    log(`发送 session:get(${SESSION_ID}, codebuddy)`);
    browser.emit('session:get', { sessionId: SESSION_ID, ide: 'codebuddy' });

    await waitFor(() => replies.length > 0, { timeoutMs: 20_000, label: 'session:full 回包' });

    const first = replies[0];
    log(`✅ 收到 session:full：${first.messages.length} 个正文元素`);
    const sample = first.messages.slice(0, 3).map((m) => {
      const el = m as { type?: string; text?: string };
      return `${el.type}: ${JSON.stringify((el.text ?? '').slice(0, 60))}`;
    });
    for (const line of sample) log('   ', line);

    // Observation window: the content agent now follows this session; a disk change should push session:append.
    // What we wait for is this conversation itself landing on disk (so it can run in the background while you chat and verify).
    const holdMs = Number(process.env.E2E_HOLD_MS ?? 10_000);
    log(`进入观察窗口 ${Math.round(holdMs / 1000)}s（等待磁盘变化 → 增量）`);
    const deadline = Date.now() + holdMs;
    while (Date.now() < deadline && appends === 0) {
      await new Promise(r => setTimeout(r, 500));
    }
    log(appends > 0 ? `✅ 增量转发正常（共 ${appends} 次）` : '⚠️ 观察窗口内没有磁盘变化（增量未验证）');
  }
  finally {
    mac?.disconnect();
    browser?.disconnect();
    for (const child of children) child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
    for (const child of children) child.kill('SIGKILL');
  }
}

const hardTimeout = setTimeout(() => {
  console.error('[e2e] 超时（含观察窗口），强制退出');
  process.exit(1);
}, Number(process.env.E2E_HOLD_MS ?? 10_000) + 90_000);

main()
  .then(() => {
    clearTimeout(hardTimeout);
    console.log('[e2e] 完成');
    process.exit(0);
  })
  .catch((err: unknown) => {
    clearTimeout(hardTimeout);
    console.error('[e2e] 失败:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
