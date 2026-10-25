import type { WorkMark } from '../lib/cursor-activity';
import type { ChatElement, IdeKind, NotificationElement, RunCommand, TodoListBlock, ToolCallElement } from '../net/protocol';
import type { PendingSendInfo } from '../store/sessions';
import { CaretDown, CaretRight, CheckCircle, XCircle } from '@phosphor-icons/react';
import { memo } from 'react';
import { formatWorkDuration } from '../lib/cursor-activity';
import { sendCommand } from '../net/socket';
import { useIdesStore } from '../store/ides';
import { AssistantBlock, HumanBubble } from './MessageBubble';
import { PlanCard } from './PlanCard';
import { ThoughtRow } from './ThoughtRow';
import { ToolGroup } from './ToolGroup';

export type Segment
  = | { kind: 'single'; el: ChatElement; key: string }
    | { kind: 'tools'; items: ToolCallElement[]; key: string };

/**
 * Consecutive tools are grouped (spec §4: collapsed to a one-line summary by default). Draw thought / plan when present in the payload.
 *
 * `prev` reuses segments whose content has not changed: after keeping the full body, a single append can be thousands of items,
 * and rebuilding every Segment would invalidate the whole column's memo (markdown is not recomputed, but React still walks the entire column).
 */
export function segmentize(body: ChatElement[], prev?: Segment[]): Segment[] {
  const byKey = new Map<string, Segment>();
  if (prev) {
    for (const s of prev) byKey.set(s.key, s);
  }
  const out: Segment[] = [];
  for (const el of body) {
    if (el.type === 'tool') {
      const last = out[out.length - 1];
      if (last?.kind === 'tools')
        last.items.push(el);
      else out.push({ kind: 'tools', items: [el], key: el.id });
      continue;
    }
    const cached = byKey.get(el.id);
    if (cached?.kind === 'single' && cached.el === el)
      out.push(cached);
    else out.push({ kind: 'single', el, key: el.id });
  }
  return out;
}

/**
 * Container class for each item. spec §4 rhythm (24px before human, 0 inside a work streak, 12px between other segments).
 * Rhythm must live on the item as padding — margin would be eaten by collapsing margins, so measured height would not match real occupancy.
 * 12px breathing room at both ends.
 */
export function itemClassOf(segments: Segment[], i: number): string {
  const seg = segments[i];
  const prev = segments[i - 1];
  const cls = ['content-col', 'px-4', 'tl-item'];
  if (seg.kind === 'single' && seg.el.type === 'human')
    cls.push('tl-item-human');
  else if (prev?.kind === 'tools' && seg.kind === 'tools')
    cls.push('tl-item-tight');
  if (i === segments.length - 1)
    cls.push('tl-item-last');
  return cls.join(' ');
}

