/**
 * Criteria for scroll feel (pure functions, unit-testable).
 *
 * Background: the timeline is "native scroll + window-by-viewport". Expand / reclaim / prepend all change DOM
 * height; **precise anchors** (`applyRead`: pin the item at the viewport top back to its previous offset) hide
 * the displacement. So "did it jump?" cannot look at `scrollTop` — reclaim/expand are designed to change it;
 * that displacement is visible by design.
 *
 * The real criterion is only "position went backward", but the **anchor must be taken inside the item**:
 * watching only the item (`.tl-item`) misses the most common case — content **above the viewport** grew
 * (iOS/WeChat have no native overflow-anchor, nobody compensates), the item's offsetTop is unchanged, but
 * what the user sees slides down as a block. Sampling therefore takes the **deepest element at the viewport
 * top** (`document.elementFromPoint`); its `offsetTop` is necessarily below the grown stretch.
 *
 * Criteria (all assume "this frame did not scroll up"):
 *  1. Same element, `st - offsetTop` got smaller → content above it grew (or something was inserted);
 *  2. Switched to another element that is further up (smaller offsetTop) → the view receded to an earlier position;
 *  3. The top item became an **earlier** one (segment order went backward) → the whole item jumped back.
 */
export interface ScrollSample {
  /** performance.now() truncated to an integer. */
  t: number;
  /** Container scrollTop. */
  st: number;
  /** Container scrollHeight. */
  sh: number;
  /** Number of rendered children. */
  n: number;
  /** Segment key of the item pinned at the viewport top. */
  key: string;
  /** Stable id of the deepest element at the viewport top (same element is identical; the probe issues ids via WeakMap). */
  elId: number;
  /** That element's offsetTop relative to `.tl-list`. */
  elTop: number;
}

export type ScrollJumpKind = 'content' | 'back' | 'item';

export interface ScrollJump {
  t: number;
  kind: ScrollJumpKind;
  key: string;
  from: ScrollSample;
  to: ScrollSample;
}

/** Pixel slack: slow scrolling / truncation / zoom all add a few pixels of noise. */
const IN_ITEM_EPS = 20;

/**
 * Whether this frame "did not scroll up, but position went backward".
 *
 * @param prev sample from the frame before
 * @param cur sample from this frame
 * @param order segment key → index of that segment in the **full body** (Timeline already has this; don't substitute
 *              "seen in history": that would miss the most typical jump-back, "top item became an earlier one")
 */
export function detectScrollJump(
  prev: ScrollSample,
  cur: ScrollSample,
  order: ReadonlyMap<string, number>,
): ScrollJump | null {
  // Scrolling up (including programmatic settle) is not a jump: paging history would otherwise hit the criteria below.
  if (cur.st < prev.st)
    return null;
  if (prev.elId === 0 || cur.elId === 0)
    return null; // no element sampled (empty window)

  if (prev.elId === cur.elId) {
    const drop = (prev.st - prev.elTop) - (cur.st - cur.elTop);
    if (drop > IN_ITEM_EPS)
      return { t: cur.t, kind: 'content', key: cur.key, from: prev, to: cur };
  }
  else if (cur.elTop < prev.elTop - IN_ITEM_EPS) {
    return { t: cur.t, kind: 'back', key: cur.key, from: prev, to: cur };
  }

  if (cur.key && prev.key && cur.key !== prev.key) {
    const a = order.get(prev.key);
    const b = order.get(cur.key);
    if (a !== undefined && b !== undefined && b < a) {
      return { t: cur.t, kind: 'item', key: cur.key, from: prev, to: cur };
    }
  }
  return null;
}
