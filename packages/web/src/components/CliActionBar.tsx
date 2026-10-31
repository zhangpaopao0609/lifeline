import type { CliApprovalOption } from '../net/protocol';
import type { ActiveTarget, CliApprovalCardState } from '../store/cli';
import { useState, useSyncExternalStore } from 'react';
import { sendCliPermission } from '../net/send';
import {
  CLI_ACTION_BAR_MAX_HEIGHT,
  cliApprovalCardOnClick,
  cliApprovalCardOnResult,
  cliApprovalPending,
  cliInterfaceState,
  cliPermissionChoice,
  cliSession,
  isCliActionBarFolded,
  useCliStore,
  visibleCliApprovals,
} from '../store/cli';
import { CliApprovalCard } from './CliApprovalCard';

const idleCard: CliApprovalCardState = { disabled: false, phase: 'pending', notice: null };

let viewportSnapshot = { height: 800, inset: 0 };

function readCliViewport(): { height: number; inset: number } {
  if (typeof window === 'undefined')
    return viewportSnapshot;
  const height = window.visualViewport?.height ?? window.innerHeight;
  const inset = Math.max(0, window.innerHeight - height);
  if (viewportSnapshot.height !== height || viewportSnapshot.inset !== inset)
    viewportSnapshot = { height, inset };
  return viewportSnapshot;
}

function subscribeCliViewport(onChange: () => void): () => void {
  window.visualViewport?.addEventListener('resize', onChange);
  window.addEventListener('resize', onChange);
  return () => {
    window.visualViewport?.removeEventListener('resize', onChange);
    window.removeEventListener('resize', onChange);
  };
}

export function CliActionBar({ target }: { target: Extract<ActiveTarget, { kind: 'cli' }> }) {
  const session = useCliStore(s => cliSession(s.cli, target.agentId, target.sessionId));
  const viewport = useSyncExternalStore(subscribeCliViewport, readCliViewport, () => viewportSnapshot);
  const [cardState, setCardState] = useState<{ id: string; card: CliApprovalCardState }>({ id: '', card: idleCard });
  const folded = isCliActionBarFolded(viewport.height, viewport.inset);
  const view = visibleCliApprovals(session?.approvals ?? [], folded);
  const expandedId = view.expanded?.approvalId ?? '';
  const card = cardState.id === expandedId ? cardState.card : idleCard;
  const setCard = (next: CliApprovalCardState) => setCardState({ id: expandedId, card: next });

  const settle = (clicked: CliApprovalCardState, approvalId: string, result: { ok: boolean; error?: string; errorCode?: string; data?: unknown }) => {
    const still = cliApprovalPending(useCliStore.getState().cli, target.agentId, approvalId);
    setCard(cliApprovalCardOnResult(clicked, cliInterfaceState(result), still));
  };

  const choose = (approvalId: string, option: CliApprovalOption) => {
    if (card.disabled)
      return;
    const decision = cliPermissionChoice(option);
    if (decision.kind !== 'selected') {
      setCard({ disabled: true, phase: 'resolving', notice: 'unsupported-permission-option' });
      return;
    }
    const clicked = cliApprovalCardOnClick(card);
    setCard(clicked);
    void sendCliPermission(
      { kind: 'cli', source: target.source, sessionId: target.sessionId },
      approvalId,
      { outcome: 'selected', optionId: decision.optionId },
    ).then(result => settle(clicked, approvalId, result)).catch(() => {
      settle(clicked, approvalId, { ok: false, error: 'failed' });
    });
  };

  const cancel = (approvalId: string) => {
    if (card.disabled)
      return;
    const clicked = cliApprovalCardOnClick(card);
    setCard(clicked);
    void sendCliPermission(
      { kind: 'cli', source: target.source, sessionId: target.sessionId },
      approvalId,
      { outcome: 'cancelled' },
    ).then(result => settle(clicked, approvalId, result)).catch(() => {
      settle(clicked, approvalId, { ok: false, error: 'failed' });
    });
  };

  if (!view.foldedLine && !view.expanded)
    return null;
  const expanded = view.expanded;
  return (
    <div
      className="mx-auto w-full max-w-[892px] box-border px-4 pt-2"
      style={{ maxHeight: CLI_ACTION_BAR_MAX_HEIGHT, overflowY: 'auto', flexShrink: 0 }}
    >
      {view.foldedLine
        ? <p className="py-2 text-[length:var(--text-chrome)] text-[var(--text-secondary)]">{view.foldedLine}</p>
        : expanded && (
          <>
            <CliApprovalCard
              approval={expanded}
              card={card}
              onChoose={option => choose(expanded.approvalId, option)}
              onCancel={() => cancel(expanded.approvalId)}
            />
            {view.extraCount > 0 && (
              <p className="py-1 text-center text-[11px] text-[var(--text-weak)]">
                还有
                {' '}
                {view.extraCount}
                {' '}
                个待审批
              </p>
            )}
          </>
        )}
    </div>
  );
}
