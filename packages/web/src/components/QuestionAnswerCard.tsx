import type { QuestionAnswer } from './questionAnswer';
import { Check, ListChecks } from '@phosphor-icons/react';

/**
 * Questionnaire answers inside a human bubble (CodeBuddy's `<question_answer>` message).
 *
 * Same visual language as the questionnaire card (QuestionnaireCard): accent icon + small header,
 * question stem in secondary color, chosen answers as the body. Each answer has a checkmark so
 * "what was picked" is obvious at a glance — no longer a screenful of XML.
 */
export function QuestionAnswerCard({ qa }: { qa: QuestionAnswer }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 border-b border-[var(--hairline)] pb-1.5">
        <ListChecks size={15} color="var(--accent)" className="shrink-0" />
        <span className="eyebrow shrink-0">问卷回答</span>
        {qa.title && (
          <span className="min-w-0 truncate text-[length:var(--text-chrome)] text-[var(--text-weak)]">{qa.title}</span>
        )}
      </div>
      {qa.items.map((item, i) => (
        <div key={`${i}|${item.question}`} className={i > 0 ? 'border-t border-[var(--hairline)] pt-2.5' : ''}>
          {item.question && (
            <div className="mb-1 flex gap-1.5 text-[length:var(--text-chrome)] leading-[1.5] text-[var(--text-secondary)]">
              {qa.items.length > 1 && (
                <span className="mono shrink-0 text-[var(--text-weak)]">
                  {i + 1}
                  .
                </span>
              )}
              <span className="min-w-0 break-words">{item.question}</span>
            </div>
          )}
          <div className="flex flex-col gap-1">
            {item.answers.map((answer, j) => (
              <div key={j} className="flex items-start gap-1.5 leading-[1.5]">
                <Check size={13} weight="bold" color="var(--accent)" className="mt-[3px] shrink-0" />
                <span className="min-w-0 break-words">{answer}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
