import type { CdpClient } from '../../cdp/client.js';
import type {
  ChatTab,
  CursorState,
  ModeInfo,
  ModelInfo,
  SelectorConfig,
  WindowKind,
} from '../../types.js';
import type { AgentsWindowDump } from './agents-window.js';
import { timingLog } from '../../timing-log.js';
import { emptyCursorState } from '../../types.js';
import {
  AGENTS_DUMP_TIMEOUT_MS,

  dumpAgentsWindow,
  mapAgentsWindowDump,
} from './agents-window.js';
import { postProcessCursorState } from './tab-identity.js';

const EVALUATE_TIMEOUT_MS = 12000;
export { EVALUATE_TIMEOUT_MS };
const MAX_POLL_BACKOFF_MS = 5000;

export interface DOMExtractorOptions {
  /** Kind of the current home window; when it returns agents, this round runs Agents-window extract. */
  activeWindowKind?: () => WindowKind;
}

export interface MessageWrapperSelection {
  element: Element;
  index: number;
}

// Keep this in sync with the inline copy inside extractionFunction. The inline
// copy is required because extractionFunction is serialized into Cursor's renderer.
export function selectMessageWrappers(container: ParentNode): MessageWrapperSelection[] {
  const dedupeNestedMatches = (elements: Element[]): Element[] => {
    const matched = new Set(elements);
    return elements.filter((element) => {
      let parent = element.parentElement;
      while (parent) {
        if (matched.has(parent))
          return false;
        parent = parent.parentElement;
      }
      return true;
    });
  };

  const wrappers = dedupeNestedMatches(
    Array.from(
      container.querySelectorAll(
        '[data-flat-index], [data-message-index], .composer-rendered-message[data-message-role], [data-message-role][data-message-id]',
      ),
    ),
  );

  return wrappers.map((element, position) => {
    const rawIndex = element.getAttribute('data-flat-index') ?? element.getAttribute('data-message-index');
    const parsedIndex = rawIndex === null ? NaN : parseInt(rawIndex, 10);
    return {
      element,
      index: Number.isNaN(parsedIndex) ? position : parsedIndex,
    };
  });
}

/** Canonical tab title cleaning - matches extractionFunction's cleanTabTitle for consistent lookups. */
export function cleanTabTitle(raw: string): string {
  let t = raw.trim().replace(/\s+/g, ' ');
  t = t.replace(/(@[\w./]+)+\s*$/, '');
  return t.trim().substring(0, 120);
}

/**
 * Runs inside Cursor's renderer process via Runtime.evaluate.
 * Must be completely self-contained (no Node.js imports).
 *
 * Live-only extraction (status/tabs/approvals/input/queue/liveActions).
 * Chat transcript comes from content-live, not DOM scraping.
 * Uses Cursor data attributes for live widgets and activity signals.
 */
