import type { IdeKind, ToolCallElement } from '../net/protocol';
import { CaretDown, CaretRight } from '@phosphor-icons/react';
import { useState } from 'react';
import { activitySummary } from '../lib/cursor-activity';
import { sendCommand } from '../net/socket';
import { useIdesStore } from '../store/ides';

const STATUS_DOT: Record<ToolCallElement['status'], string> = {
  loading: 'var(--accent)',
  completed: 'var(--ok)',
  error: 'var(--error)',
  cancelled: 'var(--text-weak)',
};

function DiffBlock({ diff }: { diff: NonNullable<ToolCallElement['diffBlock']> }) {
  if (!diff.diffLines?.length) {
    return <pre className="md-pre mono mt-1">{diff.code}</pre>;
  }
  return (
    <pre className="md-pre mono mt-1">
      {diff.diffLines.map((l, i) => (
        <div
          key={i}
          className={l.kind === 'add' ? 'diff-add' : l.kind === 'rem' ? 'diff-rem' : 'diff-ctx'}
        >
          {l.kind === 'add' ? '+ ' : l.kind === 'rem' ? '- ' : '  '}
          {l.text}
        </div>
      ))}
    </pre>
  );
}

function ToolRow({ t }: { t: ToolCallElement }) {
  const [diffOpen, setDiffOpen] = useState(false);
  return (
    <div>
      <div className="mono flex items-center gap-2 py-0.5 text-[length:var(--text-chrome)] text-[var(--text-secondary)]">
        <span className="dot-sm" style={{ background: STATUS_DOT[t.status] }} />
        <span>{t.action}</span>
        {t.filename && <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[var(--text-primary)]">{t.filename}</span>}
        {t.additions != null && (
          <span className="text-[var(--ok)]">
            +
            {t.additions}
          </span>
        )}
        {t.deletions != null && (
          <span className="text-[var(--error)]">
            -
            {t.deletions}
          </span>
        )}
        {t.diffBlock && (
          <button type="button" onClick={() => setDiffOpen(v => !v)} className="icon-btn !p-0 text-[var(--text-weak)]">
            {diffOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
          </button>
        )}
      </div>
      {diffOpen && t.diffBlock && <DiffBlock diff={t.diffBlock} />}
    </div>
  );
}

/**
 * Consecutive tools. Cursor folds them into one activity sentence ("Explored 14 files, 15 searches")
 * that expands to the rows; CodeBuddy's transcript lists every call on its own, so there it stays flat.
 * Groups with pending action buttons stay open.
 */
export function ToolGroup({ items, ide }: { items: ToolCallElement[]; ide: IdeKind }) {
  const folded = ide === 'cursor';
  const hasActions = items.some(t => (t.actions?.length ?? 0) > 0);
  const [open, setOpen] = useState(hasActions);
  const selectedIde = useIdesStore(s => s.selectedIde);
  const summary = folded ? activitySummary(items) : null;
  const expanded = !folded || open || hasActions;

  return (
    <div>
      {summary && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setOpen(v => !v)}
          className="inline-flex max-w-full flex-wrap items-center gap-x-1 border-0 bg-transparent p-0 text-left text-[length:var(--text-chrome)]"
        >
          <span className="text-[var(--text-secondary)]">{summary.action}</span>
          {summary.details && <span className="text-[var(--text-weak)]">{summary.details}</span>}
          {summary.additions != null && summary.additions > 0 && (
            <span className="text-[var(--ok)]">
              +
              {summary.additions}
            </span>
          )}
          {summary.deletions != null && summary.deletions > 0 && (
            <span className="text-[var(--error)]">
              -
              {summary.deletions}
            </span>
          )}
          {expanded ? <CaretDown size={12} className="text-[var(--text-weak)]" /> : <CaretRight size={12} className="text-[var(--text-weak)]" />}
        </button>
      )}
      {expanded && (
        <div className={folded ? 'pt-1' : undefined}>
          {items.map(t => (
            <div key={t.id}>
              <ToolRow t={t} />
              {t.actions?.length
                ? (
                    <div className="flex gap-2 py-1 pl-3.5">
                      {t.actions.map(a => (
                        <button
                          key={a.selectorPath}
                          type="button"
                          onClick={() => sendCommand('command:click_action', { ide: selectedIde, selectorPath: a.selectorPath, actionLabel: a.label })}
                          className={a.type === 'run' ? 'btn btn-primary !py-1' : 'btn btn-ghost !py-1'}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  )
                : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
