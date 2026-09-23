// Core relay state and chat element typings.
// Wire types live in @lifeline/protocol; this file keeps process config
// that is not on the socket.

import type { IdeKind } from '../../protocol/src/index.js';
import type { AuthProvider } from './auth/provider.js';

export type {
  ActivitySource,
  AgentStatus,
  Approval,
  ApprovalAction,
  AssistantMessage,
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
export type { IdeKind };

export interface ServerConfig {
  serverPort: number;
  serverHost: string;
  dataDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Auth assembly result (built by loadConfig). Test fixtures may omit it: Relay construction falls back to createAuthProvider. */
  authProvider?: AuthProvider;
  /** Explicit auth method (env AUTH_PROVIDER; overrides auto-detection). */
  authProviderName?: string;
  /** trusted-header user header name (env AUTH_HEADER). */
  authHeaderName?: string;
  /** Preset password (env AUTH_PASSWORD, skips claim; for automation). */
  authPassword?: string;
  /** Acknowledge "this server sits behind a gateway that strips that header" (env AUTH_TRUSTED_PROXY=1). */
  authTrustedProxy?: boolean;
  /** Avatar URL template with a {userId} placeholder (env AUTH_AVATAR_URL); default = frontend initial fallback. */
  authAvatarUrl?: string;
  /** Public origin (env PUBLIC_ORIGIN; expected value for WS Origin checks in password mode). */
  publicOrigin?: string;
  /** Allow running none unauthenticated on a private-network bind (env AUTH_INSECURE_ALLOW=1; never on the public internet). */
  authInsecureAllow?: boolean;
}
