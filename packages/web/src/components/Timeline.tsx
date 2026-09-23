import type { ChatElement, IdeKind, RunCommand, ThoughtBlock, TodoListBlock, ToolCallElement } from '../net/protocol';
import type { PendingSendInfo } from '../store/sessions';
import { CloudArrowDown, FileDashed, Plug } from '@phosphor-icons/react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { segmentsPrepended } from '../lib/timeline-window';
import { IDE_LABELS } from '../net/protocol';
import { sendCommand, socket } from '../net/socket';
import { isDraftTab, isSyntheticComposerId, liveSessionKeyOf, useIdesStore, viewedTabOf } from '../store/ides';
import { useMachinesStore } from '../store/machines';
import { sessionBodyKey, useSessionsStore } from '../store/sessions';
import { useUiStore } from '../store/ui';
import { CopyButton } from './CopyButton';
import { AssistantBlock, HumanBubble } from './MessageBubble';
import { PlanCard } from './PlanCard';
import { TIMELINE_PROBE_ON, TimelineProbe } from './TimelineProbe';
import { ToolGroup } from './ToolGroup';

type Segment
  = | { kind: 'single'; el: ChatElement; key: string }
    | { kind: 'tools'; items: ToolCallElement[]; key: string };

/**
 * Consecutive tools are grouped (spec §4: collapsed to a one-line summary by default). Draw thought / plan when present in the payload.
 *
 * `prev` reuses segments whose content has not changed: after keeping the full body, a single append can be thousands of items,
 * and rebuilding every Segment would invalidate the whole column's memo (markdown is not recomputed, but React still walks the entire column).
 */
