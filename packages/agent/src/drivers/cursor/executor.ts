import type { CdpClient } from '../../cdp/client.js';
import type { CommandResult, PlanModelOption, SelectorConfig, SwitchTabTarget } from '../../types.js';
import type { WindowSessionTab } from '../../window-session.js';
import { timingLog, timingPreview } from '../../timing-log.js';
import { pickWindowSession } from '../../window-session.js';
import { isPlaceholderComposerId, sameNameIdsFor } from './tab-identity.js';

/** Switch result from in-page JS (landedComposerId = real id on the composer bar after the click). */
export interface SwitchTabOutcome {
  clicked: boolean;
  occluded: boolean;
  landedComposerId?: string;
  tried?: number;
  /** Composer bar not readable, cannot verify (not a failure, but cannot confirm which row we landed on). */
  unverified?: boolean;
  via?: string;
  reason?: string;
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;
const FOCUS_DELAY_MS = 100;
/** Marker findApproveAllButton returns after clicking in-page — callers must not querySelector it. */
const APPROVE_ALL_CLICKED_INLINE = '__clicked_inline__';

/**
 * Cursor Agents window input: tiptap `.ui-prompt-input-editor__input`,
 * **not** inside `.composer-bar`, so it cannot be merged into
 * selectors.chatInput (that set is for the project window).
 *
 * Pitfall (measured 2026-09-17): user bubbles in the transcript use a
 * **read-only variant of the same class** (plus
 * `ui-prompt-input-tiptap-readonly__content`). Without excluding it,
 * `querySelector` hits the transcript bubble first — verify always sees
 * "still has text", and clear/type also land on the bubble. Must add `:not(...)`.
 */
export const AGENTS_INPUT_STRATEGIES = [
  '.ui-prompt-input-editor__input:not(.ui-prompt-input-tiptap-readonly__content)',
  '.ui-prompt-input__container [contenteditable="true"]:not(.ui-prompt-input-tiptap-readonly__content)',
];
/**
 * Composer input lookup (injected into the page). Must skip two kinds of
 * "looks like composer" elements:
 *   1. User bubbles in the transcript — read-only variant of the same class
 *      (`:not(...)` in strategies already excludes them);
 *   2. **Input inside the questionnaire tray** (after Other expands it is the
 *      same `.ui-prompt-input-editor__input`, and it precedes composer in DOM
 *      order) — measured 2026-09-17: without filtering, focus lands on the
 *      questionnaire, `Input.insertText` types into it, and "cleared" verify
 *      reads the wrong element.
 */
export const FIND_COMPOSER_INPUT_JS = `
  // Count both questionnaire containers: Agents window (glass ui-tray) and project window (composer-questionnaire-toolbar)
  const __inQuestionnaireTray = (el) => !!(el && el.closest && (
    el.closest('[class*="glass-questionnaire-tray"]') || el.closest('.composer-questionnaire-toolbar')
  ));
  const findComposerInput = (strategies, isUnsafe) => {
    for (const sel of strategies) {
      try {
        for (const node of document.querySelectorAll(sel)) {
          if (isUnsafe && isUnsafe(node)) continue;
          if (__inQuestionnaireTray(node)) continue;
          return { input: node, selector: sel };
        }
      } catch {}
    }
    return { input: null, selector: '' };
  };
`;
/**
 * Agents window submit button. **The same element** swaps identity with input
 * state: with text it is "Send message"; empty it becomes "Start voice input"
 * (same place, same `.ui-prompt-input-submit-button`). Exclude the voice
 * state so we do not open voice input.
 */
const AGENTS_SEND_BUTTON_SELECTOR
  = 'button[aria-label="Send message"], button.ui-prompt-input-submit-button:not([aria-label="Start voice input"])';

/**
 * Stop-button targeting. The two window shapes are completely different
 * (measured 2026-09-18 probe; both windows actually stopped a round):
 *
 * - Project window: the anysphere-icon-button inside `.send-with-mode`;
 *   while generating it gets `data-stop-button="true"` (icon
 *   `codicon-debug-stop`; idle empty input is `codicon-mic`, with text a
 *   paper plane). **Project-window composer is not React** (no
 *   `__reactFiber$`); click by DOM only.
 * - Agents window: `button.ui-prompt-input-submit-button`, while generating
 *   `aria-label="Stop generation"` (idle "Start voice input", with text
 *   "Send message").
 *
 * Both selectors **only match the generating state**: if neither hits, we
 * are not generating — report `Not generating` immediately; never fall back
 * to clicking the idle button (that would open voice or send the draft).
 */
export const CURSOR_STOP_JS = `(() => {
  const project = document.querySelector('[class*="send-with-mode"] [data-stop-button="true"]');
  if (project) {
    project.click();
    return { ok: true, via: 'project:data-stop-button' };
  }
  const agentsStop = Array.from(document.querySelectorAll('button.ui-prompt-input-submit-button'))
    .find((b) => !b.disabled && /^(stop|停止)/i.test((b.getAttribute('aria-label') || '').trim()));
  if (agentsStop) {
    agentsStop.click();
    return { ok: true, via: 'agents:aria-label' };
  }
  const anySubmit = document.querySelector(
    '[class*="send-with-mode"] [class*="anysphere-icon-button"], button.ui-prompt-input-submit-button'
  );
  return { ok: false, error: anySubmit ? 'Not generating' : 'Stop button not found' };
})()`;
/** Agents window rows (agent rows inside a section). */
const AGENTS_ROW_SELECTOR = '.ui-sidebar-menu-button[aria-id="glass-sidebar-agent-row"]';

/** Wrong-window / virtualized sidebar will not appear on the next try. */
export function isRetryableCommandError(message: string): boolean {
  return !message.startsWith('Tab not found:') && !message.startsWith('Chat composer not found');
}

/** Terminal/editor nodes that must not receive a remote send. */
export function isUnsafeChatInputInfo(info: string): boolean {
  return /xterm-helper-textarea|\.xterm\b/i.test(info);
}

/**
 * Pin a new draft's **run location** to this machine (`Run on: This Mac`).
 *
 * Background (measured 2026-09-17): above the `New Agent` input is a `Run on`
 * selector whose value is the button copy (`button.ui-select-trigger`:
 * `This Mac` / `Cloud` / `Remote Machines`). In `No Repo`, New Agent may
 * default to `Cloud` → that is a Cursor Cloud Agent (body lives on a cloud
 * VM, unreadable locally; see CLOUD_SECTION_IDS in agents-window.ts).
 *
 * Critical timing: **clicking New Agent itself does not create a cloud
 * record** (the cloud VM starts only when the first message is sent,
 * measured 3→3), so flipping to `This Mac` while still a draft makes this
 * session local (body still lands in state.vscdb as usual). Opening the
 * selector shows three `li[role="menuitem"]`: Cloud / This Mac / Remote
 * Machines.
 *
 * Returns `{ ok, before, after, changed, error? }`; on `ok=false` the
 * caller **must error** (do not treat a "might run in the cloud" draft as
 * success — the user sending into it would actually create a cloud agent).
 */
export function agentsSetRunOnJS(label: string): string {
  return `(async () => {
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const want = ${JSON.stringify(label)};
    const chipNow = () =>
      Array.from(document.querySelectorAll('button.ui-select-trigger'))
        .find((b) => /^(this mac|cloud|remote machines)/i.test(clean(b.textContent)));
    const chipText = () => clean(chipNow()?.textContent || '');
    const menuItems = () => Array.from(
      document.querySelectorAll('li[role="menuitem"], li[role="menuitemradio"], [role="option"]'),
    );
    const targetItem = () =>
      menuItems().find((el) => clean(el.textContent).toLowerCase() === want.toLowerCase());
    const menuOpen = () => menuItems().length > 0;
    const waitFor = async (pred, budgetMs) => {
      for (let waited = 0; waited < budgetMs; waited += 150) {
        if (pred()) return true;
        await sleep(150);
      }
      return pred();
    };
    /** Close a possibly open menu: clicking the chip while the menu is open only toggles it closed (root cause of earlier flaky failures). */
    const closeMenu = async () => {
      for (let i = 0; i < 3 && menuOpen(); i++) {
        const node = document.activeElement ?? document.body;
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
        await sleep(200);
      }
    };
    // Draft composer is async-rendered: wait up to 1.8s
    let chip = null;
    for (let i = 0; i < 12 && !chip; i++) {
      chip = chipNow();
      if (!chip) await sleep(150);
    }
    if (!chip) return { ok: false, error: 'NO_RUN_ON_CHIP' };
    const before = chipText();
    if (before.toLowerCase() === want.toLowerCase()) return { ok: true, before, after: before, changed: false };

    // Pure click + state check (same lineage as "pick model / send"; no synthetic pointer sequence, no coordinates).
    // **One attempt only**: the whole JS must stay inside the CDP evaluate 12s budget (worst ~4.8s);
    // retries belong on the Node side — otherwise in-page retries hit the 12s timeout and the reported error is "CDP timeout", not the cause.
    await closeMenu();
    const c = chipNow();
    if (!c) return { ok: false, error: 'NO_RUN_ON_CHIP', before };
    c.click();
    if (!await waitFor(menuOpen, 1800)) {
      // Some versions need the keyboard to expand
      c.focus?.();
      c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true }));
      await waitFor(menuOpen, 1000);
    }
    const item = targetItem();
    if (!item) return { ok: false, error: menuOpen() ? 'NO_TARGET_ITEM' : 'MENU_NOT_OPEN', before };
    item.click();
    if (await waitFor(() => chipText().toLowerCase() === want.toLowerCase(), 1200)) {
      return { ok: true, before, after: chipText(), changed: true };
    }
    return { ok: false, error: 'NOT_APPLIED', before, after: chipText() };
  })()`;
}

/** Pin a new draft's run location to this machine (= `agentSetRunOnJS('This Mac')`). */
export function agentsRunOnLocalJS(): string {
  return agentsSetRunOnJS('This Mac');
}

const LIST_CURSOR_SESSION_TABS_JS = `(() => {
  const __listCursorSessionTabs = true;
  const chrome = new Set(['customize', 'new agent', 'more']);
  function cleanTabTitle(raw) {
    let t = (raw || '').trim().replace(/\\s+/g, ' ');
    t = t.replace(/(@[\\w./]+)+\\s*$/, '');
    return t.trim().substring(0, 120);
  }
  function cellIsActive(tab) {
    return tab.getAttribute('data-selected') === 'true'
      || tab.getAttribute('data-highlighted') === 'true'
      || tab.classList.contains('selected')
      || tab.classList.contains('active');
  }
  const tabs = [];
  const seen = new Set();
  const push = (title, isActive) => {
    const t = cleanTabTitle(title);
    if (!t || chrome.has(t.toLowerCase()) || seen.has(t)) return;
    seen.add(t);
    tabs.push({ title: t, isActive: !!isActive });
  };
  const glassBtns = Array.from(document.querySelectorAll(
    '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > .ui-sidebar-menu-button, '
    + '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn'
  ));
  for (const btn of glassBtns) {
    const labelEl = btn.querySelector('.ui-sidebar-menu-button-label');
    const rawAgent = (labelEl && labelEl.textContent || '').trim();
    if (!rawAgent) continue;
    const li = btn.closest('li');
    const active = btn.getAttribute('aria-current') === 'page'
      || btn.classList.contains('active')
      || btn.getAttribute('data-state') === 'open'
      || !!(li && li.classList.contains('active'));
    push(rawAgent, active);
  }
  const cells = document.querySelectorAll('.agent-sidebar-list .agent-sidebar-cell, .agent-sidebar-cell');
  for (const cell of Array.from(cells)) {
    if (cell.closest('.agent-sidebar-header-actions')) continue;
    const titleEl = cell.querySelector('.agent-sidebar-cell-text');
    const raw = titleEl ? (titleEl.textContent || '') : (cell.textContent || '');
    push(raw, cellIsActive(cell));
  }
  return tabs;
})()`;

// Cursor 3.8+ uses data-message-index; older builds use data-flat-index.
const MESSAGE_WRAPPER_SELECTOR = '[data-message-index], [data-flat-index]';

// Resolves the currently-open model picker menu element across Cursor versions.
// Older builds expose `[data-testid="model-picker-menu"]`; newer builds (~3.5.17)
// removed the testid and render the picker as a generic `[role="menu"]` opened
// via `.ui-model-picker__trigger`, so we cascade through several lookups.
// Stable across model-picker renders — Cursor's React 19 useId-generated IDs
// (`_r_ld_`, `_r_qm_`, …) change on every mount, so they round-trip badly as
// model identifiers. Treat anything matching this pattern as no-id and fall
// back to the synthetic `label::<text>` form.
const REACT_USE_ID_RE = /^_r_[a-z0-9]+_$/;

// Shared in-browser helpers for reading and clicking model-picker rows. Both
// the read path (`get_model_options`) and the write path (`set_model` /
// `set_plan_model`) use the same `collectModelItems()` / `pickModelById()`
// implementations so the round-trip is consistent — there's exactly one
// definition of "what counts as a model row" and "how to map an id back to a
// row." Inject as `${MODEL_ITEM_HELPERS_JS}` inside an evaluate().
export const MODEL_ITEM_HELPERS_JS = `
  const REACT_USE_ID_RE = ${REACT_USE_ID_RE.toString()};

  // Row label, excluding text from descendant <button> elements (each row has
  // an inner "Edit" button whose text would otherwise pollute the label).
  const labelOf = (el) => {
    const clone = el.cloneNode(true);
    for (const b of Array.from(clone.querySelectorAll('button'))) b.remove();
    return (clone.textContent || '').replace(/\\s+/g, ' ').trim();
  };

  // Returns the DOM id only if it's stable; React useId values round-trip badly.
  const stableIdOf = (el) => {
    const raw = el.id || '';
    if (!raw || REACT_USE_ID_RE.test(raw)) return '';
    return raw;
  };

  // Top-level rows under the menu — drops items contained inside another
  // candidate so per-row Edit buttons don't show up as separate "models."
  const modelRowsIn = (menu) => {
    if (!menu) return [];
    const raw = Array.from(menu.querySelectorAll('[id], [role="menuitem"], button, [data-testid]'));
    return raw.filter(item => !raw.some(other => other !== item && other.contains(item)));
  };

  const clickModelRow = (item) => {
    const clickable = item.querySelector('.composer-unified-context-menu-item') || item;
    clickable.click();
  };

  const collectModelItems = (menu) => {
    const items = modelRowsIn(menu);
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const label = labelOf(item);
      if (!label) continue;
      // Skip pure action-button entries that survived the nesting filter
      // (defensive — e.g. floating Edit/Configure buttons not inside a row).
      if (/^(edit|configure|remove|delete|star)$/i.test(label)) continue;
      const stableId = stableIdOf(item);
      const key = stableId || label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const clickable = item.querySelector('.composer-unified-context-menu-item') || item;
      const cls = clickable.className || item.className || '';
      const aria = clickable.getAttribute?.('aria-checked') || item.getAttribute?.('aria-checked') || '';
      const selected = /selected|active|checked/.test(cls) || aria === 'true';
      out.push({
        id: stableId || ('label::' + label),
        label,
        selected,
      });
    }
    return out;
  };

  // Finds and clicks the row whose id (or synthesized label::id) matches the
  // requested target. Targets can be: a real DOM id ("model-opus"), a
  // synthesized "label::<text>" (when the row has no stable id), an unstable
  // React useId ("_r_ld_"), or the bare label text. Returns true on success.
  const pickModelById = (menu, targetId) => {
    if (!menu || !targetId) return false;
    const isLabelId = targetId.startsWith('label::');
    const isUnstable = REACT_USE_ID_RE.test(targetId);
    const labelTarget = (isLabelId ? targetId.slice(7) : '').trim().toLowerCase();
    const targetLc = targetId.toLowerCase();
    const fuzzy = (isLabelId || isUnstable) ? '' : targetLc.replace(/[-_]/g, ' ');

    // Slug ids from the 3.18.9 submenu (data-model-picker-item-name, e.g.
    // "grok-4.6"). There is no element with that DOM id, so look the attribute
    // up explicitly and click the owning row.
    for (const el of Array.from(menu.querySelectorAll('[data-model-picker-item-name]'))) {
      if (el.getAttribute('data-model-picker-item-name') !== targetId) continue;
      clickModelRow(el.closest('[data-testid^="model-item-"]') || el);
      return true;
    }

    if (!isLabelId && !isUnstable) {
      const byId = document.getElementById(targetId);
      if (byId && (byId === menu || menu.contains(byId))) {
        clickModelRow(byId);
        return true;
      }
    }

    const rows = modelRowsIn(menu);
    // Pass 1: exact match (preferred — avoids "GPT-5" matching "GPT-5.5").
    for (const item of rows) {
      const label = labelOf(item);
      if (!label) continue;
      const labelLc = label.toLowerCase();
      const stableId = stableIdOf(item);
      if (isLabelId || isUnstable) {
        if (labelLc === labelTarget || labelLc === targetLc) {
          clickModelRow(item);
          return true;
        }
      } else {
        if (stableId === targetId || ('label::' + label) === targetId) {
          clickModelRow(item);
          return true;
        }
      }
    }
    // Pass 2: fuzzy/substring fallback for label::-style targets, in case the
    // live row has extra text (e.g. a "Premium" badge, subtitle) beyond what
    // collectModelItems captured. Guarded by length to avoid partial matches
    // like "GPT-5" matching "GPT-5.5".
    for (const item of rows) {
      const label = labelOf(item);
      if (!label) continue;
      const labelLc = label.toLowerCase();
      if (isLabelId || isUnstable) {
        if (labelTarget.length >= 4 && labelLc.includes(labelTarget)) {
          clickModelRow(item);
          return true;
        }
      } else if (fuzzy && labelLc.includes(fuzzy)) {
        clickModelRow(item);
        return true;
      }
    }
    return false;
  };
`;

// Back-compat alias for tests that imported the old name.
export const MODEL_ITEM_COLLECTOR_JS = MODEL_ITEM_HELPERS_JS;

/**
 * Cursor 3.18.9 moved the model list out of the composer's top-level menu and
 * into a Radix submenu: the trigger (`.vscode-model-picker__trigger`) now shows
 * the *effort* ("High") and opens a parameters menu whose "Model" row holds the
 * list. That row only expands on a real pointer move, so the caller has to
 * drive one via CDP — see `openModelListMenu`.
 *
 * The submenu is the one place Cursor gives us stable hooks:
 *   [data-testid="selected-model-list-submenu"]     the list container
 *   [data-testid="model-item-<slug>"]               each row
 *   [data-model-picker-item-name="<slug>"]          the name container
 *   <p>Cursor Grok 4.6 <span>High</span></p>        name + effort badge
 * so ids are the slug and labels are the paragraph's leading text node.
 */
export const MODEL_SUBMENU_HELPERS_JS = `
  const MODEL_LIST_TESTID = 'selected-model-list-submenu';

  const findModelListSubmenu = () => document.querySelector('[data-testid="' + MODEL_LIST_TESTID + '"]');

  // The "Model  <current>" row of the parameters menu.
  const findModelSubmenuRow = () => {
    const submenu = findModelListSubmenu();
    for (const menu of Array.from(document.querySelectorAll('[role="menu"]'))) {
      if (submenu && menu.contains(submenu)) continue;
      for (const row of Array.from(menu.querySelectorAll('[role="menuitem"]'))) {
        // Row label is "Model" + the current value glued together
        // ("ModelCursor Grok 4.6"), hence a prefix test rather than equality.
        if (!/^model/i.test(labelOf(row))) continue;
        return row;
      }
    }
    return null;
  };

  const collectSubmenuModelItems = (submenu) => {
    if (!submenu) return [];
    const out = [];
    const seen = new Set();
    for (const row of Array.from(submenu.querySelectorAll('[data-testid^="model-item-"]'))) {
      const nameEl = row.querySelector('[data-model-picker-item-name]');
      const testid = row.getAttribute('data-testid') || '';
      const slug = (nameEl && nameEl.getAttribute('data-model-picker-item-name'))
        || testid.replace(/^model-item-/, '');
      if (!slug || seen.has(slug)) continue;

      // The model name is the paragraph's leading text node; the effort badge
      // is a nested styled <span> ("High"), which must not leak into the label.
      let label = '';
      const p = row.querySelector('p');
      if (p && p.firstChild && p.firstChild.nodeType === 3) {
        label = String(p.firstChild.textContent).replace(/\\s+/g, ' ').trim();
      }
      if (!label && nameEl) {
        const clone = nameEl.cloneNode(true);
        for (const s of Array.from(clone.querySelectorAll('span[style]'))) s.remove();
        label = (clone.textContent || '').replace(/\\s+/g, ' ').trim();
      }
      if (!label) label = labelOf(row);

      seen.add(slug);
      out.push({
        id: slug,
        label,
        selected: /selected|active|checked/.test(row.className || ''),
      });
    }
    return out;
  };
`;

// Inject as `${MODEL_MENU_LOOKUP_JS}` inside an evaluate; call `findModelMenu()`.
export const MODEL_MENU_LOOKUP_JS = `
  const findModelMenu = () => {
    const bySubmenu = document.querySelector('[data-testid="selected-model-list-submenu"]');
    if (bySubmenu) return bySubmenu;
    const byTestId = document.querySelector('[data-testid="model-picker-menu"]');
    if (byTestId) return byTestId;
    const triggers = document.querySelectorAll(
      '.vscode-model-picker__trigger[aria-expanded="true"],' +
      '.ui-model-picker__trigger[aria-expanded="true"],' +
      '.composer-unified-dropdown-model[aria-expanded="true"],' +
      '.composer-unified-dropdown[aria-expanded="true"]'
    );
    for (const t of Array.from(triggers)) {
      const controls = t.getAttribute('aria-controls');
      if (controls) {
        const byControls = document.getElementById(controls);
        if (byControls) return byControls;
      }
    }
    const openMenu = document.querySelector('[role="menu"][data-state="open"]');
    if (openMenu) return openMenu;
    const visibleMenus = document.querySelectorAll('[role="menu"]:not([hidden])');
    for (const m of Array.from(visibleMenus)) {
      const rect = m.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return m;
    }
    return null;
  };
`;

export type ActionClickTargetResult = { element: Element } | { error: string };

const ACTION_BUTTON_SELECTOR = 'button, [role="button"], [class*="ui-button"], [data-click-ready]';

function normalizeActionLabel(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function elementLabelMatches(element: Element, expectedLabel: string): boolean {
  // Questionnaire option rows render letter + label ("A" + "Explore…"), so
  // whole-text equality can never pass; compare the dedicated label span.
  // Freeform ("Other") rows have a textarea instead of a label span — the
  // client-facing label for them is always "Other".
  const optionLabel = element.querySelector('.composer-questionnaire-toolbar-option-label');
  if (optionLabel) {
    return normalizeActionLabel(optionLabel.textContent) === normalizeActionLabel(expectedLabel);
  }
  if (element.classList.contains('composer-questionnaire-toolbar-option-freeform')) {
    return normalizeActionLabel(expectedLabel) === 'other';
  }
  // Agents window (glass ui-tray questionnaire) options are `button.ui-tray-option`:
  // text lives in `.ui-tray-option__label`; freeform rows have `data-text-input`; outward label is always "Other".
  const trayLabel = element.querySelector('.ui-tray-option__label');
  if (trayLabel) {
    if (element.getAttribute('data-text-input') === 'true') {
      return normalizeActionLabel(expectedLabel) === 'other';
    }
    return normalizeActionLabel(trayLabel.textContent) === normalizeActionLabel(expectedLabel);
  }
  const truncatedLabel = element.querySelector('span.truncate');
  if (truncatedLabel) {
    return normalizeActionLabel(truncatedLabel.textContent) === normalizeActionLabel(expectedLabel);
  }
  return normalizeActionLabel(element.textContent) === normalizeActionLabel(expectedLabel);
}

function isElementRoot(root: Document | Element): root is Element {
  return root.nodeType === 1;
}

function queryWithin(root: Document | Element, selector: string): Element | null {
  try {
    if (isElementRoot(root) && root.matches(selector))
      return root;
    return root.querySelector(selector);
  }
  catch {
    return null;
  }
}

function firstSelectorSegment(selectorPath: string): string {
  return selectorPath.split('>')[0]?.trim() ?? '';
}

function actionSearchRoot(root: Document | Element, selectorPath: string): Document | Element {
  const firstSegment = firstSelectorSegment(selectorPath);
  if (!firstSegment)
    return root;
  return queryWithin(root, firstSegment) ?? root;
}

function buttonLikeCandidates(root: Document | Element): Element[] {
  const descendants = Array.from(root.querySelectorAll(ACTION_BUTTON_SELECTOR));
  if (isElementRoot(root) && root.matches(ACTION_BUTTON_SELECTOR)) {
    return [root, ...descendants.filter(el => el !== root)];
  }
  return descendants;
}

function matchingResolvedActionTarget(element: Element, expectedLabel: string): Element | null {
  const closest = element.closest(ACTION_BUTTON_SELECTOR);
  if (closest && elementLabelMatches(closest, expectedLabel))
    return closest;
  if (element.matches(ACTION_BUTTON_SELECTOR) && elementLabelMatches(element, expectedLabel))
    return element;

  for (const child of Array.from(element.querySelectorAll(ACTION_BUTTON_SELECTOR))) {
    if (elementLabelMatches(child, expectedLabel))
      return child;
  }

  if (elementLabelMatches(element, expectedLabel))
    return element;
  return null;
}

// Keep in sync with ACTION_CLICK_RESOLVER_JS below.
export function resolveActionClickTarget(
  root: Document | Element,
  selectorPath: string,
  expectedLabel: string,
): ActionClickTargetResult {
  const resolved = queryWithin(root, selectorPath);
  if (resolved) {
    const matched = matchingResolvedActionTarget(resolved, expectedLabel);
    if (matched)
      return { element: matched };
  }

  const scope = actionSearchRoot(root, selectorPath);
  const matches = buttonLikeCandidates(scope)
    .filter(element => elementLabelMatches(element, expectedLabel));

  if (matches.length === 1)
    return { element: matches[0] };
  return { error: `action target not found (label: ${expectedLabel})` };
}

// Keep in sync with resolveActionClickTarget() above. Inject as
// `${ACTION_CLICK_RESOLVER_JS}` inside an evaluate().
export const ACTION_CLICK_RESOLVER_JS = `
  const ACTION_BUTTON_SELECTOR = 'button, [role="button"], [class*="ui-button"], [data-click-ready]';

  const normalizeActionLabel = (value) => (value || '').trim().toLowerCase();

  const elementLabelMatches = (element, expectedLabel) => {
    const optionLabel = element.querySelector('.composer-questionnaire-toolbar-option-label');
    if (optionLabel) {
      return normalizeActionLabel(optionLabel.textContent) === normalizeActionLabel(expectedLabel);
    }
    if (element.classList.contains('composer-questionnaire-toolbar-option-freeform')) {
      return normalizeActionLabel(expectedLabel) === 'other';
    }
    // Agents window (glass ui-tray questionnaire): text in .ui-tray-option__label;
    // freeform rows have data-text-input; outward label is always "Other".
    const trayLabel = element.querySelector('.ui-tray-option__label');
    if (trayLabel) {
      if (element.getAttribute('data-text-input') === 'true') {
        return normalizeActionLabel(expectedLabel) === 'other';
      }
      return normalizeActionLabel(trayLabel.textContent) === normalizeActionLabel(expectedLabel);
    }
    const truncatedLabel = element.querySelector('span.truncate');
    if (truncatedLabel) {
      return normalizeActionLabel(truncatedLabel.textContent) === normalizeActionLabel(expectedLabel);
    }
    return normalizeActionLabel(element.textContent) === normalizeActionLabel(expectedLabel);
  };

  const queryWithin = (root, selector) => {
    try {
      if (root instanceof Element && root.matches(selector)) return root;
      return root.querySelector(selector);
    } catch {
      return null;
    }
  };

  const firstSelectorSegment = (selectorPath) => {
    const first = selectorPath.split('>')[0];
    return first ? first.trim() : '';
  };

  const actionSearchRoot = (root, selectorPath) => {
    const firstSegment = firstSelectorSegment(selectorPath);
    if (!firstSegment) return root;
    return queryWithin(root, firstSegment) || root;
  };

  const buttonLikeCandidates = (root) => {
    const descendants = Array.from(root.querySelectorAll(ACTION_BUTTON_SELECTOR));
    if (root instanceof Element && root.matches(ACTION_BUTTON_SELECTOR)) {
      return [root, ...descendants.filter(el => el !== root)];
    }
    return descendants;
  };

  const matchingResolvedActionTarget = (element, expectedLabel) => {
    const closest = element.closest(ACTION_BUTTON_SELECTOR);
    if (closest && elementLabelMatches(closest, expectedLabel)) return closest;
    if (element.matches(ACTION_BUTTON_SELECTOR) && elementLabelMatches(element, expectedLabel)) return element;

    for (const child of Array.from(element.querySelectorAll(ACTION_BUTTON_SELECTOR))) {
      if (elementLabelMatches(child, expectedLabel)) return child;
    }

    if (elementLabelMatches(element, expectedLabel)) return element;
    return null;
  };

  const resolveActionClickTarget = (root, selectorPath, expectedLabel) => {
    const resolved = queryWithin(root, selectorPath);
    if (resolved) {
      const matched = matchingResolvedActionTarget(resolved, expectedLabel);
      if (matched) return { element: matched };
    }

    const scope = actionSearchRoot(root, selectorPath);
    const matches = buttonLikeCandidates(scope)
      .filter(element => elementLabelMatches(element, expectedLabel));

    if (matches.length === 1) return { element: matches[0] };
    return { error: 'action target not found (label: ' + expectedLabel + ')' };
  };
`;

export class CommandExecutor {
  private selectors: SelectorConfig;
  private client: CdpClient | null = null;
  private windowKindProvider: () => 'project' | 'agents' = () => 'project';

  constructor(selectors: SelectorConfig) {
    this.selectors = selectors;
  }

  setClient(client: CdpClient | null): void {
    this.client = client;
  }

  /**
   * Whether the current CDP home window is a project window or Cursor's Agents
   * overview (injected by ide-slot). Default project: all existing behavior
   * is unchanged, word for word.
   */
  setWindowKindProvider(fn: () => 'project' | 'agents'): void {
    this.windowKindProvider = fn;
  }

  private windowKind(): 'project' | 'agents' {
    try {
      return this.windowKindProvider() === 'agents' ? 'agents' : 'project';
    }
    catch {
      return 'project';
    }
  }

  private chatInputStrategies(): string[] {
    return this.windowKind() === 'agents' ? AGENTS_INPUT_STRATEGIES : this.selectors.chatInput.strategies;
  }

  async sendMessage(commandId: string, text: string): Promise<CommandResult> {
    const sent = await this.withRetry(commandId, async (client) => {
      const started = Date.now();
      timingLog('cursor-send:begin', { commandId, chars: text.length, preview: timingPreview(text) });
      const strategies = this.chatInputStrategies();

      // Step 1: Find and focus the input element (evaluate only for DOM query + focus)
      const focusStarted = Date.now();
      const result = await client.evaluate(`
        (() => {
          ${FIND_COMPOSER_INPUT_JS}
          const strategies = ${JSON.stringify(strategies)};
          const isUnsafe = (el) => {
            if (!el) return true;
            const cls = (el.className && el.className.toString) ? el.className.toString() : '';
            if (cls.indexOf('xterm-helper-textarea') !== -1) return true;
            if (el.closest && (el.closest('.xterm') || el.closest('.monaco-editor'))) return true;
            return false;
          };
          const { input, selector: matchedSelector } = findComposerInput(strategies, isUnsafe);
          if (!input) return { ok: false, error: 'Chat composer not found (tried ' + strategies.length + ' selectors)' };

          const info = input.tagName + '.' + Array.from(input.classList).join('.') + ' | sel=' + matchedSelector;
          // Also return text already in the input: drafts (typed in the IDE,
          // only waiting to send) use it to decide "no need to select-all,
          // delete, and retype" (see sameAsTarget below).
          const valueText = typeof input.value === 'string' ? input.value : '';
          const contentText = input.textContent ?? '';
          const currentText = (input.isContentEditable ? contentText : (valueText || contentText)).trim();
          input.scrollIntoView({ block: 'center', behavior: 'instant' });
          input.focus();
          input.click();
          return { ok: true, info, currentText };
        })()
      `) as { ok: boolean; error?: string; info?: string; currentText?: string } | null;

      if (!result?.ok) {
        throw new Error(result?.error ?? 'Failed to focus input');
      }
      if (isUnsafeChatInputInfo(result.info ?? '')) {
        throw new Error('Chat composer not found (refusing terminal input)');
      }

      console.log(`[command-executor] Focused: ${result.info}`);
      timingLog('cursor-send:focused', { commandId, ms: Date.now() - focusStarted });
      await sleep(FOCUS_DELAY_MS);

      // Step 2/3: clear existing text then type. **Only exception**: the input
      // already holds this text (draft: already typed in the IDE; the web just
      // sends it) — leave it alone and submit. Select-all + retype would wipe
      // @file refs / images and other rich text in the draft; pointless churn.
      const alreadyTyped = (result.currentText ?? '').trim();
      const sameAsTarget = text.trim().length > 0 && alreadyTyped === text.trim();
      const agentsWindow = this.windowKind() === 'agents';
      if (sameAsTarget) {
        timingLog('cursor-send:skip-rewrite', { commandId, chars: text.length });
      }
      else {
        // Clear any existing text via Ctrl/Cmd+A then Delete (CDP Input domain)
        // Agents window input is tiptap: on macOS Ctrl+A is "move to start of line"; Cmd+A is select-all.
        const selectAllModifier = agentsWindow && process.platform === 'darwin' ? 4 : 2; // 4 = Meta, 2 = Ctrl
        await client.pressKey('a', 'KeyA', 65, selectAllModifier);
        await sleep(50);
        await client.pressKey('Backspace', 'Backspace', 8);
        await sleep(50);

        // Insert text via CDP Input.insertText (native Chromium input pipeline)
        const typeStarted = Date.now();
        await client.typeText(text);
        console.log(`[command-executor] Text inserted via Input.insertText (${text.length} chars)`);
        timingLog('cursor-send:inserted', { commandId, ms: Date.now() - typeStarted, chars: text.length });
        await sleep(150);
      }

      // Step 4: Submit. Agents window prefers clicking the "Send message"
      // button (Enter in tiptap may be treated as a newline); fall back to Enter if the click misses.
      const enterStarted = Date.now();
      let submittedVia = 'enter';
      if (agentsWindow) {
        const clicked = await client.evaluate(`
          (() => {
            const btn = document.querySelector(${JSON.stringify(AGENTS_SEND_BUTTON_SELECTOR)});
            if (!btn || btn.disabled) return false;
            btn.click();
            return true;
          })()
        `) as boolean;
        if (clicked)
          submittedVia = 'button';
      }
      if (submittedVia === 'enter') {
        await client.pressKey('Enter', 'Enter', 13);
      }
      console.log(`[command-executor] Submitted via ${submittedVia}`);
      timingLog('cursor-send:enter', { commandId, ms: Date.now() - enterStarted, via: submittedVia });
      timingLog('cursor-send:submitted', { commandId, ms: Date.now() - started });
    });
    if (!sent.ok)
      return sent;
    await this.verifyComposerCleared(commandId, text);
    return sent;
  }

  /** After Enter succeeded, a verify timeout must not retry the whole send. */
  private async verifyComposerCleared(commandId: string, text: string): Promise<void> {
    const client = this.client;
    if (!client || !client.isConnected())
      return;
    const trimmedText = text.trim();
    if (trimmedText.length === 0) {
      timingLog('cursor-send:done', { commandId, ms: 0 });
      return;
    }
    const strategies = this.chatInputStrategies();
    try {
      await sleep(300);
      const stillContainsTypedText = await client.evaluate(`
        (() => {
          ${FIND_COMPOSER_INPUT_JS}
          const strategies = ${JSON.stringify(strategies)};
          const typedText = ${JSON.stringify(trimmedText)};
          const { input } = findComposerInput(strategies, null);
          if (!input) return false;
          const valueText = typeof input.value === 'string' ? input.value : '';
          const contentText = input.textContent ?? input.innerText ?? '';
          const currentText = (input.isContentEditable ? contentText : (valueText || contentText)).trim();
          return currentText.length > 0 && currentText.includes(typedText);
        })()
      `) as boolean;

      if (stillContainsTypedText) {
        if (this.windowKind() === 'agents') {
          await client.evaluate(`
            (() => {
              const btn = document.querySelector(${JSON.stringify(AGENTS_SEND_BUTTON_SELECTOR)});
              if (!btn || btn.disabled) return false;
              btn.click();
              return true;
            })()
          `);
          console.log('[command-executor] Send button retry fired because composer still contained typed text');
          timingLog('cursor-send:agents-send-retry', { commandId });
        }
        else {
          const isMac = process.platform === 'darwin';
          await client.pressKey('Enter', 'Enter', 13, isMac ? 4 : 2);
          console.log(`[command-executor] ${isMac ? 'Cmd' : 'Ctrl'}+Enter retry fired because composer still contained typed text`);
          timingLog('cursor-send:cmd-enter', { commandId });
        }
      }
      else {
        timingLog('cursor-send:verify', { commandId, stillContains: false });
      }
    }
    catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      timingLog('cursor-send:verify-skip', { commandId, error });
      console.warn(`[command-executor] Send verify skipped (Enter already sent): ${error}`);
    }
    timingLog('cursor-send:done', { commandId });
  }

  async clickApproval(
    commandId: string,
    selectorPath: string,
  ): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      await client.click(selectorPath);
    });
  }

  /**
   * Click an allowlist / "accept all" style button.
   *
   * The web now sends the selectorPath of the button the user actually clicked:
   * Cursor allowlist copy is like "Always Run 'pnpm'", so searching "Accept All"
   * by label never finds it — must click by path. Older clients (no
   * selectorPath) fall back to label search — keep backward compatible.
   */
  async approveAll(commandId: string, selectorPath?: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      if (selectorPath) {
        await client.click(selectorPath);
        return;
      }
      const selector = await this.findApproveAllButton(client);
      if (!selector) {
        throw new Error('"Accept All" button not found');
      }
      // findApproveAllButton clicks in-page itself and returns a marker, not a selector:
      // querySelector-ing it again is always "Element not found", then treated as retryable → three extra clicks.
      if (selector === APPROVE_ALL_CLICKED_INLINE)
        return;
      await client.click(selector);
    });
  }

  async reject(
    commandId: string,
    selectorPath: string,
  ): Promise<CommandResult> {
    return this.clickApproval(commandId, selectorPath);
  }

  /**
   * Stop the current generation (= click the composer bottom-right "send ⇄ stop"
   * button in its swapped identity). Targeting for both windows is in
   * `CURSOR_STOP_JS`; if the stop state is not hit, report `Not generating`
   * and do not click the idle button. Not wrapped in `withRetry`: "not
   * generating" is not retryable; retries would only delay the failure ack by two seconds.
   */
  async stop(commandId: string): Promise<CommandResult> {
    if (!this.client || !this.client.isConnected()) {
      return { commandId, ok: false, error: 'Not connected to Cursor' };
    }
    try {
      const value = (await this.client.evaluate(CURSOR_STOP_JS)) as
        | { ok?: boolean; error?: string; via?: string }
        | null;
      if (value?.ok) {
        console.log(`[command-executor] Stop pressed (${value.via ?? 'unknown'})`);
        return { commandId, ok: true };
      }
      return { commandId, ok: false, error: value?.error ?? 'Stop button not found' };
    }
    catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { commandId, ok: false, error };
    }
  }

  async scrollChatUp(commandId: string, times: number = 5): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const containerSelectors = this.selectors.chatContainer.strategies;
      for (let i = 0; i < times; i++) {
        await client.evaluate(`
          (() => {
            const strategies = ${JSON.stringify(containerSelectors)};
            for (const sel of strategies) {
              try {
                const el = document.querySelector(sel);
                if (el) {
                  const scrollable = el.querySelector('[class*="scroll"]') || el;
                  scrollable.scrollTop = 0;
                  return true;
                }
              } catch {}
            }
            return false;
          })()
        `);
        await sleep(500);
      }
      console.log(`[command-executor] Scrolled chat up ${times} times`);
    });
  }

  async scrollChatToBottom(commandId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const containerSelectors = this.selectors.chatContainer.strategies;
      await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(containerSelectors)};
          for (const sel of strategies) {
            try {
              const el = document.querySelector(sel);
              if (el) {
                const scrollable = el.querySelector('[class*="scroll"]') || el;
                scrollable.scrollTop = scrollable.scrollHeight;
                return true;
              }
            } catch {}
          }
          return false;
        })()
      `);
      console.log('[command-executor] Scrolled chat to bottom');
    });
  }

  /**
   * Switch to a sidebar session.
   *
   * Sidebar rows have no id, so we can only click by position — the "target
   * id" must first map to "Nth row in the same-title group":
   *   1. Anchor align: where the currently open session (composer bar
   *      data-composer-id) ranks in the sidebar same-title group vs in the
   *      same-name id sequence (DB recency descending) → offset → target row;
   *   2. Same-title index (sameTitleIndex from extraction) as fallback;
   *   3. If neither works, try from the first same-title row onward.
   * After every click, re-read the composer bar: matching the target id is
   * success; a different id means the wrong row — try the next candidate
   * (cap = same-title row count). Used to click the first title match and
   * return ok even if nothing moved.
   */
  async switchTab(
    commandId: string,
    tabTitle: string,
    _selectorPath?: string,
    target?: SwitchTabTarget,
  ): Promise<CommandResult> {
    if (this.windowKind() === 'agents') {
      return this.switchAgentsRow(commandId, tabTitle, target);
    }
    const wantId = isPlaceholderComposerId(target?.composerId) ? '' : target!.composerId!;
    // Same-name id sequence (empty if the DB is unreadable → degrade to same-title index click + re-read verify)
    const idOrder = wantId ? sameNameIdsFor(wantId, tabTitle) : [];
    const result = await this.withRetryValue(commandId, async (client) => {
      const outcome = await client.evaluate(`
        (async () => {
          const title = ${JSON.stringify(tabTitle)};
          const wantId = ${JSON.stringify(wantId)};
          const wantIdx = ${JSON.stringify(typeof target?.sameTitleIndex === 'number' ? target.sameTitleIndex : -1)};
          const idOrder = ${JSON.stringify(idOrder)};
          const occluded = !!(document.hidden || document.visibilityState !== 'visible');
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const done = (extra) => Object.assign({ occluded }, extra);
          const norm = s => s.trim().replace(/\\s+/g, ' ').toLowerCase();
          const target = norm(title);
          function cleanTabTitle(raw) {
            let t = (raw || '').trim().replace(/\\s+/g, ' ');
            t = t.replace(/(@[\\w./]+)+\\s*$/, '');
            return t.trim().substring(0, 120);
          }
          function glassCompositeForBtn(btn) {
            const labelEl = btn.querySelector('.ui-sidebar-menu-button-label');
            const rawAgent = (labelEl?.textContent || '').trim();
            if (!rawAgent) return { composite: '', agentOnly: '' };
            const group = btn.closest('.ui-sidebar-group');
            const gt = group?.querySelector('.ui-sidebar-group-label-title');
            const rawGroup = (gt?.textContent || '').trim();
            let composite = cleanTabTitle(rawAgent);
            if (rawGroup) {
              const g = cleanTabTitle(rawGroup);
              if (g) composite = (g + ' / ' + cleanTabTitle(rawAgent)).substring(0, 120);
            }
            return { composite: norm(composite), agentOnly: norm(rawAgent) };
          }
          const composerIdOf = () => {
            const el = document.querySelector('div.composer-bar.editor[data-composer-id]');
            return el ? (el.getAttribute('data-composer-id') || '') : '';
          };
          // Already on the session we want: do not click any row; treat as landed.
          // Must run before enumerating same-title rows — draft sessions (click +,
          // new, no first message yet) have no sidebar row; if we first take the
          // "same-title → fuzzy → editor tab" fallback we end with Tab not found
          // and send fails with it (measured 2026-09-16 on mobile: new session
          // created but cannot talk).
          const alreadyOpen = composerIdOf();
          if (wantId && alreadyOpen === wantId) {
            return done({ clicked: true, landedComposerId: alreadyOpen, tried: 0, via: 'already' });
          }
          const cellIsSelected = (row) =>
            row.getAttribute('data-selected') === 'true'
            || row.getAttribute('data-highlighted') === 'true'
            || row.classList.contains('selected')
            || row.classList.contains('active');
          // Same-title rows. Re-enumerate before every click: switching a session reorders the sidebar by recency.
          const sameTitleRows = () => {
            const cells = Array.from(document.querySelectorAll(
              '.agent-sidebar-list .agent-sidebar-cell, .agent-sidebar-cell'
            ));
            return cells
              .filter((cell) => !cell.closest('.agent-sidebar-header-actions'))
              .filter((cell) => {
                const titleEl = cell.querySelector('.agent-sidebar-cell-text');
                const text = norm(titleEl ? (titleEl.textContent || '') : (cell.textContent || ''));
                return text === target;
              });
          };

          // Global rail (glass sidebar): this list is not tied to the in-window
          // composer bar; keep click-by-name; if the name is ambiguous, error clearly, do not guess.
          const glassBtns = Array.from(document.querySelectorAll(
            '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > .ui-sidebar-menu-button, '
            + '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn'
          ));
          if (glassBtns.length > 0) {
            const glassRows = glassBtns.map((btn) => ({
              btn,
              ...glassCompositeForBtn(btn),
            })).filter((r) => r.composite);
            const byComp = glassRows.filter((r) => r.composite === target);
            if (byComp.length === 1) {
              byComp[0].btn.click();
              return done({ clicked: true, landedComposerId: composerIdOf(), tried: 1, via: 'glass' });
            }
            const byAgent = glassRows.filter((r) => r.agentOnly === target);
            if (byAgent.length === 1) {
              byAgent[0].btn.click();
              return done({ clicked: true, landedComposerId: composerIdOf(), tried: 1, via: 'glass' });
            }
            if (byComp.length > 1 || byAgent.length > 1) {
              throw new Error('Ambiguous tab title for glass sidebar: ' + title);
            }
          }

          const rows = sameTitleRows();
          if (rows.length === 0) {
            // Exact miss: old fuzzy fallback (prefix/contains) — nearby names
            // can click the wrong row, so mark via
            const cells = document.querySelectorAll('.agent-sidebar-list .agent-sidebar-cell, .agent-sidebar-cell');
            for (const cell of Array.from(cells)) {
              if (cell.closest('.agent-sidebar-header-actions')) continue;
              const titleEl = cell.querySelector('.agent-sidebar-cell-text');
              const text = norm(titleEl ? (titleEl.textContent || '') : (cell.textContent || ''));
              if (text.startsWith(target) || target.startsWith(text)) {
                cell.click();
                return done({ clicked: true, landedComposerId: composerIdOf(), tried: 1, via: 'fuzzy' });
              }
            }
            // Editor Chat tabs carry data-resource-name (real composerId): click by id, ignore title.
            // Draft sessions (+ new) have only this click path — no sidebar row, and the
            // title is still Cursor's "New Agent" (filtered as chrome), so name search never finds them.
            if (wantId) {
              for (const tab of Array.from(document.querySelectorAll('.tabs-container .tab[role="tab"]'))) {
                if (tab.getAttribute('data-resource-name') !== wantId) continue;
                tab.click();
                let byIdLanded = composerIdOf();
                const byIdDeadline = Date.now() + 700;
                while (byIdLanded !== wantId && Date.now() < byIdDeadline) {
                  await sleep(60);
                  byIdLanded = composerIdOf();
                }
                return done({ clicked: true, landedComposerId: byIdLanded, tried: 1, via: 'editor-tab-id' });
              }
            }
            for (const tab of Array.from(document.querySelectorAll('.tabs-container .tab[role="tab"]'))) {
              const aria = tab.getAttribute('aria-label') || '';
              if (!/Chat Editors/i.test(aria)) continue;
              const labelEl = tab.querySelector('.label-name');
              const text = norm((labelEl?.textContent || '').trim() || aria.split(',')[0]);
              if (text === target || text.startsWith(target) || target.startsWith(text)) {
                tab.click();
                return done({ clicked: true, landedComposerId: composerIdOf(), tried: 1, via: 'editor-tab' });
              }
            }
            return done({ clicked: false, landedComposerId: composerIdOf(), tried: 0 });
          }

          const before = composerIdOf();
          if (wantId && before === wantId) {
            // Already viewing this session: no click needed
            return done({ clicked: true, landedComposerId: before, tried: 0, via: 'already' });
          }

          // Click order: anchor prediction → same-title index → the rest
          const order = [];
          const anchorRowIdx = rows.findIndex(cellIsSelected);
          const anchorDbIdx = before ? idOrder.indexOf(before) : -1;
          const wantDbIdx = wantId ? idOrder.indexOf(wantId) : -1;
          const confident = anchorRowIdx >= 0 && anchorDbIdx >= 0 && wantDbIdx >= 0;
          if (confident) {
            const predicted = wantDbIdx - (anchorDbIdx - anchorRowIdx);
            if (predicted >= 0 && predicted < rows.length) {
              order.push(predicted);
            } else if (wantId) {
              // Anchor is trustworthy but the target is not on this screen (folded / paged / filtered): do not click some other session
              return done({ clicked: false, landedComposerId: before, tried: 0, reason: 'target-not-in-sidebar' });
            }
          }
          if (wantIdx >= 0 && wantIdx < rows.length && order.indexOf(wantIdx) < 0) order.push(wantIdx);
          for (let i = 0; i < rows.length; i++) if (order.indexOf(i) < 0) order.push(i);

          if (!wantId) {
            // Target id unknown (new session not in the DB yet): click once by index; cannot verify after
            const row = sameTitleRows()[order[0]];
            if (!row) return done({ clicked: false, landedComposerId: composerIdOf(), tried: 0 });
            row.scrollIntoView({ block: 'nearest' });
            row.click();
            return done({ clicked: true, landedComposerId: composerIdOf(), tried: 1, unverified: true });
          }

          let tried = 0;
          for (const idx of order) {
            const current = sameTitleRows()[idx];
            if (!current) continue;
            current.scrollIntoView({ block: 'nearest' });
            current.click();
            tried++;
            let landed = composerIdOf();
            const deadline = Date.now() + 900;
            while (landed !== wantId && Date.now() < deadline) {
              await sleep(60);
              landed = composerIdOf();
            }
            if (landed === wantId) return done({ clicked: true, landedComposerId: landed, tried });
            // Composer bar unreadable (window has no open composer): cannot verify; stop clicking blindly
            if (!landed) return done({ clicked: true, landedComposerId: '', tried, unverified: true });
            // A different id = wrong row; try the next same-title candidate
          }
          return done({ clicked: false, landedComposerId: composerIdOf(), tried });
        })()
      `) as SwitchTabOutcome | null;
      return outcome ?? { clicked: false, occluded: true, tried: 0 };
    });
    if (!result.ok)
      return result;
    const outcome = (result.data ?? { clicked: false, occluded: false, tried: 0 }) as SwitchTabOutcome;
    if (outcome.clicked !== true) {
      return { commandId, ok: false, error: `Tab not found: ${tabTitle}`, data: outcome };
    }
    if (wantId && outcome.landedComposerId && outcome.landedComposerId !== wantId) {
      const landed = outcome.landedComposerId.substring(0, 8);
      console.warn(`[command-executor] Switch landed on ${landed}… but wanted ${wantId.substring(0, 8)}…`);
      return {
        commandId,
        ok: false,
        error: `点了「${tabTitle}」但落到别的会话（${landed}…）`,
        data: outcome,
      };
    }
    console.log(
      `[command-executor] Switched tab: ${tabTitle}`
      + `${outcome.landedComposerId ? ` → ${outcome.landedComposerId.substring(0, 8)}…` : ''}`
      + `${outcome.tried ? ` (tried ${outcome.tried}${outcome.via ? `, via ${outcome.via}` : ''})` : ''}`,
    );
    return { commandId, ok: true, data: outcome };
  }

  async activateCurrentTab(commandId: string): Promise<CommandResult> {
    if (!this.client || !this.client.isConnected()) {
      return { commandId, ok: false, error: 'Not connected to Cursor' };
    }
    let tabs: WindowSessionTab[] = [];
    try {
      const listed = await this.client.evaluate(LIST_CURSOR_SESSION_TABS_JS);
      tabs = Array.isArray(listed) ? listed as WindowSessionTab[] : [];
    }
    catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { commandId, ok: false, error };
    }
    const title = pickWindowSession(tabs);
    if (!title) {
      timingLog('cursor-activate', { commandId, activated: false, n: tabs.length });
      return { commandId, ok: true, data: { activated: false } };
    }
    const clicked = await this.switchTab(commandId, title);
    if (!clicked.ok)
      return clicked;
    timingLog('cursor-activate', { commandId, activated: true, title });
    return {
      ...clicked,
      data: {
        ...(clicked.data && typeof clicked.data === 'object' ? clicked.data : {}),
        activated: true,
        title,
      },
    };
  }

  /**
   * Switch agent in the Agents window: click the row by (section + title +
   * same-title index), then re-read the composer bar to verify. Rows have no
   * composerId of their own, so "re-read id === target id" is the only
   * reliable land proof; drafts (placeholder id) have nothing to verify —
   * a click is success.
   */
  private async switchAgentsRow(
    commandId: string,
    tabTitle: string,
    target?: SwitchTabTarget,
  ): Promise<CommandResult> {
    const wantId = isPlaceholderComposerId(target?.composerId) ? '' : target!.composerId!;
    const section = target?.section ?? '';
    const wantIdx = typeof target?.sameTitleIndex === 'number' ? target.sameTitleIndex : -1;
    const result = await this.withRetryValue(commandId, async (client) => {
      const outcome = await client.evaluate(`
        (async () => {
          const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
          const title = clean(${JSON.stringify(tabTitle)});
          const section = clean(${JSON.stringify(section)});
          const wantIdx = ${JSON.stringify(wantIdx)};
          const wantId = ${JSON.stringify(wantId)};
          const rows = Array.from(document.querySelectorAll(${JSON.stringify(AGENTS_ROW_SELECTOR)}));
          const sectionOf = (el) => clean(
            el.closest('.ui-sidebar-section')?.querySelector('[data-section-head] .ui-sidebar-menu-button-label')?.textContent
          );
          let hits = rows.filter((el) => clean(el.querySelector('.ui-sidebar-menu-button-label')?.textContent) === title);
          if (section) {
            const scoped = hits.filter((el) => sectionOf(el) === section);
            if (scoped.length > 0) hits = scoped;
          }
          if (hits.length === 0) return { ok: false, error: 'Tab not found: ' + title };
          const composerIdOf = () =>
            document.querySelector('div.composer-bar.editor[data-composer-id]')?.getAttribute('data-composer-id') || '';
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const order = [];
          if (wantIdx >= 0 && wantIdx < hits.length) order.push(wantIdx);
          for (let i = 0; i < hits.length; i++) if (!order.includes(i)) order.push(i);
          let landed = '';
          for (const i of order) {
            hits[i].scrollIntoView({ block: 'center' });
            hits[i].click();
            await sleep(400);
            landed = composerIdOf();
            if (!wantId) return { ok: true, landedComposerId: landed, tried: i + 1, via: 'agents' };
            if (landed === wantId) return { ok: true, landedComposerId: landed, tried: i + 1, via: 'agents' };
          }
          return {
            ok: false,
            error: '点了 ' + title + ' 但落到别的 agent（want ' + wantId + ' got ' + (landed || 'none') + '）',
          };
        })()
      `) as { ok: boolean; error?: string; landedComposerId?: string; tried?: number; via?: string } | null;
      if (!outcome?.ok)
        throw new Error(outcome?.error ?? `Tab not found: ${tabTitle}`);
      return outcome;
    });
    if (!result.ok)
      return result;
    return { commandId, ok: true, data: result.data };
  }

  /**
   * Live state of a new draft: pin `Run on` to `This Mac` (return the error
   * copy if it will not stick). **Not wrapped in withRetry**: retrying is
   * pointless (and the draft already exists; do not click New Agent again).
   *
   * Same interaction as "pick model / send": pure `.click()` + re-read
   * verify (the page side already has a menu state machine: confirm the
   * menu is not open before opening it; on failure Escape-close then retry).
   * **Do not** click by coordinates — that is extra and brittle if the
   * element moves (coords are CSS pixels and independent of zoom, but there
   * is no reason to take that extra risk).
   */
  private async ensureAgentsRunOnLocal(): Promise<{ ok: true; after: string } | { ok: false; error: string }> {
    const client = this.client;
    if (!client || !client.isConnected())
      return { ok: false, error: 'Not connected to Cursor' };
    let last = 'UNKNOWN';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const out = await client.evaluate(agentsRunOnLocalJS()) as
          | { ok: boolean; before?: string; after?: string; changed?: boolean; error?: string }
          | null;
        if (out?.ok)
          return { ok: true, after: out.after ?? '' };
        last = `${out?.error ?? 'UNKNOWN'}（当前 ${out?.before ?? '?'}）`;
      }
      catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      await sleep(400);
    }
    return { ok: false, error: last };
  }

  /**
   * New in the Agents window: with a section, click that section's `New Agent`;
   * without, click top-of-sidebar `New Chat`. Drafts have no composerId — we
   * can only confirm "the button was clicked"; but we **must** also pin run
   * location to this machine (`Run on: This Mac`): `No Repo` may default to
   * Cloud, which would create a cloud agent (body unreadable). If the pin
   * fails, error — do not let the user think it succeeded and then send
   * (that is when a cloud agent is actually created).
   */
  private async newAgentsChat(commandId: string, section?: string): Promise<CommandResult> {
    const clicked = await this.withRetry(commandId, async (client) => {
      const outcome = await client.evaluate(`
        (() => {
          const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
          const section = clean(${JSON.stringify(section ?? '')});
          if (section) {
            const sec = Array.from(document.querySelectorAll('.ui-sidebar-section')).find(
              (s) => clean(s.querySelector('[data-section-head] .ui-sidebar-menu-button-label')?.textContent) === section
            );
            if (!sec) return { ok: false, error: 'Section not found: ' + section };
            const head = sec.querySelector('[data-section-head]');
            if (head && head.getAttribute('data-section-expanded') !== 'true') head.click();
            const btn = sec.querySelector('[data-section-head] button[aria-label="New Agent"]');
            if (!btn) return { ok: false, error: 'New Agent button not found' };
            btn.click();
            return { ok: true, via: 'section' };
          }
          const primary = document.querySelector('[data-sidebar-primary-action][data-action-id="new-agent"]');
          if (!primary) return { ok: false, error: 'New Agent button not found' };
          primary.click();
          return { ok: true, via: 'primary' };
        })()
      `) as { ok: boolean; error?: string } | null;
      if (!outcome?.ok)
        throw new Error(outcome?.error ?? 'New Agent button not found');
    });
    if (!clicked.ok)
      return clicked;

    const runOn = await this.ensureAgentsRunOnLocal();
    if (!runOn.ok) {
      return {
        commandId,
        ok: false,
        error: `已建出草稿，但没能把运行位置切到「This Mac」：${runOn.error}。`
          + `请在 IDE 里手动切一下（或丢弃这条草稿），否则发消息会建出云 agent（正文本地读不到）`,
      };
    }
    console.log(`[command-executor] New agent created in Agents window (run on: ${runOn.after})`);
    return { commandId, ok: true, data: { runOn: runOn.after } };
  }

  async newChat(commandId: string, opts?: { section?: string }): Promise<CommandResult> {
    if (this.windowKind() === 'agents') {
      return this.newAgentsChat(commandId, opts?.section);
    }
    return this.withRetry(commandId, async (client) => {
      const strategies = this.selectors.newChatButton?.strategies ?? [];
      const result = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          for (const sel of strategies) {
            try {
              const el = document.querySelector(sel);
              if (el) { el.click(); return true; }
            } catch {}
          }
          return false;
        })()
      `) as boolean;
      if (!result)
        throw new Error('New Chat button not found');
      console.log(`[command-executor] New chat created`);
    });
  }

  async setMode(commandId: string, modeId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const strategies = this.selectors.modeDropdown?.strategies ?? [];

      // Click the dropdown trigger to open the menu
      const opened = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          for (const sel of strategies) {
            try {
              const el = document.querySelector(sel);
              if (el) { el.click(); return true; }
            } catch {}
          }
          return false;
        })()
      `) as boolean;
      if (!opened)
        throw new Error('Mode dropdown not found');

      await sleep(250);

      // Click the mode item whose ID ends with the modeId
      const selected = await client.evaluate(`
        (() => {
          const modeId = ${JSON.stringify(modeId)};
          const items = document.querySelectorAll('[id*="composer-mode-"][id$="-' + modeId + '"]');
          for (const item of Array.from(items)) {
            const clickable = item.querySelector('.composer-unified-context-menu-item') || item;
            clickable.click();
            return true;
          }
          return false;
        })()
      `) as boolean;
      if (!selected)
        throw new Error(`Mode "${modeId}" not found in dropdown`);
      console.log(`[command-executor] Mode set to: ${modeId}`);
    });
  }

  async clickAction(commandId: string, selectorPath: string, expectedLabel?: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      if (expectedLabel === undefined) {
        await client.click(selectorPath);
        console.log(`[command-executor] Clicked action: ${selectorPath.substring(0, 60)}`);
        return;
      }

      const result = await client.evaluate(`
        (() => {
          ${ACTION_CLICK_RESOLVER_JS}

          const selectorPath = ${JSON.stringify(selectorPath)};
          const expectedLabel = ${JSON.stringify(expectedLabel)};
          const target = resolveActionClickTarget(document, selectorPath, expectedLabel);
          if (!target.element) return { ok: false, error: target.error };

          target.element.scrollIntoView({ block: 'center', behavior: 'instant' });
          target.element.click();
          return { ok: true };
        })()
      `) as { ok: boolean; error?: string } | null;

      if (!result?.ok) {
        throw new Error(result?.error ?? `action target not found (label: ${expectedLabel})`);
      }
      console.log(`[command-executor] Clicked action: ${selectorPath.substring(0, 60)} (${expectedLabel})`);
    });
  }

  async extractToolContent(toolCallId: string): Promise<{ code: string; language?: string; filename?: string } | null> {
    if (!this.client || !this.client.isConnected())
      return null;

    const result = await this.client.evaluate(`
      (() => {
        const tcId = ${JSON.stringify(toolCallId)};
        const wrapperSel = ${JSON.stringify(MESSAGE_WRAPPER_SELECTOR)};
        const wrapper = document.querySelector('[data-tool-call-id="' + tcId + '"]')
          || document.querySelector('[data-tool-call-id="' + tcId + '"]')?.closest(wrapperSel)
          || (() => {
            for (const el of document.querySelectorAll(wrapperSel)) {
              const inner = el.querySelector('[data-tool-call-id="' + tcId + '"]');
              if (inner) return el;
            }
            return null;
          })();
        if (!wrapper) return null;

        const wasCollapsed = !!wrapper.querySelector('.composer-tool-former-message');
        if (wasCollapsed) {
          const header = wrapper.querySelector('.composer-tool-former-message') || wrapper.querySelector('.ui-collapsible-header');
          if (header) header.click();
        }

        function extract() {
          // Edit tool: look for code content in the diff viewer
          const codeContent = wrapper.querySelector('.ui-default-code__content');
          if (codeContent) {
            const lines = codeContent.querySelectorAll('.ui-default-code__line-content');
            const code = lines.length > 0
              ? Array.from(lines).map(l => l.textContent || '').join('\\n')
              : (codeContent.textContent || '').trim();

            const headerEl = wrapper.querySelector('.ui-code-block-header');
            const language = headerEl?.getAttribute('data-language') || undefined;
            const filenameEl = wrapper.querySelector('.ui-edit-tool-call__filename')
              || wrapper.querySelector('.ui-code-block-filename');
            const filename = filenameEl ? (filenameEl.textContent || '').trim() : undefined;
            return { code, language, filename };
          }

          // Shell tool output
          const shellOutput = wrapper.querySelector('.composer-terminal-output') || wrapper.querySelector('.xterm-rows');
          if (shellOutput) {
            return { code: (shellOutput.textContent || '').trim(), language: 'bash', filename: undefined };
          }

          // Generic expanded content
          const preEl = wrapper.querySelector('pre');
          if (preEl) {
            return { code: (preEl.textContent || '').trim(), language: undefined, filename: undefined };
          }

          // Full text fallback
          const text = (wrapper.textContent || '').trim();
          if (text.length > 0) return { code: text, language: undefined, filename: undefined };
          return null;
        }

        if (wasCollapsed) {
          return '__NEED_WAIT__';
        }
        return extract();
      })()
    `) as { code: string; language?: string; filename?: string } | '__NEED_WAIT__' | null;

    if (result === '__NEED_WAIT__') {
      await sleep(600);
      const expanded = await this.client.evaluate(`
        (() => {
          const tcId = ${JSON.stringify(toolCallId)};
          const wrapperSel = ${JSON.stringify(MESSAGE_WRAPPER_SELECTOR)};
          const wrapper = document.querySelector('[data-tool-call-id="' + tcId + '"]')
            || (() => {
              for (const el of document.querySelectorAll(wrapperSel)) {
                const inner = el.querySelector('[data-tool-call-id="' + tcId + '"]');
                if (inner) return el;
              }
              return null;
            })();
          if (!wrapper) return null;

          const codeContent = wrapper.querySelector('.ui-default-code__content');
          if (codeContent) {
            const lines = codeContent.querySelectorAll('.ui-default-code__line-content');
            const code = lines.length > 0
              ? Array.from(lines).map(l => l.textContent || '').join('\\n')
              : (codeContent.textContent || '').trim();
            const headerEl = wrapper.querySelector('.ui-code-block-header');
            const language = headerEl?.getAttribute('data-language') || undefined;
            const filenameEl = wrapper.querySelector('.ui-edit-tool-call__filename')
              || wrapper.querySelector('.ui-code-block-filename');
            const filename = filenameEl ? (filenameEl.textContent || '').trim() : undefined;
            return { code, language, filename };
          }

          const shellOutput = wrapper.querySelector('.composer-terminal-output') || wrapper.querySelector('.xterm-rows');
          if (shellOutput) {
            return { code: (shellOutput.textContent || '').trim(), language: 'bash', filename: undefined };
          }

          const preEl = wrapper.querySelector('pre');
          if (preEl) return { code: (preEl.textContent || '').trim(), language: undefined, filename: undefined };

          const text = (wrapper.textContent || '').trim();
          if (text.length > 0) return { code: text, language: undefined, filename: undefined };
          return null;
        })()
      `) as { code: string; language?: string; filename?: string } | null;

      // Collapse back
      await this.client.evaluate(`
        (() => {
          const tcId = ${JSON.stringify(toolCallId)};
          const wrapperSel = ${JSON.stringify(MESSAGE_WRAPPER_SELECTOR)};
          const wrapper = document.querySelector('[data-tool-call-id="' + tcId + '"]')
            || (() => {
              for (const el of document.querySelectorAll(wrapperSel)) {
                const inner = el.querySelector('[data-tool-call-id="' + tcId + '"]');
                if (inner) return el;
              }
              return null;
            })();
          if (!wrapper) return;
          const header = wrapper.querySelector('.ui-collapsible-header') || wrapper.querySelector('.composer-tool-former-message');
          if (header) header.click();
        })()
      `);

      return expanded;
    }

    return result;
  }

  async setModel(commandId: string, modelId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      // Steps 1-2: open the composer picker — and, on Cursor 3.18.9+, the
      // model-list submenu behind its "Model" row.
      await this.openModelListMenu(client);

      // Step 3: Find and click the model item via the shared helper so
      // setModel, setPlanModel, and the web client all resolve the
      // same way.
      const selected = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          ${MODEL_ITEM_HELPERS_JS}
          return pickModelById(findModelMenu(), ${JSON.stringify(modelId)});
        })()
      `) as boolean;
      if (!selected)
        throw new Error(`Model "${modelId}" not found in dropdown`);

      await sleep(200);

      // Step 4: Verify dropdown closed (confirms selection was accepted)
      const menuStillOpen = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          return findModelMenu() !== null;
        })()
      `) as boolean;
      if (menuStillOpen) {
        console.warn(`[command-executor] Model dropdown still open — pressing Escape`);
        await client.pressKey('Escape', 'Escape', 27);
        await sleep(100);
      }

      console.log(`[command-executor] Model set to: ${modelId} (menu closed: ${!menuStillOpen})`);
    });
  }

  async getModelOptions(commandId: string): Promise<CommandResult> {
    const result = await this.withRetryValue(commandId, async (client) => {
      return await this.openModelMenuAndReadOptions(client);
    });
    if (!result.ok)
      return result;
    return { commandId, ok: true, data: result.data };
  }

  async getPlanModelOptions(commandId: string, selectorPath: string): Promise<CommandResult> {
    const result = await this.withRetryValue(commandId, async (client) => {
      return await this.openPlanModelMenuAndReadOptions(client, selectorPath);
    });
    if (!result.ok)
      return result;
    return { commandId, ok: true, data: result.data };
  }

  async setPlanModel(commandId: string, selectorPath: string, planModelId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      await this.openPlanModelMenu(client, selectorPath);
      const selected = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          ${MODEL_ITEM_HELPERS_JS}
          return pickModelById(findModelMenu(), ${JSON.stringify(planModelId)});
        })()
      `) as boolean;
      if (!selected)
        throw new Error(`Plan model "${planModelId}" not found`);

      await sleep(200);
      const menuStillOpen = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          return findModelMenu() !== null;
        })()
      `) as boolean;
      if (menuStillOpen) {
        await client.pressKey('Escape', 'Escape', 27);
        await sleep(100);
      }
      console.log(`[command-executor] Plan model set to: ${planModelId}`);
    });
  }

  private async withRetry(
    commandId: string,
    action: (client: CdpClient) => Promise<void>,
  ): Promise<CommandResult> {
    if (!this.client || !this.client.isConnected()) {
      return { commandId, ok: false, error: 'Not connected to Cursor' };
    }

    let lastError: string | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await action(this.client);
        return { commandId, ok: true };
      }
      catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        timingLog('cmd:retry', { commandId, attempt: attempt + 1, error: lastError });
        console.warn(
          `[command-executor] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${lastError}`,
        );
        if (attempt < MAX_RETRIES && isRetryableCommandError(lastError)) {
          await sleep(RETRY_DELAY_MS);
        }
        else {
          break;
        }
      }
    }

    return { commandId, ok: false, error: lastError };
  }

  private async withRetryValue<T>(
    commandId: string,
    action: (client: CdpClient) => Promise<T>,
  ): Promise<CommandResult & { data?: T }> {
    if (!this.client || !this.client.isConnected()) {
      return { commandId, ok: false, error: 'Not connected to Cursor' };
    }

    let lastError: string | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await action(this.client);
        return { commandId, ok: true, data };
      }
      catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        timingLog('cmd:retry', { commandId, attempt: attempt + 1, error: lastError });
        console.warn(
          `[command-executor] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${lastError}`,
        );
        if (attempt < MAX_RETRIES && isRetryableCommandError(lastError)) {
          await sleep(RETRY_DELAY_MS);
        }
        else {
          break;
        }
      }
    }

    return { commandId, ok: false, error: lastError };
  }

  private async openPlanModelMenu(client: CdpClient, selectorPath: string): Promise<void> {
    const opened = await client.evaluate(`
      (() => {
        const selector = ${JSON.stringify(selectorPath)};
        const el = document.querySelector(selector);
        if (!el) return false;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.click();
        return true;
      })()
    `) as boolean;
    if (!opened)
      throw new Error('Plan model dropdown trigger not found');

    await sleep(300);
    const menuVisible = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        return findModelMenu() !== null;
      })()
    `) as boolean;
    if (!menuVisible)
      throw new Error('Plan model picker did not open');
  }

  private async openPlanModelMenuAndReadOptions(
    client: CdpClient,
    selectorPath: string,
  ): Promise<{ options: PlanModelOption[] }> {
    await this.openPlanModelMenu(client, selectorPath);

    const options = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        ${MODEL_ITEM_HELPERS_JS}
        return collectModelItems(findModelMenu());
      })()
    `) as PlanModelOption[];

    await client.pressKey('Escape', 'Escape', 27);
    await sleep(100);
    return { options };
  }

  /**
   * Click the composer's model-picker trigger. Skips any trigger whose id
   * starts with `plan-exec-model` (those belong to the plan-execution picker,
   * not the composer's model picker).
   */
  private async clickModelTrigger(client: CdpClient): Promise<boolean> {
    const strategies = this.selectors.modelDropdown?.strategies ?? [];
    return await client.evaluate(`
      (() => {
        const strategies = ${JSON.stringify(strategies)};
        for (const sel of strategies) {
          try {
            const candidates = document.querySelectorAll(sel);
            for (const c of Array.from(candidates)) {
              const cId = c.getAttribute('id') || '';
              if (cId.startsWith('plan-exec-model')) continue;
              c.click();
              return true;
            }
          } catch {}
        }
        return false;
      })()
    `) as boolean;
  }

  private async modelMenuVisible(client: CdpClient): Promise<boolean> {
    return await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        return findModelMenu() !== null;
      })()
    `) as boolean;
  }

  /**
   * Open the composer's model picker and, on Cursor 3.18.9+, its model-list
   * submenu. Throws when the picker never opens; leaves the menu open.
   */
  private async openModelListMenu(client: CdpClient): Promise<void> {
    const opened = await this.clickModelTrigger(client);
    if (!opened)
      throw new Error('Model dropdown trigger not found');

    await sleep(300);

    let menuVisible = await this.modelMenuVisible(client);
    if (!menuVisible) {
      // A previous Escape may not have landed yet, so that click toggled a
      // still-open menu shut. Click once more before giving up.
      await this.clickModelTrigger(client);
      await sleep(400);
      menuVisible = await this.modelMenuVisible(client);
    }
    if (!menuVisible)
      throw new Error('Model picker did not open');

    // 3.18.9+ keeps the list in a Radix submenu that only expands on a real
    // pointer move — synthetic mouse events are ignored.
    const row = await client.evaluate(`
      (() => {
        ${MODEL_ITEM_HELPERS_JS}
        ${MODEL_SUBMENU_HELPERS_JS}
        const el = findModelSubmenuRow();
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()
    `) as { x: number; y: number } | null;

    if (!row)
      return;

    for (let i = 0; i < 2; i += 1) {
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: row.x,
        y: row.y,
        button: 'none',
        buttons: 0,
        pointerType: 'mouse',
      });
      await sleep(250);
    }
    await sleep(500);

    const submenuVisible = await client.evaluate(`
      (() => {
        ${MODEL_ITEM_HELPERS_JS}
        ${MODEL_SUBMENU_HELPERS_JS}
        return findModelListSubmenu() !== null;
      })()
    `) as boolean;
    if (!submenuVisible)
      throw new Error('Model list submenu did not open');
  }

  private async openModelMenuAndReadOptions(
    client: CdpClient,
  ): Promise<{ options: PlanModelOption[] }> {
    await this.openModelListMenu(client);

    const options = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        ${MODEL_ITEM_HELPERS_JS}
        ${MODEL_SUBMENU_HELPERS_JS}
        const fromSubmenu = collectSubmenuModelItems(findModelListSubmenu());
        return fromSubmenu.length > 0 ? fromSubmenu : collectModelItems(findModelMenu());
      })()
    `) as PlanModelOption[];

    await client.pressKey('Escape', 'Escape', 27);
    await sleep(100);
    return { options };
  }

  private async findApproveAllButton(client: CdpClient): Promise<string | null> {
    const found = await client.evaluate(`
      (() => {
        const keywords = ${JSON.stringify(this.selectors.approveButton.textMatch ?? [])};
        const strategies = ${JSON.stringify(this.selectors.approveButton.strategies)};
        const containerStrategies = ${JSON.stringify(this.selectors.chatContainer.strategies)};
        let root = null;
        for (const sel of containerStrategies) {
          try {
            root = document.querySelector(sel);
            if (root) break;
          } catch {}
        }
        if (!root) root = document.body;

        // Skip menu-trigger buttons (e.g. Cursor's "Auto-Run in Sandbox"
        // mode dropdown) — they open a settings menu, not an approval.
        const isMenuTrigger = (b) => {
          const p = b.getAttribute('aria-haspopup');
          return p === 'menu' || p === 'true' || p === 'listbox';
        };

        for (const selector of strategies) {
          try {
            const buttons = root.querySelectorAll(selector);
            for (const btn of Array.from(buttons)) {
              if (isMenuTrigger(btn)) continue;
              const text = (btn.textContent || '').trim().toLowerCase();
              if (text.includes('all')) {
                btn.scrollIntoView({ block: 'center' });
                btn.click();
                return true;
              }
            }
          } catch {}
        }

        const allButtons = root.querySelectorAll('button');
        for (const btn of Array.from(allButtons)) {
          if (isMenuTrigger(btn)) continue;
          const text = (btn.textContent || '').trim().toLowerCase();
          for (const kw of keywords) {
            if (kw.toLowerCase().includes('all') && text.includes(kw.toLowerCase())) {
              btn.scrollIntoView({ block: 'center' });
              btn.click();
              return true;
            }
          }
        }

        return false;
      })()
    `) as boolean;

    if (!found) {
      throw new Error('"Accept All" button not found');
    }
    return APPROVE_ALL_CLICKED_INLINE;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
