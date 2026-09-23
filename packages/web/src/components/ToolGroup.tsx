import type { ToolCallElement } from '../net/protocol';
import { CaretDown, CaretRight, Gear } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
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
 * Consecutive tools auto-group: collapsed to a one-line summary by default;
 * expanded, each tool is a mono line. Groups with pending action buttons stay expanded (spec §4).
 */
export function ToolGroup({ items }: { items: ToolCallElement[] }) {
  const hasActions = items.some(t => (t.actions?.length ?? 0) > 0);
  const [open, setOpen] = useState(hasActions);
  const selectedIde = useIdesStore(s => s.selectedIde);

  const summary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of items) {
      const name = t.toolName || t.action || 'tool';
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, n]) => `${name} ×${n}`)
      .join(' · ');
  }, [items]);

  const expanded = open || hasActions;

  return (
    <div className="surface-card">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 border-0 bg-transparent px-2.5 py-1.5 text-left text-[length:var(--text-chrome)] text-[var(--text-secondary)]"
      >
        <Gear size={14} />
        <span className="mono min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
          {items.length}
          {' '}
          个工具调用 ·
          {summary}
        </span>
        {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
      </button>
      {expanded && (
        <div className="border-t border-[var(--hairline)] px-2.5 pb-2 pt-1">
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
