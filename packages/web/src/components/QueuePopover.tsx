import { CaretUp } from '@phosphor-icons/react';
import { useState } from 'react';
import { useIdesStore } from '../store/ides';
import { FloatLayer } from './FloatLayer';

/** Queue indicator `队列 N ▾` (spec §6: queue folded from a top strip into the composer). */
export function QueuePopover() {
  const ides = useIdesStore(s => s.ides);
  const selectedIde = useIdesStore(s => s.selectedIde);
  const queue = ides[selectedIde]?.composerQueue;
  const [open, setOpen] = useState(false);

  const items = queue?.items ?? [];
  if (items.length === 0)
    return null;

  return (
    <FloatLayer
      open={open}
      onOpenChange={setOpen}
      align="right"
      label="队列"
      trigger={(
        <button type="button" className="pill ml-auto">
          队列
          {' '}
          {queue?.queueLabel?.match(/\d+/)?.[0] ?? items.length}
          <CaretUp size={12} />
        </button>
      )}
    >
      <div className="px-2.5 pb-2 pt-1 text-[11px] text-[var(--text-weak)]">{queue?.queueLabel ?? `${items.length} Queued`}</div>
      {items.map(it => (
        <div key={it.id} className="whitespace-pre-wrap break-words border-t border-[var(--hairline)] px-2.5 py-2 text-[length:var(--text-chrome)] text-[var(--text-primary)]">
          {it.text}
        </div>
      ))}
    </FloatLayer>
  );
}
