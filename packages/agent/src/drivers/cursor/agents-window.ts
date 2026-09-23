/**
 * Cursor's Agents window (CDP title `Cursor Agents`) — a cross-repo global agent list.
 *
 * How it differs from a project window (measured 2026-09-16, Cursor 3.18.9):
 *   - no project workspace (`vscode.context.configuration().workspace` is null), no `#workbench.parts.*`;
 *   - sidebar is `.ui-sidebar-menu-button[aria-id="glass-sidebar-agent-row"]` inside
 *     `.ui-sidebar-section[data-agent-drop-section-id]` (repo / workspace groups); rows have no composerId;
 *   - the main pane is the selected agent's session: `div.composer-bar.editor[data-composer-id][data-composer-status]`;
 *   - the input is `.ui-prompt-input-editor__input` (tiptap), **not** inside `.composer-bar`.
 *
 * Two sources of truth:
 *   1. row status dots `.ui-agent-status-dot[data-variant]`: needs-attention / done-unseen / draft;
 *   2. the row's real composerId — not on the row; inferred by aligning
 *      "group → that workspace's session sequence" (see alignAgentsSectionIds;
 *      if it does not align, keep the placeholder id, do not guess).
 */

import type {
  AgentStatus,
  Approval,
  ApprovalAction,
  ChatTab,
  CursorState,
  Questionnaire,
} from '../../types.js';
import type { ComposerMeta } from './tab-identity.js';
import {
  listCloudAgentNames,
  listWorkspaceIds,
  nameKey,
  readWorkspaceComposers,
  workspaceIdOf,
} from './tab-identity.js';

/** Same origin as EVALUATE_TIMEOUT_MS: the agents window also slows when occluded; 12s is the floor (do not shrink it). */
export const AGENTS_DUMP_TIMEOUT_MS = 12000;

/**
 * `workspace:home` = the IDE's `No Repo` section. Grouping is by **ownership**,
 * not "where it runs": sessions with no local project / git repo to hang off
 * all land here — so cloud agents are always in it, but the converse is false.
 *
 * Two kinds of tenants in the bucket (measured 2026-09-17):
 *   1. **Cursor Cloud Agent**: local `ItemTable` `cloudAgentRepository.agents.*`
 *      records `bcId` + `hasStartedVm=1` +
 *      `repoUrl=origin.cursor.com/git/<team>/tmp-<hash>` (one temp cloud repo
 *      per agent), owned by `glass.cloudAgentProjects.v1`; body is on the cloud
 *      VM, locally only the agent record + search-index preview + an input
 *      draft shell (`composerData`'s `bubbleId`/`conversationMap` are both 0).
 *      **New Agent in No Repo creates this** (measured twice, both
 *      `hasStartedVm=1`).
 *   2. **Local "no-folder window" sessions**: `workspaceId` is a numeric pseudo
 *      id (e.g. `1787716961878`), body is complete in `state.vscdb` (measured
 *      `WeCube protocol permissions` 73 bubbles / `Terminal file reference`
 *      118 bubbles), readable / switchable / sendable.
 *
 * On the DOM the two kinds of rows look identical (same `aria-id` / `data-*`,
 * no cloud badge, status icons have no aria-label); **only a DB lookup can
 * tell them apart**: name hits the `cloudAgentRepository` list = cloud; unique
 * match in local `composerHeaders` = local.
 *
 * Current impl: **drop cloud rows only** (local rows still display / align /
 * switch) + **forbid remote new-chat for the whole section** (refusal gate
 * `agentsNewChatRefusalJS`; measured, New Agent in No Repo always creates a
 * cloud agent). Of 20 sections only this one contains cloud agents; the other
 * 19 (`workspace:<id>` / `repo:<url>`) have 0 cloud rows.
 */
/**
 * Sections where cloud agents appear (currently only No Repo): rows inside
 * must be **checked against the list one by one** — name hits
 * `cloudAgentRepository` (unarchived) = cloud agent → drop; the rest (local
 * no-project sessions) display as usual.
 *
 * If the list cannot be read, **drop the whole section** (conservative):
 * better to hide a few local sessions than show cloud rows whose body cannot be opened.
 */
export const CLOUD_SECTION_IDS: readonly string[] = ['workspace:home'];

