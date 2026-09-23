import type { PlanBlock, PlanTodo } from '../net/protocol';
import { useState } from 'react';
import { sendCommand } from '../net/socket';
import { useIdesStore } from '../store/ides';
import { PlanView } from './PlanView';

const TODO_DOT: Record<PlanTodo['status'], string> = {
  pending: 'var(--text-weak)',
  in_progress: 'var(--accent)',
  completed: 'var(--ok)',
};

/**
 * Plan card (spec §4): label + title + todo progress + first 3 items + N more.
 * Renders whenever type:'plan' data is present (lights up again after projection restore).
 */
export function PlanCard({ msg }: { msg: PlanBlock }) {
  const selectedIde = useIdesStore(s => s.selectedIde);
  const [viewOpen, setViewOpen] = useState(false);
  const build = msg.actions?.find(a => a.type === 'build');
  const visibleTodos = (msg.todos ?? []).slice(0, 3);
  const moreCount = msg.todosMoreCount ?? Math.max(0, (msg.todos?.length ?? 0) - 3);
  const pct = msg.todosTotal > 0 ? Math.round((msg.todosCompleted / msg.todosTotal) * 100) : 0;

  return (
    <div className="surface-card p-3.5">
      <div className="eyebrow !text-[var(--text-weak)]">{msg.label}</div>
      <div className="mb-2.5 mt-1 font-semibold">{msg.title}</div>

      <div className="progress-track mb-2.5">
        <div className="progress-fill transition-[width] duration-[var(--duration-base)] ease-[var(--ease-spring)]" style={{ width: `${pct}%` }} />
      </div>

      {visibleTodos.map((t, i) => (
        <div
          key={i}
          className={`flex items-center gap-2 py-0.5 text-[length:var(--text-chrome)] ${t.status === 'completed' ? 'text-[var(--text-weak)]' : 'text-[var(--text-secondary)]'}`}
        >
          <span className="dot-sm" style={{ background: TODO_DOT[t.status] }} />
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{t.text}</span>
        </div>
      ))}
      {moreCount > 0 && (
        <div className="py-0.5 pl-3.5 text-[11px] text-[var(--text-weak)]">
          {moreCount}
          {' '}
          more
        </div>
      )}

      <div className="mt-3 flex items-center gap-2.5">
        <button type="button" onClick={() => setViewOpen(true)} className="btn btn-ghost text-[var(--text-primary)]">
          View Plan
        </button>
        {msg.model && <span className="mono text-[11px] text-[var(--text-weak)]">{msg.model}</span>}
        {build && (
          <button
            type="button"
            onClick={() => sendCommand('command:click_action', { ide: selectedIde, selectorPath: build.selectorPath, actionLabel: build.label })}
            className="btn btn-primary ml-auto"
          >
            {build.label || 'Build'}
          </button>
        )}
      </div>

      {viewOpen && <PlanView msg={msg} onClose={() => setViewOpen(false)} />}
    </div>
  );
}
