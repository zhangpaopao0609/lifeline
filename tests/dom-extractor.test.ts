import type { CursorState } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { getDefaultSelectors } from '../packages/agent/src/config.js';
import { extractionFunction } from '../packages/agent/src/drivers/cursor/extractor.js';

function withDom(
  html: string,
  tabSelectors: string[] = [],
  approveTextMatch: string[] = [],
  rejectTextMatch: string[] = [],
  containerSelectors: string[] = ['#root'],
): CursorState {
  const dom = new JSDOM(html);
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const nodeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Node');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, 'Node', {
    configurable: true,
    value: dom.window.Node,
  });
  try {
    const state = extractionFunction(
      containerSelectors,
      [],
      approveTextMatch,
      [],
      rejectTextMatch,
      [],
      [],
      tabSelectors,
      [],
      [],
    );
    assert.ok(state, 'expected extractionFunction to return state');
    return state;
  }
  finally {
    if (documentDescriptor) {
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    }
    else {
      delete globalThis.document;
    }
    if (nodeDescriptor) {
      Object.defineProperty(globalThis, 'Node', nodeDescriptor);
    }
    else {
      delete globalThis.Node;
    }
  }
}

describe('extractionFunction', () => {
  it('does not scrape ChatElements from data-flat-index transcript rows', () => {
    const state = withDom(`
      <main id="root">
        <article data-flat-index="0" data-message-role="human" data-message-kind="human" data-message-id="h1">
          <div class="aislash-editor-input-readonly">please scrape me</div>
        </article>
        <article data-flat-index="1" data-message-role="ai" data-message-kind="assistant" data-message-id="a1">
          <div class="markdown-root"><p>hello <strong>world</strong></p></div>
        </article>
      </main>
      <div class="tabs-container">
        <div class="tab selected active" role="tab" aria-label="Live chat, Chat Editors: Editor Group 1">
          <a class="label-name">Live chat</a>
        </div>
      </div>
    `);

    assert.equal(state.messages.length, 0);
    assert.ok(Array.isArray(state.pendingApprovals));
    assert.deepEqual(
      state.chatTabs.map(t => t.title),
      ['Live chat'],
    );
    assert.equal(state.chatTabs[0].isActive, true);
  });

  it('emits Cursor 3.8 activity tool-placeholder rows without data-message-role', () => {
    const state = withDom(`
      <main id="root">
        <div data-find-row-key="tool-placeholder:call-1">
          <article data-flat-index="0" data-react-transcript-row-kind="activity" data-message-id="m-tool">
            <div data-tool-call-id="call-1" data-tool-status="completed">
              <span class="ui-tool-call-line-action">Read</span>
              <span class="ui-tool-call-line-details">src/server/dom-extractor.ts</span>
              <div class="composer-skip-button">Skip</div>
            </div>
          </article>
        </div>
      </main>
    `);

    const tool = state.messages.find(message => message.type === 'tool');

    assert.equal(state.messages.length, 0);
    assert.equal(tool, undefined);
    assert.ok(Array.isArray(state.pendingApprovals));
    assert.ok(Array.isArray(state.chatTabs));
    const skip = state.liveActions['call-1']?.find(a => a.type === 'skip');
    assert.ok(skip, 'expected Skip to land in liveActions, not messages');
  });

  it('uses anchored selector paths for data-click-ready questionnaire actions', () => {
    const state = withDom(`
      <main id="root"></main>
      <div id="composer-toolbar-section">
        <div class="composer-questionnaire-toolbar">
          <div class="composer-questionnaire-toolbar-stepper-label">1 of 1</div>
          <section class="composer-questionnaire-toolbar-actions">
            <div data-click-ready="true">
              <span><span class="truncate">Skip</span></span>
            </div>
            <div class="shortcut">Esc</div>
            <div data-click-ready="true" data-disabled="true">
              <span><span class="truncate">Continue</span></span>
            </div>
          </section>
        </div>
      </div>
    `);

    assert.ok(state.questionnaire);
    assert.equal(
      state.questionnaire.skipSelectorPath,
      '.composer-questionnaire-toolbar-actions > div[data-click-ready]:nth-child(1)',
    );
    assert.equal(
      state.questionnaire.continueSelectorPath,
      '.composer-questionnaire-toolbar-actions > div[data-click-ready]:nth-child(3)',
    );
    assert.equal(state.questionnaire.continueDisabled, true);
  });

  it('问卷带归属会话：这一轮的活跃 composer', () => {
    const state = withDom(`
      <main id="root" data-composer-id="c-own-1">
        <div class="composer-questionnaire-toolbar">
          <div class="composer-questionnaire-toolbar-stepper-label">1 of 1</div>
        </div>
      </main>
    `);

    assert.ok(state.questionnaire);
    assert.equal(state.questionnaire.composerId, 'c-own-1');
    assert.equal(state.activeComposerId, 'c-own-1');
  });

  it('emits anchored option-row selector paths for questionnaire options (public#50)', () => {
    const state = withDom(`
      <main id="root"></main>
      <div id="composer-toolbar-section">
        <div class="composer-questionnaire-toolbar">
          <div class="composer-questionnaire-toolbar-stepper-label">1 of 1</div>
          <div class="composer-questionnaire-toolbar-questions">
            <div class="composer-questionnaire-toolbar-question composer-questionnaire-toolbar-question-active">
              <div class="composer-questionnaire-toolbar-question-number">1.</div>
              <div class="composer-questionnaire-toolbar-options">
                <div class="composer-questionnaire-toolbar-option" role="button">
                  <button class="composer-questionnaire-toolbar-option-letter" type="button">A</button>
                  <span class="composer-questionnaire-toolbar-option-label">Explore the codebase</span>
                </div>
                <div class="composer-questionnaire-toolbar-option composer-questionnaire-toolbar-option-freeform" role="button">
                  <button class="composer-questionnaire-toolbar-option-letter" type="button">B</button>
                  <textarea class="composer-questionnaire-toolbar-freeform-input"></textarea>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `);

    assert.ok(state.questionnaire);
    const [question] = state.questionnaire.questions;
    assert.equal(question.options.length, 2);
    assert.equal(question.options[0].label, 'Explore the codebase');
    assert.equal(
      question.options[0].selectorPath,
      '.composer-questionnaire-toolbar-question:nth-of-type(1) .composer-questionnaire-toolbar-option:nth-of-type(1)',
    );
    assert.equal(question.options[1].label, 'Other');
    assert.equal(question.options[1].isFreeform, true);
    assert.equal(
      question.options[1].selectorPath,
      '.composer-questionnaire-toolbar-question:nth-of-type(1) .composer-questionnaire-toolbar-option:nth-of-type(2)',
    );
  });

  it('keeps buildSelectorPath selectors for legacy questionnaire actions', () => {
    const state = withDom(`
      <main id="root"></main>
      <div id="composer-toolbar-section">
        <div class="composer-questionnaire-toolbar">
          <section class="composer-questionnaire-toolbar-actions">
            <div class="composer-skip-button">Skip</div>
            <div class="composer-run-button" data-disabled="false">Continue</div>
          </section>
        </div>
      </div>
    `);

    assert.ok(state.questionnaire);
    assert.equal(
      state.questionnaire.skipSelectorPath,
      'div#composer-toolbar-section > div > section > div:nth-of-type(1)',
    );
    assert.equal(
      state.questionnaire.continueSelectorPath,
      'div#composer-toolbar-section > div > section > div:nth-of-type(2)',
    );
    assert.equal(state.questionnaire.continueDisabled, false);
    // Button copy is the IDE's real value (the web copies it; CodeBuddy uses Complete, see the codebuddy-questionnaire tests)
    assert.equal(state.questionnaire.skipLabel, 'Skip');
    assert.equal(state.questionnaire.continueLabel, 'Continue');
  });

  it('reads Cursor Agents glass rows from ui-sidebar-menu-button (not the old menu-btn class)', () => {
    const state = withDom(`
      <main id="root">
        <div data-message-role="user" data-message-id="m1">hi</div>
      </main>
      <div class="glass-sidebar-agent-list-container">
        <div class="ui-sidebar-group">
          <span class="ui-sidebar-group-label-title">Repositories</span>
          <ul class="ui-sidebar-menu">
            <li class="ui-sidebar-menu-item">
              <div class="ui-button ui-sidebar-menu-button">
                <span class="ui-sidebar-menu-button-label">Chat conversation topic</span>
              </div>
            </li>
            <li class="ui-sidebar-menu-item">
              <div class="ui-button ui-sidebar-menu-button">
                <span class="ui-sidebar-menu-button-label">Machine management limitations</span>
              </div>
            </li>
            <li class="ui-sidebar-menu-item">
              <div class="ui-button ui-sidebar-menu-button">
                <span class="ui-sidebar-menu-button-label">More</span>
              </div>
            </li>
          </ul>
        </div>
      </div>
    `);

    assert.deepEqual(
      state.chatTabs.map(t => t.title),
      ['Repositories / Chat conversation topic', 'Repositories / Machine management limitations'],
    );
    assert.equal(state.messages.length, 0);
  });

  it('uses unified-sidebar conversation cells and skips New Agent / Customize chrome', () => {
    const state = withDom(
      `
      <main id="root">
        <div data-message-role="user" data-message-id="m1">hi</div>
      </main>
      <div id="workbench.parts.unifiedsidebar">
        <div class="agent-sidebar-header-actions">
          <div class="agent-sidebar-cell" data-selected="false">
            <span class="agent-sidebar-cell-text">New Agent</span>
          </div>
          <div class="agent-sidebar-cell" data-selected="false">
            <span class="agent-sidebar-cell-text">Customize</span>
          </div>
        </div>
        <div class="agent-sidebar-list">
          <div class="agent-sidebar-cell" data-selected="true">
            <span class="agent-sidebar-cell-text">Machine management limitations</span>
          </div>
          <div class="agent-sidebar-cell" data-selected="false">
            <span class="agent-sidebar-cell-text">Chat conversation topic</span>
          </div>
        </div>
      </div>
    `,
      ['.agent-sidebar-cell'],
    );

    assert.deepEqual(
      state.chatTabs.map(t => t.title),
      ['Machine management limitations', 'Chat conversation topic'],
    );
    assert.equal(state.chatTabs[0].isActive, true);
    assert.equal(state.chatTabs[1].isActive, false);
  });

  it('prefers workbench sidebar cells over the global Cursor Agents glass list', () => {
    const state = withDom(
      `
      <main id="root">
        <div data-message-role="user" data-message-id="m1">hi</div>
      </main>
      <div class="agent-sidebar-list">
        <div class="agent-sidebar-cell" data-selected="true">
          <span class="agent-sidebar-cell-text">Machine management limitations</span>
        </div>
        <div class="agent-sidebar-cell" data-selected="false">
          <span class="agent-sidebar-cell-text">Chat conversation topic</span>
        </div>
      </div>
      <div class="glass-sidebar-agent-list-container">
        <ul class="ui-sidebar-menu">
          <li class="ui-sidebar-menu-item">
            <div class="ui-button ui-sidebar-menu-button">
              <span class="ui-sidebar-menu-button-label">Unrelated other project chat</span>
            </div>
          </li>
        </ul>
      </div>
    `,
      ['.agent-sidebar-cell'],
    );

    assert.deepEqual(
      state.chatTabs.map(t => t.title),
      ['Machine management limitations', 'Chat conversation topic'],
    );
  });

  it('falls back to Chat Editor tabs when the agent sidebar is empty', () => {
    const state = withDom(`
      <main id="root">
        <div data-message-role="user" data-message-id="m1">hi</div>
      </main>
      <div class="tabs-container">
        <div class="tab" role="tab" aria-label="src/server/index.ts, Editor Group 1">
          <a class="label-name">index.ts</a>
        </div>
        <div class="tab selected active" role="tab" aria-label="Machine management limitations, Chat Editors: Editor Group 1">
          <a class="label-name">Machine management limitations</a>
        </div>
        <div class="tab" role="tab" aria-label="Chat conversation topic, Chat Editors: Editor Group 1">
          <a class="label-name">Chat conversation topic</a>
        </div>
      </div>
    `);

    assert.deepEqual(
      state.chatTabs.map(t => t.title),
      ['Machine management limitations', 'Chat conversation topic'],
    );
    assert.equal(state.chatTabs[0].isActive, true);
  });

  it('reads the active composer from composer-bar when sidebar cells have no data-composer-id', () => {
    const state = withDom(`
      <main id="root"></main>
      <div class="composer-bar editor" data-composer-id="fd1bc76b-5001-47d8-9d1a-1e6a4c71bc9d"></div>
      <div class="agent-sidebar-list">
        <div class="agent-sidebar-cell" data-selected="false">
          <span class="agent-sidebar-cell-text">Old chat</span>
        </div>
        <div class="agent-sidebar-cell" data-selected="true">
          <span class="agent-sidebar-cell-text">New chat</span>
        </div>
      </div>
    `);

    assert.equal(state.activeComposerId, 'fd1bc76b-5001-47d8-9d1a-1e6a4c71bc9d');
    assert.equal(state.chatTabs[0].isActive, false);
    assert.equal(state.chatTabs[1].isActive, true);
    assert.equal(state.chatTabs[1].composerId, 'fd1bc76b-5001-47d8-9d1a-1e6a4c71bc9d');
    assert.equal(/^tab-\d+$/.test(state.activeComposerId), false);
  });

  it('synthesizes a draft row for a composer bar the sidebar does not list yet', () => {
    // Click ＋ to create, first message not yet sent: Cursor sidebar has no row and the DB has no
    // name. Without synthesizing a row, "current session" does not exist on the web — the send
    // target cannot be computed (phone cannot talk).
    const state = withDom(`
      <main id="root"></main>
      <div class="tabs-container">
        <div class="tab selected active" role="tab" data-resource-name="9f0c4d21-6a55-4a0e-9d3c-7b2f18ae55d1">
          <a class="label-name">New Agent</a>
        </div>
      </div>
      <div class="composer-bar editor empty" data-composer-id="9f0c4d21-6a55-4a0e-9d3c-7b2f18ae55d1"></div>
      <div class="agent-sidebar-list">
        <div class="agent-sidebar-cell" data-selected="false">
          <span class="agent-sidebar-cell-text">Old chat</span>
        </div>
      </div>
    `);

    assert.deepEqual(
      state.chatTabs.map(t => t.title),
      ['Old chat', 'New Agent'],
    );
    const draft = state.chatTabs[1];
    assert.equal(draft.composerId, '9f0c4d21-6a55-4a0e-9d3c-7b2f18ae55d1');
    assert.equal(draft.isActive, true);
    assert.equal(draft.composerIdSource, 'dom');
    // Draft: no body yet — the web must not fill in the previous session's body (it has a real id, so do not short-circuit the body fetch)
    assert.equal(draft.isDraft, true);
    assert.equal(state.activeComposerId, '9f0c4d21-6a55-4a0e-9d3c-7b2f18ae55d1');
  });

  it('does not add a second row when a sidebar row already carries the active composer', () => {
    const state = withDom(`
      <main id="root"></main>
      <div class="composer-bar editor" data-composer-id="fd1bc76b-5001-47d8-9d1a-1e6a4c71bc9d"></div>
      <div class="agent-sidebar-list">
        <div class="agent-sidebar-cell" data-selected="true">
          <span class="agent-sidebar-cell-text">New chat</span>
        </div>
      </div>
    `);

    assert.equal(state.chatTabs.length, 1);
    assert.equal(state.chatTabs[0].composerId, 'fd1bc76b-5001-47d8-9d1a-1e6a4c71bc9d');
  });

  it('keeps same-title rows separate and does not wipe the running row status', () => {
    const state = withDom(`
      <main id="root"></main>
      <div class="composer-bar editor" data-composer-id="437b6f36-8e5c-46e2-89b9-e6a93e7a47db"></div>
      <div class="agent-sidebar-list">
        <div class="agent-sidebar-cell" data-selected="true">
          <span class="agent-sidebar-cell-icon"><span class="spinning-loader"></span></span>
          <span class="agent-sidebar-cell-text">pnpm installation request</span>
        </div>
        <div class="agent-sidebar-cell" data-selected="false">
          <span class="agent-sidebar-cell-icon"><span class="spinning-loader"></span></span>
          <span class="agent-sidebar-cell-text">pnpm installation request</span>
        </div>
        <div class="agent-sidebar-cell" data-selected="false">
          <span class="agent-sidebar-cell-icon"></span>
          <span class="agent-sidebar-cell-text">pnpm installation request</span>
        </div>
        <div class="agent-sidebar-cell" data-selected="false">
          <span class="agent-sidebar-cell-icon"></span>
          <span class="agent-sidebar-cell-text">Other chat</span>
        </div>
      </div>
    `);

    // Same title, different sessions: not squeezed out by title-dedup; as many rows as the IDE sidebar
    assert.equal(state.chatTabs.filter(t => t.title === 'pnpm installation request').length, 3);
    // The selected row must still be there, still spinning, and get the composer-bar's real id
    const active = state.chatTabs.find(t => t.isActive);
    assert.equal(active?.title, 'pnpm installation request');
    assert.equal(active?.status, 'generating');
    assert.equal(active?.composerId, '437b6f36-8e5c-46e2-89b9-e6a93e7a47db');
    // Inactive rows keep their own spinner state (background-running sessions need a loading ring too)
    assert.equal(state.chatTabs.filter(t => t.status === 'generating').length, 2);
    assert.equal(state.activeComposerId, '437b6f36-8e5c-46e2-89b9-e6a93e7a47db');
  });

  it('scopes lastAssistantText to the transcript container', () => {
    const state = withDom(`
      <main id="root">
        <article data-message-role="assistant">inside tail</article>
      </main>
      <div data-message-role="assistant">outside later noise</div>
    `);
    assert.equal(state.lastAssistantText, 'inside tail');
  });

  it('does not treat a chat button that only looks like server log output as a reject approval', () => {
    const state = withDom(
      `
      <main id="root">
        <button type="button">[content-live] includeProcess=false
[config] Could not load selectors from /selectors.json, using defaults</button>
      </main>
    `,
      [],
      ['Accept', 'Approve', 'Run', 'Allow', 'Accept All'],
      ['Reject', 'Deny', 'Cancel', 'Skip'],
    );
    assert.equal(state.pendingApprovals.length, 0);
  });

  it('does not invent a pending approval from reject-only buttons', () => {
    const state = withDom(
      `
      <main id="root">
        <button type="button">Skip</button>
      </main>
    `,
      [],
      ['Accept', 'Run'],
      ['Skip'],
    );
    assert.equal(state.pendingApprovals.length, 0);
  });

  it('still extracts a real shell-tool approval row', () => {
    const state = withDom(`
      <main id="root">
        <div class="ui-tool-call-card">
          <div class="ui-shell-tool-call__command">npm test</div>
          <div class="ui-shell-tool-call__approval-row">
            <button class="ui-shell-tool-call__run-btn">Run</button>
            <button class="ui-shell-tool-call__skip-btn">Skip</button>
          </div>
        </div>
      </main>
    `);
    assert.equal(state.pendingApprovals.length, 1);
    assert.equal(state.pendingApprovals[0].description, 'npm test');
    assert.ok(state.pendingApprovals[0].actions.some(a => a.type === 'approve'));
  });

  it('extracts a new-style pending card that has no approval-row wrapper', () => {
    // 2026-09-16 measured (Cursor 1.x, new session in the demo-repo window running pnpm i):
    // the new layout dropped the `.ui-shell-tool-call__approval-row` wrapper; Run/Skip hang
    // directly on the `.ui-shell-tool-call--pending` card, nested in a [data-message-role]
    // transcript row. Old code walked approval-row (0 hits) + fallback blocked by
    // inTranscript() → the web saw no approval at all.
    const state = withDom(`
      <main id="root">
        <div class="agent-transcript-row" data-message-role="ai">
          <div class="ui-shell-tool-call ui-shell-tool-call--pending" data-shell-tool-call-marker="root">
            <span class="ui-shell-tool-call__description">Install project dependencies with pnpm</span>
            <div class="ui-tool-call-card__body">
              <span class="ui-shell-tool-call__token--command">pnpm</span>
              <span class="ui-shell-tool-call__token--whitespace"> </span>
              <span class="ui-shell-tool-call__token--text">i</span>
              <span class="ui-shell-tool-call__allowlist-button-wrapper">
                <button>Always Run 'pnpm'</button>
              </span>
              <button class="ui-shell-tool-call__skip-btn">Skip</button>
              <button class="ui-shell-tool-call__run-btn">Run</button>
            </div>
          </div>
        </div>
      </main>
    `);
    assert.equal(state.pendingApprovals.length, 1, '新版卡片必须被认成待审批');
    // Command comes from concatenating tokens (new layout has no __command block)
    assert.equal(state.pendingApprovals[0].description, 'pnpm i');
    assert.ok(state.pendingApprovals[0].actions.some(a => a.type === 'approve'));
    assert.ok(state.pendingApprovals[0].actions.some(a => a.type === 'reject'));
    // allowlist goes through buttons in the wrapper; must not miss them
    assert.ok(
      state.pendingApprovals[0].actions.some(a => a.label.includes('Always Run')),
      'wrapper 里的 allowlist 按钮要收进来',
    );
    assert.equal(state.agentStatus, 'waiting_approval');
  });

  it('does not miss shell-tool approvals when the auxiliary bar is the empty chrome shell', () => {
    // Cursor's current layout: #workbench.parts.auxiliarybar exists with class
    // `empty` (welcome chrome), while the live agent transcript + Run/Skip card
    // live in div.composer-bar.editor under the embedded editor part.
    const state = withDom(
      `
      <div id="workbench.parts.auxiliarybar" class="part auxiliarybar empty">
        New Agent
      </div>
      <div class="part editor embedded-aux-bar-editor">
        <div class="composer-bar editor">
          <div class="ui-tool-call-card">
            <div class="ui-shell-tool-call__command">git push origin master &amp;&amp; npm run deploy</div>
            <div class="ui-shell-tool-call__approval-row">
              <button class="ui-shell-tool-call__run-btn">Run</button>
              <button class="ui-shell-tool-call__skip-btn">Skip</button>
            </div>
          </div>
        </div>
      </div>
    `,
      [],
      [],
      [],
      getDefaultSelectors().chatContainer.strategies,
    );
    assert.equal(state.pendingApprovals.length, 1);
    assert.equal(state.pendingApprovals[0].description, 'git push origin master && npm run deploy');
    assert.ok(state.pendingApprovals[0].actions.some(a => a.type === 'approve'));
  });

  it('collects a generic non-shell tool approval gate (Run / Always Run / Skip)', () => {
    // 2026-09-16: besides shell commands, Cursor wraps every pending tool call in ToolApprovalGate
    // (root node data-tool-approval-gate). Buttons sit in the transcript with no ui-shell
    // semantic class; old main/fallback paths collected none (MCP calls, write-file, plan confirm, web search…).
    const state = withDom(`
      <main id="root">
        <div data-message-role="ai" data-message-id="m1">
          <div data-tool-call-id="call-mcp-1">
            <div data-tool-approval-gate="">
              <div class="ui-tool-call-card__body">
                <span class="ui-tool-call-line-action">Run MCP tool</span>
                <span class="ui-tool-call-line-details">codegraph_explore</span>
              </div>
              <div class="ui-tool-call-card__footer">
                <button>Always Run</button>
                <button>Run</button>
                <button>Skip</button>
              </div>
            </div>
          </div>
        </div>
      </main>
    `);
    assert.equal(state.pendingApprovals.length, 1);
    assert.equal(state.pendingApprovals[0].id, 'tool:call-mcp-1');
    assert.equal(state.pendingApprovals[0].description, 'Run MCP tool codegraph_explore');
    assert.ok(state.pendingApprovals[0].actions.some(a => a.type === 'approve' && a.label === 'Run'));
    assert.ok(state.pendingApprovals[0].actions.some(a => a.type === 'approve' && a.label === 'Always Run'));
    assert.ok(state.pendingApprovals[0].actions.some(a => a.type === 'reject' && a.label === 'Skip'));
    // The default action must sort before allowlist (web ApprovalCard only renders the first approve)
    assert.equal(state.pendingApprovals[0].actions[0].label, 'Run');
    assert.deepEqual(
      state.pendingApprovals[0].actions.map(a => a.label),
      ['Run', 'Always Run', 'Skip'],
    );
    assert.equal(state.agentStatus, 'waiting_approval');
  });

  it('collects a pending mode-switch card (Switch / Skip) from its title', () => {
    // 2026-09-16 measured: in the "Server code redesign and refactor" session the agent asked to
    // switch to Plan mode. The card is AgentTranscriptSwitchModeCard — no semantic class, only
    // data-switch-mode-accent (icon + label), footer Switch / Skip, plus Always ask/Always run preference dropdowns.
    const state = withDom(`
      <main id="root">
        <div data-message-role="ai" data-message-id="m2">
          <div data-tool-call-id="call-switch-1">
            <div class="ui-some-decision-card">
              <div class="header">
                <span data-switch-mode-accent="icon"></span>
                <span><span>Switch to </span><span data-switch-mode-accent="label">Plan Mode</span><span>?</span></span>
              </div>
              <div class="footer">
                <button>Always ask</button>
                <button>Skip</button>
                <button>Switch⌘⏎</button>
              </div>
            </div>
          </div>
        </div>
      </main>
    `);
    assert.equal(state.pendingApprovals.length, 1);
    assert.equal(state.pendingApprovals[0].id, 'tool:call-switch-1');
    assert.equal(state.pendingApprovals[0].description, 'Switch to Plan Mode');
    assert.ok(state.pendingApprovals[0].actions.some(a => a.type === 'approve' && a.label === 'Switch'));
    assert.ok(state.pendingApprovals[0].actions.some(a => a.type === 'reject' && a.label === 'Skip'));
    // Preference dropdown (Always ask) is not an approval action
    assert.equal(state.pendingApprovals[0].actions.length, 2);
  });

  it('does not emit decision cards that are already resolved', () => {
    const state = withDom(`
      <main id="root">
        <div data-message-role="ai" data-message-id="m3">
          <div data-tool-call-id="call-switch-done">
            <div class="ui-some-decision-card">
              <span><span data-switch-mode-accent="label">Plan Mode</span></span>
            </div>
          </div>
        </div>
        <div data-message-role="ai" data-message-id="m4">
          <div data-tool-call-id="call-gate-reject-only">
            <div data-tool-approval-gate="">
              <button>Skip</button>
            </div>
          </div>
        </div>
      </main>
    `);
    assert.equal(state.pendingApprovals.length, 0);
  });

  it('does not double-count a decision card that is also inside an approval gate', () => {
    const state = withDom(`
      <main id="root">
        <div data-message-role="ai" data-message-id="m5">
          <div data-tool-call-id="call-both-1">
            <div data-tool-approval-gate="">
              <span data-switch-mode-accent="label">Plan Mode</span>
              <button>Run</button>
              <button>Skip</button>
            </div>
          </div>
        </div>
      </main>
    `);
    assert.equal(state.pendingApprovals.length, 1);
    assert.equal(state.pendingApprovals[0].id, 'tool:call-both-1');
  });

  it('still extracts approvals when they live inside a populated auxiliary bar', () => {
    const state = withDom(
      `
      <div id="workbench.parts.auxiliarybar" class="part auxiliarybar">
        <div class="composer-bar editor">
          <div class="ui-tool-call-card">
            <div class="ui-shell-tool-call__command">npm test</div>
            <div class="ui-shell-tool-call__approval-row">
              <button class="ui-shell-tool-call__run-btn">Run</button>
              <button class="ui-shell-tool-call__skip-btn">Skip</button>
            </div>
          </div>
        </div>
      </div>
    `,
      [],
      [],
      [],
      getDefaultSelectors().chatContainer.strategies,
    );
    assert.equal(state.pendingApprovals.length, 1);
    assert.equal(state.pendingApprovals[0].description, 'npm test');
  });
});
