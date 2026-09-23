/**
 * Pure computation for the timeline render window (unit-testable).
 *
 * Timeline window indices (`winFrom` / `winTo` / `len`) are all **segment** indices — segments are cut from
 * the body by `segmentize`, and consecutive tools merge into one segment. Anywhere that treats "item count"
 * as a displacement must convert to segments, or the window jumps a whole segment (see `segmentsPrepended`).
 */
import type { ChatElement } from '../net/protocol';

/**
 * A tool following the previous item in the same segment is not a new segment start (same rule as `segmentize` in `Timeline.tsx`).
 */
function isSegmentStart(body: ChatElement[], i: number): boolean {
  return !(body[i].type === 'tool' && body[i - 1]?.type === 'tool');
}

/**
 * How many **segments** an earlier page prepended: the first item of the previous body's frame was pushed to index `at`
 * in the new body; counting segments before it is the displacement.
 *
 * ⚠️ **Do not use the store's `prependedItems` (count of prepended elements) as displacement**: consecutive tools
 * merge into one segment, so the two units are not equivalent (measured: a 60-item page with 59 tools → 59 elements, 23 segments).
 * Over-counting displacement makes "the window jump a whole segment forward": the row being read is pushed out of the
 * render window → the anchor dies → position is lost, and the window collapses to the last item (`from` clamped to `len-1`),
 * then immediately `atBottom` pins it to the session end — on a phone that feels like "keep sliding and it jumps back up, never reach the bottom".
 */
export function segmentsPrepended(body: ChatElement[], prevHeadId: string): number {
  if (!prevHeadId)
    return 0;
  const at = body.findIndex(m => m.id === prevHeadId);
  // -1 = full replace (old first item is no longer in the body), 0 = nothing prepended: both count as zero displacement; window indices are held by clamping `from`.
  if (at <= 0)
    return 0;
  let n = 0;
  for (let i = 0; i < at; i++) {
    if (isSegmentStart(body, i))
      n += 1;
  }
  // Prefix ends on a tool and the joining item is also a tool: they belong to one segment (segment key is the first of the run); decrement the segment count.
  return body[at - 1]?.type === 'tool' && body[at]?.type === 'tool' ? Math.max(0, n - 1) : n;
}