function segmentize(body: ChatElement[], prev?: Segment[]): Segment[] {
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
function itemClassOf(segments: Segment[], i: number): string {
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

function thoughtLine(el: ThoughtBlock): string {
  const bits = [el.action, el.detail].filter(Boolean);
  if (bits.length === 0)
    return el.duration ? `思考 ${el.duration}` : '思考中';
  return el.duration ? `${bits.join(' · ')} · ${el.duration}` : bits.join(' · ');
}

function TodoListCard({ msg }: { msg: TodoListBlock }) {
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

function RunCommandCard({ msg }: { msg: RunCommand }) {
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

function pendingMetaOf(el: ChatElement, pendingSends: Record<string, PendingSendInfo>): PendingSendInfo | undefined {
  if (el.type !== 'human' || !el.id.startsWith('pending-send:'))
    return undefined;
  return pendingSends[el.id.slice('pending-send:'.length)];
}

/**
 * One message. memo: the body array is new on every append; without this the whole 120-item column re-renders,
 * and real costs like markdown / code-block listeners would re-run as well.
 */
const SegmentView = memo(
  ({ seg, pendingSends }: { seg: Segment; pendingSends: Record<string, PendingSendInfo> }) => {
    if (seg.kind === 'tools') {
      return (
        <div className="tl-seg tl-seg-tools">
          <ToolGroup items={seg.items} />
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
        return <div className="tl-seg"><div className="thought-row">{thoughtLine(el)}</div></div>;
      case 'run_command':
        return <div className="tl-seg"><RunCommandCard msg={el} /></div>;
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
  (prev, next) => prev.seg === next.seg && prev.pendingSends === next.pendingSends,
);

/* ------------------------------------------------------------
   Read position: preserved across remounts and screen-off.
   ------------------------------------------------------------ */

/** Bottom-detection slack: slow scrolls often stop 1–2px short; zoom/rounding can add a few more pixels */
const BOTTOM_EPS = 24;

/** Empty segment-key list for the probe when live capture is off (avoid allocating a new one on every body change) */
const EMPTY_KEYS: string[] = [];

/**
 * "Still scrolling" idle window: consider scrolling stopped after this long with no scroll events.
 * Touch inertia keeps firing scroll events, so this one window covers both "finger still dragging" and "fling after release"
 * (writes to scrollTop are ignored during iOS inertial scrolling — that is the window we must avoid).
 */
const SCROLL_IDLE_MS = 160;

/**
 * Window-decision tracing: recorded into `window.__tl` so we can replay "why the window shrank/grew this way".
 *
 * Enabled in: `vite dev` (repro harness `packages/web/harness.html`) and **live-capture mode**
 * (URL has `tltrace`, see `TimelineProbe.tsx` — the panel dumps the decision at the moment a criterion hits).
 * Off by default in production (`import.meta.env.DEV` is folded to false at build time); call sites are on the hot path, so never leave this unconditionally on.
 */
const tlTrace = import.meta.env.DEV || TIMELINE_PROBE_ON
  ? (...args: unknown[]) => {
      const w = window as unknown as { __tl?: unknown[] };
      w.__tl = w.__tl ?? [];
      w.__tl.push([Math.round(performance.now()), ...args]);
      if (w.__tl.length > 6000)
        w.__tl.shift();
    }
  : () => {};

/**
 * The render window is counted in **viewports**, not item counts — the data layer is the full body (the store drops nothing); this only decides "how much to paint".
 *
 * Full-body render is not viable: 300 items measured 4.1s (1x) / 15s (6x); 1000 items 21.3s (1x) + 9149 DOM nodes,
 * 650k px of content. Windowing has one cost — expand/shrink when crossing a window boundary — and both are local sync operations
 * (the body is already in memory); with a precise anchor, the jump is invisible.
 *
 *  - First frame mounts only the last few items: paint as soon as one viewport of content exists, fill in the rest;
 *  - Keep at least KEEP_ABOVE viewports above the viewport and KEEP_BELOW below; expand if short;
 *  - Reclaim when above exceeds MAX_ABOVE viewports or below exceeds (KEEP_BELOW + 4) viewports, so the DOM stays bounded;
 *  - How many to expand per batch is converted from measured average item height into CHUNK viewports (item count is not the cost; pixels are).
 */
const INITIAL_ITEMS = 4;
const KEEP_ABOVE_VIEWPORTS = 8;
const KEEP_BELOW_VIEWPORTS = 4;
const MAX_ABOVE_VIEWPORTS = 16;
const MIN_CHUNK = 2;
const MAX_CHUNK = 48;
/**
 * Hard cap on a single render. Window state (winFrom/winTo) is **indices**; after a full-body replace or a length spike
 * those indices go stale — without a cap, slice(from, to) would render the whole range (measured: a 1200-item session
 * first mounted 1189 items under a stale window, then reclaimed to 13 in the same frame, burning several seconds). Convert by
 * "previous-frame measured average item height × MAX_WINDOW_VIEWPORTS viewports"; if there is no average yet, fall back to the old WINDOW=120 magnitude.
 */
const MAX_WINDOW_VIEWPORTS = 16;
const MIN_WINDOW_ITEMS = 6;
const MAX_WINDOW_ITEMS = 120;

/**
 * `atBottom`: the user is at the bottom (new messages follow).
 * When not pinned, record "which item the viewport top is on + its offset from the viewport top", and restore position from that after a data update.
 */
interface ReadState {
  atBottom: boolean;
  key: string;
  delta: number;
}

const BOTTOM_STATE: ReadState = { atBottom: true, key: '', delta: 0 };

/** In memory for as long as the component lives (survives disconnect remount / session switch); flushed to sessionStorage before screen-off (so a browser reload still finds it) */
const readStates = new Map<string, ReadState>();
const READ_STORE_PREFIX = 'ar:tl:';

/** Read only the sessionStorage copy (do not touch the in-memory map): distinguishes "position restored on a cold start" from "what this session already remembered" */
function readStored(key: string): ReadState | null {
  if (!key)
    return null;
  try {
    const raw = window.sessionStorage.getItem(READ_STORE_PREFIX + key);
    if (!raw)
      return null;
    const parsed = JSON.parse(raw) as Partial<ReadState>;
    if (typeof parsed?.atBottom === 'boolean' && typeof parsed.key === 'string' && typeof parsed.delta === 'number') {
      return { atBottom: parsed.atBottom, key: parsed.key, delta: parsed.delta };
    }
  }
  catch {
    /* Private mode / truncated record: treat as missing */
  }
  return null;
}

function readFallback(key: string): ReadState {
  if (!key)
    return BOTTOM_STATE;
  const memo = readStates.get(key);
  if (memo)
    return memo;
  try {
    const raw = window.sessionStorage.getItem(READ_STORE_PREFIX + key);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ReadState>;
      if (typeof parsed?.atBottom === 'boolean' && typeof parsed.key === 'string' && typeof parsed.delta === 'number') {
        const st: ReadState = { atBottom: parsed.atBottom, key: parsed.key, delta: parsed.delta };
        readStates.set(key, st);
        return st;
      }
    }
  }
  catch {
    /* Private mode / truncated record: treat as missing */
  }
  return BOTTOM_STATE;
}

function rememberRead(key: string, st: ReadState): void {
  if (key)
    readStates.set(key, st);
}

function persistRead(key: string, st: ReadState): void {
  if (!key)
    return;
  try {
    window.sessionStorage.setItem(READ_STORE_PREFIX + key, JSON.stringify(st));
  }
  catch {
    /* Private mode: still usable for this session, just lost after a reload */
  }
}

/** The item under the viewport top (binary search: offsetTop is monotonic) */
function topItemIndex(list: HTMLElement, scrollTop: number): number {
  const kids = list.children;
  let lo = 0;
  let hi = kids.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const el = kids[mid] as HTMLElement;
    if (el.offsetTop + el.offsetHeight > scrollTop + 1) {
      ans = mid;
      hi = mid - 1;
    }
    else {
      lo = mid + 1;
    }
  }
  return ans;
}

/**
 * Capture the read position.
 * `atDataEnd` = the current render window ends at the body end — only then does "scrolled to the bottom" count as truly pinned
 * (if the user stopped in the middle and the tail was reclaimed, the render region's bottom is not the session's bottom and must not be treated as pinned).
 */
function captureRead(sc: HTMLElement, list: HTMLElement, atDataEnd: boolean): ReadState {
  if (atDataEnd && sc.scrollHeight - sc.scrollTop - sc.clientHeight <= BOTTOM_EPS)
    return BOTTOM_STATE;
  const kids = list.children;
  if (kids.length === 0)
    return BOTTOM_STATE;
  const el = kids[topItemIndex(list, sc.scrollTop)] as HTMLElement;
  const key = el.dataset.key ?? '';
  if (!key)
    return BOTTOM_STATE;
  // delta = this item's top relative to the viewport top (negative once scrolled past); stable across data updates
  const st = { atBottom: false, key, delta: el.offsetTop - sc.scrollTop };
  tlTrace('capture', { key, delta: Math.round(st.delta), st: Math.round(sc.scrollTop) });
  return st;
}

/** Snap the view to the recorded position: pin to the bottom, otherwise put the anchor item back at the original offset */
function applyRead(sc: HTMLElement, list: HTMLElement, st: ReadState): void {
  if (st.atBottom || !st.key) {
    tlTrace('applyRead:bottom', st.atBottom, st.key, sc.scrollTop);
    sc.scrollTop = sc.scrollHeight;
    return;
  }
  const kids = list.children;
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i] as HTMLElement;
    if (el.dataset.key === st.key) {
      tlTrace('applyRead:anchor', st.key, 'from', Math.round(sc.scrollTop), 'to', Math.round(el.offsetTop - st.delta));
      sc.scrollTop = el.offsetTop - st.delta;
      return;
    }
  }
  // The anchor item is no longer in the window (head was trimmed): leave it — keeping the pixel position is better than jumping elsewhere
  tlTrace('applyRead:miss', st.key, 'st', Math.round(sc.scrollTop));
}

/**
 * P8c: IDE disconnected (machine online) — timeline empty state + copy-fix-instructions.
 *
 * ⚠️ **Do not tell the user to "quit and reopen"**: measured, Cursor 3.20.21 **does not read** `remote-debugging-port`
 * from `~/.cursor/argv.json` (in `out/main.js` that key only appears in `app.commandLine.getSwitchValue(...)`,
 * with no branch that injects from argv.json). A manual reopen only returns it to a "no debug port" state, after which the agent restarts it again.
 * Also **do not write a specific port number**: the port is now random (`--remote-debugging-port=0` + `DevToolsActivePort`).
 */
function IdeDisconnected({ ideLabel, error }: { ideLabel: string; error: string | null }) {
  const fixText = `${ideLabel} 未连接：先确认它开着 —— lifeline 会自动退出并用调试参数重新打开它（约 2 秒），不需要手动操作。手动"退出再打开"没用：这个版本不读 argv.json。`;
  return (
    <div className="tl-hint">
      <Plug size={28} color="var(--text-weak)" />
      <div className="text-[length:var(--text-body)] text-[var(--text-secondary)]">
        {ideLabel}
        {' '}
        未连接
      </div>
      <div className="max-w-[420px] leading-[1.6]">
        确认
        {' '}
        {ideLabel}
        {' '}
        已经打开 —— lifeline 会自动退出并用调试参数重新打开它（约 2 秒），不需要手动操作。
        <div className="text-[var(--text-weak)]">
          手动「退出再打开」没有用：这个版本不读
          {' '}
          <span className="mono">argv.json</span>
          。
        </div>
        {error && (
          <div className="mono mt-1.5 text-[11px]">
            最近错误：
            {error}
          </div>
        )}
      </div>
      <CopyButton text={fixText} label="复制修复说明" />
    </div>
  );
}

/**
 * The content source explicitly answered "this machine has no such session": do not keep drawing a skeleton and waiting.
 * Usually a freshly created session that has not sent its first message yet — after the message hits disk the server pushes the body.
 */
function SessionMissingNotice({ ideLabel, onRetry }: { ideLabel: string; onRetry: () => void }) {
  return (
    <div className="surface-card mx-4 mt-2.5 flex items-center gap-2.5 px-3.5 py-3 text-[length:var(--text-chrome)]">
      <FileDashed size={18} color="var(--text-weak)" />
      <div className="flex-1">
        <div className="text-[var(--text-secondary)]">这台电脑上还没有这个会话的内容</div>
        <div className="text-[11px] leading-[1.6] text-[var(--text-weak)]">
          通常是刚新建、还没发第一条消息的会话 —— 在
          {' '}
          {ideLabel}
          {' '}
          里发出第一条消息后，内容会自动出现在这里。
        </div>
      </div>
      <button type="button" onClick={onRetry} className="btn btn-ghost">
        重试
      </button>
    </div>
  );
}

/** P8d: timeline source unavailable — inline card (live state and sending are unaffected; dual-lane UI expression) */
function SourceUnavailable({ reason, onRetry }: { reason: string; onRetry: () => void }) {
  return (
    <div className="surface-card mx-4 mt-2.5 flex items-center gap-2.5 px-3.5 py-3 text-[length:var(--text-chrome)]">
      <CloudArrowDown size={18} color="var(--text-weak)" />
      <div className="flex-1">
        <div className="text-[var(--text-secondary)]">会话内容暂不可用</div>
        <div className="mono text-[11px] text-[var(--text-weak)]">{reason}</div>
      </div>
      <button type="button" onClick={onRetry} className="btn btn-ghost">
        重试
      </button>
    </div>
  );
}

/** Wait before showing the skeleton: a cache/prefetch fast reply should not flash (same as P0 launch-state anti-flicker) */
const SKELETON_APPEAR_AFTER_MS = 200;

/**
 * Skeleton while the body is fetching: laid out with the real rhythm (peer body full-width, own right bubble) and pinned to the bottom,
 * so the visual landing matches when the body arrives; the last row reuses the timeline's three-dot breathing to say "still fetching".
 */
function TimelineSkeleton() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(setShown, SKELETON_APPEAR_AFTER_MS, true);
    return () => window.clearTimeout(t);
  }, []);
  // Placeholder until the threshold so the whole block does not jump in height when the body arrives
  if (!shown)
    return <div className="flex min-h-0 flex-1 flex-col" />;
  return (
    <div className="tl-skel" role="status">
      <span className="sr-only">会话加载中…</span>
      <div className="content-col flex flex-col gap-2.5 px-4" aria-hidden>
        <div className="tl-skel-line w-[58%]" />
        <div className="tl-skel-line w-[86%]" />
        <div className="tl-skel-line w-[46%]" />
      </div>
      <div className="content-col mt-3.5 flex justify-end px-4" aria-hidden>
        <div className="tl-skel-bubble w-[52%]" />
      </div>
      <div className="content-col mt-3.5 flex flex-col gap-2.5 px-4" aria-hidden>
        <div className="tl-skel-line w-[74%]" />
        <div className="tl-skel-line w-[40%]" />
      </div>
      <div className="content-col mt-3.5 flex justify-end px-4" aria-hidden>
        <div className="tl-skel-bubble w-[34%]" />
      </div>
      <div className="content-col mt-2 flex px-4" aria-hidden>
        <span className="tl-loading">
          <span />
          <span />
          <span />
        </span>
      </div>
    </div>
  );
}

