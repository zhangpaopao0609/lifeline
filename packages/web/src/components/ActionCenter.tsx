import type { Approval, Questionnaire } from '../net/protocol';
import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { clearNotified, notifyApproval } from '../net/notify';
import { useIdesStore, viewedSessionIdOf } from '../store/ides';
import { useUiStore } from '../store/ui';
import { ApprovalCard } from './ApprovalCard';
import { QuestionnaireCard } from './QuestionnaireCard';

type ActionCard
  = | { kind: 'approval'; key: string; approval: Approval }
    | { kind: 'questionnaire'; key: string; questionnaire: Questionnaire };

export function ActionCenter() {
  const ides = useIdesStore(s => s.ides);
  const selectedIde = useIdesStore(s => s.selectedIde);
  const pendingSwitch = useUiStore(s => s.pendingSwitch);
  const state = ides[selectedIde];
  const pendingHere = pendingSwitch && pendingSwitch.ide === selectedIde ? pendingSwitch : null;
  const viewedSessionId = viewedSessionIdOf(state, pendingHere);
  const [active, setActive] = useState(0);
  const touchStartX = useRef(0);
  const seenApprovalIds = useRef<Set<string>>(new Set());

  const cards: ActionCard[] = [];
  for (const a of state?.pendingApprovals ?? []) {
    cards.push({ kind: 'approval', key: `approval:${a.id}`, approval: a });
  }
  const questionnaire = state?.questionnaire;
  // Questionnaire belongs to a session: draw it only when it belongs to "the session being viewed" —
  // clicking another session makes ownership mismatch immediately, so the card folds without waiting
  // for the next server extract to clear questionnaire (2026-09-17 feedback). Switching back, the
  // questions are still on that composer and the extract brings them again. Missing ownership /
  // session id (older server, placeholder id): skip the check and fall back to "draw if present".
  if (questionnaire && (
    !questionnaire.composerId || !viewedSessionId || questionnaire.composerId === viewedSessionId
  )) {
    cards.push({ kind: 'questionnaire', key: 'questionnaire', questionnaire });
  }

  useEffect(() => {
    const approvals = state?.pendingApprovals ?? [];
    const ids = new Set(approvals.map(a => a.id));
    for (const a of approvals) {
      if (!seenApprovalIds.current.has(a.id)) {
        seenApprovalIds.current.add(a.id);
        void notifyApproval(a.id, a.description);
      }
    }
    for (const id of [...seenApprovalIds.current]) {
      if (!ids.has(id)) {
        seenApprovalIds.current.delete(id);
        clearNotified(id);
      }
    }
  }, [state?.pendingApprovals]);

  useEffect(() => {
    setActive(v => Math.min(v, Math.max(0, cards.length - 1)));
  }, [cards.length]);

  if (cards.length === 0)
    return null;
  const card = cards[Math.min(active, cards.length - 1)];

  return (
    <div
      className="mx-auto w-full max-w-[892px] box-border px-4 pt-2"
      onTouchStart={(e) => { touchStartX.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => {
        const dx = e.changedTouches[0].clientX - touchStartX.current;
        if (Math.abs(dx) < 50)
          return;
        setActive(v => Math.min(cards.length - 1, Math.max(0, v + (dx < 0 ? 1 : -1))));
      }}
    >
      <div className="relative">
        {cards.length > 2 && (
          <div className="absolute inset-x-2 translate-y-1.5 rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--bg-2)] opacity-50" />
        )}
        {cards.length > 1 && (
          <div className="absolute inset-x-1 translate-y-[3px] rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--bg-2)] opacity-75" />
        )}

        <div className="relative overflow-hidden rounded-[var(--radius-md)] border border-[var(--hairline)] shadow-[var(--shadow-overlay)]">
          {card.kind === 'approval' ? <ApprovalCard approval={card.approval} /> : <QuestionnaireCard questionnaire={card.questionnaire} />}
        </div>

        {cards.length > 1 && (
          <div className="flex items-center justify-center gap-2.5 py-1.5">
            <button type="button" aria-label="上一张" onClick={() => setActive(v => Math.max(0, v - 1))} disabled={active === 0} className="icon-btn min-h-11 min-w-11 lg:min-h-8 lg:min-w-8 disabled:text-[var(--text-weak)]">
              <CaretLeft size={14} />
            </button>
            <span className="mono text-[11px] text-[var(--text-weak)]">
              {active + 1}
              /
              {cards.length}
            </span>
            <button type="button" aria-label="下一张" onClick={() => setActive(v => Math.min(cards.length - 1, v + 1))} disabled={active >= cards.length - 1} className="icon-btn min-h-11 min-w-11 lg:min-h-8 lg:min-w-8 disabled:text-[var(--text-weak)]">
              <CaretRight size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
