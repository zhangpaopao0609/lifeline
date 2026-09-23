import 'dotenv/config';
import type { AgentConfig, SelectorConfig } from './types.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadConfig(): AgentConfig {
  const dataDir = process.env.DATA_DIR ?? resolve(process.cwd(), 'data');

  return {
    cdpUrl: process.env.CDP_URL ?? 'http://127.0.0.1:9222',
    codebuddyCdpUrl: process.env.CODEBUDDY_CDP_URL ?? 'http://127.0.0.1:9223',
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '300', 10),
    debounceMs: parseInt(process.env.DEBOUNCE_MS ?? '150', 10),
    // Repo-relative: dev entry points (`pnpm run agent`, probes, tests) run with cwd = repo root.
    selectorsPath: process.env.SELECTORS_PATH ?? 'packages/agent/selectors.json',
    logLevel: (process.env.LOG_LEVEL as AgentConfig['logLevel']) ?? 'info',
    windowTitleQualifier: process.env.WINDOW_TITLE_QUALIFIER !== 'false',
    dataDir,
    remoteUrl: process.env.REMOTE_URL ?? '',
    agentToken: process.env.AGENT_TOKEN ?? '',
    agentsWindow: process.env.AGENTS_WINDOW !== '0',
  };
}

export function loadSelectors(config: AgentConfig): SelectorConfig {
  const fullPath = resolve(config.selectorsPath);
  try {
    const raw = readFileSync(fullPath, 'utf-8');
    return JSON.parse(raw) as SelectorConfig;
  }
  catch {
    console.warn(`[config] Could not load selectors from ${fullPath}, using defaults`);
    return getDefaultSelectors();
  }
}

/**
 * Selector fallback for processes that cannot see `packages/agent/selectors.json`.
 *
 * The installed daemon runs from `~/.lifeline/` with cwd `/`, so `loadSelectors()`
 * always fails and these defaults are the effective config in production. They
 * must stay identical to `packages/agent/selectors.json` —
 * `tests/selectors-defaults.test.ts` enforces that.
 */
export function getDefaultSelectors(): SelectorConfig {
  return {
    chatContainer: {
      strategies: [
        '#workbench\\.parts\\.auxiliarybar',
        'div.composer-bar.editor',
        '[class*=\'composer-bar\']',
        '[class*=\'composer-panel\']',
        '[class*=\'chat-widget\']',
      ],
    },
    approveButton: {
      strategies: [
        'button.ui-shell-tool-call__run-btn',
        'button.ui-shell-tool-call__allowlist-button',
        '.ui-shell-tool-call__allowlist-button-wrapper button',
        'button[aria-label*=\'Accept\']',
        'button[aria-label*=\'Approve\']',
        'button[aria-label*=\'Run\']',
        'button[aria-label*=\'Allow\']',
      ],
      textMatch: ['Accept', 'Approve', 'Run', 'Allow', 'Accept All'],
    },
    rejectButton: {
      strategies: [
        'button.ui-shell-tool-call__skip-btn',
        'button[aria-label*=\'Reject\']',
        'button[aria-label*=\'Deny\']',
        'button[aria-label*=\'Cancel\']',
      ],
      textMatch: ['Reject', 'Deny', 'Cancel', 'Skip'],
    },
    chatInput: {
      strategies: [
        '.aislash-editor-input',
        '#workbench\\.parts\\.auxiliarybar [contenteditable=\'true\']',
        '#workbench\\.parts\\.auxiliarybar textarea',
        '#workbench\\.parts\\.auxiliarybar [role=\'textbox\']',
        '.composer-bar [contenteditable=\'true\']',
        '.composer-bar textarea',
        '[contenteditable=\'true\']',
      ],
    },
    agentStatus: {
      strategies: [
        'span.auxiliary-bar-chat-title',
        '[class*=\'auxiliary-bar-chat-title\']',
        '[class*=\'status\']',
        '[class*=\'thinking\']',
        '[class*=\'spinner\']',
        '[class*=\'loading\']',
      ],
    },
    chatTabList: {
      strategies: [
        '.agent-sidebar-list .agent-sidebar-cell',
        '.agent-sidebar-cell',
        '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > .ui-sidebar-menu-button',
        '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn',
      ],
    },
    newChatButton: {
      strategies: [
        '[data-command-id=\'composer.createNewComposerTab\']',
        'a.codicon-add-two',
        '[aria-label*=\'New Chat\']',
      ],
    },
    modeDropdown: {
      strategies: [
        '.composer-unified-dropdown[data-mode]',
        '.composer-bar-input-buttons[data-mode]',
      ],
    },
    modelDropdown: {
      strategies: [
        '.vscode-model-picker__trigger',
        '.ui-model-picker__trigger',
        '.composer-unified-dropdown-model',
      ],
    },
  };
}
