/**
 * Actively trigger one approval (verify the input side of the approval chain): send a message to the target window's current session,
 * defaulting to asking the agent to "don't touch code yet; switch to Plan mode" — measured, this brings up a mode-switch confirm card (Switch / Skip),
 * and also MCP tool approvals (Run / Always Run / Skip).
 *
 * ⚠️ This **really** drives the agent inside Cursor: it burns quota and leaves a session/turn.
 *    By default `--new-chat` creates a draft session first, then sends, so it doesn't disturb a running session; pass `--no-new-chat` if you don't want that.
 *    To catch the card, pair with probe-approval-watch.ts (mode-switch cards time out after 15s).
 *
 * Usage:
 *   pnpm exec tsx scripts/probes/probe-approval-trigger.ts
 *   pnpm exec tsx scripts/probes/probe-approval-trigger.ts --window demo-repo --wait 120
 *   pnpm exec tsx scripts/probes/probe-approval-trigger.ts --text "switch this session to Plan mode"
 */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { raiseWindowAppleScript } from '../../packages/agent/src/cdp/bridge.js';
import { CdpClient } from '../../packages/agent/src/cdp/client.js';
import { loadConfig, loadSelectors } from '../../packages/agent/src/config.js';
import { CommandExecutor } from '../../packages/agent/src/drivers/cursor/executor.js';
import { extractionFunction } from '../../packages/agent/src/drivers/cursor/extractor.js';

const DEFAULT_PROMPT = '先别动代码。这次改造涉及架构取舍，请把当前会话切到 Plan 模式，我们先过一遍设计方案。';

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

/** Transcript pane is not rendered when the window is not foreground — raise it before sending (macOS, best-effort). */
function raise(title: string): Promise<void> {
  if (process.platform !== 'darwin' || !title)
    return Promise.resolve();
  const script = raiseWindowAppleScript(title, ['Cursor']);
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 4000 }, () => resolve());
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const config = loadConfig();
  const selectors = loadSelectors(config);
  const filter = flag(argv, 'window');
  const text = flag(argv, 'text') || DEFAULT_PROMPT;
  const waitSeconds = parseInt(flag(argv, 'wait') || '0', 10);
  const newChat = !argv.includes('--no-new-chat');

  const resp = await fetch(`${config.cdpUrl}/json`, { signal: AbortSignal.timeout(5000) });
  const targets = (await resp.json()) as CDPTarget[];
  const pages = targets.filter(t => t.type === 'page' && t.url.includes('workbench'));
  const page = filter
    ? pages.find(p => p.title.toLowerCase().includes(filter.toLowerCase()))
    : pages[0];
  if (!page?.webSocketDebuggerUrl) {
    console.error(`[trigger] no window${filter ? ` matching "${filter}"` : ''}`);
    process.exit(1);
  }
  console.log(`[trigger] window: ${page.title}`);
  console.log(`[trigger] prompt: ${text}`);

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

  await raise(page.title);

  const exec = new CommandExecutor(selectors);
  exec.setClient(client);

  if (newChat) {
    const created = await exec.newChat('probe-trigger-new');
    console.log(`[trigger] newChat: ${JSON.stringify(created)}`);
    await sleep(1200);
  }

  const sent = await exec.sendMessage('probe-trigger-send', text);
  console.log(`[trigger] sendMessage: ${JSON.stringify(sent)}`);

  if (waitSeconds <= 0) {
    console.log('[trigger] 已发出。抓卡片请跑：pnpm exec tsx scripts/probes/probe-approval-watch.ts');
    client.disconnect();
    return;
  }

  const deadline = Date.now() + waitSeconds * 1000;
  let lastStatus = '';
  while (Date.now() < deadline) {
    await sleep(400);
    const state = await extract();
    const approvals = (state?.pendingApprovals ?? []) as Array<Record<string, unknown>>;
    const status = String(state?.agentStatus);
    if (status !== lastStatus || approvals.length > 0) {
      lastStatus = status;
      console.log(`[trigger] status=${status} approvals=${approvals.length}`);
    }
    if (approvals.length > 0) {
      console.log(JSON.stringify(approvals, null, 2));
      break;
    }
  }

  client.disconnect();
}

main().catch((err: unknown) => {
  console.error('[trigger] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