export function extractionFunction(
  containerSelectors: string[],
  approveSelectors: string[],
  approveTextMatch: string[],
  rejectSelectors: string[],
  rejectTextMatch: string[],
  inputSelectors: string[],
  statusSelectors: string[],
  chatTabSelectors: string[],
  modeSelectors: string[],
  modelSelectors: string[],
  windowTitle?: string,
): CursorState | null {
  function projectNameFromTitle(title: string): string {
    const idx = title.indexOf(' [');
    return (idx >= 0 ? title.substring(0, idx) : title).trim();
  }
  function findFirst(selectors: string[]): Element | null {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el)
          return el;
      }
      catch { /* skip */ }
    }
    return null;
  }

  function isLiveChatContainer(el: Element): boolean {
    // Cursor 3.x keeps `#workbench.parts.auxiliarybar` in the tree with class
    // `empty` (welcome chrome) even when the live transcript lives in a sibling
    // embedded editor (`div.composer-bar.editor`). Approvals/questionnaires
    // are inside that composer; scraping the empty aux yields none.
    if (el.classList.contains('composer-bar'))
      return true;
    return !!el.querySelector(
      'div.composer-bar.editor, .ui-shell-tool-call__approval-row, [data-composer-id], [data-flat-index], [data-message-role], [data-message-index]',
    );
  }

  function findChatContainer(selectors: string[]): Element | null {
    let fallback: Element | null = null;
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (!el)
          continue;
        if (!fallback)
          fallback = el;
        if (isLiveChatContainer(el))
          return el;
      }
      catch { /* skip */ }
    }
    return fallback;
  }

  function buildSelectorPath(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) {
        seg += `#${cur.id.replace(/([.:])/g, '\\$1')}`;
        parts.unshift(seg);
        break;
      }
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === cur!.tagName);
        if (siblings.length > 1) {
          seg += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(seg);
      cur = parent;
    }
    return parts.join(' > ');
  }

  try {
    const container = findChatContainer(containerSelectors);
    if (!container)
      return null;

    // Keep this in sync with selectMessageWrappers above. This copy must stay
    // self-contained because extractionFunction is serialized into Cursor's renderer.
    function dedupeNestedMessageMatches(elements: Element[]): Element[] {
      const matched = new Set(elements);
      return elements.filter((element) => {
        let parent = element.parentElement;
        while (parent) {
          if (matched.has(parent))
            return false;
          parent = parent.parentElement;
        }
        return true;
      });
    }

    const messageWrappers = dedupeNestedMessageMatches(
      Array.from(
        container.querySelectorAll(
          '[data-flat-index], [data-message-index], .composer-rendered-message[data-message-role], [data-message-role][data-message-id]',
        ),
      ),
    );

    const composerBarId
      = document.querySelector('div.composer-bar.editor[data-composer-id]')?.getAttribute('data-composer-id')
        || container.querySelector('div.composer-bar.editor[data-composer-id]')?.getAttribute('data-composer-id')
        || '';
    let containerComposerId
      = composerBarId
        || container.getAttribute('data-composer-id')
        || container.closest('[data-composer-id]')?.getAttribute('data-composer-id')
        || '';
    if (!containerComposerId && messageWrappers.length > 0) {
      const firstMsg = messageWrappers[0];
      containerComposerId = firstMsg.closest('[data-composer-id]')?.getAttribute('data-composer-id') || '';
    }

    const _rawElements: Array<{
      flatIndex: number;
      role?: string;
      kind?: string;
      messageId?: string;
      toolCallId?: string;
      toolStatus?: string;
      indicators: string[];
      textPreview: string;
      parsedAs: string;
    }> = [];

    function detectIndicators(el: Element): string[] {
      const flags: string[] = [];
      if (el.querySelector('.loading-indicator-v3'))
        flags.push('loading-v3');
      if (el.querySelector('.make-shine'))
        flags.push('make-shine');
      if (el.querySelector('.ui-collapsible.ui-step-group-collapsible'))
        flags.push('step-group');
      if (el.querySelector('.composer-tool-former-message'))
        flags.push('compact-tool');
      if (el.querySelector('.composer-terminal-tool-call-block-container')
        || el.querySelector('.composer-tool-call-container.composer-terminal-compact-mode')) {
        flags.push('run-command');
      }
      if (el.querySelector('.plan-execution-message-content'))
        flags.push('plan-execution');
      if (el.querySelector('.composer-create-plan-container'))
        flags.push('plan-create');
      if (el.querySelector('.composer-edit-file-review-wrapper'))
        flags.push('edit-review');
      if (el.querySelector('.todo-list-container'))
        flags.push('todo-list');
      if (el.querySelector('.ui-tool-call-line-action'))
        flags.push('tool-line');
      if (el.querySelector('.ui-edit-tool-call__filename'))
        flags.push('edit-file');
      if (el.querySelector('.composer-message-group'))
        flags.push('message-group');
      if (el.querySelector('.markdown-root'))
        flags.push('markdown');
      if (el.querySelector('.aislash-editor-input-readonly'))
        flags.push('human-input');
      return flags;
    }

    function extractToolActions(
      container: Element,
    ): { label: string; type: 'run' | 'skip' | 'allow'; selectorPath: string }[] {
      const actions: { label: string; type: 'run' | 'skip' | 'allow'; selectorPath: string }[] = [];
      const seenPaths = new Set<string>();

      const skipBtn = container.querySelector('.composer-skip-button');
      if (skipBtn) {
        const path = buildSelectorPath(skipBtn);
        seenPaths.add(path);
        actions.push({ label: 'Skip', type: 'skip' as const, selectorPath: path });
      }

      const runBtns = container.querySelectorAll('.composer-run-button, .anysphere-secondary-button');
      for (const btn of Array.from(runBtns)) {
        const path = buildSelectorPath(btn);
        if (seenPaths.has(path))
          continue;
        seenPaths.add(path);
        // The character class must include `^`: that is the **Windows Ctrl glyph** (macOS is `⌘`).
        // Measured live 2026-09-20: Windows Cursor 3.21.16 button copy is `Switch^⏎` / `Run^⏎`;
        // stripping only `⌘⌃⌥⇧` leaves `Switch^`, and exact compare all miss.
        const btnText = (btn.textContent || '').replace(/[⏎⌘⇧⌃⌥^]/g, '').trim();
        const isAllow
          = btn.classList.contains('anysphere-secondary-button') || btnText.toLowerCase().includes('allow');
        if (isAllow) {
          actions.push({ label: btnText, type: 'allow' as const, selectorPath: path });
        }
        else {
          actions.push({ label: btnText || 'Run', type: 'run' as const, selectorPath: path });
        }
      }

      return actions;
    }

    for (const [wrapperPosition, wrapper] of messageWrappers.entries()) {
      const rawFlatIndex = wrapper.getAttribute('data-flat-index') ?? wrapper.getAttribute('data-message-index');
      const parsedFlatIndex = rawFlatIndex === null ? NaN : parseInt(rawFlatIndex, 10);
      const flatIndex = Number.isNaN(parsedFlatIndex) ? wrapperPosition : parsedFlatIndex;

      const msgEl = wrapper.querySelector('[data-message-role]') || wrapper;
      let role = msgEl.getAttribute('data-message-role');
      const rowKind = msgEl.getAttribute('data-react-transcript-row-kind');
      let kind = msgEl.getAttribute('data-message-kind');
      if (!kind && rowKind === 'assistantMarkdown') {
        kind = 'assistant';
      }
      if (!kind && rowKind === 'activity') {
        const rowKey = msgEl.closest('[data-find-row-key]')?.getAttribute('data-find-row-key') || '';
        if (rowKey.startsWith('tool-placeholder:')) {
          kind = 'tool';
          if (!role)
            role = 'ai';
        }
        else if (rowKey.startsWith('activity-group:') && rowKey.includes(':thinking')) {
          kind = null;
        }
      }
      const messageId = msgEl.getAttribute('data-message-id') || `fi-${flatIndex}`;
      const toolEl
        = (wrapper.getAttribute('data-tool-call-id') ? wrapper : null)
          || wrapper.querySelector('[data-tool-call-id]');

      const rawEl = {
        flatIndex,
        role: role || undefined,
        kind: kind || undefined,
        messageId,
        toolCallId: toolEl?.getAttribute('data-tool-call-id') || undefined,
        toolStatus: (toolEl?.getAttribute('data-tool-status')
          || wrapper.getAttribute('data-tool-status')
          || undefined) as string | undefined,
        indicators: detectIndicators(wrapper),
        textPreview: (wrapper.textContent || '').trim().substring(0, 120),
        parsedAs: wrapper.querySelector('.loading-indicator-v3') ? 'skipped:loading' : 'live',
      };
      _rawElements.push(rawEl);
    }

    // --- Orphan activity indicators (not inside any message wrapper) ---
    const _orphanIndicators: Array<{ cls: string; text: string; parentCls: string }> = [];
    const allIndicators = container.querySelectorAll('.loading-indicator-v3, .make-shine');
    for (const ind of Array.from(allIndicators)) {
      if (ind.closest('[data-flat-index], [data-message-index], .composer-rendered-message[data-message-role]'))
        continue;
      _orphanIndicators.push({
        cls: ind.className.substring(0, 200),
        text: (ind.textContent || '').trim().substring(0, 120),
        parentCls: (ind.parentElement?.className || '').substring(0, 200),
      });
    }

    // --- Approval extraction. Two paths:
    //
    // Primary (per-card): each pending shell tool-call card carries its own
    // Run / Skip / Allowlist buttons plus the actual command text. We surface
    // one approval entry per card with the command as the description — much
    // more useful than just the button label.
    //
    // Fallback (legacy/non-shell): older Cursor builds and non-shell approval
    // surfaces. Collapses everything found into a single entry.
    //
    // Both paths must:
    //   - scope to `container` (otherwise multi-agent workbenches leak
    //     buttons across composers and approvals never clear), and
    //   - skip elements with aria-haspopup (Cursor's "Auto-Run in Sandbox"
    //     mode-dropdown trigger has text "Auto-Run …" and would match a
    //     generic "Run" textMatch — but it opens a settings menu, not an
    //     approval action).
    const pendingApprovals: CursorState['pendingApprovals'] = [];
    const MAX_APPROVAL_LABEL = 48;
    const isMenuTrigger = (btn: Element): boolean => {
      const popup = btn.getAttribute('aria-haspopup');
      return popup === 'menu' || popup === 'true' || popup === 'listbox';
    };
    const inTranscript = (btn: Element): boolean => {
      // A button with a shell-tool-call semantic class is itself an approval action, even inside the transcript.
      // Measured 2026-09-16: new Cursor hangs Run/Skip directly on the pending card's [data-message-role];
      // a blanket exclude would hide even real approvals from the fallback path.
      if (/(^|\s)ui-shell-tool-call__/.test(String(btn.className)))
        return false;
      return !!btn.closest(
        '[data-flat-index], [data-message-index], .composer-rendered-message, [data-message-role]',
      );
    };
    const cleanBtnLabel = (raw: string): string =>
      raw.replace(/\s*(Shift\+)?⏎\s*/g, '').replace(/\s+/g, ' ').trim();
    const shortButtonLabel = (btn: Element): string => {
      const aria = cleanBtnLabel(btn.getAttribute('aria-label') || '');
      if (aria && aria.length <= MAX_APPROVAL_LABEL)
        return aria;
      const text = cleanBtnLabel(btn.textContent || '');
      if (text && text.length <= MAX_APPROVAL_LABEL)
        return text;
      return '';
    };
    const labelMatchesKeyword = (label: string, patterns: string[]): boolean => {
      if (!label)
        return false;
      const lower = label.toLowerCase();
      for (const pat of patterns) {
        const p = (pat || '').toLowerCase();
        if (!p)
          continue;
        if (lower === p)
          return true;
        const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(lower))
          return true;
      }
      return false;
    };

    const seenCards = new Set<Element>();
    // Walk source: old builds used `.ui-shell-tool-call__approval-row` (the button wrapper);
    // measured 2026-09-16, new Cursor dropped that layer and hangs buttons on the card —
    // approval-row then hits 0, the whole primary path idles, and approvals are invisible
    // on the web. Walk pending cards directly so both structures are covered:
    //   · `.ui-shell-tool-call--pending` (new, measured: `-tool-call--pending` semantic class)
    //   · `.ui-tool-call-card` (old card)
    // Button lookup inside a card always uses `card.querySelector` (no longer `row.querySelector`).
    const pendingCards = container.querySelectorAll(
      '.ui-shell-tool-call--pending, .ui-tool-call-card',
    );
    for (const card of Array.from(pendingCards)) {
      if (seenCards.has(card))
        continue;

      const actions: CursorState['pendingApprovals'][0]['actions'] = [];

      const runBtn = card.querySelector('button.ui-shell-tool-call__run-btn');
      if (runBtn && !isMenuTrigger(runBtn)) {
        actions.push({
          label: cleanBtnLabel(runBtn.textContent || '') || 'Run',
          type: 'approve',
          selectorPath: buildSelectorPath(runBtn),
        });
      }
      // Allowlist button: old is `button.__allowlist-button`, new is
      // `span.__allowlist-button-wrapper > button` (copy "Always Run 'pnpm'").
      // Cover with the wrapper so both structures are found.
      const allowlistBtn
        = card.querySelector('button.ui-shell-tool-call__allowlist-button')
          || card.querySelector('.ui-shell-tool-call__allowlist-button-wrapper button');
      if (allowlistBtn && !isMenuTrigger(allowlistBtn)) {
        const lblEl = allowlistBtn.querySelector('.ui-shell-tool-call__allowlist-button-label');
        actions.push({
          label: cleanBtnLabel(lblEl?.textContent || allowlistBtn.textContent || '') || 'Allowlist',
          type: 'approve',
          selectorPath: buildSelectorPath(allowlistBtn),
        });
      }
      const skipBtn = card.querySelector('button.ui-shell-tool-call__skip-btn');
      if (skipBtn && !isMenuTrigger(skipBtn)) {
        actions.push({
          label: cleanBtnLabel(skipBtn.textContent || '') || 'Skip',
          type: 'reject',
          selectorPath: buildSelectorPath(skipBtn),
        });
      }

      if (!actions.some(a => a.type === 'approve'))
        continue;
      seenCards.add(card);

      // Command-text sources (priority):
      //  1. `.__command` — old: one block of command text
      //  2. `.__token--*` — new: command split into tokens (command / whitespace / text);
      //     joined they are the full command line (measured "pnpm" + " " + "i" → "pnpm i")
      //  3. `.__description` — tool description ("Install project dependencies with pnpm")
      const cmdEl = card.querySelector('.ui-shell-tool-call__command');
      const cmdText = (cmdEl?.textContent || '')
        .trim()
        .replace(/^\$\s*/, '')
        .replace(/\s+/g, ' ')
        .substring(0, 240);
      const tokenEls = card.querySelectorAll('[class*="ui-shell-tool-call__token--"]');
      const tokenText = Array.from(tokenEls)
        .map(el => el.textContent || '')
        .join('')
        .trim()
        .replace(/^\$\s*/, '')
        .substring(0, 240);
      const descEl = card.querySelector('.ui-shell-tool-call__description');
      const descText = (descEl?.textContent || '').trim().substring(0, 200);
      const description = cmdText || tokenText || descText || 'Pending approval';

      // Stable per-card id — Cursor's tool-call id when available, falling
      // back to selector path. Keeps the entry consistent across polls.
      const bubble = card.closest('[data-tool-call-id]');
      const toolCallId = bubble?.getAttribute('data-tool-call-id') || buildSelectorPath(card);
      pendingApprovals.push({
        id: `tool:${toolCallId}`,
        description,
        actions,
      });
    }

    // --- Approval extraction, part 2: non-shell tool-approval cards ---
    //
    // Cursor 3.18 wraps pending tool calls "other than shell commands" into
    // ToolApprovalGate (source criterion: approval.status === 'pending' and
    // toolCallVm.case !== 'shellToolCall'); the root has `data-tool-approval-gate`,
    // footer buttons are Always Run / Run / Skip;
    // mode-switch requests go through AgentTranscriptSwitchModeCard (Switch /
    // Skip, with an Always ask preference dropdown).
    // Both live in the transcript and buttons have no `ui-shell-tool-call__`
    // semantic class, so the primary path (shell cards only) and the fallback
    // (blanket inTranscript) both miss them — measured 2026-09-16:
    // in the "Server code redesign and refactor" session the agent asked to
    // switch to Plan mode, completely invisible on the web.
    // Covers: MCP tool calls, write/delete file, plan confirm, web search/fetch,
    // MCP auth, connect GitHub, mode switch.
    const DECISION_APPROVE_LABELS = new Set([
      'run',
      'switch',
      'always run',
      'continue',
      'authenticate',
      'connect github',
      'send to background composer',
    ]);
    const DECISION_REJECT_LABELS = new Set(['skip', 'stop', 'cancel']);
    // Normalize action copy: strip shortcut glyphs then compare — measured
    // 2026-09-16, the mode-switch card's primary button is "Switch⌘⏎";
    // cleanBtnLabel only eats ⏎, leaving "Switch⌘", which never matches.
    //
    // ⚠️ **Must include `^` (Windows Ctrl glyph)**: measured live on Windows
    // 2026-09-20, Cursor 3.21.16 copy is **`Switch^⏎`** (macOS is `Switch⌘⏎`).
    // Without `^` the result is `Switch^`, exact compare with `'switch'` fails
    // → **the whole mode-switch card never enters pendingApprovals**, while
    // the `[data-switch-mode-accent]` marker is still in the DOM —
    // looks like "the approval card is visible, but not on the web", and
    // **only reproduces on Windows**.
    const actionLabelOf = (btn: Element): string =>
      cleanBtnLabel(btn.textContent || '')
        .replace(/[\s·]*[⌘⌃⌥⇧^]+\s*$/, '')
        .replace(/\s*(Enter|Return)$/i, '')
        .trim();
    const decisionCards = new Set<Element>();
    for (const gate of Array.from(container.querySelectorAll('[data-tool-approval-gate]'))) {
      decisionCards.add(gate);
    }
    // Mode-switch cards have no semantic class, only `data-switch-mode-accent`
    // (icon / label, two markers): walk up from the marker to the nearest
    // ancestor that wraps a Switch button; that is the card.
    for (const accent of Array.from(container.querySelectorAll('[data-switch-mode-accent]'))) {
      let cur: Element | null = accent;
      while (cur && cur !== container) {
        const hasSwitch = Array.from(cur.querySelectorAll('button')).some(
          b => actionLabelOf(b).toLowerCase() === 'switch',
        );
        if (hasSwitch) {
          decisionCards.add(cur);
          break;
        }
        cur = cur.parentElement;
      }
    }
    for (const card of Array.from(decisionCards)) {
      const actions: CursorState['pendingApprovals'][0]['actions'] = [];
      const seenActionPaths = new Set<string>();
      for (const btn of Array.from(card.querySelectorAll('button'))) {
        if (isMenuTrigger(btn))
          continue;
        const labelText = actionLabelOf(btn);
        const text = labelText.toLowerCase();
        const type = DECISION_APPROVE_LABELS.has(text)
          ? 'approve' as const
          : DECISION_REJECT_LABELS.has(text)
            ? 'reject' as const
            : null;
        if (!type)
          continue;
        const selectorPath = buildSelectorPath(btn);
        if (seenActionPaths.has(selectorPath))
          continue;
        seenActionPaths.add(selectorPath);
        actions.push({
          label: (labelText || shortButtonLabel(btn) || 'Approve').substring(0, MAX_APPROVAL_LABEL),
          type,
          selectorPath,
        });
      }
      // A decided card (buttons gone / only reject left) is not pending — same rule as the fallback path.
      if (!actions.some(a => a.type === 'approve'))
        continue;

      // In the footer, allowlist (Always Run) often ranks before Run, while the
      // web ApprovalCard only renders the first approve — keep the default
      // action (Run / Switch / Continue…) first, Always Run after.
      actions.sort((a, b) => {
        const rank = (x: CursorState['pendingApprovals'][0]['actions'][0]) =>
          x.type === 'approve' ? (/^always run/i.test(x.label) ? 1 : 0) : 2;
        return rank(a) - rank(b);
      });

      const bubble = card.closest('[data-tool-call-id]');
      const id = `tool:${bubble?.getAttribute('data-tool-call-id') || buildSelectorPath(card)}`;
      if (pendingApprovals.some(p => p.id === id))
        continue;

      // Description priority: tool-row summary → mode-switch card title → whole card text (strip button copy).
      const lineText = Array.from(
        card.querySelectorAll(
          '[class*="ui-tool-call-line-action"], [class*="ui-tool-call-line-details"], [class*="ui-tool-call-line-detail-strong"]',
        ),
      )
        .map(el => cleanBtnLabel(el.textContent || ''))
        .filter(Boolean)
        .join(' ');
      const accentLabel = card.querySelector('[data-switch-mode-accent="label"]');
      const switchTitle = accentLabel?.parentElement
        ? cleanBtnLabel(accentLabel.parentElement.textContent || '')
        : cleanBtnLabel(accentLabel?.textContent || '');
      let description = lineText || switchTitle.replace(/\s*\?+$/, '');
      if (!description) {
        let raw = cleanBtnLabel(card.textContent || '');
        for (const a of actions) raw = raw.split(a.label).join(' ');
        description = cleanBtnLabel(raw);
      }
      pendingApprovals.push({
        id,
        description: description.substring(0, 240) || 'Pending approval',
        actions,
      });
    }

    if (pendingApprovals.length === 0) {
      const approveButtons: { label: string; selector: string }[] = [];
      const rejectButtons: { label: string; selector: string }[] = [];
      const seenApproveBtns = new Set<Element>();
      const seenRejectBtns = new Set<Element>();

      for (const sel of approveSelectors) {
        try {
          const btns = container.querySelectorAll(sel);
          for (const btn of Array.from(btns)) {
            if (seenApproveBtns.has(btn) || isMenuTrigger(btn) || inTranscript(btn))
              continue;
            const label = shortButtonLabel(btn);
            if (label) {
              seenApproveBtns.add(btn);
              approveButtons.push({ label, selector: buildSelectorPath(btn) });
            }
          }
        }
        catch { /* skip */ }
      }
      if (approveButtons.length === 0 && approveTextMatch.length > 0) {
        for (const btn of Array.from(container.querySelectorAll('button'))) {
          if (seenApproveBtns.has(btn) || isMenuTrigger(btn) || inTranscript(btn))
            continue;
          const label = shortButtonLabel(btn);
          if (labelMatchesKeyword(label, approveTextMatch)) {
            seenApproveBtns.add(btn);
            approveButtons.push({ label, selector: buildSelectorPath(btn) });
          }
        }
      }

      for (const sel of rejectSelectors) {
        try {
          const btns = container.querySelectorAll(sel);
          for (const btn of Array.from(btns)) {
            if (seenRejectBtns.has(btn) || isMenuTrigger(btn) || inTranscript(btn))
              continue;
            const label = shortButtonLabel(btn);
            if (label) {
              seenRejectBtns.add(btn);
              rejectButtons.push({ label, selector: buildSelectorPath(btn) });
            }
          }
        }
        catch { /* skip */ }
      }
      if (rejectButtons.length === 0 && rejectTextMatch.length > 0) {
        for (const btn of Array.from(container.querySelectorAll('button'))) {
          if (seenRejectBtns.has(btn) || isMenuTrigger(btn) || inTranscript(btn))
            continue;
          const label = shortButtonLabel(btn);
          if (labelMatchesKeyword(label, rejectTextMatch)) {
            seenRejectBtns.add(btn);
            rejectButtons.push({ label, selector: buildSelectorPath(btn) });
          }
        }
      }

      if (approveButtons.length > 0) {
        const actions: CursorState['pendingApprovals'][0]['actions'] = [];
        for (const btn of approveButtons) {
          actions.push({
            label: btn.label,
            type: btn.label.toLowerCase().includes('all') ? 'approve_all' : 'approve',
            selectorPath: btn.selector,
          });
        }
        for (const btn of rejectButtons) {
          actions.push({ label: btn.label, type: 'reject', selectorPath: btn.selector });
        }
        const idParts = `${approveButtons.map(b => b.label).join(',')}|${rejectButtons.map(b => b.label).join(',')}`;
        pendingApprovals.push({
          id: idParts,
          description: approveButtons[0]?.label || 'Pending approval',
          actions,
        });
      }
    }

    // --- Agent status ---
    const statusEl = findFirst(statusSelectors);
    let agentStatus: CursorState['agentStatus'] = 'idle';
    if (statusEl) {
      const combined = `${(statusEl.textContent || '').toLowerCase()} ${statusEl.classList.toString().toLowerCase()}`;
      if (combined.includes('think'))
        agentStatus = 'thinking';
      else if (combined.includes('generat'))
        agentStatus = 'generating';
      else if (combined.includes('running') || combined.includes('execut'))
        agentStatus = 'running_tool';
      else if (combined.includes('approv') || combined.includes('wait'))
        agentStatus = 'waiting_approval';
      else if (combined.includes('error') || combined.includes('fail'))
        agentStatus = 'error';
    }
    if (pendingApprovals.length > 0)
      agentStatus = 'waiting_approval';

    // Element-based status detection removed: tool loading badges and
    // run_command elements persist in the DOM long after completion.
    // Shimmer + .loading-indicator-v3 (checked below) are the ground truth.

    const inputEl = findFirst(inputSelectors);
    /**
     * Text already in the composer (not sent yet). Draft sessions (click +, new,
     * no first message yet) put their text here — the web uses it to turn a draft
     * into "text you can send as-is". Read both input kinds:
     * contenteditable (aislash / tiptap) via textContent, native textarea via value.
     */
    const inputText = (() => {
      if (!inputEl)
        return '';
      const value = (inputEl as HTMLInputElement).value;
      const raw = typeof value === 'string' && value ? value : (inputEl.textContent || '');
      return raw.trim();
    })();

    // --- Chat tabs from agent sidebar/history cells ---
    const chatTabs: ChatTab[] = [];
    /**
     * Chat tabs in the editor: label + data-resource-name (real composerId).
     * Sidebar rows themselves have no id; only these "open sessions" can be
     * read live for a real id — the server uses it to disambiguate same-title
     * rows and switches "awaiting approval" from title match to id match.
     */
    const _editorChatTabs: Array<{ title: string; composerId: string; awaiting: boolean }> = [];

    function cleanTabTitle(raw: string): string {
      let t = raw.trim().replace(/\s+/g, ' ');
      t = t.replace(/(@[\w./]+)+\s*$/, '');
      return t.trim().substring(0, 120);
    }

    const chromeTabTitles = new Set(['new agent', 'customize', 'more']);

    try {
      // Dedup by element identity, not title: same-name sessions (Cursor can
      // list several same-title rows) are different sessions; title-dedup
      // would drop the active row and the row spinner with it (2026-09-15 report).
      const seenRows = new Set<Element>();
      let scopeRoot: Element | null = null;
      if (containerComposerId) {
        const allCells = document.querySelectorAll('.agent-sidebar-cell');
        for (const cell of Array.from(allCells)) {
          const cid = cell.getAttribute('data-composer-id') || cell.closest('[data-composer-id]')?.getAttribute('data-composer-id');
          if (cid === containerComposerId) {
            scopeRoot = cell.closest('.agent-sidebar-project-cell') || document.body;
            break;
          }
        }
      }
      if (!scopeRoot && windowTitle) {
        const projectName = projectNameFromTitle(windowTitle).toLowerCase();
        if (projectName) {
          const projectCells = document.querySelectorAll('.agent-sidebar-project-cell');
          for (const cell of Array.from(projectCells)) {
            const labelEl = cell.querySelector('.agent-sidebar-section-title-text') || cell.querySelector('.agent-sidebar-workspace-name') || cell;
            const label = (labelEl.textContent || '').trim().toLowerCase();
            const firstWord = (label.split(/[\s[\]\-]/)[0] || '').toLowerCase();
            if (label.includes(projectName) || projectName.includes(firstWord) || firstWord === projectName) {
              scopeRoot = cell;
              break;
            }
          }
        }
      }

      const inScope = (el: Element): boolean => !scopeRoot || scopeRoot.contains(el);

      // Editor Chat tabs: Cursor swaps the session icon to a question mark
      // (codicon-question) when awaiting confirm (approval / questionnaire).
      // Sidebar rows only have a spinner, so they cannot tell running vs
      // awaiting; send back data-resource-name (real composerId) so the server
      // can merge onto sidebar rows by id — title merge mixes same-name
      // sessions (four rows all get the badge).
      try {
        for (const tabEl of Array.from(document.querySelectorAll('.tabs-container .tab[role="tab"]'))) {
          const aria = tabEl.getAttribute('aria-label') || '';
          const resourceId = tabEl.getAttribute('data-resource-name') || '';
          const looksLikeComposer = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(resourceId);
          if (!looksLikeComposer && !/chat editors/i.test(aria))
            continue;
          const iconEl = tabEl.querySelector('.monaco-icon-label');
          const label = tabEl.querySelector('.monaco-highlighted-label')?.textContent ?? '';
          const title = cleanTabTitle(label || aria.split(',')[0] || '');
          if (!title)
            continue;
          _editorChatTabs.push({
            title,
            composerId: looksLikeComposer ? resourceId : '',
            awaiting: !!iconEl && iconEl.classList.contains('codicon-question'),
          });
        }
      }
      catch { /* editor tab area unavailable → treat as none */ }

      /** Row-level "running": sidebar leading icon is a spinner (.spinning-loader; cursor-icon-modifier-spin fallback) */
      const cellIsRunning = (tab: Element): boolean =>
        tab.querySelector('.agent-sidebar-cell-icon .spinning-loader') !== null
        || tab.querySelector('.cursor-icon-modifier-spin') !== null;

      // Note: Cursor session rows also have a trailing "finished but unread"
      // blue dot (`.agent-sidebar-cell-unread-indicator`, driven by the
      // composer's hasUnreadMessages; clears on select/focus, right-click can
      // Mark as Unread) — but measured 2026-09-16 it is not visible in the
      // actual UI, so we **do not wire it** (only CodeBuddy's agent-state-dot
      // goes into status). Reproduce that dot first if you want it; details
      // in CLAUDE.md under "finished but unread".

      // Same-title row index: when titles collide, "click the Nth row" can
      // only use this (the row has no id to click).
      const sameTitleCounts = new Map<string, number>();

      const pushTab = (tab: Element, rawTitle: string, composerId: string, isActive: boolean): void => {
        const title = cleanTabTitle(rawTitle);
        if (!title || chromeTabTitles.has(title.toLowerCase()) || seenRows.has(tab))
          return;
        seenRows.add(tab);
        const key = title.toLowerCase();
        const sameTitleIndex = sameTitleCounts.get(key) ?? 0;
        sameTitleCounts.set(key, sameTitleIndex + 1);
        const rowIndex = chatTabs.length;
        chatTabs.push({
          composerId: composerId || `tab-${rowIndex}`,
          title,
          isActive,
          // Row-level status (IDE sidebar's own truth): running → generating
          // (loading spinner); active in this window → active; else idle.
          // "Awaiting approval" is not decided here: same-title rows would
          // all get the badge; the server uses the editor tab's composerId
          // and matches by id (tab-identity).
          status: cellIsRunning(tab) ? 'generating' : isActive ? 'active' : 'idle',
          selectorPath: buildSelectorPath(tab),
          rowIndex,
          sameTitleIndex,
        });
      };

      const cellIsActive = (tab: Element): boolean => {
        const selectedAttr = tab.getAttribute('data-selected');
        const highlightedAttr = tab.getAttribute('data-highlighted');
        return selectedAttr === 'true'
          || highlightedAttr === 'true'
          || tab.classList.contains('selected')
          || tab.classList.contains('active');
      };

      const cellComposerId = (tab: Element): string =>
        tab.getAttribute('data-composer-id')
        || tab.closest('[data-composer-id]')?.getAttribute('data-composer-id')
        || '';

      // Workbench unified sidebar: conversation rows live in .agent-sidebar-list.
      // Header actions reuse .agent-sidebar-cell for "New Agent" / "Customize".
      for (const tab of Array.from(document.querySelectorAll('.agent-sidebar-list .agent-sidebar-cell'))) {
        if (!inScope(tab))
          continue;
        const titleEl = tab.querySelector('.agent-sidebar-cell-text');
        const rawTitle = titleEl
          ? (titleEl.textContent || '').trim()
          : (tab.getAttribute('aria-label') || tab.textContent || '').trim();
        pushTab(tab, rawTitle, cellComposerId(tab), cellIsActive(tab));
      }

      // Cursor Agents glass rail — only if this window has no workbench list.
      if (chatTabs.length === 0) {
        const glassTabRoots = document.querySelectorAll(
          '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > .ui-sidebar-menu-button, '
          + '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn',
        );
        for (const tab of Array.from(glassTabRoots)) {
          const labelEl = tab.querySelector('.ui-sidebar-menu-button-label');
          const rawAgentTitle = (labelEl?.textContent || '').trim();
          if (!rawAgentTitle)
            continue;
          if (chromeTabTitles.has(cleanTabTitle(rawAgentTitle).toLowerCase()))
            continue;

          const group = tab.closest('.ui-sidebar-group');
          const groupTitleEl = group?.querySelector('.ui-sidebar-group-label-title');
          const rawGroupTitle = (groupTitleEl?.textContent || '').trim();

          let displayTitle = cleanTabTitle(rawAgentTitle);
          if (rawGroupTitle) {
            const g = cleanTabTitle(rawGroupTitle);
            if (g) {
              displayTitle = `${g} / ${cleanTabTitle(rawAgentTitle)}`.substring(0, 120);
            }
          }

          const composerId
            = tab.getAttribute('data-composer-id')
              || tab.closest('[data-composer-id]')?.getAttribute('data-composer-id')
              || '';
          const isActive = tab.getAttribute('data-active') === 'true'
            || tab.getAttribute('aria-selected') === 'true'
            || tab.classList.contains('selected')
            || tab.classList.contains('active');
          pushTab(tab, displayTitle, composerId, isActive);
        }
      }

      for (const sel of chatTabSelectors) {
        if (chatTabs.length > 0)
          break;
        let tabItems: NodeListOf<Element>;
        try {
          const root: Element | Document = scopeRoot || document;
          tabItems = root.querySelectorAll(sel);
        }
        catch {
          continue;
        }
        if (tabItems.length === 0)
          continue;
        for (const tab of Array.from(tabItems)) {
          if (!inScope(tab))
            continue;
          if (tab.closest('.agent-sidebar-header-actions'))
            continue;
          const titleEl = tab.querySelector('.agent-sidebar-cell-text');
          const rawTitle = titleEl
            ? (titleEl.textContent || '').trim()
            : (tab.getAttribute('aria-label') || tab.textContent || '').trim();
          pushTab(tab, rawTitle, cellComposerId(tab), cellIsActive(tab));
        }
      }

      // Editor Chat tabs (Cursor 3.19 Agents Window / Chat Editors group).
      if (chatTabs.length === 0) {
        for (const tab of Array.from(document.querySelectorAll('.tabs-container .tab[role="tab"]'))) {
          const aria = tab.getAttribute('aria-label') || '';
          if (!/Chat Editors/i.test(aria))
            continue;
          const labelEl = tab.querySelector('.label-name');
          const rawTitle = (labelEl?.textContent || '').trim() || aria.split(',')[0].trim();
          const isActive = tab.classList.contains('selected') || tab.classList.contains('active');
          pushTab(tab, rawTitle, cellComposerId(tab), isActive);
        }
      }

      // composer-bar is the more authoritative "which session is open now"
      // (sidebar selected state can lag). Only reconcile isActive / composerId,
      // never rewrite status — status is the sidebar row's spinner truth;
      // it was once overwritten to active here and wiped the loading spinner
      // on the running row (2026-09-15 report).
      if (containerComposerId) {
        let matched = false;
        for (const t of chatTabs) {
          if (t.composerId === containerComposerId) {
            matched = true;
            t.isActive = true;
          }
        }
        if (matched) {
          for (const t of chatTabs) {
            if (t.composerId !== containerComposerId)
              t.isActive = false;
          }
        }
        for (const t of chatTabs) {
          if (t.isActive && /^tab-\d+$/.test(t.composerId)) {
            t.composerId = containerComposerId;
          }
        }
        /*
         * Click +, new, no first message yet (draft): Cursor gives no sidebar
         * row and the DB has no name (composerHeaders.name empty → tab-identity
         * SQL filters it out). So "current session" is missing entirely on the
         * web — no session row, send target cannot be computed, looks like
         * "the new session was created but you cannot talk" (measured 2026-09-16
         * on mobile).
         *
         * Synthesize a row for the active composer: the new session still
         * appears in the list and can still be the send target (switch_tab
         * hitting the composer bar is enough; no row click needed). Title
         * comes from the editor Chat tab (drafts use Cursor's own "New Agent");
         * if missing, fall back to the new-session title.
         */
        if (!chatTabs.some(t => t.composerId === containerComposerId)) {
          let draftEl: Element | null = null;
          for (const el of Array.from(document.querySelectorAll('.tabs-container .tab[role="tab"]'))) {
            if (el.getAttribute('data-resource-name') === containerComposerId) {
              draftEl = el;
              break;
            }
          }
          const draftRaw = draftEl
            ? (draftEl.querySelector('.label-name')?.textContent
              || draftEl.getAttribute('aria-label')
              || '').trim()
            : '';
          const draftTitle = cleanTabTitle(draftRaw) || '新会话';
          chatTabs.push({
            composerId: containerComposerId,
            title: draftTitle,
            isActive: true,
            status: 'active',
            selectorPath: draftEl ? buildSelectorPath(draftEl) : '',
            rowIndex: chatTabs.length,
            sameTitleIndex: sameTitleCounts.get(draftTitle.toLowerCase()) ?? 0,
            composerIdSource: 'dom',
            // Draft: body not generated yet; text is in the composer (web fills the input with draftText → send as-is)
            isDraft: true,
            ...(inputText ? { draftText: inputText } : {}),
          });
        }
      }
    }
    catch { /* skip */ }

    // --- Mode extraction ---
    const modeEl = findFirst(modeSelectors);
    let currentMode = 'agent';
    if (modeEl) {
      currentMode = modeEl.getAttribute('data-mode') || 'agent';
    }
    const mode: ModeInfo = {
      current: currentMode,
      available: [
        { id: 'agent', label: 'Agent', icon: 'infinity' },
        { id: 'plan', label: 'Plan', icon: 'todos' },
        { id: 'debug', label: 'Debug', icon: 'bug' },
        { id: 'chat', label: 'Ask', icon: 'chat' },
      ],
    };

    // --- Model extraction ---
    // Skip plan-scoped model dropdowns (id starts with "plan-exec-model") — those
    // show the model for a specific plan, not the composer-level model.
    let modelEl: Element | null = null;
    for (const sel of modelSelectors) {
      try {
        const candidates = document.querySelectorAll(sel);
        for (const c of Array.from(candidates)) {
          const cId = c.getAttribute('id') || '';
          if (!cId.startsWith('plan-exec-model')) {
            modelEl = c;
            break;
          }
        }
        if (modelEl)
          break;
      }
      catch { /* skip */ }
    }
    let modelName = '';
    let modelId = '';
    if (modelEl) {
      const spans = modelEl.querySelectorAll('span');
      for (const s of Array.from(spans)) {
        const t = (s.textContent || '').trim();
        if (t && !t.includes('chevron') && t.length > 1) {
          modelName = t;
          break;
        }
      }
      modelId = modelEl.getAttribute('id') || '';
    }
    const model: ModelInfo = {
      current: modelName || 'Auto',
      currentId: modelId,
    };

    // --- Raw activity signals (objective DOM snapshot for recording) ---
    const _shimmer: Array<{ text: string; inToolCall: boolean; inHeader: boolean }> = [];
    const hasLoadingIndicator = container.querySelector('.loading-indicator-v3') !== null;
    const shineEls = container.querySelectorAll('.make-shine');
    for (const sh of Array.from(shineEls).reverse()) {
      const inToolCall = !!sh.closest('[data-tool-call-id]') || !!sh.closest('.composer-terminal-tool');
      const header = sh.closest('.ui-collapsible-header');
      let text = '';
      if (header) {
        const spans = header.querySelectorAll(':scope > span');
        const parts: string[] = [];
        for (const s of Array.from(spans)) {
          if (s.classList.contains('cursor-icon') || s.classList.contains('ui-icon'))
            continue;
          const t = (s.textContent || '').trim();
          if (t)
            parts.push(t);
        }
        text = parts.join(' ');
      }
      else if (sh.classList.contains('composer-terminal-top-header-description')
        || sh.closest('.composer-terminal-top-header-text')) {
        text = (sh.textContent || '').trim();
      }
      else {
        const descEl = (sh.closest('[data-flat-index], [data-message-index], .composer-rendered-message[data-message-role]') || sh.parentElement)
          ?.querySelector('.composer-terminal-top-header-description, .ui-tool-call-line-action, .ui-edit-tool-call__filename');
        text = descEl ? (descEl.textContent || '').trim() : (sh.textContent || '').trim();
      }
      if (text.length > 2) {
        const entry = { text: text.substring(0, 80), inToolCall, inHeader: !!header };
        _shimmer.push(entry);
      }
    }

    const _rawSignals = {
      shimmer: _shimmer,
      loadingIndicator: hasLoadingIndicator,
      statusEl: statusEl ? { text: (statusEl.textContent || '').trim(), classes: statusEl.className } : undefined,
      elements: _rawElements,
      orphanIndicators: _orphanIndicators,
      editorChatTabs: _editorChatTabs,
    };

    const queueItems: { id: string; text: string }[] = [];
    let queueLabel: string | undefined;
    const toolbarSection = document.querySelector('#composer-toolbar-section');
    if (toolbarSection) {
      for (const lc of Array.from(toolbarSection.querySelectorAll('.opacity-80'))) {
        const lt = (lc.textContent || '').trim();
        if (lt && /queued/i.test(lt)) {
          queueLabel = lt;
          break;
        }
      }
      if (!queueLabel) {
        const fb = toolbarSection.querySelector('.group .opacity-80');
        const t0 = (fb?.textContent || '').trim();
        if (t0)
          queueLabel = t0;
      }
      for (const item of Array.from(toolbarSection.querySelectorAll('.composer-toolbar-queue-item'))) {
        const qid = item.getAttribute('data-queue-item-id') || '';
        let qtext = (item.getAttribute('data-queue-item-query') || '').trim();
        if (!qtext) {
          const ro = item.querySelector('.aislash-editor-input-readonly');
          qtext = (ro?.textContent || '').trim();
        }
        if (qid || qtext)
          queueItems.push({ id: qid || `qi-${queueItems.length}`, text: qtext });
      }
    }

    // "Which session is open now": sidebar selected row first; placeholder ids
    // fall back to the composer bar's container id. Questionnaire session
    // ownership uses this same value (same as activeComposerId in the return).
    const sidebarActiveId = chatTabs.find(t => t.isActive)?.composerId ?? '';
    const activeComposerId = sidebarActiveId && !/^tab-\d+$/.test(sidebarActiveId)
      ? sidebarActiveId
      : containerComposerId;

    // --- Questionnaire widget ---
    interface QOption { letter: string; label: string; isFreeform: boolean; selectorPath: string; selected: boolean }
    interface QQuestion { number: string; text: string; options: QOption[]; isActive: boolean }
    let questionnaire: {
      composerId: string;
      questions: QQuestion[];
      activeIndex: number;
      totalLabel: string;
      skipSelectorPath: string;
      continueSelectorPath: string;
      continueDisabled: boolean;
      /** Action-button copy (IDE truth): project window uses Skip / Continue */
      skipLabel: string;
      continueLabel: string;
    } | null = null;
    const qToolbar = document.querySelector('.composer-questionnaire-toolbar');
    if (qToolbar) {
      const stepperLabel = (qToolbar.querySelector('.composer-questionnaire-toolbar-stepper-label')?.textContent || '').trim();
      const questionEls = Array.from(qToolbar.querySelectorAll('.composer-questionnaire-toolbar-question'));
      const questions: QQuestion[] = [];
      let activeIdx = 0;
      // Anchored class-based paths, like the Skip/Continue actions below.
      // buildSelectorPath's body-down tag chains go stale between poll and
      // click, and they target the letter <button> whose text can never pass
      // the resolver's label check (public#50). Target the option ROW instead:
      // it carries role="button" and clicking it selects the option.
      const nthOfType = (el: Element): number => {
        const parent = el.parentElement;
        if (!parent)
          return 1;
        const sameTag = Array.from(parent.children).filter(c => c.tagName === el.tagName);
        return sameTag.indexOf(el) + 1;
      };
      for (let qi = 0; qi < questionEls.length; qi++) {
        const qEl = questionEls[qi];
        const isActive = qEl.classList.contains('composer-questionnaire-toolbar-question-active');
        if (isActive)
          activeIdx = qi;
        const num = (qEl.querySelector('.composer-questionnaire-toolbar-question-number')?.textContent || '').trim();
        const mdRoot = qEl.querySelector('.markdown-root');
        const text = (mdRoot?.textContent || '').trim();
        const optionEls = Array.from(qEl.querySelectorAll('.composer-questionnaire-toolbar-option'));
        const options: QOption[] = [];
        for (const optEl of optionEls) {
          const letterBtn = optEl.querySelector('.composer-questionnaire-toolbar-option-letter');
          const letter = (letterBtn?.textContent || '').trim();
          const isFreeform = optEl.classList.contains('composer-questionnaire-toolbar-option-freeform');
          const label = isFreeform ? 'Other' : (optEl.querySelector('.composer-questionnaire-toolbar-option-label')?.textContent || '').trim();
          const selectorPath
            = `.composer-questionnaire-toolbar-question:nth-of-type(${nthOfType(qEl)})`
              + ` .composer-questionnaire-toolbar-option:nth-of-type(${nthOfType(optEl)})`;
          // Selected state: letter / label get a `-selected` class (measured
          // 2026-09-17; both toggle in sync; use letter — freeform rows have a letter too).
          const selected
            = letterBtn?.classList.contains('composer-questionnaire-toolbar-option-letter-selected') === true
              || optEl.querySelector('.composer-questionnaire-toolbar-option-label-selected') !== null;
          // Note: project-window questionnaires have no multi-select marker
          // (bundle and live both confirm); leave multiSelect empty = single-select.
          options.push({ letter, label, isFreeform, selectorPath, selected });
        }
        questions.push({ number: num, text, options, isActive });
      }

      let skipPath = '';
      let continuePath = '';
      let continueDisabled = false;
      // Button copy is IDE truth (web copies it; do not guess from the IDE): project window uses Skip / Continue
      let skipLabel = '';
      let continueLabel = '';
      const actionsContainer = qToolbar.querySelector('.composer-questionnaire-toolbar-actions');
      if (actionsContainer) {
        // Keep questionnaire action selectors in-extractor with the existing convention:
        // prefer legacy button classes, then fall back to Cursor 3.8+ data-click-ready divs.
        const findActionByLabel = (label: string): Element | null => {
          const expected = label.trim().toLowerCase();
          for (const child of Array.from(actionsContainer.querySelectorAll(':scope > div[data-click-ready]'))) {
            const truncateText = (child.querySelector('span.truncate')?.textContent || '').trim().toLowerCase();
            if (truncateText === expected)
              return child;
          }
          return null;
        };
        const stableClickReadyPath = (el: Element): string => {
          const childIndex = el.parentElement ? Array.from(el.parentElement.children).indexOf(el) + 1 : 1;
          return `.composer-questionnaire-toolbar-actions > div[data-click-ready]:nth-child(${childIndex})`;
        };
        const skipLegacy = actionsContainer.querySelector('.composer-skip-button');
        if (skipLegacy) {
          skipPath = buildSelectorPath(skipLegacy);
          skipLabel = cleanBtnLabel(skipLegacy.textContent || '');
        }
        else {
          const skipFallback = findActionByLabel('Skip');
          if (skipFallback) {
            skipPath = stableClickReadyPath(skipFallback);
            skipLabel = cleanBtnLabel(skipFallback.textContent || '');
          }
        }
        const contLegacy = actionsContainer.querySelector('.composer-run-button');
        const contBtn = contLegacy || findActionByLabel('Continue');
        if (contBtn) {
          continuePath = contLegacy ? buildSelectorPath(contLegacy) : stableClickReadyPath(contBtn);
          continueDisabled = contBtn.getAttribute('data-disabled') === 'true';
          continueLabel = cleanBtnLabel(contBtn.textContent || '');
        }
      }

      questionnaire = {
        composerId: activeComposerId,
        questions,
        activeIndex: activeIdx,
        totalLabel: stepperLabel,
        skipSelectorPath: skipPath,
        continueSelectorPath: continuePath,
        continueDisabled,
        skipLabel,
        continueLabel,
      };
    }

    const liveActions: Record<string, { label: string; type: 'run' | 'skip' | 'allow'; selectorPath: string }[]> = {};
    for (const toolEl of Array.from(container.querySelectorAll('[data-tool-call-id]'))) {
      const toolCallId = toolEl.getAttribute('data-tool-call-id');
      if (!toolCallId)
        continue;
      const actions = extractToolActions(toolEl);
      if (actions.length)
        liveActions[toolCallId] = actions;
    }

    let lastAssistantText = '';
    const assistantNodes = container.querySelectorAll(
      '[data-message-role="assistant"], [data-react-transcript-row-kind="assistantMarkdown"]',
    );
    if (assistantNodes.length > 0) {
      lastAssistantText = (assistantNodes[assistantNodes.length - 1].textContent || '').trim();
    }

    return {
      connected: true,
      extractorStatus: 'ok',
      lastExtractionAt: null,
      consecutiveExtractionFailures: 0,
      lastExtractionError: null,
      agentStatus,
      agentActivityText: null,
      agentActivityLive: false,
      agentActivitySource: 'none',
      messages: [],
      liveActions,
      lastAssistantText: lastAssistantText || undefined,
      pendingApprovals,
      inputAvailable: inputEl !== null,
      chatTabs,
      activeComposerId,
      mode,
      model,
      windows: [],
      activeWindowId: '',
      composerQueue: { items: queueItems, ...(queueLabel ? { queueLabel } : {}) },
      questionnaire,
      contentSource: 'ok',
      _rawSignals,
    };
  }
  catch {
    return null;
  }
}

