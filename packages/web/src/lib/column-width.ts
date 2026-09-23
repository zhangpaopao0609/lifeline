/**
 * Desktop three-column widths (split-handle drag, 2026-09-20).
 *
 * - Default width = original three columns (240 / 280): anyone who hasn't dragged sees the same as before.
 * - Drag has bounds: hard min/max + viewport share + "main pane keeps at least MAIN_MIN_WIDTH" can all tighten the max —
 *   "you can drag, but not too far" is guaranteed by these three together; a narrow window won't squeeze the timeline column away.
 * - Stored only in localStorage (same idea as window order): stays in this browser, never goes to the server.
 *
 * Pure functions, no window (viewport width is passed in), unit-testable.
 */
export type ColumnKind = 'rail' | 'sess';

export interface ColumnBounds {
  min: number;
  max: number;
}

export const COLUMN_STORAGE_PREFIX = 'ar:columnWidth:';

/** Never dragged: matches the original `.shell-desktop` grid column widths. */
export const COLUMN_DEFAULT_WIDTH: Record<ColumnKind, number> = { rail: 240, sess: 280 };

/** Hard bounds — the max is the right answer for "don't drag too far": rail just fits hostname / IDE rows; sess leaves room for long titles. */
export const COLUMN_LIMITS: Record<ColumnKind, ColumnBounds> = {
  rail: { min: 200, max: 320 },
  sess: { min: 220, max: 420 },
};

/** Minimum width of the main pane (timeline + input): the first two columns cannot squeeze it away no matter how wide they get. */
export const MAIN_MIN_WIDTH = 480;

/** Viewport-share cap: only a wide screen may drag to the hard max; a narrower window scales down proportionally. */
const VIEWPORT_SHARE: Record<ColumnKind, number> = { rail: 0.25, sess: 0.4 };

/** Currently available range: subtract the other two columns (the other column + main pane) first; what's left is how far you can drag. */
export function columnBounds(kind: ColumnKind, viewportWidth: number, otherWidth: number): ColumnBounds {
  const hard = COLUMN_LIMITS[kind];
  const cap = Math.min(
    hard.max,
    Math.floor(viewportWidth * VIEWPORT_SHARE[kind]),
    Math.floor(viewportWidth - otherWidth - MAIN_MIN_WIDTH),
  );
  // In a narrow window cap may fall below min: min is the floor; better the main pane takes a hit (can't drag) than it disappears.
  return { min: hard.min, max: Math.max(hard.min, cap) };
}

export function clampColumnWidth(px: number, bounds: ColumnBounds): number {
  if (!Number.isFinite(px))
    return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(px)));
}

export function columnStorageKey(kind: ColumnKind): string {
  return `${COLUMN_STORAGE_PREFIX}${kind}`;
}

/** Unreadable / not a positive number counts as never stored (fall back to default width). storage is injected for tests. */
export function loadColumnWidth(storage: Pick<Storage, 'getItem'>, kind: ColumnKind): number | null {
  try {
    const raw = storage.getItem(columnStorageKey(kind));
    if (!raw)
      return null;
    const px = Number(raw);
    return Number.isFinite(px) && px > 0 ? px : null;
  }
  catch {
    return null;
  }
}

export function saveColumnWidth(storage: Pick<Storage, 'setItem'>, kind: ColumnKind, px: number): void {
  storage.setItem(columnStorageKey(kind), String(Math.round(px)));
}
