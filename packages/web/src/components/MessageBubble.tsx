import type { AssistantMessage, HumanMessage } from '../net/protocol';
import type { PendingSendInfo } from '../store/sessions';
import { X } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { retryUserMessage } from '../net/send';
import { isPendingSend, useSessionsStore } from '../store/sessions';
import { renderMarkdown } from './markdown';
import { parseQuestionAnswer } from './questionAnswer';
import { QuestionAnswerCard } from './QuestionAnswerCard';

/** Assistant markdown view: html:false render + after mount, take over code-block copy/fullscreen. */
export function MarkdownView({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);
  const [expandedCode, setExpandedCode] = useState<{ lang: string; code: string } | null>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root)
      return;
    const cleanups: Array<() => void> = [];
    root.querySelectorAll('.md-codeblock').forEach((block) => {
      const copyBtn = block.querySelector('.md-codeblock-copy');
      const expandBtn = block.querySelector('.md-codeblock-expand');
      const lang = block.querySelector('.md-codeblock-lang')?.textContent ?? 'text';
      const code = block.querySelector('pre code') ?? block.querySelector('pre');
      if (!code)
        return;
      if (copyBtn) {
        const onClick = () => {
          void navigator.clipboard.writeText(code.textContent ?? '');
          copyBtn.textContent = '已复制 ✓';
          window.setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
        };
        copyBtn.addEventListener('click', onClick);
        cleanups.push(() => copyBtn.removeEventListener('click', onClick));
      }
      if (expandBtn) {
        const onClick = () => setExpandedCode({ lang, code: code.textContent ?? '' });
        expandBtn.addEventListener('click', onClick);
        cleanups.push(() => expandBtn.removeEventListener('click', onClick));
      }
    });
    return () => cleanups.forEach(fn => fn());
  }, [html]);

  return (
    <>
      <div ref={ref} className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
      {expandedCode && (
        <div className="anim-overlay code-fs">
          <div className="flex items-center justify-between border-b border-[var(--hairline)] px-4 py-2.5">
            <span className="mono text-[length:var(--text-chrome)] text-[var(--text-weak)]">{expandedCode.lang}</span>
            <button type="button" aria-label="关闭" onClick={() => setExpandedCode(null)} className="icon-btn">
              <X size={18} />
            </button>
          </div>
          <pre className="mono m-0 flex-1 overflow-auto p-4 text-[13px] leading-[1.6]">{expandedCode.code}</pre>
        </div>
      )}
    </>
  );
}

const UNCONFIRMED_AFTER_MS = 10_000;

/**
 * Human bubble: right-aligned bg-2, asymmetric 14/4 radius, no avatar.
 * Send tri-state (spec §7): … sending → ✓ delivered → reconcile and pop the bubble; 10s without popping → badge "submitted, unconfirmed" (no auto-resend);
 * failure → red border + inline "retry / restore to input".
 */
export function HumanBubble({ msg, meta }: { msg: HumanMessage; meta?: PendingSendInfo }) {
  const pending = isPendingSend(msg);
  const removePendingBubble = useSessionsStore(s => s.removePendingBubble);
  const setPendingRestore = useSessionsStore(s => s.setPendingRestore);
  const commandId = pending ? msg.id.slice('pending-send:'.length) : '';
  const failed = meta?.state === 'failed';
  const unconfirmed = meta?.state === 'delivered' && meta.deliveredAt > 0 && Date.now() - meta.deliveredAt > UNCONFIRMED_AFTER_MS;
  /**
   * Questionnaire-answer message (CodeBuddy emits `<question_answer>` XML as a user message):
   * if parsing yields structure, draw the card; otherwise fall back to the raw text — see questionAnswer.ts.
   */
  const qa = useMemo(() => parseQuestionAnswer(msg.text), [msg.text]);

  return (
    <div className={`flex flex-col items-end ${meta?.state === 'sending' ? 'opacity-70' : ''}`}>
      <div className={`bubble-human ${failed ? 'is-failed' : ''} ${qa ? 'is-qa' : ''}`}>
        {msg.quoted?.text && (
          <div className="mb-1.5 overflow-hidden border-l-2 border-[var(--hairline-strong)] pl-2.5 text-[length:var(--text-chrome)] text-[var(--text-secondary)] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
            {msg.quoted.text}
          </div>
        )}
        {msg.mentions?.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-1">
            {msg.mentions.map((m, i) => (
              <span key={`${m.name}-${i}`} className="rounded-[var(--radius-sm)] bg-[var(--accent-soft)] px-1.5 py-px text-[length:var(--text-chrome)] text-[var(--accent)]">
                @
                {m.name}
              </span>
            ))}
          </div>
        )}
        {qa
          ? (
              <QuestionAnswerCard qa={qa} />
            )
          : (
              <span className="whitespace-pre-wrap break-words">
                {msg.text}
                {meta?.state === 'sending' && <span className="ml-1.5 text-[var(--text-weak)]">…</span>}
                {meta?.state === 'delivered' && !unconfirmed && <span className="ml-1.5 text-[var(--ok)]">✓</span>}
              </span>
            )}
      </div>

      {unconfirmed && (
        <div className="mt-0.5 text-[11px] text-[var(--text-weak)]">已提交，未确认</div>
      )}

      {failed && (
        <div className="mt-1.5 flex gap-2">
          <button type="button" onClick={() => retryUserMessage(commandId)} className="btn btn-outline !py-0.5">
            重试
          </button>
          <button
            type="button"
            onClick={() => { setPendingRestore(msg.text); removePendingBubble(commandId); }}
            className="btn btn-ghost !py-0.5"
          >
            填回输入框
          </button>
        </div>
      )}
    </div>
  );
}

export function AssistantBlock({ msg }: { msg: AssistantMessage }) {
  return <MarkdownView text={msg.text} />;
}
