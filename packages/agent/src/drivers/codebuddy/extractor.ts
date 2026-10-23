import type { CdpClient } from '../../cdp/client.js';
import type { AgentStatus, CursorState } from '../../types.js';
import type { CodeBuddyLiveDump } from './live.js';
import { timingLog } from '../../timing-log.js';
import { emptyCursorState } from '../../types.js';
import { mapCodeBuddyLive } from './live.js';

const EVALUATE_TIMEOUT_MS = 12000;
const MAX_POLL_BACKOFF_MS = 5000;

/** Enter the inner agent iframe when evaluating on the coding-copilot webview. */
export const CODEBUDDY_FRAME_JS = `
  const shell = document.getElementById('active-frame');
  let root = document;
  try { const cd = shell && shell.contentDocument; if (cd && cd.body) root = cd; } catch (e) {}
`;

/**
 * Pending-decision surfaces.
 *
 * `.tool-menu .menu-item` is the one that matters: CodeBuddy CN 2026-09 renders
 * a shell command's Run / Skip / Reject actions there while the decision is
 * pending (verified live, see `dumpCodeBuddyLive`).
 *
 * `.card-buttons` is deliberately absent — it only ever holds the "Ask Each
 * Time" mode chooser and the "Run in Background" escape hatch, so treating it
 * as an approval source produced a phantom "Run in Background" entry.
 */
/**
 * Composer model popover (verified live on CodeBuddy CN 2026-09).
 *
 * The row's own textContent glues badges and pricing onto the name
 * ("Deepseek-V4.1-FlashHigh错峰使用0.11x"), so labels must come from the nested
 * `modelName` node. Group headers use `groupLabel`, not `modelItem`, so the row
 * selector already excludes them.
 */
export const CODEBUDDY_MODEL_TRIGGER_SEL = '[class*="model-select-module_trigger"]';
export const CODEBUDDY_MODEL_ITEM_SEL = '[class*="model-select-module_modelItem"]';
export const CODEBUDDY_MODEL_NAME_SEL = '[class*="model-select-module_modelName"]';

/** Inject after CODEBUDDY_FRAME_JS inside an evaluate; call collectCodeBuddyModels(). */
export const CODEBUDDY_MODEL_ROWS_JS = `
  const collectCodeBuddyModels = () => {
    const seen = new Set();
    const out = [];
    for (const row of Array.from(root.querySelectorAll(${JSON.stringify(CODEBUDDY_MODEL_ITEM_SEL)}))) {
      const nameEl = row.querySelector(${JSON.stringify(CODEBUDDY_MODEL_NAME_SEL)});
      const label = ((nameEl || row).textContent || '').replace(/\\s+/g, ' ').trim();
      if (!label || seen.has(label)) continue;
      seen.add(label);
      out.push({ id: label, label });
    }
    return out;
  };
`;

/**
 * Click the model row by name. The row (not the inner span) owns the React
 * onClick, so the click must land on it.
 */
export function codebuddyClickModelExpression(modelName: string): string {
  return `(() => {
    ${CODEBUDDY_FRAME_JS}
    const want = ${JSON.stringify(modelName)}.trim().toLowerCase();
    for (const row of Array.from(root.querySelectorAll(${JSON.stringify(CODEBUDDY_MODEL_ITEM_SEL)}))) {
      const nameEl = row.querySelector(${JSON.stringify(CODEBUDDY_MODEL_NAME_SEL)});
      const label = ((nameEl || row).textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      if (label === want || label.startsWith(want)) {
        row.click();
        return { ok: true };
      }
    }
    return { ok: false, error: 'Model row not found' };
  })()`;
}

export interface CodingCopilotTargetFields {
  url: string;
  webSocketDebuggerUrl?: string;
  id?: string;
  parentId?: string;
  openerId?: string;
  browserContextId?: string;
  title?: string;
}

export interface CodingCopilotPickHint {
  /** Workbench page id to bind the webview to. */
  workbenchId?: string;
  /** Other-window polls must not fall back to the first coding-copilot panel. */
  requireUnique?: boolean;
}

/**
 * Pick the coding-copilot webview for one workbench.
 *
 * Heuristic, in order (Electron `/json` often omits parent links):
 * 1. `parentId` or `openerId` equals the active workbench id
 * 2. same `browserContextId` as that workbench target
 * 3. first coding-copilot target with a websocket (single-window fallback)
 */
export function pickCodingCopilotTarget<T extends CodingCopilotTargetFields>(
  targets: T[],
  hint?: CodingCopilotPickHint,
): T | undefined {
  const panels = targets.filter(t => t.url.includes('coding-copilot') && Boolean(t.webSocketDebuggerUrl));
  if (panels.length === 0)
    return undefined;
  const workbenchId = hint?.workbenchId;
  if (!workbenchId)
    return panels[0];

  const byParent = panels.find(t => t.parentId === workbenchId || t.openerId === workbenchId);
  if (byParent)
    return byParent;

  const workbench = targets.find(t => t.id === workbenchId);
  const ctx = workbench?.browserContextId;
  if (ctx) {
    const byCtx = panels.find(t => t.browserContextId === ctx);
    if (byCtx)
      return byCtx;
  }
  if (hint?.requireUnique)
    return undefined;
  return panels[0];
}

