import type { CdpClient } from '../packages/agent/src/cdp/client.js';
import type { CodeBuddyLiveDump } from '../packages/agent/src/drivers/codebuddy/live.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { parseCdpTitle, pickWorkbenchTarget } from '../packages/agent/src/cdp/bridge.js';
import { CodeBuddyExecutor } from '../packages/agent/src/drivers/codebuddy/executor.js';
import {
  codebuddyClickExpression,
  CodeBuddyExtractor,
  dumpCodeBuddyLive,
  pickCodingCopilotTarget,
} from '../packages/agent/src/drivers/codebuddy/extractor.js';
import {

  mapCodeBuddyLive,
} from '../packages/agent/src/drivers/codebuddy/live.js';

const ROOT = dirname(fileURLToPath(import.meta.url));

function fixtureDump(): CodeBuddyLiveDump {
  return {
    inputAvailable: true,
    agentStatus: 'idle',
    agentActivityText: null,
    chatTabs: [{ id: 'sess-1', title: 'Demo tab', isActive: true }],
    activeComposerId: 'sess-1',
    pendingApprovals: [
      {
        id: 'appr-1',
        selectorPath: '.execute-command-compact__btn--allow',
        description: 'Run command',
      },
    ],
    liveActions: {},
    mode: { current: 'Craft', available: [{ id: 'craft', label: 'Craft', icon: '' }] },
    model: { current: 'Auto', currentId: 'auto' },
  };
}

describe('mapCodeBuddyLive', () => {
  it('maps a fixture dump with one approval, idle status, and one tab', () => {
    const state = mapCodeBuddyLive(fixtureDump());
    assert.equal(state.pendingApprovals?.length, 1);
    assert.equal(state.agentStatus, 'idle');
    assert.equal(state.chatTabs?.length, 1);
    assert.equal(state.chatTabs?.[0]?.title, 'Demo tab');
    assert.equal(state.chatTabs?.[0]?.isActive, true);
    assert.equal(state.inputAvailable, true);
    assert.ok(!('messages' in state) || (state.messages?.length ?? 0) === 0);
  });

  it('maps a running tab to status generating (web 会话列表按行画 loading)', () => {
    const dump = fixtureDump();
    dump.chatTabs = [
      { id: 'sess-run', title: 'Running tab', isActive: false, running: true },
      { id: 'sess-idle', title: 'Idle tab', isActive: false },
      { id: 'sess-active', title: 'Active tab', isActive: true },
    ];
    const state = mapCodeBuddyLive(dump);
    assert.equal(state.chatTabs?.[0]?.status, 'generating');
    assert.equal(state.chatTabs?.[1]?.status, 'idle');
    assert.equal(state.chatTabs?.[2]?.status, 'active');
  });

  it('maps a tab waiting for confirmation to waiting_approval, 且问号优先于转圈', () => {
    const dump = fixtureDump();
    dump.chatTabs = [
      { id: 'sess-ask', title: 'Needs approval', isActive: false, needsAttention: true },
      { id: 'sess-both', title: 'Running + asking', isActive: true, running: true, needsAttention: true },
    ];
    const state = mapCodeBuddyLive(dump);
    assert.equal(state.chatTabs?.[0]?.status, 'waiting_approval');
    assert.equal(state.chatTabs?.[1]?.status, 'waiting_approval');
  });

  it('maps a tab that finished with unread results to status unread, 且不盖转圈/问号', () => {
    const dump = fixtureDump();
    dump.chatTabs = [
      { id: 'sess-done', title: 'Done tab', isActive: false, unread: true },
      { id: 'sess-run-unread', title: 'Running tab', isActive: false, running: true, unread: true },
      { id: 'sess-ask-unread', title: 'Asking tab', isActive: false, needsAttention: true, unread: true },
    ];
    const state = mapCodeBuddyLive(dump);
    assert.equal(state.chatTabs?.[0]?.status, 'unread');
    assert.equal(state.chatTabs?.[1]?.status, 'generating');
    assert.equal(state.chatTabs?.[2]?.status, 'waiting_approval');
  });

  it('keeps every action of a transcript tool menu instead of collapsing it to one', () => {
    const dump = fixtureDump();
    dump.pendingApprovals = [
      {
        id: 'tool:rm -f /tmp/cb.txt',
        selectorPath: 's-run',
        description: 'rm -f /tmp/cb.txt',
        actions: [
          { label: 'Run', type: 'approve', selectorPath: 's-run' },
          { label: 'Skip', type: 'reject', selectorPath: 's-skip' },
          { label: 'Reject', type: 'reject', selectorPath: 's-reject' },
        ],
      },
    ];
    const state = mapCodeBuddyLive(dump);
    assert.equal(state.pendingApprovals?.length, 1);
    const approval = state.pendingApprovals?.[0];
    assert.equal(approval?.description, 'rm -f /tmp/cb.txt');
    assert.deepEqual(approval?.actions.map(a => a.type), ['approve', 'reject', 'reject']);
    assert.deepEqual(approval?.actions.map(a => a.label), ['Run', 'Skip', 'Reject']);
    assert.deepEqual(approval?.actions.map(a => a.selectorPath), ['s-run', 's-skip', 's-reject']);
  });

  it('maps a 拒绝/Deny button as reject when selectorPath has no deny/reject substring', () => {
    const dump = fixtureDump();
    dump.pendingApprovals = [
      {
        id: 'appr-deny',
        selectorPath: '.card-buttons > button:nth-of-type(2)',
        description: '拒绝',
      },
      {
        id: 'appr-deny-en',
        selectorPath: '.checkpoint-confirm-dialog > button:nth-of-type(1)',
        description: 'Deny',
      },
    ];
    assert.doesNotMatch(dump.pendingApprovals[0].selectorPath, /deny|reject/i);
    assert.doesNotMatch(dump.pendingApprovals[1].selectorPath, /deny|reject/i);

    const state = mapCodeBuddyLive(dump);
    for (const approval of state.pendingApprovals ?? []) {
      const action = approval.actions[0];
      assert.equal(action?.type, 'reject');
      assert.equal(action?.label, 'Deny');
    }
  });
});

