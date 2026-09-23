import type { AgentsWindowDump } from '../packages/agent/src/drivers/cursor/agents-window.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { dumpAgentsWindow, mapAgentsWindowDump } from '../packages/agent/src/drivers/cursor/agents-window.js';

/**
 * Questionnaire in the Agents window (AskQuestion overlay).
 *
 * 2026-09-17 probe (real window + real questionnaire): Agents-window questionnaires are **not** the
 * project-window `.composer-questionnaire-toolbar`; they are the glass kit's `ui-tray`:
 *   - Root carries `glass-questionnaire-tray` (`[class*="..."]` match; hashed classes change);
 *   - One `.ui-tray-step` per question; the current one has `data-active="true"` (several questions on one screen, no paging);
 *   - Options are `button.ui-tray-option`: letter in `.ui-tray-option__badge`, text in
 *     `.ui-tray-option__label`; the freeform row has `data-text-input="true"` (label is the "Other..." placeholder);
 *   - Continue is disabled via a **valueless `data-disabled` attribute** (not `data-disabled="true"`).
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

/** Measured shape (one question + Other + Continue disabled until answered). */
const QUESTIONNAIRE_SINGLE = `
<div class="ui-tray glass-questionnaire-tray" data-visible="true">
  <div data-component="tray-header">
    <div data-component="tray-header-content">
      <div class="ui-text" data-component="tray-header-title">Questions</div>
    </div>
    <div data-component="tray-header-trailing">
      <button data-component="tray-header-action-button" aria-label="Collapse questions"></button>
    </div>
  </div>
  <div class="ui-collapsible-content-view ui-tray__collapsible-scroll-area">
    <div>
      <div class="ui-scroll-area ui-tray__scroll-area">
        <div class="ui-scroll-area__viewport">
          <div class="ui-scroll-area__content">
            <div data-component="tray-body">
              <div data-component="tray-steps-slide">
                <div class="ui-tray-step" role="group" data-component="tray-step" data-active="true">
                  <div class="ui-tray-step__header">
                    <div class="ui-tray-step__title">问卷链路测试：随便选一个</div>
                  </div>
                  <div class="ui-tray-step__options">
                    <button class="ui-tray-option" data-component="tray-option" data-variant="badge">
                      <span class="ui-tray-option__badge">A</span>
                      <span class="ui-text ui-tray-option__label">测试选项 A</span>
                    </button>
                    <button class="ui-tray-option" data-component="tray-option" data-variant="badge" data-selected="true">
                      <span class="ui-tray-option__badge">B</span>
                      <span class="ui-text ui-tray-option__label">测试选项 B</span>
                    </button>
                    <button class="ui-tray-option ui--default-marker" data-component="tray-option" data-text-input="true" data-variant="badge">
                      <span class="ui-tray-option__badge">C</span>
                      <span class="ui-text ui-tray-option__label" data-placeholder="true">Other...</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="ui-tray-footer">
    <span data-measure="true"><button class="ui-button" data-variant="ghost">Skip</button></span>
    <div class="ui-tray-footer__primary" data-measure="true">
      <button class="ui-button" data-disabled="" data-variant="primary">Continue⌘⏎</button>
    </div>
  </div>
</div>`;

/** Multi-question variant: two steps, second active; Continue already enabled (no data-disabled). */
const QUESTIONNAIRE_MULTI = `
<div class="ui-tray glass-questionnaire-tray">
  <div data-component="tray-steps-slide">
    <div class="ui-tray-step" data-component="tray-step">
      <div class="ui-tray-step__title">第一题？</div>
      <div class="ui-tray-step__options">
        <button class="ui-tray-option" data-component="tray-option"><span class="ui-tray-option__badge">A</span><span class="ui-tray-option__label">甲</span></button>
      </div>
    </div>
    <div class="ui-tray-step" data-component="tray-step" data-active="true" data-allow-multiple="true">
      <div class="ui-tray-step__title">第二题？</div>
      <div class="ui-tray-step__options">
        <button class="ui-tray-option" data-component="tray-option" data-selected="true"><span class="ui-tray-option__badge">A</span><span class="ui-tray-option__label">乙</span></button>
      </div>
    </div>
  </div>
  <div class="ui-tray-footer">
    <span><button class="ui-button" data-variant="ghost">Skip</button></span>
    <div class="ui-tray-footer__primary"><button class="ui-button" data-variant="primary">Continue</button></div>
  </div>
</div>`;

