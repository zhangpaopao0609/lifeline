/**
 * Agent-process types. Wire payloads come from @lifeline/protocol; this file
 * adds CDP/selector config that never leaves the machine.
 */

export type {
  ActivitySource,
  AgentIdesState,
  AgentStatus,
  Approval,
  ApprovalAction,
  AssistantMessage,
  CdpIssue,
  ChatElement,
  ChatTab,
  CodeBlockItem,
  CommandPayload,
  CommandResult,
  ComposerQueueItem,
  ComposerQueueState,
  CursorState,
  CursorWindow,
  DiffLineKind,
  ExtractorStatus,
  HumanMessage,
  IdeKind,
  LoadingIndicator,
  ModeInfo,
  ModelInfo,
  PlanAction,
  PlanBlock,
  PlanFullData,
  PlanModelOption,
  PlanTodo,
  Questionnaire,
  QuestionnaireOption,
  QuestionnaireQuestion,
  RawElement,
  RawSignals,
  RunAction,
  RunCommand,
  SendMessageTarget,
  SwitchTabTarget,
  ThoughtBlock,
  TodoListBlock,
  ToolCallElement,
  WindowKind,
} from '../../protocol/src/index.js';

export {
  applyIdePatch,
  emptyCursorState,
  emptyIdesState,
  parseIde,
  wrapIncomingFull,
} from '../../protocol/src/index.js';

export interface SelectorStrategy {
  strategies: string[];
  textMatch?: string[];
}

export interface SelectorConfig {
  chatContainer: SelectorStrategy;
  approveButton: SelectorStrategy;
  rejectButton: SelectorStrategy;
  chatInput: SelectorStrategy;
  agentStatus: SelectorStrategy;
  [key: string]: SelectorStrategy;
}

/** Loopback CDP + poll config for the local agent. Not a server config. */
export interface AgentConfig {
  cdpUrl: string;
  codebuddyCdpUrl: string;
  pollIntervalMs: number;
  debounceMs: number;
  selectorsPath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  windowTitleQualifier: boolean;
  dataDir: string;
  remoteUrl: string;
  agentsWindow: boolean;
  agentToken: string;
}
