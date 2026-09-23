import type { CdpEndpointSource } from '../../../protocol/src/index.js';
import type { CDPBridge, CDPBridgeOptions } from '../cdp/bridge.js';
import type { CdpClient } from '../cdp/client.js';
import type { CodeBuddyExecutor } from '../drivers/codebuddy/executor.js';
import type { CodeBuddyExtractor } from '../drivers/codebuddy/extractor.js';
import type { CommandExecutor } from '../drivers/cursor/executor.js';
import type { DOMExtractor } from '../drivers/cursor/extractor.js';
import type { ContentSource } from '../sources/content-source.js';
import type { StateManager } from '../state-manager.js';
import type { AgentConfig, CursorState, IdeKind, SelectorConfig, WindowKind } from '../types.js';

export type AnyExtractor = DOMExtractor | CodeBuddyExtractor;
export type AnyExecutor = CommandExecutor | CodeBuddyExecutor;

/** Target fields from the CDP /json list (was an inline type in ide-slot; shared at the driver layer). */
export interface CdpTargetFields {
  url: string;
  webSocketDebuggerUrl?: string;
  id?: string;
  parentId?: string;
  openerId?: string;
  browserContextId?: string;
  title?: string;
}

/**
 * Ops surface the slot exposes to the driver — the driver drives live state
 * only through this and never touches slot-private state.
 * CodeBuddy's dual-connection state machine (gen / backoff / webview client)
 * all goes through this; no kind branching remains in ide-slot.
 */
export interface LiveSlotHandle {
  kind: IdeKind;
  cdp: CDPBridge;
  stateManager: StateManager;
  extractor: AnyExtractor;
  executor: AnyExecutor;
  /** Currently effective CDP URL (may differ from the configured value after resolveEndpoint). */
  currentCdpUrl: () => string;
  /** CDP endpoint source (for liveIssue diagnostics); undefined = not yet resolved. */
  endpointSource: () => CdpEndpointSource | undefined;
  pollIntervalMs: number;
  /** CDP /json list (test hook can override). */
  fetchCdpTargets: (cdpUrl: string) => Promise<CdpTargetFields[]>;
  /** Factory for a direct client to the coding-copilot webview (test hook can override). */
  createLiveClient: () => CdpClient;
  /** Timer (test hook can override). */
  schedule: typeof setTimeout;
  now: () => number;
}

/** Extractor factory context: Cursor-specific window context fields that CodeBuddy ignores. */
export interface ExtractorFactoryContext {
  selectors: SelectorConfig;
  onExtraction: (state: CursorState | null, errorMessage?: string | null) => void;
  /** cursor: workbench active-window title (DOMExtractor's titleFn). */
  activeWindowTitle: () => string;
  /** cursor: active window kind (Agents overview switches to agents extract). CursorWindow['kind'] is optional; callers default it. */
  activeWindowKind: () => WindowKind;
}

/** Executor factory context: Cursor-specific window-kind provider that CodeBuddy ignores. */
export interface ExecutorFactoryContext {
  selectors: SelectorConfig;
  /** cursor: executor window-kind provider (agents window uses a different command target). */
  windowKindProvider: () => 'agents' | 'project';
}

/** CDPBridge per-IDE options (ide / resolveUrl / test hooks are passed uniformly by the slot). */
export interface IdeBridgeOptions {
  titleSuffixes?: string[];
  relauncher?: CDPBridgeOptions['relauncher'];
  appNames?: string[];
}

/** live-ides probe injection signature (quiet strategy only, never a gate — review R1). */
export type HasLiveApp = (
  exists: (path: string) => boolean,
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) => boolean;

/**
 * Full wiring for one IDE: port discovery, CDP-bridge diffs, extract/execute
 * factories, live-connect strategy, probe and argv paths. Adding an IDE = one
 * new implementation + a registration in drivers/index.ts.
 */
export interface IdeDriver {
  kind: IdeKind;
  /** This IDE's CDP URL field on AgentConfig (cursor: cdpUrl / codebuddy: codebuddyCdpUrl). */
  cdpUrlOf: (config: AgentConfig) => string;
  /** DevToolsActivePort file candidates (auto-discover the port). */
  portCandidates: () => string[];
  /** argv.json paths (current platform first; uninstall must also list paths written on other platforms). */
  argvPaths: () => string[];
  /** Whether a GUI build is installed on this machine (live-ides quiet strategy, not a gate). */
  hasLiveApp: HasLiveApp;
  /** CDPBridge per-IDE options; empty object = all bridge defaults. */
  bridgeOptions: () => IdeBridgeOptions;
  /** Declarative WindowMonitor diffs (window-poll dispatch is internal to the monitor, not exported). */
  windowMonitor: { otherWindowsRequireWsUrl: boolean };
  /** Disk session source (cursor: SQLite state.vscdb / codebuddy: JSON history); return null if it cannot be opened. */
  openDiskAdapter: (opts: { includeProcess?: boolean }) => ContentSource | null;
  /** Command capability matrix: the router uses this to reject "commands this IDE does not support" instead of hard-coding kind checks. */
  capabilities: {
    /** get_plan_full: CodeBuddy has no Cursor-style plan-card DOM. */
    getPlanFull: boolean;
  };
  createExtractor: (ctx: ExtractorFactoryContext) => AnyExtractor;
  createExecutor: (ctx: ExecutorFactoryContext) => AnyExecutor;
  /** How to attach live state after the CDP bridge connects: cursor hangs off workbench; codebuddy uses a dual-connection state machine. */
  attachLive: (slot: LiveSlotHandle) => void;
  /** Shared by disconnect / stop; must be idempotent. */
  detachLive: (slot: LiveSlotHandle) => void;
  /** Wait for the command path to be ready after slot.start. */
  waitUntilReady: (slot: LiveSlotHandle) => Promise<boolean>;
}