export function codebuddyClickExpression(path: string): string {
  return `(() => {
    ${CODEBUDDY_FRAME_JS}
    const el = root.querySelector(${JSON.stringify(path)});
    if (!el) return { ok: false, error: 'Element not found' };
    el.click();
    return { ok: true };
  })()`;
}

/**
 * Marker of a **single-question** questionnaire option row (`question-floating-module_optionItem_`), vs multi mode's `..._option_`.
 *
 * ⚠️ Keep this as a *duplicate* of the literal inside `dumpCodeBuddyLive`, never a dedupe:
 * that function is serialized into the page with `fn.toString()` (see its own doc), so a reference
 * to this const would be a page-side ReferenceError while tests (in-process) stay green.
 */
export const CODEBUDDY_SINGLE_OPTION_MARK = 'question-floating-module_optionItem_';

/**
 * Click one option of a **single-question** questionnaire (single mode).
 *
 * Measured live 2026-10-05 (CodeBuddy CN 1.106.1, probe over CDP on the coding-copilot webview):
 * one `click()` only paints `selected_` — nothing is submitted. The IDE's own
 * `question-floating.react` does `onOptionSelect(v); setTimeout(() => onSubmit(), 0)`, and that
 * `onSubmit` closes over the **previous** `selectedAnswer` state: on the first click it is still
 * empty (`if (!w) return`), so the submit is skipped; the *next* click submits `w`, i.e. the option
 * selected by the **previous** click — click A then B and the answer on the wire is A.
 *
 * So a single option row needs the two clicks a human ends up doing, but packed correctly:
 *   1. click → wait for `selected_` on that very row (React's re-render, so the IDE state now holds it);
 *   2. click again → `onSubmit` now closes over this option and submits **it**.
 * If the row is already `selected_` before we click, one click is enough (that click is the submit) —
 * click twice there would only risk a double submit on a fixed IDE. The same guard runs after the
 * second click: the questionnaire root unmounting means the answer is in, stop.
 *
 * Only for single mode. Multi mode's `option_` rows are toggles (`answers.includes(x) ? remove : add`)
 * and multi-select questions would be *un*selected by a second click — never route them here.
 *
 * Entry when the overlay is already gone (answered by an earlier click / dismissed / collapsed — the
 * extractor treats collapsed as "no questionnaire"): report `ok` instead of `Element not found`.
 * The select-then-confirm round trip takes ~1s, so a user tapping a *second* option inside that window
 * would otherwise get a scary "选项没点上" for a question that is in fact already answered (the card
 * unmounts on the next extract). A row that is missing while the overlay is still open stays an error.
 */
export function codebuddySingleOptionClickExpression(path: string): string {
  return `(async () => {
    ${CODEBUDDY_FRAME_JS}
    const SELECTED = 'question-floating-module_selected_';
    const ROOT_SEL = '[class*="question-floating-module_singleQuestion_"]';
    const FLOATING_SEL = '[class*="question-floating-module_questionFloating_"]';
    const COLLAPSED = 'question-floating-module_collapsed_';
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const isSelected = (el) => !!el && typeof el.className === 'string' && el.className.includes(SELECTED);
    const alive = () => !!root.querySelector(FLOATING_SEL) && !!root.querySelector(${JSON.stringify(path)});
    const first = root.querySelector(${JSON.stringify(path)});
    if (!first) {
      const qRoot = root.querySelector(FLOATING_SEL);
      if (!qRoot) return { ok: true, via: 'questionnaire-gone' };
      if (typeof qRoot.className === 'string' && qRoot.className.includes(COLLAPSED))
        return { ok: true, via: 'questionnaire-collapsed' };
      return { ok: false, error: 'Element not found' };
    }
    if (!first.closest(ROOT_SEL)) return { ok: false, error: 'Not a single-question option' };
    const alreadySelected = isSelected(first);
    first.click();
    if (alreadySelected) {
      // The click was the submit (the IDE submits the answer already held in its state).
      for (let i = 0; i < 24 && alive(); i++) await sleep(25);
      return { ok: true, via: 'single-submit' };
    }
    // Wait for React to paint the selection — the next click must read it as the "previous" answer.
    let landed = null;
    for (let i = 0; i < 32; i++) {
      landed = root.querySelector(${JSON.stringify(path)});
      if (!landed || isSelected(landed)) break;
      await sleep(25);
    }
    if (!alive()) return { ok: true, via: 'single-submitted' };
    if (!isSelected(landed)) return { ok: true, via: 'single-select-unconfirmed' };
    // Grace beat: a fixed IDE that submits on the first click would drop the overlay here.
    await sleep(120);
    const again = root.querySelector(${JSON.stringify(path)});
    if (!again || !alive()) return { ok: true, via: 'single-submitted' };
    again.click();
    for (let i = 0; i < 40 && alive(); i++) await sleep(25);
    return { ok: true, via: 'single-confirm' };
  })()`;
}

/**
 * Click a row by value. When kind = 'tab', `value` may be a session id
 * (data-session-tab-id, **preferred, exact**) or a title (exact → prefix
 * fallback). Session switches should pass an id: the sidebar can have
 * same-title sessions, and title-click only hits the first.
 */
