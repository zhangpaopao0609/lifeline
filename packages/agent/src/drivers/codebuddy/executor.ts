import type { CdpClient } from '../../cdp/client.js';
import type { CommandResult, SwitchTabTarget } from '../../types.js';
import type { WindowSessionTab } from '../../window-session.js';
import { timingLog, timingPreview } from '../../timing-log.js';
import { pickWindowSession } from '../../window-session.js';
import {
  CODEBUDDY_FRAME_JS,
  CODEBUDDY_MODEL_ROWS_JS,
  CODEBUDDY_MODEL_TRIGGER_SEL,
  codebuddyClickByValueExpression,
  codebuddyClickExpression,
  codebuddyClickModelExpression,
} from './extractor.js';
import {
  composerStillContains,
  FIBER_COMPOSER_TEXT_JS,
  FIBER_ENTER_JS,
  fiberInsertExpression,
  interpretFiberSendResult,
} from './fiber-script.js';
import { DENY_RE } from './live.js';

const INSERT_WAIT_MS = 300;
const DROPDOWN_WAIT_MS = 250;
const NOT_IMPLEMENTED = 'not implemented';

/**
 * CodeBuddy CN 2026-09 moved the "+" new-chat control out of the coding-copilot
 * webview into the workbench action bar (panel title). Runs against the
 * workbench page target, NOT the webview.
 */
const WORKBENCH_NEW_CHAT_JS = `(() => {
  const btns = Array.from(document.querySelectorAll(
    '.codicon-codingcopilot-new-chat, a[aria-label="Start New Chat"], [aria-label="新建会话"]'
  ));
  const target = btns.find((b) => b.offsetParent || b.getClientRects().length) || btns[0];
  if (!target) return { ok: false, error: 'New Chat button not found' };
  target.click();
  return { ok: true };
})()`;

/**
 * Stop the current generation (= click the composer bottom-right submit
 * button in its swapped identity).
 *
 * Measured 2026-09-18 probe: this button has **no** stop class and no
 * aria-label on the DOM; `[class*="stop"]` never hits (idle is a paper-plane
 * icon + `icon-button-module_disabled_*`; while generating it becomes a
 * square icon and drops disabled, other classes identical). The only stable
 * handle is the React fiber: that submit-button layer's props are
 * `loading / disabled / disabledTooltip / onSend / onCancel`; while
 * generating `loading === true`, and `onCancel` is "stop".
 * So walk up from every [role=button] in the composer looking for a fiber
 * with onSend+onCancel, and call onCancel **only when loading is true** —
 * do not guess icons, and do not treat "not generating" as success.
 */
export const CODEBUDDY_STOP_JS = `(() => {
  ${CODEBUDDY_FRAME_JS}
  const host = root.querySelector('[class*="chat-input-module_container"]');
  const scope = host ? (host.closest('[class*="chat-input-module"]') || host) : root;
  let submitButtons = 0;
  for (const el of Array.from(scope.querySelectorAll('[role="button"], button'))) {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (!key) continue;
    let fiber = el[key];
    for (let depth = 0; fiber && depth < 12; depth++) {
      const props = fiber.memoizedProps;
      if (props && typeof props.onSend === 'function' && typeof props.onCancel === 'function') {
        submitButtons += 1;
        if (props.loading === true) {
          try {
            props.onCancel();
          } catch (e) {
            return { ok: false, error: 'onCancel threw: ' + String(e).slice(0, 160) };
          }
          return { ok: true, via: 'fiber.onCancel' };
        }
        break;
      }
      fiber = fiber.return;
    }
  }
  return { ok: false, error: submitButtons > 0 ? 'Not generating' : 'Stop button not found' };
})()`;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function notImplemented(commandId: string): CommandResult {
  return { commandId, ok: false, error: NOT_IMPLEMENTED };
}

export interface CodeBuddyExecutorOptions {
  wait?: (ms: number) => Promise<void>;
}

function clickResult(commandId: string, value: unknown): CommandResult {
  if (value && typeof value === 'object' && (value as { ok?: boolean }).ok === true) {
    return { commandId, ok: true };
  }
  const error = value && typeof value === 'object'
    ? (value as { error?: string }).error
    : undefined;
  return { commandId, ok: false, error: error || 'Element not found' };
}

/**
 * CodeBuddy command path: Slate fiber insertText, wait one beat, then onEnter.
 * Clicks use Runtime.evaluate querySelector(path).click() inside #active-frame.
 */