describe('CodeBuddy live selectors', () => {
  it('does not scrape the message timeline or reuse Cursor composer-bar', () => {
    const live = readFileSync(join(ROOT, '../packages/agent/src/drivers/codebuddy/live.ts'), 'utf8');
    const extractor = readFileSync(join(ROOT, '../packages/agent/src/drivers/codebuddy/extractor.ts'), 'utf8');
    const combined = `${live}\n${extractor}`;
    assert.doesNotMatch(combined, /composer-bar/);
    assert.doesNotMatch(combined, /data-flat-index/);
    assert.match(combined, /execute-command-compact__btn--allow/);
    assert.match(combined, /execute-command-compact__btn--deny/);
    // Verified live: the pending shell-command decision is rendered in the
    // transcript card's bottom menu, not in `.card-buttons`.
    assert.match(combined, /\.tool-menu \.menu-item/);
    assert.match(combined, /roots-confirm-card__actions/);
    assert.match(combined, /checkpoint-confirm-dialog/);
    assert.match(combined, /high-credit-approval-floating-module_confirm/);
  });
});

/**
 * Markup captured from CodeBuddy CN 2026-09 (CDP 9223) while a `rm` command
 * was waiting for a decision. `.card-buttons` is present but empty; the
 * Run/Skip/Reject items live in `.card-bottom > .tool-menu`.
 */