export function codebuddyClickByValueExpression(kind: 'tab' | 'mode' | 'model' | 'new_chat', value: string): string {
  return `(() => {
    ${CODEBUDDY_FRAME_JS}
    const want = ${JSON.stringify(value)}.trim().toLowerCase();
    function textOf(el) {
      return (el && (el.textContent || el.getAttribute('aria-label') || '') || '').replace(/\\s+/g, ' ').trim();
    }
    function click(el) {
      if (!el) return { ok: false, error: 'Element not found' };
      el.click();
      return { ok: true };
    }
    const kind = ${JSON.stringify(kind)};
    if (kind === 'tab') {
      const tabs = Array.from(root.querySelectorAll('.session-tab'));
      const hit = tabs.find((t) => {
        const id = (t.getAttribute('data-session-tab-id') || '').toLowerCase();
        const title = textOf(t.querySelector('.session-tab-name') || t).toLowerCase();
        return id === want || title === want || title.startsWith(want) || want.startsWith(title);
      });
      return click(hit);
    }
    if (kind === 'mode') {
      const items = Array.from(root.querySelectorAll('[class*="mode-selector-dropdown-module_item"]'));
      const hit = items.find((el) => {
        const t = textOf(el).toLowerCase();
        return t === want || t.startsWith(want) || want.startsWith(t) || t.includes(want);
      });
      return click(hit);
    }
    if (kind === 'model') {
      const items = Array.from(root.querySelectorAll(
        '[class*="model-select"] [class*="item"], [class*="model-dropdown"] [class*="item"], [role="menuitem"], [role="option"]'
      ));
      const hit = items.find((el) => {
        const t = textOf(el).toLowerCase();
        return t === want || t.startsWith(want) || want.startsWith(t) || t.includes(want);
      });
      return click(hit);
    }
    const newChatSelectors = [
      '[class*="session-tab-add"]',
      '[class*="new-chat"]',
      '[class*="new-session"]',
      '[aria-label="New Chat"]',
      '[aria-label="New chat"]',
      '[aria-label="新建会话"]',
      '[aria-label="新建对话"]',
      '[title="New Chat"]',
    ];
    for (const sel of newChatSelectors) {
      try {
        const el = root.querySelector(sel);
        if (el) { el.click(); return { ok: true }; }
      } catch (e) {}
    }
    return { ok: false, error: 'New Chat button not found' };
  })()`;
}

/**
 * Runs inside the coding-copilot webview via Runtime.evaluate.
 * Must be self-contained (serialized with fn.toString). Live widgets only.
 */
