import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { dumpAgentsWindow } from '../packages/agent/src/drivers/cursor/agents-window.js';

/**
 * Pending-decision card extraction (2026-09-17 measured shape):
 *   - The mode-switch card has no semantic class, only `data-switch-mode-accent` (icon + label, two places);
 *     buttons live in the card footer, copy carries a shortcut glyph (`Switch⌘⏎`);
 *   - Stripping only trailing ⌘⌃⌥⇧ is not enough — ⏎ comes last, so you are left with `Switch⌘` which never matches;
 *   - selectorPath must carry a stable anchor (`[data-message-id]`): portal-rendered buttons with a
 *     `div:nth-child(1) > …` path hit some other element (click returns ok but the card does nothing).
 */

function withDom<T>(html: string, fn: () => T): T {
  const dom = new JSDOM(html);
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  try {
    return fn();
  }
  finally {
    if (documentDescriptor)
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    else delete (globalThis as { document?: unknown }).document;
  }
}

const SWITCH_CARD = `
<div data-react-transcript-root>
  <div data-message-id="m-1" data-tool-call-id="t-1">
    <div>
      <div>
        <span data-switch-mode-accent="icon"></span>
        <span data-switch-mode-accent="label">Plan Mode</span>
        <div class="card-body">Switch to Plan Mode? User requested switching the current session to Plan mode.</div>
        <div class="card-footer" data-component="card-footer">
          <button data-variant="text">Always ask</button>
          <button data-variant="text">Skip</button>
          <button data-variant="primary">Switch⌘⏎</button>
        </div>
      </div>
    </div>
  </div>
</div>`;

const GATE_CARD = `
<div data-react-transcript-root>
  <div data-message-id="m-2" data-tool-call-id="t-2">
    <div data-tool-approval-gate="">
      <div class="ui-shell-tool-call__command">rm -f /tmp/x.txt</div>
      <button class="ui-shell-tool-call__run-btn">Run ⌘⏎</button>
      <button class="ui-shell-tool-call__allowlist-button">Always Run 'rm' ⇧⌘⏎</button>
      <button class="ui-shell-tool-call__skip-btn">Skip</button>
    </div>
  </div>
</div>`;

describe('dumpAgentsWindow 的待决策卡', () => {
  it('从 data-switch-mode-accent 找到模式切换卡，并剥掉快捷键角标', () => {
    const dump = withDom(SWITCH_CARD, () => dumpAgentsWindow());
    assert.equal(dump.approvals.length, 1);
    const actions = dump.approvals[0].actions;
    assert.deepEqual(
      actions.map(a => [a.label, a.type]),
      [['Switch', 'approve'], ['Skip', 'reject']],
    );
    // "Always ask" is a preference dropdown, not an action
    assert.equal(actions.some(a => /always ask/i.test(a.label)), false);
    // The path must be anchored on the transcript row (otherwise some other element is clicked)
    assert.match(actions[0].selectorPath, /^\[data-message-id="m-1"\]/);
    assert.equal(dump.approvals[0].description.includes('Switch to Plan Mode?'), true);
  });

  it('工具审批门：Run / Always Run / Skip，默认动作排前', () => {
    const dump = withDom(GATE_CARD, () => dumpAgentsWindow());
    assert.equal(dump.approvals.length, 1);
    assert.deepEqual(
      dump.approvals[0].actions.map(a => [a.label, a.type]),
      [['Run', 'approve'], ['Always Run \'rm\'', 'approve_all'], ['Skip', 'reject']],
    );
    assert.match(dump.approvals[0].actions[0].selectorPath, /^\[data-message-id="m-2"\]/);
  });

  it('已决卡（没有可放行动作）不算待审批', () => {
    const decided = `
      <div data-message-id="m-3">
        <span data-switch-mode-accent="label">Plan Mode</span>
        <div class="card-footer"><button>Skip</button></div>
      </div>`;
    const dump = withDom(decided, () => dumpAgentsWindow());
    assert.deepEqual(dump.approvals, []);
  });

  it('没有卡时 approvals 为空，且输入框只看 composer（不认转录气泡）', () => {
    const noCards = `
      <div data-react-transcript-root>
        <div data-message-id="m-4">
          <div class="ui-prompt-input-editor__input ui-prompt-input-tiptap-readonly__content">转录气泡</div>
        </div>
      </div>
      <div class="ui-prompt-input">
        <div class="tiptap ProseMirror ui-prompt-input-editor__input" contenteditable="true"></div>
      </div>`;
    const dump = withDom(noCards, () => dumpAgentsWindow());
    assert.deepEqual(dump.approvals, []);
    assert.equal(dump.inputAvailable, true);
  });
});

/**
 * Shell-command approval card (missed in the 2026-09-17 probe):
 *   this Agents-window path used to only recognize `[data-tool-approval-gate]` and `data-switch-mode-accent`,
 *   while a pending shell approval is `.ui-shell-tool-call--pending` (neither semantic marker) → approvals always empty,
 *   so cards like "`npx tsc --noEmit` is not on the allowlist" were invisible on webx.
 * Below pins the real measured shape (tokens split into command / whitespace / text).
 */