export function TodoListCard({ msg }: { msg: TodoListBlock }) {
  const dot = { pending: 'var(--text-weak)', in_progress: 'var(--accent)', completed: 'var(--ok)' } as const;
  return (
    <div className="surface-card px-3 py-2 text-[length:var(--text-chrome)]">
      <div className="mb-1 text-[var(--text-primary)]">
        {msg.title}
        {' '}
        (
        {msg.todosCompleted}
        /
        {msg.todosTotal}
        )
      </div>
      {msg.todos.map((t, i) => (
        <div
          key={i}
          className={`flex items-center gap-2 py-0.5 ${t.status === 'completed' ? 'text-[var(--text-weak)]' : 'text-[var(--text-secondary)]'}`}
        >
          <span className="dot-sm" style={{ background: dot[t.status] }} />
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export function RunCommandCard({ msg }: { msg: RunCommand }) {
  const selectedIde = useIdesStore(s => s.selectedIde);
  return (
    <div className="surface-card p-3">
      {msg.description && <div className="mb-2">{msg.description}</div>}
      <pre className="md-pre mono">
        $
        {msg.command}
      </pre>
      {msg.actions?.length > 0 && (
        <div className="mt-2.5 flex gap-2">
          {msg.actions.map(a => (
            <button
              key={a.selectorPath}
              type="button"
              onClick={() => sendCommand('command:click_action', { ide: selectedIde, selectorPath: a.selectorPath, actionLabel: a.label })}
              className={a.type === 'run' ? 'btn btn-primary' : 'btn btn-ghost'}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationRow({ msg }: { msg: NotificationElement }) {
  const failed = msg.status === 'error';
  const Icon = failed ? XCircle : CheckCircle;
  return (
    <div className="flex items-start gap-2 py-0.5 text-[length:var(--text-chrome)] text-[var(--text-secondary)]">
      <Icon size={14} weight="fill" className={failed ? 'mt-px shrink-0 text-[var(--error)]' : 'mt-px shrink-0 text-[var(--ok)]'} />
      <span className="text-[var(--text-weak)]">{failed ? 'Failed' : 'Finished'}</span>
      <span className="min-w-0 truncate">{msg.title}</span>
    </div>
  );
}

export function pendingMetaOf(el: ChatElement, pendingSends: Record<string, PendingSendInfo>): PendingSendInfo | undefined {
  if (el.type !== 'human' || !el.id.startsWith('pending-send:'))
    return undefined;
  return pendingSends[el.id.slice('pending-send:'.length)];
}

/**
 * One message. memo: the body array is new on every append; without this the whole 120-item column re-renders,
 * and real costs like markdown / code-block listeners would re-run as well.
 */
export const SegmentView = memo(
  ({ seg, pendingSends, ide }: { seg: Segment; pendingSends: Record<string, PendingSendInfo>; ide: IdeKind }) => {
    if (seg.kind === 'tools') {
      return (
        <div className="tl-seg tl-seg-tools">
          <ToolGroup items={seg.items} ide={ide} />
        </div>
      );
    }
    const el = seg.el;
    switch (el.type) {
      case 'human':
        return <div className="tl-seg tl-seg-human"><HumanBubble msg={el} meta={pendingMetaOf(el, pendingSends)} /></div>;
      case 'assistant':
        return <div className="tl-seg"><AssistantBlock msg={el} /></div>;
      case 'todo_list':
        return <div className="tl-seg"><TodoListCard msg={el} /></div>;
      case 'plan':
        return <div className="tl-seg"><PlanCard msg={el} /></div>;
      case 'thought':
        return <div className="tl-seg"><ThoughtRow el={el} /></div>;
      case 'run_command':
        return <div className="tl-seg"><RunCommandCard msg={el} /></div>;
      case 'notification':
        return <div className="tl-seg"><NotificationRow msg={el} /></div>;
      case 'loading':
        return (
          <div className="tl-seg">
            <span className="tl-loading">
              <span />
              <span />
              <span />
            </span>
          </div>
        );
      default:
        return null;
    }
  },
  (prev, next) => prev.seg === next.seg && prev.pendingSends === next.pendingSends && prev.ide === next.ide,
);

/**
 * One timeline row, with Cursor's "Worked for" fold.
 * A closed group keeps the header on its first segment and hides the rest.
 */
export function FoldedSegment({
  seg,
  mark,
  open,
  onToggle,
  pendingSends,
  ide,
}: {
  seg: Segment;
  mark: WorkMark | undefined;
  open: boolean;
  onToggle: (groupId: string) => void;
  pendingSends: Record<string, PendingSendInfo>;
  ide: IdeKind;
}) {
  if (mark && !mark.head && !open)
    return null;
  const duration = mark?.head?.durationMs ? formatWorkDuration(mark.head.durationMs) : undefined;
  const action = mark?.head?.active ? 'Working' : 'Worked';
  const details = mark?.head && !mark.head.active && duration ? `for ${duration}` : undefined;
  return (
    <>
      {mark?.head && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onToggle(mark.groupId)}
          className="mb-1 inline-flex items-center gap-1 border-0 bg-transparent p-0 text-left text-[length:var(--text-chrome)]"
        >
          <span className="text-[var(--text-secondary)]">{action}</span>
          {details && <span className="text-[var(--text-weak)]">{details}</span>}
          {open ? <CaretDown size={12} className="text-[var(--text-weak)]" /> : <CaretRight size={12} className="text-[var(--text-weak)]" />}
        </button>
      )}
      {(open || !mark) && <SegmentView seg={seg} pendingSends={pendingSends} ide={ide} />}
    </>
  );
}