export function dumpCodeBuddyLive(): CodeBuddyLiveDump | null {
  try {
    const shell = document.getElementById('active-frame');
    let root: Document = document;
    try {
      const cd = (shell as HTMLIFrameElement | null)?.contentDocument;
      if (cd && cd.body)
        root = cd;
    }
    catch { /* stay on document */ }

    function textOf(el: Element | null): string {
      return (el?.textContent || el?.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    }

    function buildSelectorPath(el: Element): string {
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur !== document.body && parts.length < 8) {
        let seg = cur.tagName.toLowerCase();
        if (cur.id) {
          seg += `#${cur.id.replace(/([.:])/g, '\\$1')}`;
          parts.unshift(seg);
          break;
        }
        const raw = typeof cur.className === 'string' ? cur.className : '';
        const cls = raw.trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) {
          const esc = typeof CSS !== 'undefined' && CSS.escape
            ? CSS.escape
            : (c: string) => c.replace(/([^\w-])/g, '\\$1');
          seg += `.${cls.map(c => esc(c)).join('.')}`;
        }
        const parent: Element | null = cur.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(c => c.tagName === cur!.tagName);
          if (siblings.length > 1) {
            seg += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
          }
        }
        parts.unshift(seg);
        cur = parent;
      }
      return parts.join(' > ');
    }

    const input = root.querySelector(
      '[class*="chat-input-module_container"] [data-slate-editor="true"]',
    ) || root.querySelector('[data-slate-editor="true"]');

    // --- Pending approvals ------------------------------------------------
    //
    // Verified live against CodeBuddy CN 2026-09 (CDP 9223). A shell command
    // waiting for a decision renders its actions in the transcript card's
    // bottom menu, not as loose buttons:
    //
    //   div.assistant-message-tool.execute-command
    //     div.tool-inner.border.tool-status-pending
    //       div.card-bottom
    //         div.tool-menu                       ← exists only while pending
    //           div.menu-title                    "Run Command?"
    //                                             | "Contains dangerous command, run anyway?"
    //           div.menu-content
    //             div.menu-item  Run / Skip / Reject
    //
    // So one card = one approval carrying three actions, not three approvals.
    // `.card-buttons` is skipped on purpose: it holds only "Ask Each Time" and
    // "Run in Background".
    const pendingApprovals: CodeBuddyLiveDump['pendingApprovals'] = [];
    const seenApprovalCards = new Set<Element>();
    for (const menu of Array.from(root.querySelectorAll('.tool-menu'))) {
      const card = menu.closest('.assistant-message-tool');
      if (!card || seenApprovalCards.has(card))
        continue;
      const items = Array.from(menu.querySelectorAll('.menu-item'));
      if (items.length === 0)
        continue;
      seenApprovalCards.add(card);

      const actions = items.map((item) => {
        const label = textOf(item);
        const type: 'approve' | 'reject' = /^(run|运行|allow|允许|accept|接受)$/i.test(label)
          ? 'approve'
          : 'reject';
        return { label, type, selectorPath: buildSelectorPath(item) };
      });
      // Read the description from the header only. Verified live: the danger
      // menu's settings gear renders a Tooltip that leaves a stale
      // `.command-text` node (holding a PREVIOUS command) inside
      // `.menu-title-settings`, so an unscoped `.command-text` query can pick
      // up the wrong command.
      //
      // CommandTitle renders `.command-text`, or `.command-text-expanded` once
      // the result is expanded (defaultShowResult=true for execute-command, so
      // the expanded form is the common one). Non-shell cards (file writes,
      // deletes, ...) have no command text, so fall back to the header itself.
      const headerEl = card.querySelector('.card-header');
      const commandEl = headerEl?.querySelector('.command-text, .command-text-expanded')
        || headerEl?.querySelector('.card-header-top .left')
        || headerEl;
      const menuTitleEl = menu.querySelector('.menu-title-danger-text')
        || menu.querySelector('.menu-title');
      const description = textOf(commandEl)
        || textOf(menuTitleEl)
        || 'Pending approval';
      const approvePath = actions.find(a => a.type === 'approve')?.selectorPath ?? actions[0].selectorPath;
      pendingApprovals.push({
        id: `tool:${description.slice(0, 120)}`,
        selectorPath: approvePath,
        description,
        actions,
      });
    }

    // Floating / modal confirmations that are not transcript cards. Each is a
    // single button, so they keep the one-approval-per-button shape.
    const flatApprovalSel = [
      '[class*="execute-command-compact__btn--allow"]',
      '[class*="execute-command-compact__btn--deny"]',
      '[class*="roots-confirm-card__actions"] button',
      '[class*="checkpoint-confirm-dialog"] button',
      '[class*="high-credit-approval-floating-module_confirm"]',
      '[class*="high-credit-approval-floating-module_reject"]',
    ].join(',');
    Array.from(root.querySelectorAll(flatApprovalSel)).forEach((el, i) => {
      const cls = typeof el.className === 'string' ? el.className : '';
      const isDeny = /deny|reject/.test(cls) || /deny|reject|取消|拒绝/.test(textOf(el).toLowerCase());
      pendingApprovals.push({
        id: el.id || `approval-${i}`,
        selectorPath: buildSelectorPath(el),
        description: textOf(el) || (isDeny ? 'Deny' : 'Allow'),
        isDeny,
      });
    });

    // Session tabs: both sidebar row data and the source of "which session
    // owns the questionnaire" (the overlay hangs on the current composer).
    // Extract before the questionnaire block so the questionnaire can see activeTab.
    const chatTabs = Array.from(root.querySelectorAll('.session-tab')).map((el) => {
      const id = el.getAttribute('data-session-tab-id') || '';
      const titleEl = el.querySelector('.session-tab-name');
      const isActive = el.classList.contains('session-tab-active')
        || el.getAttribute('aria-selected') === 'true';
      return {
        id,
        title: textOf(titleEl || el),
        isActive,
        // Row-level "running": generating session tabs have agent-state-spinner (spinning)
        running: el.querySelector('.agent-state-spinner') !== null,
        // Row-level "needs attention": awaiting confirm (approval / questionnaire) tabs have agent-state-question (question mark)
        needsAttention: el.querySelector('.agent-state-question') !== null,
        // Row-level "finished, result not yet seen": terminal unread session
        // tabs have a small dot (agent-state-dot). Same origin as the two
        // above: genie's AgentStateIndicator: error > question > spinner > dot.
        unread: el.querySelector('.agent-state-dot') !== null,
        selectorPath: buildSelectorPath(el),
      };
    });

    const activeTab = chatTabs.find(t => t.isActive);

    // --- Questionnaire (AskQuestion overlay) --------------------------------
    //
    // Structure checked against CodeBuddy's own bundle source
    // (question-floating.react.js + CSS Modules):
    //   Root `question-floating-module_questionFloating_<hash>`; CSS Modules
    //   hashes change, so always prefix-match with `[class*="..."]`, **and
    //   keep the trailing underscore on the prefix** (`option_` / `optionItem_`
    //   written separately) so option / optionItem / options do not collide;
    //   when collapsed the content is not rendered at all (React conditional)
    //   — treat as no questionnaire.
    //   · single mode (one question, not multi-select): singleQuestion →
    //     questionText + optionItem (optionLetter / optionText / `selected_`
    //     class) + customInputRow (Other, input.customInput);
    //     **clicking an option submits; no footer** (Skip / Continue paths empty).
    //   · multi mode (several questions or one multi-select): multiQuestion →
    //     questionBlock × N (questionNumber / questionText / `multiBadge_`=
    //     multi-select / option rows) + footer (skipBtn / continueBtn;
    //     continue with `disabled_` class = unanswered questions remain).
    // ⚠️ Live trigger on this machine collided with the user using CodeBuddy
    //    (cannot send a test message into an active session), so this block
    //    follows the bundle structure and is **pending live verification**:
    //    when a real questionnaire appears, run
    //    `scripts/probes/probe-live-extract.ts` and inspect the questionnaire
    //    field in the dump.
    const hasQClass = (el: Element | null, marker: string): boolean =>
      !!el && typeof el.className === 'string' && el.className.includes(marker);
    const nthOfTypeOf = (el: Element): number => {
      const parent = el.parentElement;
      if (!parent)
        return 1;
      const sameTag = Array.from(parent.children).filter(c => c.tagName === el.tagName);
      return sameTag.indexOf(el) + 1;
    };
    let questionnaire: CodeBuddyLiveDump['questionnaire'] = null;
    const qRoot = root.querySelector('[class*="question-floating-module_questionFloating_"]');
    if (qRoot && !hasQClass(qRoot, 'question-floating-module_collapsed_')) {
      type QOptions = NonNullable<CodeBuddyLiveDump['questionnaire']>['questions'][number]['options'];
      const questions: NonNullable<CodeBuddyLiveDump['questionnaire']>['questions'] = [];
      const single = qRoot.querySelector('[class*="question-floating-module_singleQuestion_"]');
      const multi = qRoot.querySelector('[class*="question-floating-module_multiQuestion_"]');
      if (single) {
        const options: QOptions = [];
        for (const el of Array.from(single.querySelectorAll('[class*="question-floating-module_optionItem_"]'))) {
          options.push({
            letter: textOf(el.querySelector('[class*="question-floating-module_optionLetter_"]')),
            label: textOf(el.querySelector('[class*="question-floating-module_optionText_"]')),
            isFreeform: false,
            selected: hasQClass(el, 'question-floating-module_selected_'),
            selectorPath:
              `[class*="question-floating-module_singleQuestion_"]`
              + ` [class*="question-floating-module_optionItem_"]:nth-of-type(${nthOfTypeOf(el)})`,
          });
        }
        const customRow = single.querySelector('[class*="question-floating-module_customInputRow_"]');
        if (customRow) {
          options.push({
            letter: String.fromCharCode(65 + options.length),
            label: 'Other',
            isFreeform: true,
            selected: hasQClass(customRow, 'question-floating-module_selected_'),
            selectorPath: '[class*="question-floating-module_singleQuestion_"] [class*="question-floating-module_customInputRow_"]',
          });
        }
        questions.push({
          number: '1',
          text: textOf(single.querySelector('[class*="question-floating-module_questionText_"]')),
          options,
          isActive: true,
          multiSelect: false,
        });
      }
      else if (multi) {
        const blocks = Array.from(multi.querySelectorAll('[class*="question-floating-module_questionBlock_"]'));
        for (let bi = 0; bi < blocks.length; bi++) {
          const block = blocks[bi];
          const options: QOptions = [];
          for (const el of Array.from(block.querySelectorAll('[class*="question-floating-module_option_"]'))) {
            options.push({
              letter: textOf(el.querySelector('[class*="question-floating-module_optionLetter_"]')),
              label: textOf(el.querySelector('[class*="question-floating-module_optionText_"]')),
              isFreeform: false,
              selected: hasQClass(el, 'question-floating-module_selected_'),
              selectorPath:
                `[class*="question-floating-module_questionBlock_"]:nth-of-type(${nthOfTypeOf(block)})`
                + ` [class*="question-floating-module_option_"]:nth-of-type(${nthOfTypeOf(el)})`,
            });
          }
          const customRow = block.querySelector('[class*="question-floating-module_customInputRow_"]');
          if (customRow) {
            options.push({
              letter: String.fromCharCode(65 + options.length),
              label: 'Other',
              isFreeform: true,
              selected: hasQClass(customRow, 'question-floating-module_selected_'),
              selectorPath:
                `[class*="question-floating-module_questionBlock_"]:nth-of-type(${nthOfTypeOf(block)})`
                + ` [class*="question-floating-module_customInputRow_"]`,
            });
          }
          const rawNumber = textOf(block.querySelector('[class*="question-floating-module_questionNumber_"]'));
          questions.push({
            number: (rawNumber || String(bi + 1)).replace(/[.．、]\s*$/, '') || String(bi + 1),
            text: textOf(block.querySelector('[class*="question-floating-module_questionText_"]')),
            options,
            isActive: bi === 0,
            // "Multi-select" badge only renders on multiSelect questions (confirmed in JSX)
            multiSelect: !!block.querySelector('[class*="question-floating-module_multiBadge_"]'),
          });
        }
      }
      if (questions.length > 0) {
        const skipBtn = qRoot.querySelector('[class*="question-floating-module_skipBtn_"]');
        const continueBtn = qRoot.querySelector('[class*="question-floating-module_continueBtn_"]');
        // Button copy is IDE truth: CodeBuddy's primary is **Complete**
        // (bundle `questionFloating.complete`, with a ⏎ icon on the right),
        // unlike Cursor's Continue. Strip shortcut glyphs (⏎ may be an icon
        // or text); the web copies this label as-is.
        const actionTextOf = (el: Element | null): string =>
          // `^` = Windows Ctrl glyph (see the actionLabelOf note in dom-extractor.ts)
          textOf(el).replace(/[⌘⌃⌥⇧^⏎]/g, '').replace(/\s+/g, ' ').trim();
        questionnaire = {
          composerId: activeTab?.id || '',
          questions,
          activeIndex: 0,
          totalLabel: '',
          skipSelectorPath: skipBtn ? '[class*="question-floating-module_skipBtn_"]' : '',
          continueSelectorPath: continueBtn ? '[class*="question-floating-module_continueBtn_"]' : '',
          continueDisabled: hasQClass(continueBtn, 'question-floating-module_disabled_'),
          skipLabel: actionTextOf(skipBtn),
          continueLabel: actionTextOf(continueBtn),
        };
      }
    }

    // Generating = current session tab is spinning (IDE's own running truth,
    // same source as the web's row-level loading). The old path looked for
    // `[class*="stop"]` on the composer bottom-right stop button — measured
    // 2026-09-18 probe: that button has **no** stop class / aria-label, 0
    // hits in the whole tree, so the check was permanently dead (agentStatus
    // stayed idle for the whole generation).
    const statusEl = root.querySelector('[class*="exec-status-text"], [role="status"]');
    const activity = textOf(statusEl) || null;

    let agentStatus: AgentStatus = 'idle';
    if (pendingApprovals.length > 0)
      agentStatus = 'waiting_approval';
    else if (activeTab?.running)
      agentStatus = 'generating';
    else if (activity && /runn|generat|think|tool/i.test(activity))
      agentStatus = 'generating';

    const modeBtn = root.querySelector('[class*="mode-selector-module_modeButton"]');
    const modelBtn = root.querySelector('[class*="model-select-module_trigger"]');
    const modeLabel = textOf(modeBtn) || 'Craft';
    const modelLabel = textOf(modelBtn) || 'Auto';

    const liveActions: CodeBuddyLiveDump['liveActions'] = {};
    const actionBtns = Array.from(
      root.querySelectorAll('[class*="assistant-message-tool"] button, [class*="tool-call"] button'),
    );
    actionBtns.forEach((el, i) => {
      const label = textOf(el);
      if (!label)
        return;
      const lower = label.toLowerCase();
      let type: 'run' | 'skip' | 'allow' | null = null;
      if (/skip/.test(lower))
        type = 'skip';
      else if (/allow/.test(lower))
        type = 'allow';
      else if (/^run$|运行/.test(lower))
        type = 'run';
      if (!type)
        return;
      const key = el.closest('[data-tool-call-id]')?.getAttribute('data-tool-call-id') || `action-${i}`;
      const list = liveActions[key] ?? [];
      list.push({ label, type, selectorPath: buildSelectorPath(el) });
      liveActions[key] = list;
    });

    // Rendered timeline messages of the active conversation. Remote-workspace
    // (SSH) sessions persist on the remote host, so the disk content source can
    // never see them — the DOM is the only local signal. Assistant bubbles are
    // converted back to markdown (tables / code fences / headings survive) so the
    // console renders them like a disk-backed session.
    const htmlToMd = (rootEl: Element): string => {
      const escCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
      const inline = (node: Element): string => {
        let out = '';
        for (const ch of Array.from(node.childNodes || [])) {
          if (ch.nodeType === 3) {
            out += (ch.textContent || '').replace(/\s+/g, ' ');
            continue;
          }
          if (ch.nodeType !== 1)
            continue;
          const el2 = ch as Element;
          const tag = el2.tagName.toLowerCase();
          const inner = inline(el2);
          if (tag === 'strong' || tag === 'b') {
            out += `**${inner.trim()}**`;
          }
          else if (tag === 'em' || tag === 'i') {
            out += `*${inner.trim()}*`;
          }
          else if (tag === 'code') {
            out += `\`${(el2.textContent || '').replace(/`/g, '\\`')}\``;
          }
          else if (tag === 'a') {
            const href = el2.getAttribute('href');
            out += href ? `[${inner.trim()}](${href})` : inner;
          }
          else if (tag === 'br') {
            out += '\n';
          }
          else if (tag === 'img') {
            out += el2.getAttribute('alt') || '';
          }
          else {
            out += inner;
          } // span/div/other inline wrappers: unwrap
        }
        return out.replace(/ {2,}/g, ' ').trim();
      };
      const tableToMd = (tbl: Element): string => {
        const rows: string[][] = [];
        const headCells = Array.from(tbl.querySelectorAll('thead th, thead td'));
        if (headCells.length)
          rows.push(headCells.map(c => inline(c)));
        const bodyRows = Array.from(tbl.querySelectorAll('tbody tr'));
        const src = bodyRows.length ? bodyRows : Array.from(tbl.querySelectorAll('tr')).slice(headCells.length ? 1 : 0);
        for (const tr of src) {
          const cells = Array.from(tr.querySelectorAll('th, td')).map(c => inline(c));
          if (cells.length)
            rows.push(cells);
        }
        if (!rows.length)
          return '';
        const cols = Math.max(...rows.map(r => r.length));
        const norm = rows.map((r) => {
          while (r.length < cols) r.push('');
          return r.map(escCell);
        });
        const lines = [
          `| ${norm[0].join(' | ')} |`,
          `| ${norm[0].map(() => '---').join(' | ')} |`,
        ];
        for (const r of norm.slice(1)) lines.push(`| ${r.join(' | ')} |`);
        return `\n\n${lines.join('\n')}\n\n`;
      };
      const block = (node: Element, depth: number): string => {
        let out = '';
        for (const ch of Array.from(node.childNodes || [])) {
          if (ch.nodeType === 3) {
            const t = (ch.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
            if (t)
              out += `${t}\n\n`;
            continue;
          }
          if (ch.nodeType !== 1)
            continue;
          const el2 = ch as Element;
          const tag = el2.tagName.toLowerCase();
          if (/^h[1-6]$/.test(tag)) {
            out += `${'#'.repeat(+tag[1])} ${inline(el2)}\n\n`;
          }
          else if (tag === 'p') {
            const t = inline(el2);
            if (t)
              out += `${t}\n\n`;
          }
          else if (tag === 'table') {
            out += tableToMd(el2);
          }
          else if (tag === 'pre') {
            const code = el2.querySelector('code');
            const lang = code ? (((code.className || '').match(/language-(\w+)/) || [])[1] || '') : '';
            out += `\n\`\`\`${lang}\n${((code || el2).textContent || '').replace(/\n+$/, '')}\n\`\`\`\n\n`;
          }
          else if (tag === 'blockquote') {
            const t = block(el2, depth).trim().split('\n').map(l => `> ${l}`).join('\n');
            out += `${t}\n\n`;
          }
          else if (tag === 'ul' || tag === 'ol') {
            let i = 0;
            for (const li of Array.from(el2.children)) {
              if (li.tagName.toLowerCase() !== 'li')
                continue;
              i++;
              const marker = tag === 'ol' ? `${i}. ` : '- ';
              // An li without block-level children renders inline; otherwise it would shatter into lines
              const hasBlock = Array.from(li.children).some(c => /^(p|div|ul|ol|table|pre|blockquote|h[1-6])$/.test(c.tagName.toLowerCase()));
              const t = hasBlock ? (block(li, depth + 1).trim() || inline(li)) : inline(li);
              out += `${'  '.repeat(depth)}${marker}${t.replace(/\n/g, `\n${'  '.repeat(depth)}  `)}\n`;
            }
            out += '\n';
          }
          else if (tag === 'hr') {
            out += '\n---\n\n';
          }
          else if (tag === 'div' || tag === 'section' || tag === 'article') {
            out += block(el2, depth);
          } // .cb-markdown and other containers: recurse
          else if (tag === 'br') {
            out += '\n';
          }
          else {
            const t = inline(el2);
            if (t)
              out += `${t}\n\n`;
          }
        }
        return out;
      };
      return block(rootEl, 0).replace(/\n{3,}/g, '\n\n').trim();
    };

    const chatMessages: { role: 'user' | 'assistant'; id: string; text: string }[] = [];
    try {
      const clsMatch = (el: Element, re: RegExp): boolean => {
        const raw = typeof el.className === 'string' ? el.className : '';
        return raw.split(/\s+/).some(c => re.test(c));
      };
      // CSS Modules hashes change; prefix-match with the trailing underscore kept.
      const ASST_BOX_RE = /^message-timeline-module_assistantMessage_/;
      const msgNodes = Array.from(root.querySelectorAll('[id^="user-message-"], [class*="message-timeline-module_assistantMessage_"]'));
      let seq = 0;
      for (const el of msgNodes) {
        // Skip nodes nested inside another matched message container (defensive).
        let anc = el.parentElement;
        let nested = false;
        while (anc) {
          if ((anc.id && anc.id.startsWith('user-message-')) || clsMatch(anc, ASST_BOX_RE)) {
            nested = true;
            break;
          }
          anc = anc.parentElement;
        }
        if (nested)
          continue;
        seq++;
        if (el.id && el.id.startsWith('user-message-')) {
          const t = Array.from(el.querySelectorAll('[class*="message-timeline-module_userMessageText_"]')).pop();
          const target = (t || el) as HTMLElement;
          // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- innerText keeps the rendered line breaks (<br>); textContent flattens them
          const text = ((target.innerText || target.textContent) || '').trim();
          if (text)
            chatMessages.push({ role: 'user', id: `dom-${el.id.slice('user-message-'.length)}`, text });
        }
        else if (clsMatch(el, ASST_BOX_RE)) {
          const parts: string[] = [];
          for (const n of Array.from(el.querySelectorAll('[class*="message-timeline-module_assistantTextContent_"]'))) {
            const s = htmlToMd(n);
            if (s)
              parts.push(s);
          }
          const text = parts.join('\n\n').trim();
          if (text)
            chatMessages.push({ role: 'assistant', id: `dom-a${seq}`, text });
        }
      }
    }
    catch { /* message scraping is best-effort; the rest of the dump still stands */ }

    return {
      inputAvailable: input !== null,
      agentStatus,
      agentActivityText: activity,
      chatMessages,
      chatTabs,
      activeComposerId: activeTab?.id || '',
      pendingApprovals,
      liveActions,
      questionnaire,
      mode: {
        current: modeLabel,
        available: [
          { id: 'craft', label: 'Craft', icon: '' },
          { id: 'ask', label: 'Ask', icon: '' },
        ],
      },
      model: { current: modelLabel, currentId: modelLabel },
    };
  }
  catch {
    return null;
  }
}