const SHELL_CARD = `
<div data-react-transcript-root>
  <div data-message-id="m-5" data-tool-call-id="call-9b7ae174">
    <div class="ui-shell-tool-call ui-1k57tk5 ui-shell-tool-call--pending">
      <span class="ui-shell-tool-call__description">Typecheck the project</span>
      <div class="ui-shell-tool-call__summary">
        <span class="ui-shell-tool-call__token--command">npx</span>
        <span class="ui-shell-tool-call__token--whitespace"> </span>
        <span class="ui-shell-tool-call__token--text">tsc</span>
        <span class="ui-shell-tool-call__token--whitespace"> </span>
        <span class="ui-shell-tool-call__token--text">--noEmit</span>
      </div>
      <div class="ui-shell-tool-call__footer">
        <button class="ui-shell-tool-call__skip-btn">Skip</button>
        <span class="ui-shell-tool-call__allowlist-button-wrapper">
          <button>Always Run⇧⏎</button>
        </span>
        <button class="ui-shell-tool-call__run-btn">Run⏎</button>
      </div>
    </div>
  </div>
</div>`;

describe('dumpAgentsWindow 的 shell 待审批卡', () => {
  it('抽出 Run / Always Run / Skip，命令行当描述，selectorPath 能命中按钮', () => {
    const dom = new JSDOM(SHELL_CARD);
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    try {
      const dump = dumpAgentsWindow();
      assert.equal(dump.approvals.length, 1);
      assert.deepEqual(
        dump.approvals[0].actions.map(a => [a.label, a.type]),
        [['Run', 'approve'], ['Always Run', 'approve_all'], ['Skip', 'reject']],
      );
      // Description is the command line (joined tokens), not the whole card copy — the latter would include button labels
      assert.equal(dump.approvals[0].description, 'npx tsc --noEmit');
      // The path must be anchored on the transcript row and actually hit the matching button (that is what the web client clicks)
      for (const action of dump.approvals[0].actions) {
        assert.match(action.selectorPath, /^\[data-message-id="m-5"\]/);
        const el = dom.window.document.querySelector(action.selectorPath);
        assert.ok(el, `selectorPath 未命中：${action.selectorPath}`);
        assert.equal(el.textContent?.includes(action.label), true);
      }
    }
    finally {
      if (documentDescriptor)
        Object.defineProperty(globalThis, 'document', documentDescriptor);
      else delete (globalThis as { document?: unknown }).document;
    }
  });

  it('嵌套卡只算一条（.ui-tool-call-card 包住 shell 行）', () => {
    const nested = `
      <div data-message-id="m-6">
        <div class="ui-tool-call-card">
          <div class="ui-shell-tool-call ui-shell-tool-call--pending">
            <span class="ui-shell-tool-call__description">Typecheck the project</span>
            <button class="ui-shell-tool-call__run-btn">Run</button>
            <button class="ui-shell-tool-call__skip-btn">Skip</button>
          </div>
        </div>
      </div>`;
    const dump = withDom(nested, () => dumpAgentsWindow());
    assert.equal(dump.approvals.length, 1);
    assert.deepEqual(dump.approvals[0].actions.map(a => a.type), ['approve', 'reject']);
    assert.equal(dump.approvals[0].description, 'Typecheck the project');
  });

  it('菜单触发器（aria-haspopup）不算动作，Run 必须排在第一个 approve', () => {
    // 2026-09-17 measured footer: two aria-haspopup="menu" buttons on the same row;
    // "Autorun mode: Allowlist" matches the allow… prefix and steals the slot in front of Run
    // (web ApprovalCard only draws the first approve → the primary button becomes an unclickable Allowlist).
    const live = `
      <div data-message-id="m-8">
        <div class="ui-shell-tool-call ui-1k57tk5 ui-shell-tool-call--pending">
          <div class="ui-shell-tool-call__summary">
            <span class="ui-shell-tool-call__token--command">npx</span>
            <span class="ui-shell-tool-call__token--whitespace"> </span>
            <span class="ui-shell-tool-call__token--text">tsc</span>
          </div>
          <button class="ui-button" data-variant="ghost" aria-label="Shell command options" aria-haspopup="menu"></button>
          <button class="ui-button" data-variant="text" aria-label="Autorun mode: Allowlist" aria-haspopup="menu">Allowlist</button>
          <button class="ui-button ui-shell-tool-call__skip-btn" data-variant="text">Skip</button>
          <button class="ui-button" data-variant="secondary">Always Run⇧⏎</button>
          <button class="ui-button ui-shell-tool-call__run-btn" data-variant="primary">Run⏎</button>
        </div>
      </div>`;
    const dump = withDom(live, () => dumpAgentsWindow());
    assert.equal(dump.approvals.length, 1);
    assert.deepEqual(
      dump.approvals[0].actions.map(a => [a.label, a.type]),
      [['Run', 'approve'], ['Always Run', 'approve_all'], ['Skip', 'reject']],
    );
    assert.equal(dump.approvals[0].actions.some(a => /allowlist/i.test(a.label)), false);
    assert.equal(dump.approvals[0].description, 'npx tsc');
  });

  it('已决的 shell 卡（只剩 Skip）不算待审批', () => {
    const decidedShell = `
      <div data-message-id="m-7">
        <div class="ui-shell-tool-call ui-shell-tool-call--pending">
          <span class="ui-shell-tool-call__description">Typecheck the project</span>
          <button class="ui-shell-tool-call__skip-btn">Skip</button>
        </div>
      </div>`;
    const dump = withDom(decidedShell, () => dumpAgentsWindow());
    assert.deepEqual(dump.approvals, []);
  });
});