export class DOMExtractor {
  private selectors: SelectorConfig;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private client: CdpClient | null = null;
  private onExtract: (state: CursorState | null, errorMessage?: string | null) => void;
  private getWindowTitle: () => string;
  private loggedFirstExtraction = false;
  private basePollIntervalMs = 300;
  private currentPollIntervalMs = 300;
  private pollInFlight = false;
  private failureStreak = 0;
  private running = false;
  private paused = false;
  private activeWindowKind: () => WindowKind = () => 'project';

  constructor(
    selectors: SelectorConfig,
    onExtract: (state: CursorState | null, errorMessage?: string | null) => void,
    getWindowTitle: () => string = () => '',
    options: DOMExtractorOptions = {},
  ) {
    this.selectors = selectors;
    this.onExtract = onExtract;
    this.getWindowTitle = getWindowTitle;
    this.activeWindowKind = options.activeWindowKind ?? (() => 'project');
  }

  /**
   * When Cursor's Agents overview is home, none of the project extractor's
   * DOM exists: this round runs agents extraction (groups + rows + current
   * composer) instead; the project path is untouched.
   */
  private isAgentsWindow(): boolean {
    try {
      return this.activeWindowKind() === 'agents';
    }
    catch {
      return false;
    }
  }

  private async extractAgentsWindow(client: CdpClient): Promise<CursorState | null> {
    const dump = await client.callFunctionWithTimeout(
      dumpAgentsWindow as (...args: never[]) => unknown,
      [],
      AGENTS_DUMP_TIMEOUT_MS,
    ) as AgentsWindowDump | null;
    if (!dump)
      return null;
    // windowId is stamped by StateManager in onExtraction (activeWindowId)
    return { ...emptyCursorState(), connected: true, ...mapAgentsWindowDump(dump) };
  }

