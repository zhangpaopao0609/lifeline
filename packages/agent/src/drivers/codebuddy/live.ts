import type {
  AgentStatus,
  Approval,
  ChatTab,
  CursorState,
  ModeInfo,
  ModelInfo,
  Questionnaire,
  RunAction,
} from '../../types.js';

export interface CodeBuddyLiveDumpTab {
  id: string;
  title: string;
  isActive: boolean;
  /** This session is generating right now (agent-state-spinner spinning on the tab) */
  running?: boolean;
  /** This session is waiting for confirmation (approval/questionnaire): agent-state-question mark on the tab, needs a human */
  needsAttention?: boolean;
  /** This session finished and the result has not been viewed: agent-state-dot on the tab (terminal + unread) */
  unread?: boolean;
  selectorPath?: string;
}

export interface CodeBuddyLiveDumpApprovalAction {
  label: string;
  type: Approval['actions'][number]['type'];
  selectorPath: string;
}

export interface CodeBuddyLiveDumpApproval {
  id: string;
  /** Path of the approve action; kept for the single-button confirmations. */
  selectorPath: string;
  description: string;
  /** Set by the dump from class + label when the path has no deny/reject token. */
  isDeny?: boolean;
  /**
   * Full action set when the dump resolved a transcript tool menu
   * (`.tool-menu`: Run / Skip / Reject). Absent for one-button surfaces, where
   * the action is derived from `selectorPath` + `description` instead.
   */
  actions?: CodeBuddyLiveDumpApprovalAction[];
}

export interface CodeBuddyLiveDump {
  inputAvailable: boolean;
  agentStatus: AgentStatus;
  agentActivityText: string | null;
  chatTabs: CodeBuddyLiveDumpTab[];
  activeComposerId: string;
  pendingApprovals: CodeBuddyLiveDumpApproval[];
  liveActions: Record<string, { label: string; type: RunAction['type']; selectorPath: string }[]>;
  mode: ModeInfo;
  model: ModelInfo;
  /**
   * AskQuestion overlay (`question-floating-module_*`, structure checked against bundle source).
   * single mode (one question, not multi-select) submits on option click, no
   * Skip / Continue path (empty string); multi mode (several questions or one
   * multi-select) has a footer.
   */
  questionnaire: Questionnaire | null;
}

export const DENY_RE = /deny|reject|cancel|取消|拒绝/;

export function looksLikeDeny(text: string | undefined, isDeny?: boolean): boolean {
  if (isDeny === true)
    return true;
  return DENY_RE.test((text ?? '').toLowerCase());
}

function approvalActionType(item: CodeBuddyLiveDumpApproval): 'approve' | 'reject' {
  if (looksLikeDeny(item.description, item.isDeny) || looksLikeDeny(item.selectorPath)) {
    return 'reject';
  }
  return 'approve';
}

function mapTab(tab: CodeBuddyLiveDumpTab): ChatTab {
  return {
    composerId: tab.id,
    title: tab.title,
    isActive: tab.isActive,
    // Row-level status (same priority as the IDE tab icons): waiting for
    // confirm (question mark) > running (spinner) > finished unread (dot) >
    // active/idle. The web session list draws a warning badge / loading ring /
    // done dot from this; otherwise it falls back to active/idle.
    status: tab.needsAttention
      ? 'waiting_approval'
      : tab.running
        ? 'generating'
        : tab.unread
          ? 'unread'
          : tab.isActive ? 'active' : 'idle',
    selectorPath: tab.selectorPath ?? '',
  };
}

function mapApproval(item: CodeBuddyLiveDumpApproval): Approval {
  if (item.actions && item.actions.length > 0) {
    return {
      id: item.id,
      description: item.description,
      actions: item.actions.map(action => ({
        label: action.label || (action.type === 'reject' ? 'Deny' : 'Allow'),
        type: action.type,
        selectorPath: action.selectorPath,
      })),
    };
  }
  const type = approvalActionType(item);
  return {
    id: item.id,
    description: item.description,
    actions: [
      {
        label: type === 'reject' ? 'Deny' : 'Allow',
        type,
        selectorPath: item.selectorPath,
      },
    ],
  };
}

function mapLiveActions(
  raw: CodeBuddyLiveDump['liveActions'],
): Record<string, RunAction[]> {
  const out: Record<string, RunAction[]> = {};
  for (const [key, actions] of Object.entries(raw)) {
    out[key] = actions.map(a => ({
      label: looksLikeDeny(a.label) ? 'Deny' : a.label,
      type: a.type,
      selectorPath: a.selectorPath,
    }));
  }
  return out;
}

/**
 * Map a CodeBuddy webview dump onto CursorState live fields.
 * Timeline stays on session:* — this never emits messages.
 */
export function mapCodeBuddyLive(dump: CodeBuddyLiveDump): Partial<CursorState> {
  const live = dump.agentStatus !== 'idle' && dump.agentStatus !== 'error';
  return {
    inputAvailable: dump.inputAvailable,
    agentStatus: dump.agentStatus,
    agentActivityText: dump.agentActivityText,
    agentActivityLive: live,
    agentActivitySource: dump.agentActivityText ? 'shimmer' : 'none',
    pendingApprovals: dump.pendingApprovals.map(mapApproval),
    liveActions: mapLiveActions(dump.liveActions),
    chatTabs: dump.chatTabs.map(mapTab),
    activeComposerId: dump.activeComposerId,
    mode: dump.mode,
    model: dump.model,
    // Tolerate old dumps (callers before this extract did not have this field)
    questionnaire: dump.questionnaire ?? null,
  };
}