describe('dumpAgentsWindow 的问卷抽取（glass ui-tray）', () => {
  it('单题形态：题干 / 选项（含 Other）/ 路径 / Continue 禁用', () => {
    const dump = withDom(QUESTIONNAIRE_SINGLE, () => dumpAgentsWindow());
    const q = dump.questionnaire;
    assert.ok(q, 'questionnaire 应为非 null');
    assert.equal(q.questions.length, 1);
    assert.equal(q.activeIndex, 0);
    assert.equal(q.questions[0].text, '问卷链路测试：随便选一个');
    assert.equal(q.questions[0].isActive, true);
    assert.deepEqual(
      q.questions[0].options.map(o => [o.letter, o.label, o.isFreeform]),
      [
        ['A', '测试选项 A', false],
        ['B', '测试选项 B', false],
        ['C', 'Other', true],
      ],
    );
    // Ground-truth selected state (measured data-selected) and single-select marker (no data-allow-multiple)
    assert.deepEqual(q.questions[0].options.map(o => o.selected), [false, true, false]);
    assert.equal(q.questions[0].multiSelect, false);
    assert.equal(
      q.questions[0].options[0].selectorPath,
      '.glass-questionnaire-tray .ui-tray-step:nth-of-type(1) .ui-tray-option:nth-of-type(1)',
    );
    assert.equal(
      q.questions[0].options[2].selectorPath,
      '.glass-questionnaire-tray .ui-tray-step:nth-of-type(1) .ui-tray-option:nth-of-type(3)',
    );
    assert.equal(q.skipSelectorPath, '.glass-questionnaire-tray .ui-tray-footer button[data-variant="ghost"]');
    assert.equal(q.continueSelectorPath, '.glass-questionnaire-tray .ui-tray-footer__primary > button');
    // A valueless data-disabled attribute still counts as disabled
    assert.equal(q.continueDisabled, true);
    // Button copy follows the IDE and strips shortcut glyphs (that raw text is what the web UI draws)
    assert.equal(q.skipLabel, 'Skip');
    assert.equal(q.continueLabel, 'Continue');
  });

  it('多题形态：activeIndex 落在 data-active 的 step 上；无 data-disabled 则 Continue 可用', () => {
    const dump = withDom(QUESTIONNAIRE_MULTI, () => dumpAgentsWindow());
    const q = dump.questionnaire;
    assert.ok(q);
    assert.equal(q.questions.length, 2);
    assert.equal(q.activeIndex, 1);
    assert.deepEqual(q.questions.map(x => x.text), ['第一题？', '第二题？']);
    assert.equal(q.questions[0].isActive, false);
    assert.equal(q.questions[1].isActive, true);
    assert.equal(
      q.questions[1].options[0].selectorPath,
      '.glass-questionnaire-tray .ui-tray-step:nth-of-type(2) .ui-tray-option:nth-of-type(1)',
    );
    assert.equal(q.continueDisabled, false);
    // Per-question multi-select marker: only a step with data-allow-multiple is multi-select
    assert.equal(q.questions[0].multiSelect, false);
    assert.equal(q.questions[1].multiSelect, true);
    assert.equal(q.questions[1].options[0].selected, true);
  });

  it('问卷带归属会话：主区 composer bar 的 data-composer-id', () => {
    const dom = `<div class="composer-bar editor" data-composer-id="c-own-1"></div>${QUESTIONNAIRE_SINGLE}`;
    const dump = withDom(dom, () => dumpAgentsWindow());
    assert.equal(dump.questionnaire?.composerId, 'c-own-1');
    assert.equal(dump.activeComposerId, 'c-own-1');
  });

  it('没有问卷 → null（窗口被遮挡时就是这种形态）', () => {
    const dump = withDom('<div data-react-transcript-root></div>', () => dumpAgentsWindow());
    assert.equal(dump.questionnaire, null);
  });
});

describe('dumpAgentsWindow 的 inputAvailable 与问卷输入框', () => {
  // 2026-09-17 probe: after Other expands, the input is the same `.ui-prompt-input-editor__input`
  // (tiptap), earlier in DOM order than the composer — must not count it as "composer available".
  it('问卷 tray 里的输入框不算 composer 可用；真 composer 存在才算', () => {
    const onlyTray = `
      <div class="ui-tray glass-questionnaire-tray">
        <div class="tiptap ProseMirror ui-prompt-input-editor__input"></div>
      </div>`;
    assert.equal(withDom(onlyTray, () => dumpAgentsWindow()).inputAvailable, false);

    const withComposer = `
      <div class="ui-tray glass-questionnaire-tray">
        <div class="tiptap ProseMirror ui-prompt-input-editor__input"></div>
      </div>
      <div class="ui-prompt-input">
        <div class="tiptap ProseMirror ui-prompt-input-editor__input"></div>
      </div>`;
    assert.equal(withDom(withComposer, () => dumpAgentsWindow()).inputAvailable, true);
  });
});

describe('mapAgentsWindowDump 的问卷', () => {
  const QUESTION = {
    composerId: 'c1',
    questions: [{ number: '1', text: 'X?', options: [], isActive: true }],
    activeIndex: 0,
    totalLabel: '',
    skipSelectorPath: 's',
    continueSelectorPath: 'c',
    continueDisabled: false,
  };
  const base: AgentsWindowDump = {
    sections: [],
    activeComposerId: 'c1',
    composerStatus: 'completed',
    inputAvailable: true,
    approvals: [],
    questionnaire: QUESTION,
  };

  it('有问卷就透传进 live state（含归属会话）', () => {
    const mapped = mapAgentsWindowDump(base, { resolveIds: false });
    assert.equal(mapped.questionnaire?.questions[0].text, 'X?');
    assert.equal(mapped.questionnaire?.composerId, 'c1');
  });

  it('云 agent：问卷一起丢掉（同「看不见不决策」）', () => {
    const mapped = mapAgentsWindowDump(
      { ...base, activeComposerId: 'bc-29ffb1e4-699a-4b49-ad23-cda97b252d03' },
      { resolveIds: false },
    );
    assert.equal(mapped.questionnaire, null);
  });

  it('补抽取前的老 dump（没带字段）→ 输出 null，不炸', () => {
    const legacy = { ...base } as Partial<AgentsWindowDump>;
    delete legacy.questionnaire;
    const mapped = mapAgentsWindowDump(legacy as AgentsWindowDump, { resolveIds: false });
    assert.equal(mapped.questionnaire, null);
  });
});