const PENDING_TOOL_MENU_HTML = `
  <div class="session-tab session-tab-active" data-session-tab-id="sess-1" aria-selected="true">
    <span class="session-tab-name">Demo tab</span>
  </div>
  <div class="chat-input-module_container">
    <div data-slate-editor="true"></div>
  </div>
  <div class="message-timeline-module_assistantMessageContent_lkN3o">
    <div class="assistant-message-tools">
      <div class="assistant-message-tool-container">
        <div class="assistant-message-tool execute-command">
          <div class="tool-inner border tool-status-pending">
            <div class="card-header click-header">
              <div class="card-header-top">
                <div class="left">
                  <span class="command-text-expanded">rm -f /tmp/cb.txt</span>
                </div>
              </div>
              <div class="card-buttons"></div>
            </div>
            <div class="card-content"><span class="content"></span></div>
            <div class="card-bottom">
              <div class="tool-menu">
                <div class="menu-title menu-title-danger">
                  <span class="menu-title-warn-icon"></span>
                  <span class="menu-title-danger-text">Contains dangerous command, run anyway?</span>
                  <span class="menu-title-settings">
                    <span class="command-text">STALE COMMAND FROM A PREVIOUS CARD</span>
                  </span>
                </div>
                <div class="menu-content">
                  <div class="menu-item">Run</div>
                  <div class="menu-item">Skip</div>
                  <div class="menu-item">Reject</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
`;

describe('parseCdpTitle suffixes', () => {
  it('strips Cursor by default and leaves CodeBuddy product names intact until suffixes are passed', () => {
    assert.equal(parseCdpTitle('demo-repo - Cursor'), 'demo-repo');
  });

  it('strips CodeBuddy product suffixes when they are injected', () => {
    const suffixes = [' - CodeBuddy', ' - CodeBuddy CN'];
    assert.equal(parseCdpTitle('demo-repo - CodeBuddy', suffixes), 'demo-repo');
    assert.equal(parseCdpTitle('demo-repo - CodeBuddy CN', suffixes), 'demo-repo');
  });
});

describe('workbench windows exclude webviews', () => {
  it('does not treat a coding-copilot iframe as a window', () => {
    const target = pickWorkbenchTarget([
      {
        id: 'iframe',
        type: 'iframe',
        title: 'coding-copilot',
        url: 'vscode-webview://hash/coding-copilot',
        webSocketDebuggerUrl: 'ws://iframe',
      },
      {
        id: 'page',
        type: 'page',
        title: 'demo-repo - CodeBuddy',
        url: 'vscode-file://vscode-app/Applications/CodeBuddy CN.app/workbench.html',
        webSocketDebuggerUrl: 'ws://page',
      },
    ]);
    assert.equal(target?.id, 'page');
  });
});

function withDom<T>(html: string, fn: () => T): T {
  const dom = new JSDOM(html);
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: dom.window.document,
  });
  try {
    return fn();
  }
  finally {
    if (documentDescriptor) {
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    }
    else {
      delete (globalThis as { document?: unknown }).document;
    }
  }
}

