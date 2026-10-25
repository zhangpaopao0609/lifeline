import type { ComponentPropsWithoutRef } from 'react';
import type { ListRange, VirtuosoHandle } from 'react-virtuoso';
import type { PagingState } from '../lib/timeline-paging';
import type { TlSnapshot } from '../lib/timeline-persist';
import type { Segment } from './timeline-segments';
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { markWork } from '../lib/cursor-activity';
import { pillCount } from '../lib/new-message-pill';
import { shouldPageAtTop, shouldPrefetch } from '../lib/timeline-paging';
import { canRestore, loadSnapshot, saveSnapshot } from '../lib/timeline-persist';
import { segmentsPrepended } from '../lib/timeline-window';
import { parseIde } from '../net/protocol';
import { socket } from '../net/socket';
import { useSessionsStore } from '../store/sessions';
import { FoldedSegment, itemClassOf, segmentize } from './timeline-segments';

/**
 * PoC: the timeline rendered by react-virtuoso (chat-oriented bidirectional virtual list).
 *
 * Same data path as `Timeline` (store bodies → segmentize → SegmentView), a different scroll architecture:
 *  - measured item heights + top/bottom spacers → **scrollbar reflects the whole loaded body**, not just the render window;
 *  - prepending an earlier page = `firstItemIndex` delta protocol → the library re-anchors internally (no manual scrollTop math);
 *  - `followOutput` = stick-to-bottom while new items arrive; `initialTopMostItemIndex` = open at the session end;
 *  - window positioning happens inside the spacer, so no `scrollTop` writes during inertia (the iOS/WeChat dead zone);
 *  - read position persists across session switches (in-memory) and reloads (sessionStorage, head-match guarded).
 *
 * Not in this PoC (design-doc items): absolute fast-scroll over the whole history.
 */

/** firstItemIndex must stay positive (library contract); start high and decrement by the prepended segment count. */
const FIRST_INDEX_BASE = 1_000_000;

/** Rough first-guess item height: most segments are one-line tool/assistant rows; measurements refine immediately. */
const DEFAULT_ITEM_HEIGHT = 48;

/** Pixel overscan around the viewport (render a bit before/after, so fast scrolls don't flash blanks). */
const OVERSCAN_PX = 600;

/** Paging re-arm distance: after a page fires, scrolling below this re-arms (anti chain-drag). */
const REARM_PX = 50;

/**
 * Production default for `onMaybePage`: resolve the cursor from the store and emit `session:get { before }` —
 * the exact shape the pre-refactor Timeline used. A default is REQUIRED: the production `Timeline` wrapper
 * mounts the core without the prop, and a bare `onMaybePage = undefined` made every paging decision a silent
 * no-op (found in the production deployment test: hasMore session, gesture armed, stuck at top, nothing fired).
 * Harness/tests pass their own scripted handler and keep working unchanged.
 */
function defaultOnMaybePage(sessionKey: string): void {
  const req = useSessionsStore.getState().beginEarlier(sessionKey);
  if (!req)
    return;
  const ide = parseIde(sessionKey.slice(0, sessionKey.indexOf(':')));
  const sessionId = sessionKey.slice(sessionKey.indexOf(':') + 1);
  socket.emit('session:get', { sessionId, ide, before: req.before });
}

/**
 * The virtuoso list element carries the legacy `.tl-list` class — `TimelineProbe.relTop` walks offsetParent
 * up to `.tl-list`, and rhythm CSS may target it.
 */
const TlList = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>((props, ref) => (
  <div {...props} ref={ref} className={`tl-list ${props.className ?? ''}`} />
));

/** "Load earlier" affordance at the head of loaded data (the missing paging indicator in the current UI). */
function LoadEarlierHeader() {
  return (
    <div className="content-col px-4 py-2 text-center text-[length:var(--text-chrome)] text-[var(--text-weak)]">
      ↑ 上滑加载更早
    </div>
  );
}

export interface TimelineVirtuosoProps {
  /** `sessionBodyKey(ide, sessionId)` — the body this timeline renders. Remount per session (key={...}) in production. */
  sessionKey: string;
  /** Grab the imperative handle (scrollToIndex / getState) — harness and tests use it. */
  bindHandle?: (handle: VirtuosoHandle | null) => void;
  /** Grab the scroller element (the Timeline wrapper uses it for send-to-bottom). */
  bindScroller?: (el: HTMLElement | null) => void;
  /** "Might need an earlier page" (scrolled to the start of loaded data). Honor only with a user gesture by default. */
  onMaybePage?: () => void;
  /** false = fire onMaybePage without requiring a user gesture (harness scripting; production keeps the gate). */
  pageGate?: boolean;
}

