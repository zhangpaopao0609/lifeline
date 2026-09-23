import type { ScrollJump, ScrollSample } from '../lib/scroll-jump';
/**
 * Live scroll capture on a real device (**mounted only when the URL has `tltrace`**; otherwise not in the tree).
 *
 * Why it exists: timeline "keep sliding and it jumps" only happens on device (especially iOS/WeChat WKWebView);
 * it does not reproduce on desktop. Rather than guess, put the **criteria** in the user's hands:
 *  - sample each frame "item at viewport top + its offset from the viewport top" (see `lib/scroll-jump.ts`);
 *  - on a hit, pin both frames on the panel (`scrollTop`/`scrollHeight`/rendered count/inTop);
 *  - the panel also shows **the windowing decision at that instant** (`window.__tl`, see `tlTrace` in `Timeline.tsx`):
 *    whether it took extendUp or reclaim, and with what args, so they line up at a glance.
 *
 * Usage: append `&tltrace=1` to the console URL (e.g. `/console?m=…&ide=codebuddy&s=…&tltrace=1`),
 * reproduce once, then screenshot the panel — criteria, samples, and decisions on one screen; no more guessing "did it jump?".
 */
import { useEffect, useRef, useState } from 'react';
import { detectScrollJump } from '../lib/scroll-jump';

/** URL has `tltrace` (off when value is 0/false/off): read once at module load, then frozen. */
const flag = (() => {
  if (typeof location === 'undefined')
    return false;
  const m = /[?&]tltrace(?:=([^&]*))?/.exec(location.search);
  if (!m)
    return false;
  return !['0', 'false', 'off'].includes(m[1] ?? '1');
})();

export const TIMELINE_PROBE_ON = flag;

/** Sample-ring size: ~8 seconds at 60fps, enough to see the jump before and after. */
const RING = 480;
/** Max jumps kept on the panel. */
const KEEP_JUMPS = 3;

/** Element → stable id (same element is identical; for cross-frame compare; nothing written onto the DOM). */
const elIds = new WeakMap<Element, number>();
let elIdSeq = 0;
function elIdOf(el: Element): number {
  const hit = elIds.get(el);
  if (hit !== undefined)
    return hit;
  elIdSeq += 1;
  elIds.set(el, elIdSeq);
  return elIdSeq;
}

/** Vertical offset of an element relative to `.tl-list` (walk offsetParent; don't trust offsetTop alone). */
function relTop(el: Element, root: HTMLElement): number {
  let y = 0;
  let cur = el as HTMLElement | null;
  while (cur && cur !== root) {
    y += cur.offsetTop;
    cur = cur.offsetParent as HTMLElement | null;
  }
  return Math.round(y);
}

/**
 * Sample one frame: the top item (segment key) + **the deepest element at the top** (in-item coordinates).
 * The latter is the point: when content grows inside an item, the item's offsetTop is unchanged; only a deeper element moves.
 */
function samplePoint(sc: HTMLElement, list: HTMLElement): { key: string; el: Element | null; elTop: number } {
  const kids = list.children;
  if (kids.length === 0)
    return { key: '', el: null, elTop: -1 };
  let lo = 0;
  let hi = kids.length - 1;
  let top = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const el = kids[mid] as HTMLElement;
    if (el.offsetTop + el.offsetHeight > sc.scrollTop + 1) {
      top = mid;
      hi = mid - 1;
    }
    else {
      lo = mid + 1;
    }
  }
  const item = kids[top] as HTMLElement;
  const rect = sc.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = Math.min(Math.max(rect.top + 1, 1), window.innerHeight - 1);
  const hit = document.elementFromPoint(x, y);
  // Hit may be the item / list / scroll container itself (landing on whitespace): fall back to the item.
  const el = hit && hit !== list && hit !== sc && list.contains(hit) ? hit : item;
  return { key: item.dataset.key ?? '', el, elTop: relTop(el, list) };
}

function fmt(s: ScrollSample): string {
  return `st=${s.st} elTop=${s.elTop} sh=${s.sh} n=${s.n} ${s.key.slice(0, 10)}`;
}

function clock(t: number): string {
  const d = new Date(Date.now() - (performance.now() - t));
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** @param keys full-body segment keys (passed in by Timeline): the order criterion needs them; don't substitute sample history. */
export function TimelineProbe({ keys }: { keys: readonly string[] }) {
  const [jumps, setJumps] = useState<ScrollJump[]>([]);
  const [lastTrace, setLastTrace] = useState<string[]>([]);
  const [live, setLive] = useState<string>('');
  const ringRef = useRef<ScrollSample[]>([]);
  const jumpRef = useRef<ScrollJump[]>([]);
  const orderRef = useRef<ReadonlyMap<string, number>>(new Map());
  orderRef.current = new Map(keys.map((k, i) => [k, i]));

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const sc = document.querySelector('.tl-scroll') as HTMLElement | null;
      const list = sc?.querySelector('.tl-list') as HTMLElement | null;
      if (sc && list) {
        const { key, el, elTop } = samplePoint(sc, list);
        const cur: ScrollSample = {
          t: Math.round(performance.now()),
          st: Math.round(sc.scrollTop),
          sh: sc.scrollHeight,
          n: list.children.length,
          key,
          elId: el ? elIdOf(el) : 0,
          elTop,
        };
        const ring = ringRef.current;
        const prev = ring[ring.length - 1];
        if (prev) {
          const jump = detectScrollJump(prev, cur, orderRef.current);
          if (jump) {
            const next = [jump, ...jumpRef.current].slice(0, KEEP_JUMPS);
            jumpRef.current = next;
            setJumps(next);
            const tl = (window as unknown as { __tl?: unknown[] }).__tl ?? [];
            setLastTrace(
              tl
                .filter(e => Math.abs((e as [number])[0] - jump.t) < 400)
                .map(e => JSON.stringify(e).slice(0, 150)),
            );
          }
        }
        ring.push(cur);
        if (ring.length > RING)
          ring.shift();
        setLive(fmt(cur));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const last = jumps[0];
  return (
    <div className="tl-probe" role="status">
      <div className="tl-probe-head">
        时间线采样 · 跳
        {' '}
        {jumps.length}
        {' '}
        次
        {last ? ` · ${clock(last.t)}` : ''}
      </div>
      <div>
        现在
        {live || '（还没采到）'}
      </div>
      {last
        ? (
            <>
              <div>
                跳前 [
                {last.kind}
                ]
                {' '}
                {fmt(last.from)}
              </div>
              <div>
                跳后 [
                {last.kind}
                ]
                {' '}
                {fmt(last.to)}
              </div>
              <div>决策：</div>
              {lastTrace.slice(0, 6).map((line, i) => (
                <div key={i} className="tl-probe-line">
                  {line}
                </div>
              ))}
            </>
          )
        : (
            <div>还没命中（没往上滑却：条内内容往下挪 / 退到更早的块 / 退到更早的条）</div>
          )}
    </div>
  );
}