export class CodeBuddyExecutor {
  private client: CdpClient | null = null;
  private workbenchClient: CdpClient | null = null;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(options: CodeBuddyExecutorOptions = {}) {
    this.wait = options.wait ?? sleep;
  }

  setClient(client: CdpClient | null): void {
    this.client = client;
  }

  /** Client connected to the workbench page (action-bar buttons live there). */
  setWorkbenchClient(client: CdpClient | null): void {
    this.workbenchClient = client;
  }

  isReady(): boolean {
    return !!this.client?.isConnected();
  }

  private requireClient(): { ok: false; error: string } | CdpClient {
    const client = this.client;
    if (!client || !client.isConnected()) {
      return { ok: false, error: 'Not connected to CodeBuddy' };
    }
    return client;
  }

  async sendMessage(commandId: string, text: string): Promise<CommandResult> {
    const client = this.requireClient();
    if (!('evaluate' in client)) {
      return { commandId, ...client };
    }

    try {
      const started = Date.now();
      timingLog('codebuddy-send:begin', { commandId, chars: text.length, preview: timingPreview(text) });
      const insertStarted = Date.now();
      const inserted = await client.evaluate(fiberInsertExpression(text)) as
        | { ok?: boolean; err?: string }
        | null;
      timingLog('codebuddy-send:insert', {
        commandId,
        ms: Date.now() - insertStarted,
        ok: !!(inserted && !inserted.err),
        error: inserted?.err,
      });
      if (!inserted || inserted.err) {
        return { commandId, ok: false, error: inserted?.err ?? 'no editor' };
      }

      await this.wait(INSERT_WAIT_MS);

      const enterStarted = Date.now();
      const entered = await client.evaluate(FIBER_ENTER_JS) as
        | { called?: boolean; err?: string; error?: string }
        | null;
      timingLog('codebuddy-send:enter', {
        commandId,
        ms: Date.now() - enterStarted,
        called: entered?.called,
        error: entered?.err || entered?.error,
      });
      let snapshot: unknown;
      try {
        const snapshotStarted = Date.now();
        snapshot = await client.evaluate(FIBER_COMPOSER_TEXT_JS);
        timingLog('codebuddy-send:snapshot', {
          commandId,
          ms: Date.now() - snapshotStarted,
        });
      }
      catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        timingLog('codebuddy-send:verify-skip', { commandId, error });
        const ok = entered?.called !== false && !entered?.err && !entered?.error;
        timingLog('codebuddy-send:done', { commandId, ok, error, ms: Date.now() - started });
        return { commandId, ok };
      }
      const outcome = interpretFiberSendResult({
        inserted,
        entered,
        stillContains: composerStillContains(snapshot, text),
      });
      timingLog('codebuddy-send:done', {
        commandId,
        ok: outcome.ok,
        error: outcome.error,
        ms: Date.now() - started,
      });
      return { commandId, ...outcome };
    }
    catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      timingLog('codebuddy-send:error', { commandId, error });
      return { commandId, ok: false, error };
    }
  }

  private async clickPath(commandId: string, path: string): Promise<CommandResult> {
    const client = this.requireClient();
    if (!('evaluate' in client)) {
      return { commandId, ...client };
    }
    if (!path)
      return { commandId, ok: false, error: 'Missing selectorPath' };
    try {
      const value = await client.evaluate(codebuddyClickExpression(path));
      return clickResult(commandId, value);
    }
    catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { commandId, ok: false, error };
    }
  }

  async clickApproval(commandId: string, selectorPath: string): Promise<CommandResult> {
    return this.clickPath(commandId, selectorPath);
  }

  async approveAll(commandId: string): Promise<CommandResult> {
    const client = this.requireClient();
    if (!('evaluate' in client)) {
      return { commandId, ...client };
    }
    try {
      const value = await client.evaluate(`(() => {
        ${CODEBUDDY_FRAME_JS}
        function textOf(el) {
          return ((el && (el.textContent || el.getAttribute('aria-label'))) || '').replace(/\\s+/g, ' ').trim();
        }
        let n = 0;

        // Transcript tool menu: Run / Skip / Reject. Match Run positively —
        // clicking "the first .menu-item" would Skip the command instead.
        for (const menu of Array.from(root.querySelectorAll('.tool-menu'))) {
          for (const item of Array.from(menu.querySelectorAll('.menu-item'))) {
            const label = textOf(item);
            if (!/^(run|运行|allow|允许|accept|接受)$/i.test(label)) continue;
            if (/${DENY_RE.source}/.test(label.toLowerCase())) continue;
            item.click();
            n++;
          }
        }

        // Floating confirmations are single-button, so a deny-label guard is
        // enough. card-buttons is NOT here: its only button is
        // "Run in Background", which is not an approval.
        const sel = [
          '[class*="execute-command-compact__btn--allow"]',
          '[class*="high-credit-approval-floating-module_confirm"]',
          '[class*="roots-confirm-card__actions"] button',
        ].join(',');
        for (const el of Array.from(root.querySelectorAll(sel))) {
          const t = textOf(el).toLowerCase();
          if (/${DENY_RE.source}/.test(t)) continue;
          el.click();
          n++;
        }
        return n > 0 ? { ok: true } : { ok: false, error: 'No approve buttons' };
      })()`);
      return clickResult(commandId, value);
    }
    catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { commandId, ok: false, error };
    }
  }

  async reject(commandId: string, selectorPath: string): Promise<CommandResult> {
    return this.clickPath(commandId, selectorPath);
  }

  /** Stop the current generation; if not generating, return `Not generating` (not success). See CODEBUDDY_STOP_JS. */
  async stop(commandId: string): Promise<CommandResult> {
    const client = this.requireClient();
    if (!('evaluate' in client)) {
      return { commandId, ...client };
    }
    try {
      const value = await client.evaluate(CODEBUDDY_STOP_JS);
      return clickResult(commandId, value);
    }
    catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { commandId, ok: false, error };
    }
  }

  /**
   * After a click, "which row is showing now": read data-session-tab-id on
   * the active row. Unreadable (old DOM / not in the webview) returns empty
   * — the caller treats that as "unverified", not failure.
   */
  private async activeTabId(client: CdpClient): Promise<string> {
    try {
      const id = await client.evaluate(`(() => {
        ${CODEBUDDY_FRAME_JS}
        const el = Array.from(root.querySelectorAll('.session-tab')).find(
          (t) => t.classList.contains('session-tab-active') || t.getAttribute('aria-selected') === 'true'
        );
        return el ? (el.getAttribute('data-session-tab-id') || '') : '';
      })()`);
      return typeof id === 'string' ? id : '';
    }
    catch {
      return '';
    }
  }

  /** Wait until the active row becomes the target id (UI needs a frame to swap class); on timeout return the current value. */
  private async awaitLandedTab(client: CdpClient, wantId: string, timeoutMs = 800): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let landed = await this.activeTabId(client);
    while (landed !== wantId && Date.now() < deadline) {
      await this.wait(80);
      landed = await this.activeTabId(client);
    }
    return landed;
  }

  /**
   * Switch to a session. Three keys, ordered by how stable they are:
   *   1. composerId — the row's own `data-session-tab-id`, ground truth;
   *   2. selectorPath — old DOM path chain (goes stale on reorder; fallback only);
   *   3. title — exact → prefix fallback (same-title sessions only hit the first).
   * After an id / title hit, re-read the active row's id: landing on another
   * session is failure, not a fake success.
   */
  async switchTab(
    commandId: string,
    tabTitle: string,
    selectorPath?: string,
    target?: SwitchTabTarget,
  ): Promise<CommandResult> {
    const client = this.requireClient();
    if (!('evaluate' in client)) {
      return { commandId, ...client };
    }
    if (!tabTitle && !selectorPath)
      return { commandId, ok: false, error: 'Missing tabTitle' };
    const wantId = target?.composerId ?? '';
    try {
      // 1) Click by id: the expression compares data-session-tab-id first (the title branch will not false-hit an id)
      if (wantId) {
        const byId = await client.evaluate(codebuddyClickByValueExpression('tab', wantId));
        if (byId && (byId as { ok?: boolean }).ok === true) {
          const landed = await this.awaitLandedTab(client, wantId);
          if (landed && landed !== wantId) {
            // Landed on another session (same title / order changed): fail; do not let the web leave highlight on the target as if it succeeded
            const short = landed.slice(0, 8);
            return {
              commandId,
              ok: false,
              error: `点了「${tabTitle}」但落到别的会话（${short}…）`,
              data: { landedComposerId: landed, via: 'id' },
            };
          }
          timingLog('codebuddy-switch', { commandId, byId: true, verified: !!landed });
          return { commandId, ok: true, data: { landedComposerId: landed || wantId, via: 'id' } };
        }
      }
      // 2) Old path: DOM selectorPath (goes stale on reorder; still verify after the click)
      if (selectorPath) {
        const byPath = await this.clickPath(commandId, selectorPath);
        if (byPath.ok) {
          const landed = wantId ? await this.awaitLandedTab(client, wantId) : '';
          if (wantId && landed && landed !== wantId) {
            return {
              commandId,
              ok: false,
              error: `点了「${tabTitle}」但落到别的会话（${landed.slice(0, 8)}…）`,
              data: { landedComposerId: landed, via: 'selectorPath' },
            };
          }
          timingLog('codebuddy-switch', { commandId, byId: false, via: 'selectorPath', verified: !!landed });
          return { commandId, ok: true, data: { landedComposerId: landed, via: 'selectorPath' } };
        }
        if (!tabTitle)
          return byPath;
      }
      // 3) By title
      if (!tabTitle)
        return { commandId, ok: false, error: 'Tab not found: (no title)' };
      const value = await client.evaluate(codebuddyClickByValueExpression('tab', tabTitle));
      const result = clickResult(commandId, value);
      if (!result.ok)
        return result;
      const landed = wantId ? await this.awaitLandedTab(client, wantId) : '';
      if (wantId && landed && landed !== wantId) {
        return {
          commandId,
          ok: false,
          error: `点了「${tabTitle}」但落到别的会话（${landed.slice(0, 8)}…）`,
          data: { landedComposerId: landed, via: 'title' },
        };
      }
      timingLog('codebuddy-switch', { commandId, byId: false, verified: !!landed });
      return { commandId, ok: true, data: { landedComposerId: landed, via: 'title' } };
    }
    catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { commandId, ok: false, error };
    }
  }

  async activateCurrentTab(commandId: string): Promise<CommandResult> {
    const client = this.requireClient();
    if (!('evaluate' in client)) {
      return { commandId, ...client };
    }
    try {
      const listed = await client.evaluate(`(() => {
        ${CODEBUDDY_FRAME_JS}
        return Array.from(root.querySelectorAll('.session-tab')).map((el) => {
          const titleEl = el.querySelector('.session-tab-name');
          const title = ((titleEl || el).textContent || '').replace(/\\s+/g, ' ').trim();
          const isActive = el.classList.contains('session-tab-active')
            || el.getAttribute('aria-selected') === 'true';
          return { title, isActive };
        }).filter((t) => t.title);
      })()`);
      const tabs = (Array.isArray(listed) ? listed : []) as WindowSessionTab[];
      const title = pickWindowSession(tabs);
      if (!title) {
        timingLog('codebuddy-activate', { commandId, activated: false, n: tabs.length });
        return { commandId, ok: true, data: { activated: false } };
      }
      const clicked = await this.switchTab(commandId, title);
      if (!clicked.ok)
        return clicked;
      timingLog('codebuddy-activate', { commandId, activated: true, title });
      return {
        ...clicked,
        data: {
          ...(clicked.data && typeof clicked.data === 'object' ? clicked.data : {}),
          activated: true,
          title,
        },
      };
    }
    catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { commandId, ok: false, error };
    }
  }

  async newChat(commandId: string): Promise<CommandResult> {
    // New UI: the "+" lives in the workbench action bar, outside the webview.
    const workbench = this.workbenchClient;
    if (workbench && workbench.isConnected()) {
      try {
        const value = await workbench.evaluate(WORKBENCH_NEW_CHAT_JS);
        const result = clickResult(commandId, value);
        if (result.ok)
          return result;
      }
      catch {
        // fall through to the webview cascade (older CodeBuddy builds)
      }
    }
    // Old UI fallback: the "+" was a sibling inside the webview session tab bar.
    const client = this.requireClient();
    if (!('evaluate' in client)) {
      return { commandId, ...client };
    }
    try {
      const value = await client.evaluate(codebuddyClickByValueExpression('new_chat', ''));
      return clickResult(commandId, value);
    }
    catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { commandId, ok: false, error };
    }
  }

  async setMode(commandId: string, modeId: string): Promise<CommandResult> {
    const client = this.requireClient();
    if (!('evaluate' in client)) {
      return { commandId, ...client };
    }
    if (!modeId)
      return { commandId, ok: false, error: 'Missing modeId' };
    try {
      const opened = await client.evaluate(`(() => {
        ${CODEBUDDY_FRAME_JS}
        const el = root.querySelector('[class*="mode-selector-module_modeButton"]');
        if (!el) return { ok: false, error: 'Mode dropdown not found' };
        el.click();
        return { ok: true };
      })()`);
      if (!opened || (opened as { ok?: boolean }).ok !== true) {
        return clickResult(commandId, opened);
      }
      await this.wait(DROPDOWN_WAIT_MS);
      const value = await client.evaluate(codebuddyClickByValueExpression('mode', modeId));
      return clickResult(commandId, value);
    }
    catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { commandId, ok: false, error };
    }
  }

  async setModel(commandId: string, modelId: string): Promise<CommandResult> {
    const client = this.requireClient();
    if (!('evaluate' in client)) {
      return { commandId, ...client };
    }
    if (!modelId)
      return { commandId, ok: false, error: 'Missing modelId' };
    try {
      const opened = await client.evaluate(`(() => {
        ${CODEBUDDY_FRAME_JS}
        const el = root.querySelector(${JSON.stringify(CODEBUDDY_MODEL_TRIGGER_SEL)});
        if (!el) return { ok: false, error: 'Model dropdown not found' };
        el.click();
        return { ok: true };
      })()`);
      if (!opened || (opened as { ok?: boolean }).ok !== true) {
        return clickResult(commandId, opened);
      }
      await this.wait(DROPDOWN_WAIT_MS);
      const value = await client.evaluate(codebuddyClickModelExpression(modelId));
      return clickResult(commandId, value);
    }
    catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { commandId, ok: false, error };
    }
  }

  /**
   * Read the model list from the composer's model popover.
   *
   * Verified live against CodeBuddy CN 2026-09. The popover renders one
   * `model-select-module_modelItem` per model, with the clean name in a nested
   * `model-select-module_modelName` — the row's own textContent glues badges and
   * pricing onto the name ("Deepseek-V4.1-FlashHigh错峰使用0.11x"), so it must
   * not be used as the label. Group headers are `groupLabel`, not `modelItem`,
   * so the row selector already excludes them.
   *
   * Returns `{ options }` — the same shape as the Cursor executor, because the
   * web client reads `data.options`.
   */
  async getModelOptions(commandId: string): Promise<CommandResult> {
    const client = this.requireClient();
    if (!('evaluate' in client)) {
      return { commandId, ...client };
    }
    try {
      const opened = await client.evaluate(`(() => {
        ${CODEBUDDY_FRAME_JS}
        const el = root.querySelector(${JSON.stringify(CODEBUDDY_MODEL_TRIGGER_SEL)});
        if (!el) return { ok: false, error: 'Model dropdown not found' };
        el.click();
        return { ok: true };
      })()`);
      if (!opened || (opened as { ok?: boolean }).ok !== true) {
        return clickResult(commandId, opened);
      }

      await this.wait(DROPDOWN_WAIT_MS);

      const options = await client.evaluate(`(() => {
        ${CODEBUDDY_FRAME_JS}
        ${CODEBUDDY_MODEL_ROWS_JS}
        return collectCodeBuddyModels();
      })()`) as { id: string; label: string }[];

      // The popover is only open because we opened it — leave the IDE as found.
      await client.evaluate(`(() => {
        ${CODEBUDDY_FRAME_JS}
        const el = root.querySelector(${JSON.stringify(CODEBUDDY_MODEL_TRIGGER_SEL)});
        if (el) el.click();
        return { ok: true };
      })()`);

      if (!Array.isArray(options) || options.length === 0) {
        return { commandId, ok: false, error: 'Model list came back empty' };
      }
      return { commandId, ok: true, data: { options } };
    }
    catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { commandId, ok: false, error };
    }
  }

  async getPlanModelOptions(commandId: string, _selectorPath: string): Promise<CommandResult> {
    return notImplemented(commandId);
  }

  async setPlanModel(
    commandId: string,
    _selectorPath: string,
    _planModelId: string,
  ): Promise<CommandResult> {
    return notImplemented(commandId);
  }

  async clickAction(
    commandId: string,
    selectorPath: string,
    _actionLabel?: string,
  ): Promise<CommandResult> {
    return this.clickPath(commandId, selectorPath);
  }
}