/** Cloud-agent id prefix (`data-composer-id` on the DOM; the DB has no composer of that id). */
export function isCloudAgentId(composerId: string): boolean {
  return composerId.startsWith('bc-');
}

export function isCloudSectionId(sectionId: string): boolean {
  return CLOUD_SECTION_IDS.includes(sectionId);
}

export interface AgentsWindowRow {
  title: string;
  /** Relative time on the right of the list (`8m` / `2d`); display only. */
  time: string;
  active: boolean;
  unread: boolean;
  /** `.ui-agent-status-dot[data-variant]`: `needs-attention` / `done-unseen` / `draft` / '' (no dot). */
  dot: string;
  /** Running: `.ui-dot-grid-loader` in the status slot (`data-shape="sine_3x3"`, measured 2026-09-17). */
  running?: boolean;
}

export interface AgentsWindowSection {
  /** `data-agent-drop-section-id`：`workspace:<id>` / `repo:<url>` / `workspace:home`。 */
  id: string;
  title: string;
  expanded: boolean;
  rows: AgentsWindowRow[];
}

export interface AgentsWindowApprovalDump {
  description: string;
  actions: Array<{ label: string; type: string; selectorPath: string }>;
}

export interface AgentsWindowDump {
  sections: AgentsWindowSection[];
  activeComposerId: string;
  /** `data-composer-status`：cancelled / needs_attention / done / in_progress / draft / archived。 */
  composerStatus: string;
  inputAvailable: boolean;
  /**
   * Text currently in the composer (the not-yet-sent part) — a draft's text is here.
   * The sidebar draft-row title is also this, but newlines are flattened and it
   * may be truncated; **only here can we get the original**.
   */
  inputText?: string;
  approvals: AgentsWindowApprovalDump[];
  /**
   * The current agent's questionnaire (AskQuestion overlay), or null.
   *
   * Same composer component as the project window, same
   * `.composer-questionnaire-toolbar*` classes (cross-checked 2026-09-17 in
   * Cursor's glass bundle: glass CSS has the whole family).
   * When the window is occluded / minimized Cursor does not render the
   * transcript, so this naturally cannot be read — same constraint as approvals.
   */
  questionnaire: Questionnaire | null;
}

/**
 * Page-side extract (self-contained; must not reference Node-side variables —
 * it is serialized and dropped into the renderer).
 * Read-only; clicks nothing.
 */
