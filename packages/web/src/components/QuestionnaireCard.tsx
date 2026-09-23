import type { Questionnaire, QuestionnaireOption, QuestionnaireQuestion } from '../net/protocol';
import { CaretDown, Check, ListChecks } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { sendCommand, sendCommandAwaitResult } from '../net/socket';
import { useIdesStore } from '../store/ides';
import { useUiStore } from '../store/ui';

/** Max wait for an option click: landing is a CDP click, even slow is only a few seconds. */
const CLICK_TIMEOUT_MS = 8000;

/**
 * Questionnaire card. **Draw every question on one screen**, not only the "current" one:
 *   - CodeBuddy multi-question questionnaires (question-floating multiQuestion) are multi-question on one screen:
 *     stems listed one by one; header `1 / 3` is **answered / total**; Continue (Complete) lights only after all three.
 *     Drawing only the active question means questions 2..N don't exist on the page — "can pick only one, Continue never lights"
 *     (reproduced 2026-09-18).
 *   - Cursor Agents glass tray is likewise multi-question on one screen (one `.ui-tray-step` each); the project-window
 *     `.composer-questionnaire-toolbar` also draws every question in one toolbar (`-active` only marks the current).
 *   The page has no "go to next question" command (none in command-router), so paging by active is a dead end here:
 *   draw all at once; clicking a question uses its own selectorPath.
 */