describe('dumpCodeBuddyLive', () => {
  it('dumps one approval, one tab, and no messages', () => {
    const dump = withDom(
      `
      <div class="session-tab session-tab-active" data-session-tab-id="sess-1" aria-selected="true">
        <span class="session-tab-name">Demo tab</span>
      </div>
      <div class="chat-input-module_container">
        <div data-slate-editor="true"></div>
      </div>
      <button class="execute-command-compact__btn--allow">Allow</button>
      `,
      () => dumpCodeBuddyLive(),
    );
    assert.ok(dump);
    assert.equal(dump.pendingApprovals.length, 1);
    assert.equal(dump.agentStatus, 'waiting_approval');
    assert.equal(dump.chatTabs.length, 1);
    assert.equal(dump.chatTabs[0].title, 'Demo tab');
    assert.equal(dump.inputAvailable, true);
    assert.equal('messages' in dump, false);
  });

  it('reads the unread dot on a session tab (agent-state-dot) without confusing it with the spinner', () => {
    // 2026-09-16 live check (CodeBuddy CN): an unread finished session tab has
    // `<span class="agent-state-indicator agent-state-dot"><span class="agent-state-dot" aria-label="Unread">`.
    const dump = withDom(
      `
      <div class="session-tab" data-session-tab-id="sess-done">
        <span class="agent-state-indicator agent-state-dot">
          <span class="agent-state-dot" aria-label="Unread"></span>
        </span>
        <span class="session-tab-name">Done tab</span>
      </div>
      <div class="session-tab session-tab-active" data-session-tab-id="sess-run" aria-selected="true">
        <span class="agent-state-indicator agent-state-spinner">
          <svg aria-label="Running"></svg>
        </span>
        <span class="session-tab-name">Running tab</span>
      </div>
      `,
      () => dumpCodeBuddyLive(),
    );
    assert.ok(dump);
    assert.equal(dump.chatTabs.length, 2);
    assert.equal(dump.chatTabs[0].unread, true);
    assert.equal(dump.chatTabs[0].running, false);
    assert.equal(dump.chatTabs[1].running, true);
    assert.equal(dump.chatTabs[1].unread, false);
    // Live "generating" criterion = the current session tab is spinning (2026-09-18 probe: the old
    // `[class*="stop"]` lookup for the composer stop button never hit → always reported idle while generating)
    assert.equal(dump.agentStatus, 'generating');
  });

  it('reads one approval with Run / Skip / Reject from the transcript tool menu', () => {
    const dump = withDom(PENDING_TOOL_MENU_HTML, () => dumpCodeBuddyLive());
    assert.ok(dump);
    assert.equal(dump.pendingApprovals.length, 1);
    assert.equal(dump.agentStatus, 'waiting_approval');

    const approval = dump.pendingApprovals[0];
    assert.equal(approval.description, 'rm -f /tmp/cb.txt');
    assert.deepEqual(
      approval.actions?.map(a => [a.label, a.type]),
      [['Run', 'approve'], ['Skip', 'reject'], ['Reject', 'reject']],
    );
    assert.match(approval.actions?.[0].selectorPath ?? '', /menu-item:nth-of-type\(1\)/);
    assert.match(approval.actions?.[2].selectorPath ?? '', /menu-item:nth-of-type\(3\)/);
  });

  it('reads a hook approval on a non-shell card, ignoring the menu title tooltip', () => {
    // HookApprovalMenu (write / delete / web_fetch / ... cards) renders the
    // same .tool-menu with Run / Skip / Reject and a per-tool title.
    const dump = withDom(
      `
      <div class="assistant-message-tool delete-files">
        <div class="tool-inner border tool-status-pending">
          <div class="card-header">
            <div class="card-header-top">
              <div class="left"><span class="delete-file-name">build/output.js</span></div>
            </div>
          </div>
          <div class="card-bottom">
            <div class="tool-menu">
              <div class="menu-title">Delete file?</div>
              <div class="menu-content">
                <div class="menu-item">Run</div>
                <div class="menu-item">Skip</div>
                <div class="menu-item">Reject</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      `,
      () => dumpCodeBuddyLive(),
    );
    assert.ok(dump);
    assert.equal(dump.pendingApprovals.length, 1);
    assert.equal(dump.agentStatus, 'waiting_approval');
    assert.equal(dump.pendingApprovals[0].description, 'build/output.js');
    assert.deepEqual(
      dump.pendingApprovals[0].actions?.map(a => [a.label, a.type]),
      [['Run', 'approve'], ['Skip', 'reject'], ['Reject', 'reject']],
    );
  });

  it('does not turn "Run in Background" in .card-buttons into an approval', () => {
    const dump = withDom(
      `
      <div class="assistant-message-tool execute-command">
        <div class="tool-inner border">
          <div class="card-header click-header">
            <div class="card-buttons">
              <div class="command-control">
                <div class="button-container">
                  <div class="command-options">
                    <button class="codebuddy-button vscode-tertiary small">Run in Background</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      `,
      () => dumpCodeBuddyLive(),
    );
    assert.ok(dump);
    assert.equal(dump.pendingApprovals.length, 0);
    assert.notEqual(dump.agentStatus, 'waiting_approval');
  });
});

