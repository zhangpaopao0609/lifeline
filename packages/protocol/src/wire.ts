/**
 * Sole source of truth for "which IDEs exist" (P2 single-point). Adding an IDE changes this (and the
 * P3 driver); zod enum / agent-hub lists / web lists and labels all derive from here — don't hand-write
 * the list elsewhere. Lives in wire.ts (with the types) rather than ide.ts, to avoid an ide.ts ↔ wire.ts
 * circular import.
 */
export const IDE_KINDS = ['cursor', 'codebuddy'] as const;
export type IdeKind = (typeof IDE_KINDS)[number];

export interface HumanMessage {
  type: 'human';
  id: string;
  flatIndex: number;
  text: string;
  mentions: { name: string; mentionType: string }[];
  quoted?: { text: string };
  /** Client optimistic-bubble marker (not a wire field): pending-send state */
  pending?: boolean;
}

export interface AssistantMessage {
  type: 'assistant';
  id: string;
  flatIndex: number;
  text: string;
}

export type DiffLineKind = 'add' | 'rem' | 'ctx' | 'meta' | 'hunk';

export interface CodeBlockItem {
  blockKind: 'code' | 'diff';
  filename?: string;
  language?: string;
  code: string;
  diffLines?: { kind: DiffLineKind; text: string }[];
}

export interface ToolCallElement {
  type: 'tool';
  id: string;
  flatIndex: number;
  toolCallId: string;
  status: 'loading' | 'completed' | 'error' | 'cancelled';
  action: string;
  toolName?: string;
  details: string;
  filename?: string;
  additions?: number;
  deletions?: number;
  summaryText?: string;
  actions?: RunAction[];
  blocked?: string;
  diffBlock?: CodeBlockItem;
}

export interface ThoughtBlock {
  type: 'thought';
  id: string;
  flatIndex: number;
  duration: string;
  action?: string;
  detail?: string;
  thoughtKind?: 'step_summary' | 'thinking_step';
}

export interface PlanTodo {
  text: string;
  status: 'pending' | 'completed' | 'in_progress';
}

export interface PlanAction {
  label: string;
  type: 'view_plan' | 'build';
  selectorPath: string;
}

export interface PlanBlock {
  type: 'plan';
  id: string;
  flatIndex: number;
  label: string;
  title: string;
  todosCompleted: number;
  todosTotal: number;
  description?: string;
  todos?: PlanTodo[];
  todosMoreCount?: number;
  model?: string;
  modelDropdownSelectorPath?: string;
  actions?: PlanAction[];
}

export interface TodoListBlock {
  type: 'todo_list';
  id: string;
  flatIndex: number;
  title: string;
  todosCompleted: number;
  todosTotal: number;
  todos: PlanTodo[];
}

export interface RunAction {
  label: string;
  type: 'run' | 'skip' | 'allow';
  selectorPath: string;
}

export interface RunCommand {
  type: 'run_command';
  id: string;
  flatIndex: number;
  toolCallId: string;
  description: string;
  candidates: string;
  command: string;
  actions: RunAction[];
}

export interface LoadingIndicator {
  type: 'loading';
  id: string;
  flatIndex: number;
  text?: string;
}

export type ChatElement
  = | HumanMessage
    | AssistantMessage
    | ToolCallElement
    | ThoughtBlock
    | PlanBlock
    | TodoListBlock
    | RunCommand
    | LoadingIndicator;

export interface ChatTab {
  composerId: string;
  title: string;
  isActive: boolean;
  status: string;
  selectorPath: string;
  windowId?: string;
  rowIndex?: number;
  sameTitleIndex?: number;
  composerIdSource?: 'dom' | 'db';
  section?: string;
  sectionId?: string;
  /**
   * Draft (created via + / New Agent, first message not yet sent): the body does not exist yet;
   * the page must **not** overlay the previous session's body (Agents-window drafts don't even have a composerId).
   */
  isDraft?: boolean;
  /**
   * Text already typed in the draft (current IDE composer contents; field omitted = unknown/none).
   * The Agents-window draft-row title is this text (newlines are flattened), so only the composer
   * original of **the currently selected draft** is brought up — the page fills it into the input
   * so the draft can be "sent as-is".
   */
  draftText?: string;
}

export type WindowKind = 'project' | 'agents';

export interface CursorWindow {
  id: string;
  title: string;
  url: string;
  wsUrl?: string;
  chatTabs?: ChatTab[];
  kind?: WindowKind;
}

export interface ModeInfo {
  current: string;
  available: { id: string; label: string; icon: string }[];
}

export interface ModelInfo {
  current: string;
  currentId: string;
}

export type ExtractorStatus = 'idle' | 'waiting' | 'ok' | 'stale';

export type AgentStatus
  = | 'idle'
    | 'thinking'
    | 'generating'
    | 'running_tool'
    | 'waiting_approval'
    | 'error';

export type ActivitySource
  = | 'none'
    | 'shimmer'
    | 'loading_tool'
    | 'loading_indicator'
    | 'tail_thought';