export function dumpAgentsWindow(): AgentsWindowDump {
  const clean = (s: string | null | undefined): string => (s || '').replace(/\s+/g, ' ').trim();
  /**
   * Element path. **Must carry a stable anchor**: a relative path from the root
   * like `div:nth-child(1) > …` makes `querySelector` hit the first
   * lookalike in the document (portal buttons are especially easy to mis-click;
   * measured 2026-09-17: click returned success but the card did not react).
   * Anchor on the nearest `data-message-id` (transcript row) or
   * `data-tool-call-id`, then nth-child downward.
   */
  const pathOf = (el: Element): string => {
    const ANCHORS = ['data-message-id', 'data-tool-call-id'];
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body) {
      for (const attr of ANCHORS) {
        const value = node.getAttribute(attr);
        if (value) {
          const safe = value.replace(/["\\]/g, '\\$&');
          const tail = parts.length ? ` > ${parts.join(' > ')}` : '';
          return `[${attr}="${safe}"]${tail}`;
        }
      }
      const parent: Element | null = node.parentElement;
      if (!parent)
        break;
      const idx = Array.from(parent.children).indexOf(node) + 1;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${idx})`);
      node = parent;
    }
    return parts.join(' > ');
  };

  // Walk the sidebar in DOM order: a section head opens a new group; other rows hang off the current group
  const sections: AgentsWindowSection[] = [];
  let current: AgentsWindowSection | null = null;
  for (const el of Array.from(document.querySelectorAll('.ui-sidebar-menu-button'))) {
    if (el.hasAttribute('data-section-head')) {
      const root = el.closest('.ui-sidebar-section');
      current = {
        id: root?.getAttribute('data-agent-drop-section-id') || '',
        title: clean(el.querySelector('.ui-sidebar-menu-button-label')?.textContent),
        expanded: el.getAttribute('data-section-expanded') === 'true',
        rows: [],
      };
      sections.push(current);
      continue;
    }
    if (el.getAttribute('aria-id') !== 'glass-sidebar-agent-row')
      continue;
    if (!el.getAttribute('data-variant'))
      continue;
    if (!current) {
      current = { id: '', title: '', expanded: true, rows: [] };
      sections.push(current);
    }
    const dot = el.querySelector('.ui-agent-status-dot');
    current.rows.push({
      title: clean(el.querySelector('.ui-sidebar-menu-button-label')?.textContent),
      time: clean(el.querySelector('.ui-sidebar-menu-button-end')?.textContent),
      active: el.hasAttribute('data-active'),
      unread: el.hasAttribute('data-unread'),
      dot: dot?.getAttribute('data-variant') || '',
      running: !!el.querySelector('.ui-sidebar-menu-button-status-icon .ui-dot-grid-loader'),
    });
  }

  // Pending-decision cards (measured 2026-09-17: all three kinds appear in the agents window)
  //   1. shell-command approval: `.ui-shell-tool-call--pending` (new: the tool
  //      row itself carries Run / Skip / Always Run; the command is split into
  //      tokens on the row). **Missed extract measured 2026-09-17** — this path
  //      originally only recognized the two semantic markers below, and a shell
  //      card has neither, so an approval like "`npx tsc --noEmit` is not in
  //      the allowlist" was completely invisible on the web (the project-window
  //      path could see it the same day; see pendingCards in the DOM extractor).
  //   2. tool approval: `[data-tool-approval-gate]` is itself the card
  //      (Run / Always Run / Skip);
  //   3. mode switch: no semantic class, only `data-switch-mode-accent`
  //      (icon/label, two places); same as the project window — walk up from
  //      the marker to the nearest ancestor that wraps a Switch button.
  const DECISION_APPROVE = /^(switch|always run|continue|inherit|run|allow|accept|approve|send to background composer|connect github|authenticate)/i;
  const DECISION_REJECT = /^(skip|stop|cancel|reject|deny)/i;
  /**
   * Normalize button copy: **every** shortcut glyph must be stripped
   * (`Switch⌘⏎` → `Switch`). Stripping only trailing ⌘⌃⌥⇧ is not enough —
   * ⏎ is last, so after strip we still have `Switch⌘`, and the compare always
   * fails (measured 2026-09-17: the mode-switch card is that name).
   */
  const actionLabelOf = (btn: Element): string =>
    clean(btn.textContent || btn.getAttribute('aria-label')).replace(/[⌘⌃⌥⇧^⏎]/g, '').replace(/\s+/g, ' ').trim();

  /**
   * Menu triggers are not actions. A shell-card footer hangs two
   * `aria-haspopup="menu"` buttons (measured 2026-09-17: the "Allowlist" with
   * `aria-label="Autorun mode: Allowlist"`, and the ⋯ of "Shell command
   * options") — copy `Allowlist` hits DECISION_APPROVE's `allow…` prefix and
   * would be treated as an interactive action, ranking ahead of Run (the web
   * ApprovalCard only draws the first approve) → the primary button on the
   * web becomes "Allowlist", and clicking it only pops a menu.
   * The project window has the same guard.
   */
  const isMenuTrigger = (btn: Element): boolean => {
    const popup = btn.getAttribute('aria-haspopup');
    return popup === 'menu' || popup === 'true' || popup === 'listbox';
  };

  const cards = new Set<Element>();
  const shellCards = new Set<Element>();
  for (const gate of Array.from(document.querySelectorAll('[data-tool-approval-gate]'))) cards.add(gate);
  // Pending shell cards: also take the old card class (`.ui-tool-call-card`).
  // Decided cards have no buttons; the "no placeable action" rule below filters them.
  for (const shell of Array.from(document.querySelectorAll('.ui-shell-tool-call--pending, .ui-tool-call-card'))) {
    cards.add(shell);
    shellCards.add(shell);
  }
  for (const accent of Array.from(document.querySelectorAll('[data-switch-mode-accent]'))) {
    let cur: Element | null = accent;
    while (cur && cur !== document.body) {
      const hasSwitch = Array.from(cur.querySelectorAll('button')).some(
        b => actionLabelOf(b).toLowerCase() === 'switch',
      );
      if (hasSwitch) {
        cards.add(cur);
        break;
      }
      cur = cur.parentElement;
    }
  }
  // Nested de-dupe: in a containment, keep only the outer card
  // (`.ui-tool-call-card` wraps the shell row), or the same card is extracted as two approvals.
  for (const card of Array.from(cards)) {
    for (const other of Array.from(cards)) {
      if (other !== card && other.contains(card)) {
        cards.delete(card);
        shellCards.delete(card);
        break;
      }
    }
  }

  /**
   * Command line of a shell card. Three-level fallback (same as the project
   * window): command block → token join (new builds split the command into
   * command / whitespace / text tokens, "npx" + " " + "tsc" …) → tool description.
   * Cleaner than the whole card's textContent, which would also glue in button
   * copy (Run / Always Run / Skip).
   */
  const shellCommandOf = (card: Element): string => {
    const cmd = clean(card.querySelector('.ui-shell-tool-call__command')?.textContent).replace(/^\$\s*/, '');
    if (cmd)
      return cmd;
    const tokens = clean(
      Array.from(card.querySelectorAll('[class*="ui-shell-tool-call__token--"]'))
        .map(el => el.textContent || '')
        .join(''),
    ).replace(/^\$\s*/, '');
    if (tokens)
      return tokens;
    return clean(card.querySelector('.ui-shell-tool-call__description')?.textContent);
  };

  const approvals: AgentsWindowApprovalDump[] = [];
  for (const card of Array.from(cards)) {
    const actions: AgentsWindowApprovalDump['actions'] = [];
    const seenPaths = new Set<string>();
    for (const btn of Array.from(card.querySelectorAll('button'))) {
      if (isMenuTrigger(btn))
        continue;
      const label = actionLabelOf(btn);
      if (!label)
        continue;
      const type = /^always run/i.test(label)
        ? 'approve_all'
        : DECISION_APPROVE.test(label) ? 'approve' : DECISION_REJECT.test(label) ? 'reject' : '';
      if (!type)
        continue;
      const selectorPath = pathOf(btn);
      if (seenPaths.has(selectorPath))
        continue;
      seenPaths.add(selectorPath);
      actions.push({ label, type, selectorPath });
    }
    // A decided card (buttons gone / no placeable action) is not pending — same rule as the project window
    if (!actions.some(a => a.type === 'approve'))
      continue;
    // Default action (Run / Switch) first, allowlist (Always Run) after, reject last
    // (the web ApprovalCard only draws the first approve).
    // Note `approve_all` is a distinct type; do not bucket by `type === 'approve'` — that would drop it into the reject bucket.
    actions.sort((a, b) => {
      const rank = (x: { type: string; label: string }) =>
        x.type === 'reject' ? 2 : /^always run/i.test(x.label) ? 1 : 0;
      return rank(a) - rank(b);
    });
    // Shell cards use the command line as description; gate / mode-switch keep whole-card copy (same as before this change)
    const description = (shellCards.has(card) ? shellCommandOf(card) : '') || clean(card.textContent);
    approvals.push({ description: description.slice(0, 400), actions });
  }

  // --- Questionnaire (glass ui-tray system, measured 2026-09-17) -------------
  //
  // The agents-window questionnaire is **not** the project window's
  // `.composer-questionnaire-toolbar`; it is another glass `ui-tray` (hung on
  // the input header tray). Measured structure:
  //   div.ui-tray.glass-questionnaire-tray
  //     [data-component="tray-header"] > [data-component="tray-header-title"]（"Questions"）
  //   .ui-tray-step[data-active] × N   — one per question (same screen, not paginated)
  //     .ui-tray-step__title           — prompt
  //     .ui-tray-option × M            — options (`data-text-input="true"` = Other freeform)
  //       .ui-tray-option__badge (letter) / .ui-tray-option__label (text)
  //     .ui-tray-footer：Skip（button[data-variant="ghost"]）
  //       / Continue（.ui-tray-footer__primary > button，
  //         **empty `data-disabled` attribute** = still unanswered questions)
  // When the window is occluded / minimized Cursor does not render the transcript, so this is naturally null.
  // The main-pane composer bar also gives "which agent is current": the questionnaire belongs to it; switching away on the web dismisses the card.
  const bar = document.querySelector('div.composer-bar.editor[data-composer-id]');
  let questionnaire: Questionnaire | null = null;
  const qTray = document.querySelector('[class*="glass-questionnaire-tray"]');
  if (qTray) {
    const nthOfType = (el: Element): number => {
      const parent = el.parentElement;
      if (!parent)
        return 1;
      const sameTag = Array.from(parent.children).filter(c => c.tagName === el.tagName);
      return sameTag.indexOf(el) + 1;
    };
    const questions: Questionnaire['questions'] = [];
    let activeIdx = 0;
    for (const step of Array.from(qTray.querySelectorAll('.ui-tray-step'))) {
      const isActive = step.getAttribute('data-active') === 'true';
      if (isActive)
        activeIdx = questions.length;
      const text = (step.querySelector('.ui-tray-step__title')?.textContent || '').trim();
      // Multi-select: `data-allow-multiple="true"` only appears on multi-select questionnaires (single-select has no such attribute)
      const multiSelect = step.getAttribute('data-allow-multiple') === 'true';
      const options: Questionnaire['questions'][number]['options'] = [];
      for (const optEl of Array.from(step.querySelectorAll('.ui-tray-option'))) {
        const letter = (optEl.querySelector('.ui-tray-option__badge')?.textContent || '').trim();
        const isFreeform = optEl.getAttribute('data-text-input') === 'true';
        const label = isFreeform
          ? 'Other'
          : (optEl.querySelector('.ui-tray-option__label')?.textContent || '').trim();
        options.push({
          letter,
          label,
          isFreeform,
          // Real selected state (an IDE click counts too) — the web uses it to converge with optimistic state
          selected: optEl.getAttribute('data-selected') === 'true',
          selectorPath:
            `.glass-questionnaire-tray .ui-tray-step:nth-of-type(${nthOfType(step)})`
            + ` .ui-tray-option:nth-of-type(${nthOfType(optEl)})`,
        });
      }
      // Stepper / question number: the tray has no ready-made numbers (several questions on one screen); we compute the index for the web to draw
      questions.push({ number: String(questions.length + 1), text, options, isActive, multiSelect });
    }

    const skipBtn = qTray.querySelector('.ui-tray-footer button[data-variant="ghost"]');
    const continueBtn = qTray.querySelector('.ui-tray-footer__primary > button');
    questionnaire = {
      composerId: bar?.getAttribute('data-composer-id') || '',
      questions,
      activeIndex: activeIdx,
      totalLabel: '',
      skipSelectorPath: skipBtn ? '.glass-questionnaire-tray .ui-tray-footer button[data-variant="ghost"]' : '',
      continueSelectorPath: continueBtn ? '.glass-questionnaire-tray .ui-tray-footer__primary > button' : '',
      continueDisabled: continueBtn ? continueBtn.hasAttribute('data-disabled') : false,
      // Copy button labels from the IDE (`actionLabelOf` strips shortcut glyphs)
      skipLabel: skipBtn ? actionLabelOf(skipBtn) : '',
      continueLabel: continueBtn ? actionLabelOf(continueBtn) : '',
    };
  }

  // The real composer input (user bubbles in the transcript are a read-only
  // variant of the same class; the Other input in the questionnaire tray is
  // the same tiptap class and sits before the composer in the DOM — neither
  // counts; see FIND_COMPOSER_INPUT_JS in command-executor). Also take the
  // text inside: an Agents-window draft **is** that text; the web uses it to
  // turn a draft into "text that can be sent as-is".
  const composerEl = Array.from(document.querySelectorAll(
    '.ui-prompt-input-editor__input:not(.ui-prompt-input-tiptap-readonly__content)',
  )).find(el => !el.closest('[class*="glass-questionnaire-tray"]'));

  return {
    sections,
    activeComposerId: bar?.getAttribute('data-composer-id') || '',
    composerStatus: bar?.getAttribute('data-composer-status') || '',
    inputAvailable: !!composerEl,
    inputText: composerEl ? (composerEl.textContent || '').trim() : '',
    approvals,
    questionnaire,
  };
}

/**
 * Row-level status → ChatTab.status (the web draws badges from this). Priority:
 * waiting for approval > running > finished unread > draft > current row > idle
 * (these are mutually exclusive on one row; take the most informative).
 */
export function rowStatusOf(row: AgentsWindowRow): string {
  if (row.dot === 'needs-attention')
    return 'waiting_approval';
  if (row.running)
    return 'generating';
  if (row.dot === 'done-unseen' || row.unread)
    return 'unread';
  if (row.dot === 'draft')
    return 'draft';
  return row.active ? 'active' : 'idle';
}

/** Draft row (New Agent): the matching DB row has empty `name`, filtered out by `readWorkspaceComposers`, so it occupies no sequence slot. */
export function isDraftRow(row: AgentsWindowRow): boolean {
  return row.dot === 'draft' || nameKey(row.title) === 'new agent';
}

/** `data-composer-status` → global agentStatus. */
export function agentStatusFromComposerStatus(status: string): AgentStatus {
  switch (status) {
    case 'needs_attention':
      return 'waiting_approval';
    case 'in_progress':
      return 'generating';
    default:
      return 'idle';
  }
}

/** Take the id from `workspace:<id>`; `home` / `repo:` return empty (those need another workspace lookup). */
export function workspaceIdFromSectionId(sectionId: string): string {
  if (!sectionId.startsWith('workspace:'))
    return '';
  const id = sectionId.slice('workspace:'.length);
  return id && id !== 'home' ? id : '';
}

export interface AgentsIdentityDeps {
  readWorkspaceComposers: (workspaceId: string) => ComposerMeta[];
  workspaceIdOf: (composerId: string) => string;
  listWorkspaceIds: () => string[];
  /** Cloud-agent names in local records (unarchived); `null` = could not read (take the drop-the-section conservative branch). */
  listCloudAgentNames: () => string[] | null;
}

const defaultDeps: AgentsIdentityDeps = {
  readWorkspaceComposers,
  workspaceIdOf,
  listWorkspaceIds,
  listCloudAgentNames,
};

/** Allow skipping a few "IDE did not paint" sessions in the sequence (pagination/collapse), but do not use it to guess. */
const ALIGN_LOOKAHEAD = 3;
/** Cache of section → workspace resolution: a repo section would scan the whole DB; do not scan every round. */
const SECTION_CACHE_TTL_MS = 5 * 60 * 1000;
const sectionWorkspaceCache = new Map<string, { at: number; workspaceId: string }>();

/** For tests: clear the section cache and injected deps. */
export function resetAgentsIdentityForTest(): void {
  sectionWorkspaceCache.clear();
}

function alignToList(
  rows: AgentsWindowRow[],
  list: ComposerMeta[],
): { ids: string[]; matched: number } {
  const ids: string[] = rows.map(() => '');
  let cursor = 0;
  let matched = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (isDraftRow(row))
      continue;
    const key = nameKey(row.title);
    if (!key)
      continue;
    let found = -1;
    for (let k = cursor; k < Math.min(list.length, cursor + ALIGN_LOOKAHEAD); k++) {
      if (nameKey(list[k].name) === key) {
        found = k;
        break;
      }
    }
    if (found < 0)
      break; // broken chain: no ids for this row or after
    ids[i] = list[found].composerId;
    matched++;
    cursor = found + 1;
  }
  return { ids, matched };
}

/**
 * Rows of one section → real composerId (same length as rows; '' if unmatched).
 *
 * Three-tier strategy (prefer empty over guessing):
 *   1. `workspace:<id>` looks up that workspace's session sequence directly;
 *   2. the section has a selected row → reverse-lookup workspace from its
 *      composerId (anchor, most trustworthy);
 *   3. the rest (`repo:` / `home`): take the whole title sequence and find the
 *      **unique** best match across the DB.
 */
export function alignAgentsSectionIds(
  section: AgentsWindowSection,
  activeComposerId: string,
  deps: AgentsIdentityDeps = defaultDeps,
): string[] {
  if (section.rows.length === 0)
    return [];
  const activeIdx = section.rows.findIndex(r => r.active);
  const anchorId = activeIdx >= 0 && activeComposerId ? activeComposerId : '';

  const directWorkspace = workspaceIdFromSectionId(section.id);
  if (directWorkspace) {
    const { ids } = alignToList(section.rows, deps.readWorkspaceComposers(directWorkspace));
    return ids;
  }

  // repo:/home sections: check the cache first (use on hit, but the anchor must still match)
  const cached = sectionWorkspaceCache.get(section.id);
  if (cached && Date.now() - cached.at < SECTION_CACHE_TTL_MS) {
    const { ids } = alignToList(section.rows, deps.readWorkspaceComposers(cached.workspaceId));
    const anchorOk = !anchorId || (activeIdx >= 0 && ids[activeIdx] === anchorId);
    if (anchorOk && ids.some(Boolean))
      return ids;
    sectionWorkspaceCache.delete(section.id);
  }

  const candidates: string[] = [];
  const anchorWorkspace = anchorId ? deps.workspaceIdOf(anchorId) : '';
  if (anchorWorkspace)
    candidates.push(anchorWorkspace);
  for (const id of deps.listWorkspaceIds()) {
    if (!candidates.includes(id))
      candidates.push(id);
  }

  const scored: Array<{ workspaceId: string; ids: string[]; score: number }> = [];
  for (const workspaceId of candidates) {
    const list = deps.readWorkspaceComposers(workspaceId);
    if (list.length === 0)
      continue;
    const { ids, matched } = alignToList(section.rows, list);
    if (matched === 0)
      continue;
    // If an anchor is present it must match: otherwise this workspace is not this group
    if (anchorId && activeIdx >= 0 && ids[activeIdx] !== anchorId)
      continue;
    scored.push({ workspaceId, ids, score: matched });
  }
  if (scored.length === 0)
    return section.rows.map(() => '');

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const anchored = Boolean(anchorId) && activeIdx >= 0 && best.ids[activeIdx] === anchorId;
  if (!anchored && scored.length > 1 && scored[1].score >= best.score) {
    // Two workspaces look equally like it: do not guess
    return section.rows.map(() => '');
  }
  sectionWorkspaceCache.set(section.id, { at: Date.now(), workspaceId: best.workspaceId });
  return best.ids;
}

/**
 * Button copy carries shortcut glyphs (`Run ⌘⏎` / `Always Run 'pnpm' ⇧⌘⏎`):
 * strip them before comparing, or finding a button by copy always fails
 * (the project window hit the same pit).
 */
export function cleanActionLabel(label: string): string {
  // `^` = Windows Ctrl glyph (see the actionLabelOf note in the DOM extractor)
  return label.replace(/[⌘⌃⌥⇧^⏎]/g, '').replace(/\s+/g, ' ').trim();
}

function mapApproval(dump: AgentsWindowApprovalDump, index: number): Approval {
  const actions: ApprovalAction[] = dump.actions.map(a => ({
    label: cleanActionLabel(a.label),
    type: a.type === 'approve_all' ? 'approve_all' : a.type === 'reject' ? 'reject' : 'approve',
    selectorPath: a.selectorPath,
  }));
  return {
    id: `agents-gate-${index}:${dump.description.slice(0, 40)}`,
    description: dump.description,
    actions,
  };
}

export interface MapAgentsDumpOptions {
  windowId?: string;
  /** Injectable in tests; default is tab-identity's read-only DB. */
  deps?: AgentsIdentityDeps;
  /** false = DOM only (no DB); row ids are all placeholders. */
  resolveIds?: boolean;
}

/**
 * dump → live fields. The timeline still goes through content-live (read disk
 * by composerId); this only emits live state.
 * When a row id cannot be resolved, keep a `tab-N` placeholder (same as the
 * project-window sidebar; the click side then converges by position).
 */
export function mapAgentsWindowDump(
  dump: AgentsWindowDump,
  opts: MapAgentsDumpOptions = {},
): Partial<CursorState> {
  const deps = opts.deps ?? defaultDeps;
  /**
   * Whether the current agent is cloud: take `data-composer-id` on
   * `div.composer-bar` (cloud agents are always `bc-…`; the local DB has no
   * such id). This kind of agent has no projectable composer and the
   * transcript does not show it, so live id / input / approvals / window-level
   * status are all treated as "it does not exist" (see the file header).
   */
  const activeIsCloud = isCloudAgentId(dump.activeComposerId);
  /**
   * Cloud-agent rows are **filtered by name, for every section**:
   *   · measured, of 20 current sections only `No Repo` mixes in cloud agents,
   *     but New Agent's "Run on" can pick **Cloud** onto a repo (it would then
   *     hang in that repo section; unmeasured) — so do not only watch
   *     `CLOUD_SECTION_IDS`; that is only "where we know they appear";
   *   · on the DOM a cloud row looks identical to a local row; match by name;
   *   · list unreadable (null) → drop cloud sections wholesale (conservative),
   *     leave other sections as-is (cannot judge row by row);
   *   · when the current agent is cloud, drop the `data-active` row too (the
   *     name cache may have just expired, leaving an unopenable "current row").
   * DOM-only mode explicitly does not query the DB → treat the list as unreadable.
   */
  const cloudNames = opts.resolveIds === false ? null : deps.listCloudAgentNames();
  const cloudKeys = cloudNames ? new Set(cloudNames.map(nameKey)) : null;
  const sections = dump.sections.flatMap((section) => {
    if (!cloudKeys)
      return isCloudSectionId(section.id) ? [] : [section];
    const rows = section.rows.filter(
      row => !cloudKeys.has(nameKey(row.title)) && !(activeIsCloud && row.active),
    );
    return rows.length ? [{ ...section, rows }] : [];
  });
  /**
   * Draft text in the current composer (not given for a cloud agent: the row
   * is hidden, body unreadable, and remote send should not be allowed).
   * **Only for the currently selected draft**: a non-selected draft's composer
   * is not in the DOM (extract cannot get the original; the sidebar title is
   * flattened); clicking it (switch_tab) will pick it up on the next extract.
   */
  const activeInputText = activeIsCloud ? '' : (dump.inputText ?? '').trim();
  const tabs: ChatTab[] = [];
  for (const section of sections) {
    const ids = opts.resolveIds === false
      ? section.rows.map(() => '')
      : alignAgentsSectionIds(section, dump.activeComposerId, deps);
    const sameTitle = new Map<string, number>();
    for (let i = 0; i < section.rows.length; i++) {
      const row = section.rows[i];
      const key = nameKey(row.title);
      const n = sameTitle.get(key) ?? 0;
      sameTitle.set(key, n + 1);
      const id = ids[i] ?? '';
      const draft = isDraftRow(row);
      tabs.push({
        composerId: id || `tab-${tabs.length}`,
        title: row.title || '(untitled)',
        isActive: row.active,
        status: rowStatusOf(row),
        selectorPath: '',
        windowId: opts.windowId,
        rowIndex: tabs.length,
        sameTitleIndex: n,
        composerIdSource: id ? 'db' : undefined,
        section: section.title,
        sectionId: section.id,
        // Draft: no body yet (the web must not fill in the previous session's body); text is in the composer.
        ...(draft ? { isDraft: true } : {}),
        ...(draft && row.active && activeInputText ? { draftText: activeInputText } : {}),
      });
    }
  }

  // Global agentStatus first looks at the current row's row-level truth
  // (spinner / pending approval); it is newer than data-composer-status:
  // the latter is the session's own persisted status (still completed after it finished).
  const activeRow = sections.flatMap(s => s.rows).find(r => r.active);
  const agentStatus: AgentStatus = activeRow?.dot === 'needs-attention'
    ? 'waiting_approval'
    : activeRow?.running
      ? 'generating'
      : agentStatusFromComposerStatus(dump.composerStatus);

  return {
    messages: [],
    chatTabs: tabs,
    // If the current agent is cloud it has no projectable composer: do not
    // report `bc-…` as a live id (content-live would only log content:missing,
    // and the web would get an extra unclickable "current session").
    activeComposerId: activeIsCloud ? '' : dump.activeComposerId || '',
    // The input exists on a cloud agent too, but row/body are not shown, so do not offer a remote input entry
    inputAvailable: activeIsCloud ? false : dump.inputAvailable,
    // Also report a cloud agent's window-level status as "idle": it has no
    // displayable current row; reporting "waiting approval / running" would
    // disagree with the top bar (cards below). Local rows keep their own
    // running/unread row badges; those are not lost.
    agentStatus: activeIsCloud ? 'idle' : agentStatus,
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    // Cards are drawn in the current agent's transcript: current agent is cloud → the card is cloud too, drop together
    // (an invisible session must not be remotely decided; switch to it in the IDE first).
    pendingApprovals: activeIsCloud ? [] : dump.approvals.map(mapApproval),
    liveActions: {},
    composerQueue: { items: [] },
    // Same for the questionnaire: drop a cloud agent's questionnaire too (same "invisible → no decide").
    // `?? null` tolerates old dumps (callers before this extract / old test fixtures had no this field).
    questionnaire: activeIsCloud ? null : (dump.questionnaire ?? null),
  };
}