/**
 * Timeline: a normal scroll container (**not virtualized**).
 *
 * The body window is already capped at 120 items by the store; virtualization's saved DOM is paid for with a whole estimation stack:
 * unmeasured items can only be extrapolated from nearby measured sizes, and correcting scrollTop over and over during scroll makes the position drift;
 * if catch-up rendering cannot keep up with a fling, blank frames appear. Here we use real height + a precise anchor:
 *  - Scroll position = the browser's own scrollTop, no estimates, no corrections;
 *  - After a data update (append / window trim / full replace), restore position from "the item at the viewport top + offset";
 *  - Read position lives outside the component (memory + sessionStorage), so reconnect remount, wake-from-screen-off, and browser reload can all restore it.
 */
export function Timeline() {
  const ides = useIdesStore(s => s.ides);
  const selectedIde = useIdesStore(s => s.selectedIde);
  const state = ides[selectedIde];
  // Content-source machine (Linux): its body comes from the server mirror/projection, unrelated to CDP — do not treat as "disconnected".
  const machineContentOnly = useMachinesStore(
    s => s.machines.find(m => m.agentId === s.selectedAgentId)?.contentOnly === true,
  );
  const pendingSwitch = useUiStore(s => s.pendingSwitch);
  const pendingHere = pendingSwitch && pendingSwitch.ide === selectedIde ? pendingSwitch : null;
  // Optimistic "switching": fetch the body for the target session immediately (render from cache if present; otherwise show loading + already prefetched on click)
  const pendingKey = pendingHere && !isSyntheticComposerId(pendingHere.composerId)
    ? sessionBodyKey(pendingHere.composerId, selectedIde)
    : '';
  // Current session (the target while an optimistic switch is in flight); draft detection shares the same truth with the empty state and composer prefill
  const viewedTab = viewedTabOf(state, pendingHere);
  const liveKey = pendingKey || liveSessionKeyOf(selectedIde, state, pendingHere);
  const body = useSessionsStore(s => (liveKey ? s.bodies[liveKey] : undefined));
  const sessionMissing = useSessionsStore(s => (liveKey ? s.unavailable[liveKey] === true : false));
  const pendingSends = useSessionsStore(s => s.pendingSends);
  const pageMeta = useSessionsStore(s => (liveKey ? s.pageMeta[liveKey] : undefined));
  /** ensureWindow / onScroll are stable callbacks: latest context needed for page-fetch goes through a ref */
  const pageCtxRef = useRef<{ key: string; ide: IdeKind; hasMore: boolean; nextBefore?: number }>({
    key: '',
    ide: 'cursor',
    hasMore: false,
  });
  pageCtxRef.current = {
    key: liveKey,
    ide: selectedIde,
    hasMore: pageMeta?.hasMore === true,
    nextBefore: pageMeta?.nextBefore,
  };
  /**
   * Window **state** indices (not the ones clipped by `clipItems` at render time).
   * Page-fetch must have **winFrom <= 0 and sliceFrom === 0 (winRef.from === 0)**:
   *  - Looking only at `winFrom` fires too early (initial `winFrom` is already 0; what hides the head is clipItems);
   *  - Looking only at `sliceFrom` never reaches 0 when `to = len`, so the criterion never fires;
   *  - Looking only at `scrollTop` chains page-fetches (scrollTop is unchanged after a prepend).
   * Fallback `above <= 0`: if the viewport constants (KEEP_BELOW / MAX_ABOVE) are later tuned so the tail is never reclaimed,
   * `sliceFrom` never reaches 0 and page-fetch deadlocks (no crash, just cannot page).
   * Declared here, assigned after `winFrom` is declared (see below) — until then `winFrom` is still in the TDZ.
   */
  const headRef = useRef(0);
  /** Item count currently clipped for render (ensureWindow is a stable callback and cannot read render-phase variables) */
  const clipItemsRef = useRef(MAX_WINDOW_ITEMS);
  /** Max extra pages to fetch when restoring an anchor on a cold start (more than that means the read position is too far back; let the user scroll) */
  const ANCHOR_REFETCH_MAX = 3;
  const anchorRefetchRef = useRef(0);
  /**
   * An anchor that is remembered but not yet realized. **Do not judge from `readRef.current`**: `captureRead` rewrites it
   * to "the item currently at the viewport top" in every data-change effect — as soon as the tail page arrives, the anchor is wiped.
   */
  const pendingAnchorRef = useRef<ReadState | null>(null);
  /**
   * The item under the viewport top when the previous page arrived. If the user has not moved (it is still at the top), do not fetch the next page —
   * otherwise sitting at "the start of already-loaded data" auto-pulls the whole session page by page (measured: first open wasted 3 pages).
   */
  const lastPageTopRef = useRef('');
  /**
   * Whether the user has actually pushed (touchstart / wheel). **Page-fetch only honors a gesture**:
   * body changes / prepend / settle all programmatically write scrollTop, so looking only at "are we at the start" cannot tell "the user scrolled to the top"
   * from "just settled, scrollTop is still 0" — the latter auto-pages a top-stopped view all the way to the session start
   * (measured in wire mode: first open with no gesture still fetched 3 pages / 900KB, and the position was dragged into the middle of the session).
   */
  const userScrolledRef = useRef(false);
  const prevSegmentsRef = useRef<Segment[] | undefined>(undefined);
  const segments = useMemo(() => {
    const next = segmentize(body ?? [], prevSegmentsRef.current);
    prevSegmentsRef.current = next;
    return next;
  }, [body]);

  const hasDelivered = Object.values(pendingSends).some(p => p.state === 'delivered');
  /** Full segment keys (only live-capture mode needs them: the probe's "segment-order went backwards" criterion reads this; do not allocate when off) */
  const segKeys = useMemo(() => (TIMELINE_PROBE_ON ? segments.map(s => s.key) : EMPTY_KEYS), [segments]);

  const [, forceTick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!hasDelivered)
      return;
    const t = window.setInterval(forceTick, 3000);
    return () => window.clearInterval(t);
  }, [hasDelivered]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** Current read position (the source of truth synced to the scroll handler and every effect) */
  const readRef = useRef<ReadState>(BOTTOM_STATE);
  const liveKeyRef = useRef(liveKey);
  liveKeyRef.current = liveKey;
  /** Sessions that have already had their "first-batch unroll" (re-layout only on session switch or first body arrival) */
  const arrivedRef = useRef('');
  /** Previous-frame measured average item height / viewport height (render-cap only; do not read the DOM during render) */
  const avgItemPxRef = useRef(0);
  const viewportPxRef = useRef(0);
  /** Render window [winFrom, winTo); winTo = MAX_SAFE_INTEGER means paint through the end of the body */
  const [winFrom, setWinFrom] = useState(0);
  const [winTo, setWinTo] = useState(Number.MAX_SAFE_INTEGER);
  /**
   * "Reclaim above" and "extend upward" are two criteria on the same axis: reclaim chops above-viewport slack down to ~8 viewports,
   * extend-up adds it back to 8 when slack is under 4.8 viewports. When item heights vary a lot the reachable set is sparse —
   * measured, a single 11367px code block already occupies 17 viewports, leaving only the two solutions "25 viewports" and "3 viewports"; no solution
   * exists in the [4.8, 16] viewport band: reclaim → extend → reclaim becomes a dead loop (35ms per cycle,
   * after 52 nested updates React throws Maximum update depth exceeded, unmounts the whole tree, and the page goes white).
   *
   * So after a reclaim cut, check whether the slack actually held: `reclaimPending` records the pre-cut `above` as a waterline,
   * and if the next round's "extend upward" would pull the head back (slack was not kept), raise the waterline to that — later, do not reclaim
   * while `above` stays at or below the waterline. Only retry when geometry actually changed (session grew, or the user kept scrolling down so `above` grew).
   */
  const reclaimFloorRef = useRef(0);
  const reclaimPendingRef = useRef(0);
  /**
   * Prepend shift (**segments**, see `segmentsPrepended`): how many segments the previous frame's body-head was pushed back this frame.
   * `prevHeadIdRef` is only advanced in the layout effect, so however many re-renders happen in the same commit, the computed value is the same.
   */
  const prevHeadIdRef = useRef('');
  const shift = body ? segmentsPrepended(body, prevHeadIdRef.current) : 0;
  /** Page-fetch trigger looks at "window state" indices, not the clipped render window (see headRef above for why) */
  headRef.current = winFrom + shift;

  const len = segments.length;
  /**
   * Clamp `from` to `len - 1`, not `len`: after a full-body replace `winFrom` may be longer than the new body,
   * and clamping to `len` yields `slice(len, len)` = empty array — `ensureWindow` sees no children and returns,
   * so the timeline paints empty and does not self-heal (clearing `pageMeta`/`prependedItems` cannot fix this; that treats the cursor, not the index).
   */
  const from = Math.min(Math.max(0, winFrom + shift), Math.max(0, len - 1));
  const toRaw = winTo === Number.MAX_SAFE_INTEGER ? winTo : winTo + shift;
  const to = Math.min(Math.max(from, toRaw), len);
  /**
   * Cap: window indices may come from the previous body (full replace / length spike). First clamp the render count by
   * "previous-frame measured average item height × viewport count"; then ensureWindow will pull the window back to a proper slack for the current viewport.
   */
  const clipItems = avgItemPxRef.current > 0 && viewportPxRef.current > 0
    ? Math.max(
        MIN_WINDOW_ITEMS,
        Math.min(MAX_WINDOW_ITEMS, Math.round((MAX_WINDOW_VIEWPORTS * viewportPxRef.current) / avgItemPxRef.current)),
      )
    : MAX_WINDOW_ITEMS;
  const sliceFrom = Math.max(from, to - clipItems);
  /** ensureWindow needs the post-clip item count (a stable callback cannot read render-phase variables; go through a ref) */
  clipItemsRef.current = clipItems;
  /** Window end = body end. Only then does "scrolled to the bottom" equal pinned (see captureRead) */
  const atDataEndRef = useRef(true);
  atDataEndRef.current = to >= len;
  /** Read the latest values in ensureWindow / onScroll so closures do not see stale state */
  const winRef = useRef({ from: sliceFrom, to, len });
  winRef.current = { from: sliceFrom, to, len };

  const scroller = () => scrollRef.current;
  const list = () => listRef.current;

  /**
   * Keep the render window in viewport units: leave enough slack above and below the viewport; expand if short, reclaim if too much.
   * Expand/reclaim both change DOM height; the caller must captureRead first — the anchor effect then corrects the position.
   * One action per call (return); hysteresis between thresholds so it does not oscillate.
   */
  const ensureWindow = useCallback(() => {
    const sc = scrollRef.current;
    const l = listRef.current;
    if (!sc || !l || l.children.length === 0)
      return;
    const { from: wf, to: wt, len: total } = winRef.current;
    const vh = sc.clientHeight || 1;
    const above = sc.scrollTop;
    // Check whether the last reclaim's slack actually held (see reclaimFloorRef): if not, raise the waterline to the pre-cut position
    if (reclaimPendingRef.current > 0) {
      if (above < KEEP_ABOVE_VIEWPORTS * vh) {
        reclaimFloorRef.current = Math.max(reclaimFloorRef.current, reclaimPendingRef.current);
      }
      reclaimPendingRef.current = 0;
    }
    // The start of already-loaded data is still not the session start: ask the server for the previous page (local expand has nothing left)
    const page = pageCtxRef.current;
    const atLoadedHead = headRef.current <= 0 && (wf === 0 || above <= 0);
    if (atLoadedHead && page.hasMore && above < KEEP_ABOVE_VIEWPORTS * vh * 0.6 && userScrolledRef.current) {
      // Two gates: (1) there must have been a user gesture (otherwise settle-phase scrollTop=0 would be treated as "scrolled to the top");
      // (2) the top item must not be the same as when the previous page arrived (do not fetch the next page if the user has not moved toward earlier content).
      const top = readRef.current.key;
      if (top !== lastPageTopRef.current) {
        const req = useSessionsStore.getState().beginEarlier(page.key);
        if (req) {
          lastPageTopRef.current = top;
          userScrolledRef.current = false;
          const sessionId = page.key.slice(page.key.indexOf(':') + 1);
          socket.emit('session:get', { sessionId, ide: page.ide, before: req.before });
        }
      }
    }
    const below = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
    const avg = sc.scrollHeight / Math.max(1, l.children.length);
    /** Convert a pixel shortfall into an item count via average item height (fill enough in one shot; do not squeeze frame by frame) */
    const fit = (needPx: number) =>
      Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, Math.ceil(needPx / Math.max(1, avg))));
    tlTrace('win', { wf, wt, total, above, below, vh, n: l.children.length, head: headRef.current, clip: clipItemsRef.current, floor: reclaimFloorRef.current });
    // Not enough slack above → extend upward (history is already in memory; expand locally and synchronously).
    // Writes back must use the **state value** as the baseline: `wf` is the render-window start after `clipItems` clipping; writing that back
    // fights "clip → write a clipped value → get clipped again" — measured, this can reach
    // `Maximum update depth exceeded` (a single-page body + scroll-to-top always hits it; after pagination every open looks like this).
    // Do not return when state is already 0: let the tail-reclaim below pull `to` down so the clip lifts on its own.
    //
    // ⚠️ This branch, plus "unclip" and "reclaim above", all three need `!scrollingRef.current`: they all change
    // content **above** the viewport (and must pair with a scrollTop write). During iOS inertial scrolling those writes are ignored —
    // content changed, position not patched, and the user sees a "jump while sliding". After scroll stops, `noteScrolling`'s timer
    // runs ensureWindow again and does the pending action (writes take effect then).
    if (!scrollingRef.current && wf > 0 && above < KEEP_ABOVE_VIEWPORTS * vh * 0.6) {
      const base = headRef.current;
      if (base > 0) {
        tlTrace('extendUp', base, fit(KEEP_ABOVE_VIEWPORTS * vh - above));
        setWinFrom(Math.max(0, base - fit(KEEP_ABOVE_VIEWPORTS * vh - above)));
        return;
      }
    }
    // Render is clipped (render start > state-window start) and already pinned to the top → shrink the state window to "start + one viewport of items".
    // Without this, `sliceFrom = max(from, to - clipItems)` permanently keeps that already-loaded head outside the viewport
    // (measured: short bubbles + one page of body → scroll to top top=0, below≈6.5 viewports, render still starts at h-280, and you cannot push further).
    // The target depends only on state and clipItems (not the current render), so it **converges in one step**; and it is mutually exclusive with "extend down"
    // (when pinned to the top, below is large, so the extend-tail branch does not fire at the same time) — no dead loop of pushing each other.
    if (!scrollingRef.current && wf > headRef.current && above <= 0 && wt > headRef.current + clipItemsRef.current) {
      tlTrace('clipRelease', { wf, head: headRef.current, wt, clip: clipItemsRef.current, to: headRef.current + clipItemsRef.current });
      setWinTo(headRef.current + clipItemsRef.current);
      return;
    }
    // Not enough slack below and not yet painted to the end → extend downward.
    // Threshold is a full KEEP_BELOW viewports: after the tail has been reclaimed, "scrolled to the render region's bottom" ≠ session end,
    // so scrolling to the bottom must keep expanding, or it sticks halfway and new messages stop following.
    if (wt < total && below < KEEP_BELOW_VIEWPORTS * vh) {
      tlTrace('extendDown', wt, Math.min(total, wt + fit(KEEP_BELOW_VIEWPORTS * vh - below)));
      setWinTo(Math.min(total, wt + fit(KEEP_BELOW_VIEWPORTS * vh - below)));
      return;
    }
    // Too much slack above → reclaim (the user will not go back to what is above); do not touch while scrolling (see the previous branch for why)
    if (!scrollingRef.current && above > MAX_ABOVE_VIEWPORTS * vh && above > reclaimFloorRef.current) {
      const cut = above - KEEP_ABOVE_VIEWPORTS * vh;
      const kids = l.children;
      let k = 0;
      while (k < kids.length - 1 && (kids[k + 1] as HTMLElement).offsetTop <= cut) k++;
      /**
       * Granularity is "whole items": when items are very tall (3000px code blocks are common), converging to `cut` can chop far more than 8 viewports in one go,
       * and after the chop it immediately falls into "not enough slack above → extend upward" — the two branches push each other, measured 30ms per cycle,
       * after 52 nested updates React throws `Maximum update depth exceeded` and unmounts the whole tree (page goes white).
       * So after reclaim there must still be 8 viewports of slack; if not, leave the whole item (better to keep extra DOM than to chop into a dead loop).
       */
      const kTop = k > 0 ? (kids[k] as HTMLElement).offsetTop : 0;
      const keepAbove = k > 0 ? above - kTop : 0;
      tlTrace('reclaim', { cut, k, kTop, keepAbove, pass: k > 0 && keepAbove >= KEEP_ABOVE_VIEWPORTS * vh });
      if (k > 0 && keepAbove >= KEEP_ABOVE_VIEWPORTS * vh) {
        reclaimPendingRef.current = above;
        setWinFrom(wf + k);
      }
      return;
    }
    // Too much slack below (user stopped in the middle) → reclaim the tail; when pinned, below≈0 so this does not fire
    if (below > (KEEP_BELOW_VIEWPORTS + 4) * vh) {
      const keepPx = sc.scrollTop + sc.clientHeight + KEEP_BELOW_VIEWPORTS * vh;
      const kids = l.children;
      let k = kids.length;
      while (k > 1 && (kids[k - 1] as HTMLElement).offsetTop >= keepPx) k--;
      const nextTo = wf + k;
      tlTrace('reclaimTail', { k, nextTo, wt, will: nextTo < wt });
      if (nextTo < wt)
        setWinTo(nextTo);
    }
  }, []);

  // Session switch / mount: take the position recorded for this session (default pinned), and settle it before this paint
  useLayoutEffect(() => {
    const st = readFallback(liveKey);
    readRef.current = st;
    // Session switch: forget the body-head id (the new session's first id will not match the old one, and a shift could not be computed anyway)
    prevHeadIdRef.current = '';
    // Session switch: zero the reclaim waterline / pending check (the waterline remembers "this session was cut at this position and the slack did not hold")
    reclaimFloorRef.current = 0;
    reclaimPendingRef.current = 0;
    // Cold start (browser reload / killed for low memory): **only trust the sessionStorage copy**.
    // The in-memory position is what this session scrolled to; it was definitely rendered and does not need extra pages; treating it as a cold-start anchor
    // would waste up to 3 extra pages on every mount (measured in wire: first open with no gesture auto-paged 3 pages / 900KB, position dragged to the middle).
    const stored = readStored(liveKey);
    anchorRefetchRef.current = 0;
    pendingAnchorRef.current = stored && !stored.atBottom && stored.key ? stored : null;
    const sc = scroller();
    const l = list();
    if (sc && l)
      applyRead(sc, l, st);
  }, [liveKey]);

  // Session switch / first body arrival: first frame paints only the last few items — this must be computed in the render phase;
  // if it lives in an effect the first frame has already mounted the full set, so nothing was split (measured: first frame still 1.2s at 6x CPU throttle).
  const freshSession = arrivedRef.current !== liveKey;
  const shownFrom = freshSession ? Math.max(0, segments.length - INITIAL_ITEMS) : winFrom;
  const shownTo = freshSession ? Number.MAX_SAFE_INTEGER : winTo;

  useLayoutEffect(() => {
    if (!liveKey || segments.length === 0 || arrivedRef.current === liveKey)
      return;
    arrivedRef.current = liveKey;
    setWinFrom(shownFrom);
    setWinTo(shownTo);
  }, [liveKey, segments.length, shownFrom, shownTo]);

  // Body change / window expand-shrink: follow to the bottom if pinned, otherwise put the anchor item back at the original offset (done in the same paint, no visible jump),
  // then check slack once more (keep expanding if short; stop when enough).
  useLayoutEffect(() => {
    const sc = scroller();
    const l = list();
    if (!sc || !l)
      return;
    tlTrace('effect', { st: Math.round(sc.scrollTop), sh: sc.scrollHeight, n: l.children.length, shift, winFrom, winTo, read: readRef.current.key });
    // The prepend shift was already added to the indices in the render phase; here we only commit the shift into state
    // (next frame shift is 0 and winFrom is the new value, so the result is unchanged). **Do not return**: this frame still needs to settle by the anchor.
    if (shift > 0) {
      setWinFrom(v => v + shift);
      setWinTo(v => (v === Number.MAX_SAFE_INTEGER ? v : v + shift));
    }
    // Advance the body-head memory to this frame: next frame the same body computes a shift of 0
    prevHeadIdRef.current = body?.[0]?.id ?? '';
    applyRead(sc, l, readRef.current);
    // The read anchor is **in the body** but not rendered (window clipped to the tail / just prepended) → move the window there.
    // Without this: applyRead cannot find it so it cannot settle, scrollTop stays at 0 — that both looks like "the user is at the start of already-loaded data"
    // (so it auto-fetches the next page) and loses the position. Measured: first open auto-paged all the way to the session start, wasting 3 pages ~900KB.
    const pending = pendingAnchorRef.current ?? readRef.current;
    if (pending && pending.key) {
      const el = l.querySelector(`[data-key="${CSS.escape(pending.key)}"]`);
      if (el) {
        if (pendingAnchorRef.current) {
          // Write readRef to pending before capture: otherwise captureRead records the intent as "top of the tail page",
          // and next frame applyRead yanks away the position we just restored
          pendingAnchorRef.current = null;
          readRef.current = pending;
          sc.scrollTop = (el as HTMLElement).offsetTop - pending.delta;
        }
      }
      else if ((body ?? []).some(m => m.id === pending.key)) {
        // In the body, just not rendered (window pinned to the tail) → move the window; do not waste a page-fetch.
        // The criterion must use the body, not the DOM: otherwise a mid-session cold start would waste 3 pages then give up,
        // leaving the position at the top of the tail page — which is exactly what this step is meant to fix.
        const at = (body ?? []).findIndex(m => m.id === pending.key);
        setWinFrom(Math.max(0, at - INITIAL_ITEMS));
        setWinTo(at + INITIAL_ITEMS);
      }
      else if (pendingAnchorRef.current && anchorRefetchRef.current < ANCHOR_REFETCH_MAX) {
        const page = pageCtxRef.current;
        const req = useSessionsStore.getState().beginEarlier(page.key);
        if (req) {
          anchorRefetchRef.current += 1;
          const sessionId = page.key.slice(page.key.indexOf(':') + 1);
          socket.emit('session:get', { sessionId, ide: page.ide, before: req.before });
        }
      }
    }
    readRef.current = captureRead(sc, l, atDataEndRef.current);
    rememberRead(liveKeyRef.current, readRef.current);
    avgItemPxRef.current = sc.scrollHeight / Math.max(1, l.children.length);
    viewportPxRef.current = sc.clientHeight;
    ensureWindow();
  }, [segments, winFrom, winTo, ensureWindow]);

  /**
   * Breakpoint on the scroll chain (touch).
   *
   * iOS / WeChat-embedded WKWebView either do not support `overscroll-behavior` (older versions) or only block the container itself:
   * pulling past either end of the timeline chains the scroll to the page — the shell bounces, and WeChat also pulls down the domain bar
   * (viewport height changes, the whole timeline reflows, and what the user sees is a "jump while sliding").
   * Eat this touchmove when we are **truly at an end** and there is no earlier/newer content to load.
   *
   * Two constraints, do not change them:
   *  - React's `onTouchMove` is passive (`preventDefault` is a no-op), so we must addEventListener ourselves;
   *  - Eat only when **truly at an end**: look at both `atDataEndRef` and `headRef+hasMore` — looking only at scrollTop
   *    would also eat the pull that happens before the render region has expanded, and the user could never trigger window expansion (self-deadlock).
   */
  /**
   * iOS/WKWebView (including WeChat) **has no native scroll anchoring**, while Chrome does — the kind of jump desktop never sees
   * all shows up on the phone. So we add two layers of fallback (both only act when they are **actually needed**):
   *
   *  1. **Do not perform window actions that need a scrollTop write while scrolling** (extend up / reclaim above / unclip):
   *     iOS ignores those writes during inertial scrolling, but the content still changes — the user sees a "jump while sliding".
   *     Extend down and reclaim-tail do not write scrollTop, so they stay as-is (unaffected, and still able to scroll to the bottom).
   *  2. **When content grows after commit** (image/font/markdown reflow), patch position once from the read anchor —
   *     that is what native browser anchoring would do; iOS does not have it, so we do it ourselves. Yield to the finger during a scroll gesture,
   *     and patch after release (`scrollIdleRef`'s timer).
   */
  const scrollingRef = useRef(false);
  const scrollIdleTimerRef = useRef(0);
  const noteScrolling = useCallback(() => {
    scrollingRef.current = true;
    window.clearTimeout(scrollIdleTimerRef.current);
    scrollIdleTimerRef.current = window.setTimeout(() => {
      scrollingRef.current = false;
      const sc = scroller();
      const l = list();
      if (sc && l)
        applyRead(sc, l, readRef.current); // Settle after release: snap the anchor back (patch writes that iOS inertia ignored)
      ensureWindow();
    }, SCROLL_IDLE_MS);
  }, [ensureWindow]);

  const touchStartYRef = useRef(0);
  const touchGuardRef = useRef<HTMLElement | null>(null);
  const onTouchMoveGuard = useCallback((e: TouchEvent) => {
    const sc = scrollRef.current;
    if (!sc || e.touches.length !== 1)
      return;
    const dy = (e.touches[0]?.clientY ?? 0) - touchStartYRef.current;
    if (dy === 0)
      return;
    const headEdge = sc.scrollTop <= 0 && headRef.current <= 0 && !pageCtxRef.current.hasMore;
    const tailEdge = atDataEndRef.current && sc.scrollHeight - sc.scrollTop - sc.clientHeight <= 1;
    if ((dy > 0 && headEdge) || (dy < 0 && tailEdge))
      e.preventDefault();
  }, []);
  useEffect(() => {
    const sc = scrollRef.current;
    // No scroll container in skeleton/empty state; when the container is swapped, move the listener (runs every frame, but only rebinds on swap)
    if (touchGuardRef.current === sc)
      return;
    touchGuardRef.current?.removeEventListener('touchmove', onTouchMoveGuard);
    touchGuardRef.current = sc;
    sc?.addEventListener('touchmove', onTouchMoveGuard, { passive: false });
  });

  /**
   * When content grows **after commit** (image load, font swap, markdown/code-block reflow), native browser scroll anchoring
   * would patch scrollTop for you — iOS/WKWebView (including WeChat) does not, so we patch it ourselves: put the item at the viewport top back at the original offset.
   * Yield to the finger during a scroll gesture / inertia (iOS ignores this kind of write); after release, `noteScrolling`'s timer patches again.
   * The ResizeObserver callback runs after layout and before paint, which is the right moment to patch.
   */
  const resizeGuardRef = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    const l = list();
    if (!l || resizeGuardRef.current)
      return; // The container is stable for the component's lifetime; skeleton/empty state has none
    const ro = new ResizeObserver(() => {
      if (scrollingRef.current)
        return;
      const sc = scroller();
      if (!sc)
        return;
      applyRead(sc, l, readRef.current);
      ensureWindow();
    });
    ro.observe(l);
    resizeGuardRef.current = ro;
    return () => {
      ro.disconnect();
      resizeGuardRef.current = null;
    };
  });

  // User scroll: update the read position (reading offsetTop does not change styles, so no layout thrash) + keep render-window slack
  const onScroll = useCallback(() => {
    const sc = scroller();
    const l = list();
    if (sc && l) {
      readRef.current = captureRead(sc, l, atDataEndRef.current);
      rememberRead(liveKeyRef.current, readRef.current);
    }
    noteScrolling();
    ensureWindow();
  }, [ensureWindow, noteScrolling]);

  const bottomNonce = useUiStore(s => s.bottomNonce);
  // Send: return to pinned (same as Composer's requestScrollToBottom); if the tail was reclaimed, paint through to the end again
  useLayoutEffect(() => {
    if (bottomNonce === 0)
      return;
    readRef.current = BOTTOM_STATE;
    rememberRead(liveKeyRef.current, BOTTOM_STATE);
    setWinTo(Number.MAX_SAFE_INTEGER);
    const sc = scroller();
    const l = list();
    if (sc && l)
      applyRead(sc, l, readRef.current);
  }, [bottomNonce]);

  /**
   * Screen-off / leave-and-come-back / server reconnect: snap the position back.
   * On these paths the browser may drop the inner container's scrollTop (or never remount the component at all),
   * so positioning only at mount is not enough — snap again on wake so the user is back where they were.
   */
  useEffect(() => {
    const reassert = () => {
      const sc = scroller();
      const l = list();
      if (sc && l)
        applyRead(sc, l, readRef.current);
      ensureWindow();
    };
    const onVisibility = () => {
      if (document.hidden) {
        persistRead(liveKeyRef.current, readRef.current);
        return;
      }
      reassert();
      // The system may restore zoom/visual viewport only after the event (same extra check as page-zoom)
      window.setTimeout(reassert, 300);
    };
    const onHide = () => persistRead(liveKeyRef.current, readRef.current);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', reassert);
    window.addEventListener('focus', reassert);
    window.addEventListener('pagehide', onHide);
    socket.on('connect', reassert);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', reassert);
      window.removeEventListener('focus', reassert);
      window.removeEventListener('pagehide', onHide);
      socket.off('connect', reassert);
    };
  }, []);

  // Content-source machines (Linux / remote dev boxes) have no live state, so `connected` is always false,
  // but the body is projected from `session:get` and **does not depend on CDP** — do not treat as "not connected",
  // or that machine's sessions would never open in the web UI (and "read-only" is exactly its product role).
  if (state && state.connected === false && !machineContentOnly) {
    return (
      <IdeDisconnected
        ideLabel={IDE_LABELS[selectedIde]}
        error={state.lastExtractionError ?? null}
      />
    );
  }
  if (!liveKey) {
    // Draft (created via + / New Agent, first message not yet sent): do not say "no open session" —
    // the session is right here, it just has no body yet. The text lives in the IDE composer (draftText);
    // the input will fill it in, so they can send directly.
    if (isDraftTab(viewedTab)) {
      return (
        <div className="tl-hint">
          {viewedTab?.draftText
            ? '新会话（草稿）—— 草稿里的文字已填进下方输入框，可以直接发送。'
            : '新会话（草稿）—— 在下方输入框发一条消息就能开始。'}
        </div>
      );
    }
    return (
      <div className="tl-hint">
        当前没有打开的会话 —— 从左侧选一台机器，或点窗口分组头部的 ＋ 新建会话。
      </div>
    );
  }

  const sourceUnavailable = state?.contentSource === 'unavailable';
  const retrySource = () => {
    const sessionId = liveKey.slice(liveKey.indexOf(':') + 1);
    // force: skip the server's missing cache and lookup cooldown; a user-initiated retry must actually ask the content source
    socket.emit('session:get', { sessionId, ide: selectedIde, force: true });
  };

  if (!body) {
    if (sessionMissing) {
      return (
        <SessionMissingNotice
          ideLabel={IDE_LABELS[selectedIde]}
          onRetry={retrySource}
        />
      );
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {sourceUnavailable && <SourceUnavailable reason={state?.lastExtractionError ?? '内容源读取失败'} onRetry={retrySource} />}
        <TimelineSkeleton />
      </div>
    );
  }
  if (segments.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {sourceUnavailable && <SourceUnavailable reason={state?.lastExtractionError ?? '内容源读取失败'} onRetry={retrySource} />}
        <div className="tl-hint">
          {sourceUnavailable ? '恢复后可继续浏览与发送' : '会话为空 —— 在下方输入框发一条消息试试。'}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sourceUnavailable && <SourceUnavailable reason={state?.lastExtractionError ?? '内容源读取失败'} onRetry={retrySource} />}
      {TIMELINE_PROBE_ON && <TimelineProbe keys={segKeys} />}
      <div
        ref={scrollRef}
        className="tl-scroll"
        onScroll={onScroll}
        onTouchStart={(e) => { userScrolledRef.current = true; touchStartYRef.current = e.touches[0]?.clientY ?? 0; }}
        onWheel={() => { userScrolledRef.current = true; }}
      >
        <div ref={listRef} className="tl-list">
          {/* Paint only the [sliceFrom, to) slice (keep slack in viewport units + stale-window cap); rhythm classes use full-body indices so expanding the window does not jump.
              Cap: when window indices fight, `to` may not be greater than `sliceFrom` (stale-anchor page-fill failed, prepend shift and seat write in the same frame),
              then paint at least one viewport — we have measured a full-screen blank of "body has 797 items, rendered 0". On the normal path max() does not change behavior. */}
          {segments.slice(sliceFrom, Math.max(to, Math.min(segments.length, sliceFrom + MIN_WINDOW_ITEMS))).map((seg, k) => (
            <div key={seg.key} data-key={seg.key} className={itemClassOf(segments, sliceFrom + k)}>
              <SegmentView seg={seg} pendingSends={pendingSends} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