export interface ApprovalAction {
  label: string;
  type: 'approve' | 'reject' | 'approve_all';
  selectorPath: string;
}

export interface Approval {
  id: string;
  description: string;
  actions: ApprovalAction[];
}

export interface ComposerQueueItem {
  id: string;
  text: string;
}

export interface ComposerQueueState {
  items: ComposerQueueItem[];
  queueLabel?: string;
}

export interface QuestionnaireOption {
  letter: string;
  label: string;
  isFreeform: boolean;
  selectorPath: string;
  selected?: boolean;
}

export interface QuestionnaireQuestion {
  number: string;
  text: string;
  options: QuestionnaireOption[];
  isActive: boolean;
  multiSelect?: boolean;
}

export interface Questionnaire {
  composerId: string;
  questions: QuestionnaireQuestion[];
  activeIndex: number;
  totalLabel: string;
  skipSelectorPath: string;
  continueSelectorPath: string;
  continueDisabled: boolean;
  /**
   * Action-button copy (IDE ground truth, optional → old agents omit it and the page falls back to Skip / Continue).
   * Wording differs across products: CodeBuddy is **Complete**, both Cursor flavors are Continue;
   * don't let the page guess copy by IDE (2026-09-18 feedback: page drew Continue, IDE showed Complete).
   */
  skipLabel?: string;
  continueLabel?: string;
}

export interface RawElement {
  flatIndex: number;
  role?: string;
  kind?: string;
  messageId?: string;
  toolCallId?: string;
  toolStatus?: string;
  indicators: string[];
  textPreview: string;
  parsedAs: string;
}

export interface RawSignals {
  shimmer: Array<{ text: string; inToolCall: boolean; inHeader: boolean }>;
  loadingIndicator: boolean;
  statusEl?: { text: string; classes: string };
  elements: RawElement[];
  orphanIndicators: Array<{ cls: string; text: string; parentCls: string }>;
  editorChatTabs?: Array<{ title: string; composerId: string; awaiting: boolean }>;
}

/**
 * **Cause classification** for an IDE whose CDP cannot connect (agent-side judgment, sent up with state).
 *
 * This is the root of "no hint, just read-only": previously every failure collapsed into a single
 * `connected=false` boolean, so cases like "port occupied by another process" had no outlet and the
 * page could only paint the status dot grey.
 *
 * Each kind maps to a **different disposition** (see spec §4.3), so don't merge them —
 * merging is equivalent to falling back to "one boolean".
 */
export type NotCdpCause = 'http' | 'foreign';

export type CdpRelaunchHint
  = | 'relaunched'
    | 'skipped-not-running'
    | 'skipped-cooldown'
    | 'skipped-quit-pending'
    | 'skipped-warming-up'
    | 'skipped-platform'
  /**
   * IDE executable not found (candidate table + App Paths all miss) → **neither quit nor launch**.
   * The "quit first, then launch" order means a failed launch equals shutting down the user's IDE,
   * which is worse than not self-healing.
   */
    | 'skipped-no-exe'
  /** Already restarted several times in a short window: leave the IDE alone (blocks the "kill IDE in a loop because the diagnosis was wrong" cycle). */
    | 'skipped-throttled';

export type CdpIssueKind
  /** Nobody listening on the port: IDE came up without --remote-debugging-port, or isn't running → restart the IDE */
  = | 'no-listener'
  /** Port has an HTTP response, but it isn't this IDE's CDP: cause=http non-2xx; cause=foreign UA mismatch → don't restart, name the occupant */
    | 'not-cdp'
  /** It is CDP, but there are no targets (no window / window not yet rendered) → **normal state, wait quietly */
    | 'no-window'
  /** Pages exist, but none look like a workbench → log + hint */
    | 'no-workbench'
  /** A target was chosen, but the WebSocket handshake failed → hint + back off */
    | 'attach-failed'
  /** Everything else (timeout / unknown network error); see detail */
    | 'unknown';

/**
 * Which connection is in trouble.
 *
 * `workbench` = the main connection (read sessions, run commands); `live` = the second live connection
 * (CodeBuddy's `coding-copilot` webview, providing input and approvals).
 * They can both be healthy, both be down, or one of each — the last is "can see and click but cannot send",
 * and must be reported separately.
 */
export type CdpScope = 'workbench' | 'live';

/** Where this probe's address came from (only for wording; not used in any diagnosis) */
export type CdpEndpointSource
  /** Directly from config (non-loopback, or local file unavailable) */
  = | 'config'
  /** From `<userDataDir>/DevToolsActivePort` */
    | 'active-port-file'
  /** Local file unavailable; fell back to the loopback port in config */
    | 'config-fallback';

