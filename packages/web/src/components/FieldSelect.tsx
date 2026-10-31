import { CaretDown, Check, CircleNotch } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

const TRIGGER = 'field-select w-full border border-[var(--hairline)] bg-transparent px-2 py-1.5 text-left text-[length:var(--text-chrome)] text-[var(--text-primary)] flex items-center justify-between gap-2';

/**
 * Full-width choice in a form. Agent, model, and thinking in the new-session
 * dialog all use this trigger, so the caret is one icon instead of a native
 * select arrow beside a hand-drawn one.
 */
export function FieldSelect({
  labelledBy,
  value,
  options,
  onChange,
  disabled = false,
  loading = false,
  placeholder,
  busyLabel = '正在读取',
  searchable = false,
  searchLabel = '搜索',
  showId = false,
}: {
  labelledBy: string;
  value: string;
  options: Array<{ id: string; label: string }>;
  onChange: (id: string) => void;
  disabled?: boolean;
  loading?: boolean;
  placeholder: string;
  busyLabel?: string;
  searchable?: boolean;
  searchLabel?: string;
  /** Model rows also show the id. Agent and thinking do not. */
  showId?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filtered = filterRows(options, searchable ? query : '');
  const active = Math.min(cursor, Math.max(filtered.length - 1, 0));
  const selected = options.find(row => row.id === value);

  const pick = (id: string) => {
    onChange(id);
    setQuery('');
    setOpen(false);
  };

  useEffect(() => {
    if (!open)
      return;
    inputRef.current?.focus();
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node))
        setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape')
        return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  if (loading || disabled) {
    return (
      <button
        type="button"
        disabled
        aria-labelledby={labelledBy}
        aria-busy={loading}
        className={`${TRIGGER} disabled:opacity-60`}
      >
        <span className="truncate">{loading ? busyLabel : placeholder}</span>
        <FieldCaret loading={loading} />
      </button>
    );
  }

  return (
    <div ref={rootRef} className={`relative ${open ? 'z-20' : ''}`}>
      <button
        type="button"
        aria-labelledby={labelledBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setQuery('');
          setCursor(0);
          setOpen(current => !current);
        }}
        className={TRIGGER}
      >
        <span className="truncate">{selected?.label ?? placeholder}</span>
        <FieldCaret />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 flex max-h-72 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--hairline)] bg-[var(--bg-2)] shadow-[var(--shadow-overlay)]">
          {searchable && (
            <input
              ref={inputRef}
              value={query}
              aria-label={searchLabel}
              placeholder={searchLabel}
              onChange={(event) => {
                setQuery(event.target.value);
                setCursor(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  const next = Math.min(active + 1, filtered.length - 1);
                  setCursor(next);
                  listRef.current?.querySelectorAll('[role="option"]')[next]?.scrollIntoView({ block: 'nearest' });
                }
                else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  const next = Math.max(active - 1, 0);
                  setCursor(next);
                  listRef.current?.querySelectorAll('[role="option"]')[next]?.scrollIntoView({ block: 'nearest' });
                }
                else if (event.key === 'Enter') {
                  event.preventDefault();
                  const row = filtered[active];
                  if (row)
                    pick(row.id);
                }
                else if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                }
              }}
              className="m-1.5 border border-[var(--hairline)] bg-transparent px-2 py-1.5 text-[length:var(--text-chrome)] text-[var(--text-primary)]"
            />
          )}
          <div ref={listRef} role="listbox" aria-labelledby={labelledBy} className="overflow-y-auto p-1">
            {filtered.map((row, index) => (
              <button
                key={row.id || 'default'}
                type="button"
                role="option"
                aria-selected={row.id === value}
                data-selected={row.id === value ? 'true' : undefined}
                data-active={index === active ? 'true' : undefined}
                onMouseEnter={() => setCursor(index)}
                onClick={() => pick(row.id)}
                className={`menu-item ${index === active ? 'bg-[var(--bg-3)]' : ''}`}
              >
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                {showId && row.id && <span className="shrink-0 text-[length:var(--text-chrome)] text-[var(--text-weak)]">{row.id}</span>}
                {row.id === value && <Check size={14} color="var(--accent)" />}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="p-2.5 text-[length:var(--text-chrome)] text-[var(--text-weak)]">没有匹配的选项</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FieldCaret({ loading = false }: { loading?: boolean }) {
  if (loading)
    return <CircleNotch size={14} weight="bold" className="shrink-0 animate-spin" aria-hidden="true" />;
  return <CaretDown size={12} className="shrink-0" aria-hidden="true" />;
}

function filterRows(rows: Array<{ id: string; label: string }>, query: string): Array<{ id: string; label: string }> {
  const needle = query.trim().toLowerCase();
  if (!needle)
    return rows;
  return rows.filter(row => `${row.label} ${row.id}`.toLowerCase().includes(needle));
}