export class CodeBuddyExtractor {
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private client: CdpClient | null = null;
  private readonly onExtract: (state: CursorState | null, errorMessage?: string | null) => void;
  private loggedFirstExtraction = false;
  private basePollIntervalMs = 300;
  private currentPollIntervalMs = 300;
  private pollInFlight = false;
  private failureStreak = 0;
  private running = false;
  private paused = false;

  constructor(
    onExtract: (state: CursorState | null, errorMessage?: string | null) => void,
  ) {
    this.onExtract = onExtract;
  }

  start(client: CdpClient, intervalMs: number): void {
    this.client = client;
    this.stop();
    this.running = true;
    this.paused = false;
    this.basePollIntervalMs = intervalMs;
    this.currentPollIntervalMs = intervalMs;
    this.failureStreak = 0;
    console.log(`[codebuddy-extractor] Starting polling every ${intervalMs}ms`);
    this.scheduleNextPoll(0);
  }

  stop(): void {
    this.running = false;
    this.paused = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.currentPollIntervalMs = this.basePollIntervalMs;
    this.failureStreak = 0;
  }

  pause(): void {
    this.paused = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  resume(): void {
    if (!this.paused)
      return;
    this.paused = false;
    if (this.running && !this.pollTimer && !this.pollInFlight) {
      this.scheduleNextPoll(0);
    }
  }

  /**
   * Force one extraction now (used right after a command switched the active tab).
   * Skips the interval wait and waits out an in-flight poll so the DOM is read after
   * the IDE painted the switch; resolves once onExtract ran. No-op while paused/stopped.
   */
  async pollNow(): Promise<void> {
    if (!this.running)
      return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    // The in-flight round read the pre-command DOM: wait it out, then extract; max 800ms
    const deadline = Date.now() + 800;
    while (this.pollInFlight && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    if (this.paused || !this.running || this.pollInFlight)
      return;
    await this.poll();
  }

  setClient(client: CdpClient | null): void {
    this.client = client;
  }

  private scheduleNextPoll(delayMs = this.currentPollIntervalMs): void {
    if (!this.running)
      return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delayMs);
  }

  private handleFailure(message: string): void {
    const timedOut = message.includes('timeout');
    this.failureStreak++;
    if (timedOut) {
      const nextInterval = Math.min(
        Math.max(this.basePollIntervalMs, this.basePollIntervalMs * (2 ** (this.failureStreak - 1))),
        MAX_POLL_BACKOFF_MS,
      );
      if (nextInterval !== this.currentPollIntervalMs) {
        this.currentPollIntervalMs = nextInterval;
        console.warn(`[codebuddy-extractor] Backing off poll interval to ${this.currentPollIntervalMs}ms after ${message}`);
      }
    }
    this.onExtract(null, message);
  }

  private async poll(): Promise<void> {
    if (this.paused) {
      return;
    }
    if (this.pollInFlight) {
      this.scheduleNextPoll();
      return;
    }
    this.pollInFlight = true;

    if (!this.client || !this.client.isConnected()) {
      this.handleFailure('CDP client not connected');
      this.pollInFlight = false;
      this.scheduleNextPoll();
      return;
    }

    const client = this.client;
    try {
      const started = Date.now();
      const dump = await client.callFunctionWithTimeout(
        dumpCodeBuddyLive as (...args: never[]) => unknown,
        [],
        EVALUATE_TIMEOUT_MS,
      ) as CodeBuddyLiveDump | null;
      // The in-flight round read the old window's webview: drop it after a switch,
      // or those tabs would be emitted as the new window's session list (list flash).
      if (!this.isCurrentClient(client))
        return;
      const ms = Date.now() - started;
      if (!dump) {
        timingLog('extract', { ide: 'codebuddy', ms, ok: false, error: 'null' });
        this.handleFailure('Extraction returned null');
        return;
      }
      if (ms >= 200) {
        timingLog('extract', { ide: 'codebuddy', ms, ok: true, tabs: dump.chatTabs.length });
      }

      this.failureStreak = 0;
      this.currentPollIntervalMs = this.basePollIntervalMs;

      const mapped = mapCodeBuddyLive(dump);
      const state: CursorState = {
        ...emptyCursorState(),
        ...mapped,
        messages: [],
      };

      if (!this.loggedFirstExtraction) {
        this.loggedFirstExtraction = true;
        console.log(`[codebuddy-extractor] First successful extraction:`);
        console.log(`  status: ${state.agentStatus}${state.agentActivityText ? ` (${state.agentActivityText})` : ''}`);
        console.log(`  approvals: ${state.pendingApprovals.length}`);
        console.log(`  inputAvailable: ${state.inputAvailable}`);
        console.log(`  chatTabs: ${state.chatTabs.length}`);
        console.log(`  mode: ${state.mode.current}, model: ${state.model.current}`);
      }

      this.onExtract(state, null);
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Failures from the old window (usually disconnect during a switch) are not extraction failures for the new window
      if (!this.isCurrentClient(client))
        return;
      timingLog('extract', { ide: 'codebuddy', ok: false, error: message });
      if (!message.includes('WebSocket closed') && !message.includes('Intentional disconnect')) {
        console.warn(`[codebuddy-extractor] Extraction failed: ${message}`);
      }
      this.handleFailure(message);
    }
    finally {
      this.pollInFlight = false;
      this.scheduleNextPoll();
    }
  }

  /** Is the client this poll used still the one we should read (window switched / already stopped → no longer counts). */
  private isCurrentClient(client: CdpClient | null): boolean {
    return this.running && this.client === client;
  }
}