export interface CdpIssue {
  kind: CdpIssueKind;
  scope: CdpScope;
  /** Probe address, e.g. http://127.0.0.1:9222 */
  cdpUrl: string;
  port: number;
  /** Raw error text, for humans */
  detail: string;
  /** best-effort: process occupying this port, e.g. "Google Chrome (pid 65600)" */
  occupant?: string;
  /**
   * Enrichment: `/json/version` Browser string, e.g. "Chrome/148.0.7778.280".
   * **Display copy only; not used in diagnosis** — product names look different across IDEs/versions
   * (CodeBuddy's UA is `CodeBuddyCN/1.106.1`, not `CodeBuddy`).
   */
  browser?: string;
  notCdpCause?: NotCdpCause;
  relaunch?: CdpRelaunchHint;
  endpointSource?: CdpEndpointSource;
  /** Diagnosis timestamp (not used in dedup comparison) */
  at: number;
}

export interface CursorState {
  connected: boolean;
  extractorStatus: ExtractorStatus;
  lastExtractionAt: number | null;
  consecutiveExtractionFailures: number;
  lastExtractionError: string | null;
  agentStatus: AgentStatus;
  agentActivityText: string | null;
  agentActivityLive: boolean;
  agentActivitySource?: ActivitySource;
  messages: ChatElement[];
  liveActions: Record<string, RunAction[]>;
  lastAssistantText?: string;
  pendingApprovals: Approval[];
  inputAvailable: boolean;
  chatTabs: ChatTab[];
  activeComposerId: string;
  mode: ModeInfo;
  model: ModelInfo;
  windows: CursorWindow[];
  activeWindowId: string;
  composerQueue: ComposerQueueState;
  questionnaire: Questionnaire | null;
  contentSource: 'ok' | 'unavailable';
  /** Workbench CDP connection problem (managed by the bridge; kept across DOM extraction). */
  cdpIssue?: CdpIssue | null;
  /** Live (coding-copilot) CDP connection problem. */
  liveIssue?: CdpIssue | null;
  _rawSignals?: RawSignals;
}

export interface MachineIdeStatus {
  connected: boolean;
  pendingApprovals: number;
}

/** Machine-alias length cap: the rail is only 240px, anything longer is eaten by ellipsis (server truncates to it; the input box limits to it). */
export const MACHINE_NAME_MAX_LENGTH = 24;

/**
 * OS values an agent will self-report — the `process.platform` values we recognize when issuing commands.
 * Unrecognized values **omit this field**; the page falls back to its own OS toggle (see `enroll-os.ts`).
 */
export const AGENT_PLATFORMS = ['darwin', 'win32', 'linux'] as const;
export type AgentPlatform = (typeof AGENT_PLATFORMS)[number];

/** Narrow an on-the-wire string to a known platform; old agent / unknown platform → undefined. */
export function toAgentPlatform(raw: unknown): AgentPlatform | undefined {
  if (typeof raw !== 'string')
    return undefined;
  return (AGENT_PLATFORMS as readonly string[]).includes(raw) ? (raw as AgentPlatform) : undefined;
}

export interface MachineInfo {
  agentId: string;
  /** Hostname the machine self-reports; never rewritten */
  hostname: string;
  /** User-chosen console alias; empty = show hostname. Display always uses `displayName || hostname` */
  displayName?: string;
  connected: boolean;
  lastSeenAt: number;
  ides?: Partial<Record<IdeKind, MachineIdeStatus>>;
  contentIdes?: IdeKind[];
  contentOnly?: boolean;
  cliVersion?: string;
  /**
   * OS of **this machine**. The console uses it to issue platform-matching commands (uninstall / upgrade) —
   * the person looking at the page may be on a different OS; browser UA is only suitable for enroll
   * flows that don't yet know which machine. Default (old agent omits it) = the page falls back to the OS toggle.
   */
  platform?: AgentPlatform;
}

export interface MachinesListPayload {
  machines?: MachineInfo[];
  cliLatest?: string;
}

export type AuthKind = 'trusted-header' | 'password' | 'none';

export interface UserInfo {
  userId: string;
  avatar: string;
  /** Server auth method (shipped in user:info). Old servers omit it → frontend degrades display based on whether userId is present. */
  authKind?: AuthKind;
}

export type StateFullWire = CursorState | { ides: Partial<Record<IdeKind, CursorState>> };

export type StatePatchWire
  = | Partial<CursorState>
    | { ide: IdeKind; patch: Partial<CursorState> };

export interface CommandResult {
  commandId: string;
  ok: boolean;
  error?: string;
  data?: unknown;
}

export interface CommandPayload {
  commandId: string;
  type?: string;
  text?: string;
  approvalId?: string;
  actionType?: string;
  selectorPath?: string;
  actionLabel?: string;
  composerId?: string;
  modeId?: string;
  modelId?: string;
  planLabel?: string;
  planModelId?: string;
  tabTitle?: string;
  windowId?: string;
  sameTitleIndex?: number;
  section?: string;
  ide?: IdeKind;
}

export interface SendMessageTarget {
  windowId: string;
  tabTitle: string;
  selectorPath?: string;
  composerId?: string;
  section?: string;
}

export interface SwitchTabTarget {
  composerId?: string;
  sameTitleIndex?: number;
  section?: string;
}

export interface PlanFullData {
  todos: PlanTodo[];
  body: string;
}

export interface PlanModelOption {
  id: string;
  label: string;
  selected?: boolean;
}