  start(client: CdpClient, intervalMs: number): void {
    this.client = client;
    this.stop();
    this.running = true;
    this.paused = false;
    this.basePollIntervalMs = intervalMs;
    this.currentPollIntervalMs = intervalMs;
    this.failureStreak = 0;
    console.log(`[dom-extractor] Starting polling every ${intervalMs}ms`);
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
        console.warn(`[dom-extractor] Backing off poll interval to ${this.currentPollIntervalMs}ms after ${message}`);
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
      const agentsWindow = this.isAgentsWindow();
      const state = agentsWindow
        ? await this.extractAgentsWindow(client)
        : await client.callFunctionWithTimeout(
          extractionFunction as (...args: never[]) => unknown,
          [
            this.selectors.chatContainer.strategies,
            this.selectors.approveButton.strategies,
            this.selectors.approveButton.textMatch ?? [],
            this.selectors.rejectButton.strategies,
            this.selectors.rejectButton.textMatch ?? [],
            this.selectors.chatInput.strategies,
            this.selectors.agentStatus.strategies,
            this.selectors.chatTabList?.strategies ?? [],
            this.selectors.modeDropdown?.strategies ?? [],
            this.selectors.modelDropdown?.strategies ?? [],
            this.getWindowTitle(),
          ],
          EVALUATE_TIMEOUT_MS,
        ) as CursorState | null;
      // The in-flight round read the old window's DOM: drop it after a switch,
      // or those tabs would be emitted as the new window's session list (list flash).
      if (!this.isCurrentClient(client))
        return;
      const ms = Date.now() - started;
      if (!state) {
        timingLog('extract', { ide: 'cursor', ms, ok: false, error: 'null' });
      }
      else if (ms >= 200) {
        timingLog('extract', { ide: 'cursor', ms, ok: true });
      }

      // The agents-window dump is already mapped (including row identity); do not apply project-window post-process
      const derivedState = state
        ? (agentsWindow ? state : postProcessCursorState(state))
        : null;
      this.failureStreak = 0;
      this.currentPollIntervalMs = this.basePollIntervalMs;

      if (derivedState && !this.loggedFirstExtraction) {
        this.loggedFirstExtraction = true;
        console.log(`[dom-extractor] First successful extraction:`);
        console.log(`  status: ${derivedState.agentStatus}${derivedState.agentActivityText ? ` (${derivedState.agentActivityText})` : ''}`);
        console.log(`  messages: ${derivedState.messages.length}`);
        console.log(`  approvals: ${derivedState.pendingApprovals.length}`);
        console.log(`  inputAvailable: ${derivedState.inputAvailable}`);
        console.log(`  chatTabs: ${derivedState.chatTabs.length}`);
        console.log(`  mode: ${derivedState.mode.current}, model: ${derivedState.model.current}`);
        if (derivedState.messages.length > 0) {
          const last = derivedState.messages[derivedState.messages.length - 1];
          const preview = last.type === 'human'
            ? last.text
            : last.type === 'assistant'
              ? last.text
              : last.type === 'tool'
                ? `${last.action} ${last.details}`
                : last.type === 'thought'
                  ? `thought ${last.duration}`
                  : last.type === 'plan'
                    ? `${last.label}: ${last.title}`
                    : last.type === 'run_command'
                      ? `run: ${last.command.substring(0, 60)}`
                      : last.type === 'todo_list'
                        ? `todos: ${last.todosCompleted}/${last.todosTotal}`
                        : 'loading';
          console.log(`  last element (${last.type}): "${preview.substring(0, 80)}..."`);
        }
      }

      this.onExtract(derivedState, null);
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Failures from the old window (usually disconnect during a switch) are not extraction failures for the new window
      if (!this.isCurrentClient(client))
        return;
      timingLog('extract', { ide: 'cursor', ok: false, error: message });
      if (!message.includes('WebSocket closed') && !message.includes('Intentional disconnect')) {
        console.warn(`[dom-extractor] Extraction failed: ${message}`);
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