export function TimelineVirtuoso({ sessionKey, bindHandle, bindScroller, onMaybePage, pageGate = true }: TimelineVirtuosoProps) {
  const body = useSessionsStore(s => (sessionKey ? s.bodies[sessionKey] : undefined));
  const pendingSends = useSessionsStore(s => s.pendingSends);
  const hasMore = useSessionsStore(s => (sessionKey ? s.pageMeta[sessionKey]?.hasMore === true : false));

  const prevSegmentsRef = useRef<Segment[] | undefined>(undefined);
  const segments = useMemo(() => {
    const next = segmentize(body ?? [], prevSegmentsRef.current);
    prevSegmentsRef.current = next;
    return next;
  }, [body]);
  /** `sessionKey` is `${ide}:${sessionId}` (store/sessions sessionBodyKey). */
  const ide = useMemo(() => parseIde(sessionKey.split(':', 1)[0]), [sessionKey]);
  const marks = useMemo(() => markWork(segments, ide), [segments, ide]);
  const [workOpen, setWorkOpen] = useState<Record<string, boolean>>({});
  const toggleWork = useCallback((groupId: string) => {
    setWorkOpen((prev) => {
      const active = marks.some(mark => mark?.head?.id === groupId && mark.head.active);
      const currently = groupId in prev ? prev[groupId] : active;
      return { ...prev, [groupId]: !currently };
    });
  }, [marks]);
  const workIsOpen = useCallback((groupId: string) => {
    if (groupId in workOpen)
      return workOpen[groupId];
    return marks.some(mark => mark?.head?.id === groupId && mark.head.active);
  }, [marks, workOpen]);

  /** Paging only after a real gesture — otherwise "opened and settled at top" would auto-drag the whole history. */
  const userTouchedRef = useRef(false);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  /** Follow-state of the view (pill clearing + overscroll tail guard). */
  const atBottomRef = useRef(true);
  /**
   * Paging trigger (pure decisions in lib/timeline-paging), evaluated on every **scroll event**:
   *  - at the loaded head → page now (shouldPageAtTop);
   *  - approaching it (range.start close / scrollTop near 0) → prefetch (shouldPrefetch).
   *
   * Not `atTopStateChange`/`rangeChanged` as triggers: the first only fires on *transitions* (a gated arrival
   * at the top would never re-arm — "keep pulling up" would dead-end), the second only when the render range
   * changes* (overscan often already covers the head, so it never fires at all). Measured in the harness.
   *
   * Anti auto-drag: firing disarms until the user leaves the top (scrollTop > REARM_PX) — the prepend's own
   * position-correction scrollTop write would otherwise immediately chain the next page. The gesture gate
   * (`userScrolled`) stays authoritative for "did a human ask for this".
   */
  /** Explicit prop wins (harness scripts its own); otherwise the production fetch above. */
  const maybePageFn = onMaybePage ?? (() => defaultOnMaybePage(sessionKey));
  const maybePageRef = useRef(maybePageFn);
  maybePageRef.current = maybePageFn;
  const pageGateRef = useRef(pageGate);
  pageGateRef.current = pageGate;
  const rangeStartRef = useRef(Number.MAX_SAFE_INTEGER);
  const armedRef = useRef(true);
  const pageState = (): PagingState => ({
    atLoadedHead: (scrollerElRef.current?.scrollTop ?? 1) <= 1,
    hasMore: useSessionsStore.getState().pageMeta[sessionKey]?.hasMore === true,
    userScrolled: userTouchedRef.current,
    rangeStart: rangeStartRef.current,
  });
  const onScrollPaging = () => {
    const sc = scrollerElRef.current;
    if (!sc)
      return;
    if (sc.scrollTop > REARM_PX)
      armedRef.current = true;
    if (!armedRef.current)
      return;
    if (pageGateRef.current) {
      const s = pageState();
      if (!shouldPageAtTop(s) && !shouldPrefetch(s))
        return;
    }
    armedRef.current = false;
    maybePageRef.current?.();
  };
  const onScrollPagingRef = useRef(onScrollPaging);
  onScrollPagingRef.current = onScrollPaging;
  /**
   * Read-position capture, trailing-debounced on scroll. Unmount-time capture is impossible: React nulls the
   * ref before passive cleanups run (measured: sessionStorage never written). Scroll-driven capture also
   * covers data-driven moves — followOutput and the prepend correction both write scrollTop, which fires
   * scroll events — so the in-memory snapshot is at most one debounce window stale.
   */
  const PERSIST_DEBOUNCE_MS = 300;
  const persistTimerRef = useRef(0);
  /** Topmost visible segment (key + viewport offset) — the restore target for persistence and the prepend correction. */
  const captureAnchor = () => {
    const sc = scrollerElRef.current;
    if (!sc)
      return null;
    const sr = sc.getBoundingClientRect();
    for (const el of Array.from(sc.querySelectorAll<HTMLElement>('[data-key]'))) {
      if (el.getBoundingClientRect().bottom > sr.top + 1)
        return { key: el.dataset.key ?? '', offset: Math.round(el.getBoundingClientRect().top - sr.top) };
    }
    return null;
  };
  const capturePosition = useCallback(() => {
    const anchor = captureAnchor();
    const b = useSessionsStore.getState().bodies[sessionKey];
    if (!anchor || !b || b.length === 0)
      return;
    saveSnapshot(sessionKey, { headId: b[0].id, anchorKey: anchor.key, anchorOffset: anchor.offset });
  }, [sessionKey]);
  const schedulePersist = useCallback(() => {
    window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(capturePosition, PERSIST_DEBOUNCE_MS);
  }, [capturePosition]);
  const schedulePersistRef = useRef(schedulePersist);
  schedulePersistRef.current = schedulePersist;
  const bindScrollerRef = useRef(bindScroller);
  bindScrollerRef.current = bindScroller;
  /**
   * Overscroll containment (touch): iOS/WKWebView (incl. WeChat) either lacks `overscroll-behavior` chaining
   * or only blocks the container itself — pulling past either end chains the scroll to the page (the shell
   * bounces; WeChat pulls down its domain bar). Eat the touchmove only at a TRUE edge: at the head with
   * nothing earlier to load, or at the bottom. React's onTouchMove is passive, hence the manual listener.
   */
  const touchStartYRef = useRef(0);
  const onTouchMoveGuard = useCallback((e: TouchEvent) => {
    const sc = scrollerElRef.current;
    if (!sc || e.touches.length !== 1)
      return;
    const dy = (e.touches[0]?.clientY ?? 0) - touchStartYRef.current;
    if (dy === 0)
      return;
    const hasMore = useSessionsStore.getState().pageMeta[sessionKey]?.hasMore === true;
    const headEdge = sc.scrollTop <= 1 && !hasMore;
    const tailEdge = atBottomRef.current;
    if ((dy > 0 && headEdge) || (dy < 0 && tailEdge))
      e.preventDefault();
  }, [sessionKey]);
  const touchGuardRef = useRef(onTouchMoveGuard);
  touchGuardRef.current = onTouchMoveGuard;
  /**
   * Identity-stable on purpose: the library re-publishes `scrollerRef` on every parent re-render and calls
   * it with null then the same element — with a per-render identity that re-fired the null-out branch below
   * and re-attached all listeners per re-render (measured: listener count grows linearly in a streaming
   * session). Stable identity ⇒ null arrives only at a true unmount.
   */
  const scrollerRef = useCallback((el: HTMLElement | Window | null) => {
    if (!el) {
      scrollerElRef.current = null; // true unmount only: post-unmount corrections no-op
      bindScrollerRef.current?.(null);
      return;
    }
    if (el === scrollerElRef.current)
      return;
    scrollerElRef.current = el as HTMLElement;
    bindScrollerRef.current?.(scrollerElRef.current);
    // Narrow to HTMLElement so the typed event-map overloads apply — the `HTMLElement | Window` union
    // collapses to the generic `EventListener` overload, which rejects `(e: TouchEvent)` under strictFunctionTypes.
    const node = el as HTMLElement;
    node.addEventListener('touchstart', (e: TouchEvent) => {
      userTouchedRef.current = true;
      touchStartYRef.current = e.touches[0]?.clientY ?? 0;
    }, { passive: true });
    el.addEventListener('wheel', () => { userTouchedRef.current = true; }, { passive: true });
    el.addEventListener('scroll', () => {
      onScrollPagingRef.current();
      schedulePersistRef.current();
    }, { passive: true });
    node.addEventListener('touchmove', (e: TouchEvent) => touchGuardRef.current(e), { passive: false });
  }, []);

  /**
   * Deferred correction writes (prepend fine-tune / restore fine-tune) must not land during iOS/WKWebView
   * inertial scrolling — those writes are silently ignored there and the user sees a jump. Single slot:
   * a correction scheduled while another is pending replaces it (the last correction wins; both are
   * keyed exact writes, so the residual is bounded by one item's height).
   */
  const scrollingRef = useRef(false);
  const pendingCorrectionRef = useRef<(() => void) | null>(null);
  const correctionTimerRef = useRef(0);
  const runPendingCorrection = useCallback(() => {
    const fn = pendingCorrectionRef.current;
    pendingCorrectionRef.current = null;
    fn?.();
  }, []);
  /** Stable library callbacks (identity churn re-publishes their internal subscriptions on every render). */
  const onIsScrolling = useCallback((scrolling: boolean) => {
    scrollingRef.current = scrolling;
    if (!scrolling)
      runPendingCorrection();
  }, [runPendingCorrection]);
  const onRangeChanged = useCallback((range: ListRange) => {
    rangeStartRef.current = range.startIndex;
  }, []);
  /** Schedule an exact scrollTop write after the library's own post-scrollToIndex corrections settle; yield to inertia. */
  const scheduleCorrection = useCallback((fineTune: () => void, delayMs: number) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.clearTimeout(correctionTimerRef.current);
      correctionTimerRef.current = window.setTimeout(() => {
        if (scrollingRef.current) {
          pendingCorrectionRef.current = fineTune; // inertial scroll: write after it stops
          // Safety: never force an exact write mid-gesture (desktop: yanks the viewport; iOS: swallowed
          // AND consumes the slot). Re-check on each expiry and keep waiting while still scrolling.
          const safety = () => {
            if (scrollingRef.current) {
              correctionTimerRef.current = window.setTimeout(safety, 800);
              return;
            }
            runPendingCorrection();
          };
          correctionTimerRef.current = window.setTimeout(safety, 800);
        }
        else {
          fineTune();
        }
      }, delayMs);
    }));
  }, [runPendingCorrection]);
  /**
   * Clear the pending timers on unmount. The rAF chains themselves are not cancellable here — a rAF that
   * fires post-unmount schedules one more timer whose fine-tune writes to a detached element (measured
   * benign: getBoundingClientRect returns 0 on detached nodes, the write is a no-op).
   */
  useEffect(() => () => {
    window.clearTimeout(persistTimerRef.current);
    window.clearTimeout(correctionTimerRef.current);
  }, []);

  /**
   * Prepend protocol: when an earlier page lands, the body grows at the head. `firstItemIndex` must drop by the
   * prepended **segment** count in the same commit as the data change, or the library treats it as a replace and
   * the viewport jumps.
   *
   * The delta is computed in a **store subscription** (not during render): zustand notifies synchronously inside
   * `setState`, so the queued `setFirstItemIndex` batches with the store-driven re-render into one commit — the
   * same contract as the library's "same event handler" example. A render-phase update is NOT equivalent: under
   * StrictMode's double render the queued update is lost (measured in the harness: firstItemIndex never moved).
   * Displacement itself is `segmentsPrepended` (segment units, tool-run joining handled).
   */
  const [firstItemIndex, setFirstItemIndex] = useState(FIRST_INDEX_BASE);
  /**
   * Exact-anchor correction, scoped to the prepend moment only.
   *
   * The library shifts the viewport by the **estimated** height of the prepended items (defaultItemHeight each);
   * real chat items are markdown-heavy, so a 60-segment page can drift by thousands of px and push the reading
   * position out of the render window (measured: anchor item unmounted, drift 'LOST'). Fix: capture the topmost
   * visible item (key + viewport offset) synchronously in the subscription — the DOM still shows the pre-prepend
   * state there — then after the commit force-render the anchor (`scrollToIndex`) and fine-tune the residual with
   * one exact `scrollTop` write. This is ~30 lines instead of the current Timeline's whole scroll machine, and it
   * never runs during scroll — only when a page arrives over the network.
   */
  const pendingAnchorRef = useRef<{ key: string; offset: number } | null>(null);
  useEffect(() => {
    let prevBody = useSessionsStore.getState().bodies[sessionKey];
    return useSessionsStore.subscribe((s) => {
      const nextBody = s.bodies[sessionKey];
      if (!nextBody || nextBody === prevBody)
        return;
      const prevHeadId = prevBody?.[0]?.id ?? '';
      const prepended = segmentsPrepended(nextBody, prevHeadId);
      prevBody = nextBody;
      if (prepended > 0) {
        pendingAnchorRef.current = captureAnchor();
        setFirstItemIndex(f => f - prepended);
      }
    });
  }, [sessionKey]);

  /** Restore the reading position after a prepended page lands (see pendingAnchorRef). */
  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    if (!pending || segments.length === 0)
      return;
    pendingAnchorRef.current = null;
    const at = segments.findIndex(s => s.key === pending.key);
    const h = virtuosoRef.current;
    const sc = scrollerElRef.current;
    if (at < 0 || !h || !sc)
      return; // anchor merged away (tool-run join) or wholesale replace: fall back to protocol behavior
    h.scrollToIndex({ index: at, align: 'start', behavior: 'auto' });
    // The library keeps adjusting scrollTop for a few frames after scrollToIndex (its own measurement
    // corrections — and they ignore a visible Header above item 0, measured: -35px residual when the
    // "load earlier" header is present). Apply our exact offset after those settle, yielding to inertia.
    scheduleCorrection(() => {
      const el = sc.querySelector(`[data-key="${CSS.escape(pending.key)}"]`);
      if (!el)
        return;
      const actual = (el as HTMLElement).getBoundingClientRect().top - sc.getBoundingClientRect().top;
      sc.scrollTop += actual - pending.offset;
    }, 150);
  }, [segments, scheduleCorrection]);

  /**
   * Read-position restore (mount-time, anchor-based — same primitives as the prepend correction):
   * `initialTopMostItemIndex` lands the anchor segment at the viewport top, then one exact correction
   * restores its recorded offset. react-virtuoso's own `restoreStateFrom` snapshot was measured unusable
   * under our `firstItemIndex` protocol (restored size-ranges balloon the estimated list ~2×; the viewport
   * ends at 0 or the bottom of the wrong height). A useState initializer restores in one shot when the body
   * is cached (SPA session switch, no first-frame flash); a cold reload's tail-only body fails `canRestore`
   * → bottom open.
   */
  const [restorePlan] = useState<TlSnapshot | null>(() => {
    const snap = loadSnapshot(sessionKey);
    const b = useSessionsStore.getState().bodies[sessionKey];
    return canRestore(snap, b) ? snap! : null;
  });
  const restoreAppliedRef = useRef(false);

  /** Open at the session end (chat semantics); computed once — later data changes go through followOutput. */
  const [initialIndex] = useState(() => ({ index: Math.max(0, segments.length - 1), align: 'end' as const }));

  /** Persist immediately when the page is being hidden (screen-off / navigation) — no debounce. */
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden)
        capturePosition();
    };
    const onPageHide = () => capturePosition();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [sessionKey, capturePosition]);

  /**
   * Read-position restore, DELAYED past the library's init: scrollToIndex is a no-op in the mount commit
   * (internal size system not ready — measured: st stayed 0), and `initialTopMostItemIndex`-based restore
   * corrupts the size system on giant rows (measured: sh 28738 → 35732). So: open at the bottom
   * (deterministic), then ~RESTORE_DELAY_MS later jump to the anchor with the proven prepend-correction
   * primitives. Cost: a visible bottom→anchor transition on session switch; revisit with
   * `totalListHeightChanged`-gated timing during the real-device pass.
   */
  useLayoutEffect(() => {
    if (!restorePlan || segments.length === 0 || restoreAppliedRef.current)
      return;
    const h = virtuosoRef.current;
    if (!h)
      return;
    const apply = () => {
      // The scroller element is NOT attached at layout-effect time (the library wires its scrollerRef
      // asynchronously relative to React's ref attach — measured in the harness); by now it is.
      const sc = scrollerElRef.current;
      if (!sc)
        return;
      const at = segments.findIndex(s => s.key === restorePlan.anchorKey);
      if (at < 0)
        return; // anchor merged away (tool-run join): stay at the bottom open
      restoreAppliedRef.current = true; // set HERE (after guards): StrictMode's cleanup+re-run must be able to re-schedule
      h.scrollToIndex({ index: at, align: 'start', behavior: 'auto' });
      scheduleCorrection(() => {
        const el = sc.querySelector(`[data-key="${CSS.escape(restorePlan.anchorKey)}"]`);
        if (!el)
          return;
        const actual = (el as HTMLElement).getBoundingClientRect().top - sc.getBoundingClientRect().top;
        sc.scrollTop += actual - restorePlan.anchorOffset;
      }, 150);
    };
    const t = window.setTimeout(apply, 300);
    return () => window.clearTimeout(t);
  }, [segments, restorePlan, scheduleCorrection]);

  /**
   * New-message pill: segments appended while the view is away from the bottom accumulate into a
   * floating count; clicking it (or reaching the bottom) clears it. `pillCount` is the pure reducer.
   * Only **tail appends** count — a prepended history page keeps the previous tail as the last item,
   * and a wholesale replace drops it entirely; neither is "new messages arriving".
   * Known rare edge (reviewer-verified): a mixed commit (earlier page + tail append in ONE store
   * notification) counts `grew` including the prepended segments — overcount-only; the precise count
   * would be `segments.length - 1 - segments.findIndex(s => s.key === prevLast)`.
   */
  const [pill, setPill] = useState(0);
  const prevSegLenRef = useRef(segments.length);
  const prevLastKeyRef = useRef(segments[segments.length - 1]?.key ?? '');
  useLayoutEffect(() => {
    const prevLen = prevSegLenRef.current;
    const prevLast = prevLastKeyRef.current;
    prevSegLenRef.current = segments.length;
    prevLastKeyRef.current = segments[segments.length - 1]?.key ?? '';
    const grew = segments.length - prevLen;
    const lastKey = segments[segments.length - 1]?.key ?? '';
    const isTailAppend = grew > 0 && prevLast !== '' && prevLast !== lastKey && segments.some(s => s.key === prevLast);
    if (isTailAppend)
      setPill(p => pillCount(pillCount(p, { type: 'append', n: grew }), { type: 'bottom', atBottom: atBottomRef.current }));
  }, [segments]);
  const onAtBottomChange = useCallback((atBottom: boolean) => {
    atBottomRef.current = atBottom;
    if (atBottom)
      setPill(p => pillCount(p, { type: 'bottom', atBottom: true }));
  }, []);

  // `components` must stay an object — passing `undefined` overwrites the library's internal default {} and crashes it.
  // Memoized: a fresh object each render would churn the library's component-context subscribers.
  const components = useMemo(
    () => ({ Header: hasMore ? LoadEarlierHeader : undefined, List: TlList }),
    [hasMore],
  );

  if (!body || segments.length === 0)
    return null;

  return (
    <div className="relative flex min-h-0 flex-1">
      <Virtuoso
        ref={(r) => { virtuosoRef.current = r; bindHandle?.(r ?? null); }}
        data={segments}
        computeItemKey={(_, seg) => seg.key}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={initialIndex}
        followOutput={isAtBottom => (isAtBottom ? 'auto' : false)}
        atBottomStateChange={onAtBottomChange}
        // iOS/WKWebView ignores scrollTop writes during inertial scrolling: the deferred correction
        // (scheduleCorrection) queues through this signal instead of writing into the void.
        isScrolling={onIsScrolling}
        // rangeChanged only feeds rangeStartRef (prefetch proximity input); the paging trigger itself is the
        // scroll listener (see onScrollPaging) — see the comment there for why the library callbacks don't gate.
        rangeChanged={onRangeChanged}
        defaultItemHeight={DEFAULT_ITEM_HEIGHT}
        increaseViewportBy={{ top: OVERSCAN_PX, bottom: OVERSCAN_PX }}
        minOverscanItemCount={3}
        className="tl-scroll"
        style={{ flex: 1, minHeight: 0 }}
        scrollerRef={scrollerRef}
        components={components}
        itemContent={(index, seg) => {
          // The library's index is ABSOLUTE (offset by firstItemIndex under the prepend protocol);
          // itemClassOf needs the position within the current segments array.
          const local = index - firstItemIndex;
          const mark = marks[local];
          const open = mark ? workIsOpen(mark.groupId) : true;
          if (mark && !mark.head && !open)
            return <div data-key={seg.key} />;
          return (
            <div data-key={seg.key} className={itemClassOf(segments, local)}>
              <FoldedSegment
                seg={seg}
                mark={mark}
                open={open}
                onToggle={toggleWork}
                pendingSends={pendingSends}
                ide={ide}
              />
            </div>
          );
        }}
      />
      {pill > 0 && (
        <button
          type="button"
          className="btn btn-primary absolute bottom-3 right-4 z-10 rounded-full px-3.5 py-1.5 shadow-md"
          onClick={() => {
            setPill(p => pillCount(p, { type: 'seen' }));
            const sc = scrollerElRef.current;
            if (sc)
              sc.scrollTop = sc.scrollHeight;
          }}
        >
          {pill > 1 ? `${pill} 条新消息` : '回到底部'}
        </button>
      )}
    </div>
  );
}