describe('pickCodingCopilotTarget', () => {
  it('finds the coding-copilot iframe among workbench pages', () => {
    const hit = pickCodingCopilotTarget([
      { url: 'vscode-file://app/workbench.html', webSocketDebuggerUrl: 'ws://page', type: 'page' },
      { url: 'vscode-webview://hash/coding-copilot', webSocketDebuggerUrl: 'ws://panel', type: 'iframe' },
    ]);
    assert.equal(hit?.webSocketDebuggerUrl, 'ws://panel');
  });
});

describe('CodeBuddyExtractor', () => {
  it('reports extraction failures on the callback instead of throwing', async () => {
    const seen: Array<{ state: unknown; error: string | null | undefined }> = [];
    const extractor = new CodeBuddyExtractor((state, errorMessage) => {
      seen.push({ state, error: errorMessage });
    });
    const client = {
      isConnected: () => true,
      callFunctionWithTimeout: async () => {
        throw new Error('boom');
      },
    } as unknown as CdpClient;
    extractor.start(client, 20);
    await new Promise(r => setTimeout(r, 30));
    extractor.stop();
    assert.ok(seen.some(s => s.state === null && String(s.error).includes('boom')));
  });
});

describe('CodeBuddyExecutor clicks', () => {
  it('approve clicks via querySelector(path).click() inside the agent frame', async () => {
    let expr = '';
    const client = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        expr = expression;
        return { ok: true };
      },
    } as unknown as CdpClient;
    const exec = new CodeBuddyExecutor({ wait: async () => {} });
    exec.setClient(client);
    const result = await exec.clickApproval('c1', '.execute-command-compact__btn--allow');
    assert.equal(result.ok, true);
    assert.match(expr, /querySelector/);
    assert.match(expr, /\.click\(\)/);
    assert.match(expr, /active-frame/);
    assert.doesNotMatch(expr, /composer-bar/);
    assert.match(codebuddyClickExpression('.x'), /querySelector/);
  });

  it('keeps ok:false when the click target is missing', async () => {
    const client = {
      isConnected: () => true,
      evaluate: async () => ({ ok: false, error: 'Element not found' }),
    } as unknown as CdpClient;
    const exec = new CodeBuddyExecutor({ wait: async () => {} });
    exec.setClient(client);
    const result = await exec.switchTab('c2', 'missing-tab');
    assert.equal(result.ok, false);
  });

  it('approveAll skips 拒绝 and Deny and clicks Allow', async () => {
    const { DENY_RE } = await import('../packages/agent/src/drivers/codebuddy/live.js');
    const clicks: string[] = [];
    const client = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        const skip = expression.match(/if \((\/(?:\\.|[^/])+\/)\.test\(t\)\) continue/);
        assert.ok(skip, 'approveAll must skip using an interpolated deny regex');
        const re = new Function(`return ${skip[1]}`)() as RegExp;
        assert.equal(re.source, DENY_RE.source, 'must reuse looksLikeDeny DENY_RE, not a third regex');
        for (const label of ['Allow', '拒绝', 'Deny', '取消']) {
          const t = label.toLowerCase();
          if (re.test(t))
            continue;
          clicks.push(label);
        }
        return clicks.length > 0 ? { ok: true } : { ok: false, error: 'No approve buttons' };
      },
    } as unknown as CdpClient;
    const exec = new CodeBuddyExecutor({ wait: async () => {} });
    exec.setClient(client);
    const result = await exec.approveAll('c-all');
    assert.equal(result.ok, true);
    assert.deepEqual(clicks, ['Allow']);
  });
});
