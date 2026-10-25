import type { ThoughtBlock } from '../net/protocol';
import { CaretDown, CaretRight } from '@phosphor-icons/react';
import { useState } from 'react';
import { thoughtHeader } from '../lib/thought-label';

/**
 * Thinking body is folded by default, same as Cursor's "Thought 1s".
 * A thought with no body is just the one-line label.
 */
export function ThoughtRow({ el }: { el: ThoughtBlock }) {
  const detail = el.detail?.trim() ?? '';
  const [open, setOpen] = useState(false);
  const header = thoughtHeader(el);
  if (!detail) {
    return <div className="thought-row">{header}</div>;
  }
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-1 border-0 bg-transparent p-0 text-left text-[length:var(--text-chrome)] text-[var(--text-secondary)]"
      >
        <span>{header}</span>
        {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
      </button>
      {open && <div className="thought-row mt-1 whitespace-pre-wrap text-[var(--text-secondary)]">{detail}</div>}
    </div>
  );
}
