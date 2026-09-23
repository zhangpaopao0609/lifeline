import type { AgentPlatform, ChatElement, IdeKind } from './wire.js';

export interface SessionRef {
  ide: IdeKind;
  workspaceId: string;
  sessionId: string;
  parentSessionId?: string;
}

export interface SessionMeta {
  ref: SessionRef;
  title: string;
  createdAt: number;
  lastUpdatedAt: number;
  isArchived: boolean;
  isSubagent: boolean;
  status: 'idle' | 'generating' | 'completed' | 'aborted';
  messageCount: number;
  tokensUsed?: number;
  tokenLimit?: number;
  linesAdded?: number;
  linesRemoved?: number;
  filesChanged?: number;
  childSessionIds?: string[];
  modelName?: string;
  mode?: string;
}

export interface MessageHeader {
  messageId: string;
  role: 'human' | 'assistant' | 'tool';
  createdAt: number;
  preview?: string;
  thinkingDurationMs?: number;
  complete: boolean;
}

export interface SessionsIndexPayload {
  sessions: SessionMeta[];
  reportedIdes?: IdeKind[];
  mode?: 'full' | 'delta';
  removed?: Array<{ ide: IdeKind; sessionId: string }>;
}

/** How many body items to move at once. Shared source of truth for server→web pages and relay slices. */
export const SESSION_PAGE_ITEMS = 200;

export interface SessionGetPayload {
  sessionId?: string;
  tabTitle?: string;
  ide?: IdeKind;
  /** How far the requester has currently received; when it matches the responder, only session:sync is returned. */
  sinceSeq?: number;
  /** Last page with `flat_index <= before` (before is an overlap token); default = tail page. */
  before?: number;
  /** Default = SESSION_PAGE_ITEMS (server clamps the cap). */
  limit?: number;
  /** User-initiated retry: skip the server missing-cache and poke cooldown; force one ask of the content source. */
  force?: boolean;
}

/** Agent explicitly answers "this machine does not have this session" (not on disk). Reused same-shape for server→web unavailable. */
export interface SessionMissingPayload {
  sessionId: string;
  ide?: IdeKind;
}

export interface SessionBodyPayload {
  sessionId: string;
  messages: ChatElement[];
  ide?: IdeKind;
  /**
   * Body-stream sequence: full is always 0 (baseline reset); append / patch are monotonically incremented by the agent.
   * Old agents omit this field — all old behavior, no gap detection.
   */
  seq?: number;
  /** true = a page (merge by id, don't replace); default = authoritative full. */
  isPage?: boolean;
  /** Earlier pages are still available (nextBefore is sent back as session:get.before). */
  hasMore?: boolean;
  /** Smallest flatIndex on this page. */
  nextBefore?: number;
  /** Which before this page is answering (default = tail page). Receiver picks the merge rule from this. */
  before?: number;
}

export interface SessionPatchPayload {
  sessionId: string;
  messages: ChatElement[];
  ide?: IdeKind;
  /** After this batch of elements, this is the receiver's reconciliation point. */
  seq: number;
  /** Set when forwarding a slice: true = merge as a tail page; don't mergeById onto the prefix. */
  isPage?: boolean;
  hasMore?: boolean;
  nextBefore?: number;
}

/** Body-stream reconciliation passed: confirmation only, no messages. */
export interface SessionSyncPayload {
  sessionId: string;
  ide?: IdeKind;
  seq: number;
}

export interface AgentRegisterPayload {
  agentId?: string;
  hostname?: string;
  version?: string;
  owner?: string;
  /**
   * GUI-bearing IDEs detected on this machine. **Quiet-policy only** (whether to report a connect failure),
   * not used in "can we connect" decisions. Default (old agent) = previous-version criteria.
   */
  liveIdes?: IdeKind[];
  /**
   * This machine is **content-source only**: the agent does not connect CDP, does not take over input,
   * only reads session data.
   *
   * Decided by **platform** (Linux = true), not probed — see agent-side `canControlIde()`.
   * The server uses this to fold the machine into the "content source" group and project it read-only.
   * Default (old agent) = previous-version criteria.
   */
  contentSource?: boolean;
  /**
   * The machine's own OS (`process.platform`, only the values we recognize).
   * The console uses it to issue matching uninstall/upgrade commands for **this machine** — the device
   * looking at the page may not be the same OS. Default (old agent) = the page falls back to its own OS toggle.
   */
  platform?: AgentPlatform;
}