export function QuestionnaireCard({ questionnaire: q }: { questionnaire: Questionnaire }) {
  const selectedIde = useIdesStore(s => s.selectedIde);
  const pushToast = useUiStore(s => s.pushToast);

  const total = q.questions.length;
  /** Question-surface fingerprint: a different questionnaire (surface changed) drops all optimistic state. */
  const quizKey = q.questions.map(x => `${x.number}|${x.text}`).join('//');
  const liveKey = useRef(quizKey);

  const allOptions = useMemo(
    () => q.questions.flatMap(question => question.options.map(option => ({ question, option }))),
    [q],
  );

  // Selected state = IDE truth (`option.selected`) as the base + local optimistic overlay:
  //   undefined = never clicked, use truth; true/false = clicked, wait for the next extract's selected state to converge.
  // Clicks in the IDE, page refresh/reconnect, and failure rollback all land on the same truth.
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const inflight = useRef<Set<string>>(new Set());
  const lastServer = useRef<Record<string, boolean>>({});

  useEffect(() => {
    liveKey.current = quizKey;
    setPicked({});
    inflight.current.clear();
    lastServer.current = {};
  }, [quizKey]);

  // Reconcile truth vs optimistic: once truth **changes** (server handled our click / IDE re-picked), that item is given back to truth.
  // Don't wait until "both sides equal": under a single-select assumption we stamp optimistic false on the other options of the same question;
  // if that question actually supports multi-select (desktop project window has no multi-select flag), a truth true would stay covered forever.
  useEffect(() => {
    setPicked((p) => {
      const next: Record<string, boolean> = { ...p };
      let changed = false;
      for (const { option } of allOptions) {
        const local = next[option.selectorPath];
        if (local === undefined)
          continue;
        const server = option.selected === true;
        const prev = lastServer.current[option.selectorPath];
        if ((prev !== undefined && prev !== server) || server === local) {
          delete next[option.selectorPath];
          changed = true;
        }
      }
      return changed ? next : p;
    });
    lastServer.current = Object.fromEntries(
      allOptions.map(({ option }) => [option.selectorPath, option.selected === true]),
    );
  }, [allOptions]);

  // After the question list is capped (see .qa-list-scroll in tokens.css), whether more questions are clipped below — decides the bottom fade.
  // Touch has no persistent scrollbar; just cutting the content looks like "question 4 vanished" (2026-09-18 feedback).
  const listRef = useRef<HTMLDivElement>(null);
  const [clipsBelow, setClipsBelow] = useState(false);
  const syncClipHint = () => {
    const el = listRef.current;
    if (!el)
      return;
    setClipsBelow(el.scrollHeight - el.clientHeight - el.scrollTop > 2);
  };
  useEffect(() => {
    syncClipHint();
    window.addEventListener('resize', syncClipHint);
    return () => window.removeEventListener('resize', syncClipHint);
    // quizKey change = a different questionnaire: the scroll container remounts with the key, position returns to top; measure again here
  }, [quizKey]);

  const isOn = (opt: QuestionnaireOption): boolean => {
    const local = picked[opt.selectorPath];
    return local !== undefined ? local : opt.selected === true;
  };

  const drop = (paths: string[]) => {
    setPicked((p) => {
      const next = { ...p };
      for (const path of paths) delete next[path];
      return next;
    });
  };

  const click = (selectorPath: string, actionLabel?: string) => {
    sendCommand('command:click_action', { ide: selectedIde, selectorPath, ...(actionLabel ? { actionLabel } : {}) });
  };

  /** Option: flip optimistic first, then send; single-select only turns off **this question's** other items; failure rolls the whole group back to truth. */
  const pick = (question: QuestionnaireQuestion, opt: QuestionnaireOption) => {
    const path = opt.selectorPath;
    // picked only updates on the next render, so a double-click would leak through; the ref blocks repeats inside the same click.
    if (inflight.current.has(path))
      return;
    const on = !isOn(opt);
    const others = question.multiSelect
      ? []
      : question.options.filter(o => o.selectorPath !== path).map(o => o.selectorPath);
    inflight.current.add(path);
    setPicked((p) => {
      const next = { ...p };
      for (const other of others) next[other] = false;
      next[path] = on;
      return next;
    });
    const touched = [...others, path];
    void sendCommandAwaitResult(
      'command:click_action',
      { ide: selectedIde, selectorPath: path, actionLabel: opt.label },
      CLICK_TIMEOUT_MS,
    )
      .then((r) => {
        if (r.ok || liveKey.current !== quizKey)
          return;
        drop(touched);
        pushToast(r.error || '选项没点上', 'error');
      })
      .catch(() => {
        if (liveKey.current !== quizKey)
          return;
        drop(touched);
        pushToast('选项点击超时', 'error');
      })
      .finally(() => { inflight.current.delete(path); });
  };

  // Same meaning as the IDE: number of questions answered (any option selected on this question) / total.
  const answered = q.questions.filter(question => question.options.some(o => isOn(o))).length;

  return (
    <div className="rounded-b-[var(--radius-md)] border-t-2 border-[var(--accent)] bg-[var(--bg-2)] px-3.5 pb-3 pt-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <ListChecks size={16} color="var(--accent)" />
        <span className="eyebrow">问卷</span>
        <span className="mono ml-auto text-[11px] text-[var(--text-weak)]">
          已答
          {answered}
          /
          {total}
        </span>
      </div>
      {/* Question list capped + inner scroll (.qa-list-scroll): an uncapped multi-question quiz would squash Timeline to 0,
          push Composer off-viewport, and the last questions never enter the screen (2026-09-18 feedback); header (answered x/y)
          and footer (Skip / Complete) stay outside the scroll, always visible. key=quizKey: a new quiz returns to question 1. */}
      <div className="relative">
        <div key={quizKey} ref={listRef} onScroll={syncClipHint} className="qa-list-scroll -mr-1.5 pr-1.5">
          {q.questions.map((question, qi) => {
            const number = (question.number || String(qi + 1)).replace(/[.．、]\s*$/, '') || String(qi + 1);
            return (
              <div key={`${number}|${question.text}|${qi}`} className={qi > 0 ? 'mt-3 border-t border-[var(--hairline)] pt-3' : ''}>
                <div className="mb-2 flex items-center gap-1.5 text-[var(--text-primary)]">
                  <span>
                    {number}
                    .
                    {' '}
                    {question.text}
                  </span>
                  {question.multiSelect && (
                    <span className="shrink-0 rounded border border-[var(--hairline)] px-1 text-[10px] leading-4 text-[var(--text-weak)]">
                      多选
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {question.options.map((opt) => {
                    const on = isOn(opt);
                    return (
                      <button
                        key={opt.selectorPath}
                        type="button"
                        aria-pressed={on}
                        onClick={() => pick(question, opt)}
                        className={`btn ${on ? 'btn-soft' : 'btn-ghost text-[var(--text-primary)]'} inline-flex min-h-11 lg:min-h-8 items-center gap-1.5`}
                      >
                        <span className="mono text-[var(--accent)]">{opt.letter}</span>
                        {opt.label}
                        {on && <Check size={13} weight="bold" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        {clipsBelow && (
          <div className="qa-list-fade" aria-hidden>
            <CaretDown size={12} weight="bold" />
          </div>
        )}
      </div>
      {/* CodeBuddy single-mode questionnaires have no footer (clicking an option submits); empty paths mean no buttons.
          Copy matches IDE truth: CodeBuddy's primary is Complete, both Cursor kits are Continue —
          only older agents without a label fall back to Continue (2026-09-18 feedback: the page drew Continue
          while the user saw Complete in the IDE). */}
      {(q.skipSelectorPath || q.continueSelectorPath) && (
        <div className="mt-2.5 flex gap-2">
          {q.skipSelectorPath && (
            <button type="button" onClick={() => click(q.skipSelectorPath)} className="btn btn-ghost min-h-11 lg:min-h-8">
              {q.skipLabel || 'Skip'}
            </button>
          )}
          {q.continueSelectorPath && (
            <button
              type="button"
              disabled={q.continueDisabled}
              onClick={() => click(q.continueSelectorPath)}
              className="btn btn-primary min-h-11 lg:min-h-8"
            >
              {q.continueLabel || 'Continue'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
