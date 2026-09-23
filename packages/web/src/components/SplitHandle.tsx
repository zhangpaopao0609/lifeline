import type { ColumnBounds } from '../lib/column-width';
import { useEffect, useRef } from 'react';
import { clampColumnWidth } from '../lib/column-width';

/** Arrow-key step (Shift takes a larger step). */
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

export interface SplitHandleProps {
  /** Accessible name / tooltip: which column this seam resizes. */
  label: string;
  /** Positioning (`left` reads a CSS variable, see tokens.css): split-rail / split-sess. */
  className: string;
  /** Currently displayed width (starting point of this drag). */
  width: number;
  /** Default width restored on double-click. */
  defaultWidth: number;
  bounds: ColumnBounds;
  /** Live width while dragging: write the DOM (skip React — the timeline is heavy; a per-frame re-render would feel sluggish). */
  onPreview: (px: number) => void;
  /** Commit (pointer-up / double-click / keyboard): submit + persist. */
  onCommit: (px: number) => void;
}

/**
 * Split between the three columns: an 11px hit area floats on the seam (does not occupy a grid column),
 * invisible until hover, and does not compete with each column's own hairline. Inside the hit area the
 * cursor is col-resize (set in CSS; also globally locked while dragging — see .split-handle and
 * body.is-col-resizing in tokens.css).
 *
 * Drag uses pointer capture: the handle still follows after the cursor leaves the seam or even the window;
 * pointer-up commits. Keyboard ←/→ and double-click reset are cheap extra entries that feel wrong to omit.
 */
export function SplitHandle({
  label,
  className,
  width,
  defaultWidth,
  bounds,
  onPreview,
  onCommit,
}: SplitHandleProps) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ startX: number; startWidth: number; latest: number } | null>(null);

  // Unmount (e.g. window shrinks past the phone breakpoint and the whole desktop shell is swapped): don't leave "dragging" global styles behind.
  useEffect(() => () => document.body.classList.remove('is-col-resizing'), []);

  const move = (clientX: number) => {
    const d = drag.current;
    if (!d)
      return;
    d.latest = clampColumnWidth(d.startWidth + (clientX - d.startX), bounds);
    onPreview(d.latest);
  };

  const end = () => {
    const d = drag.current;
    if (!d)
      return;
    drag.current = null;
    document.body.classList.remove('is-col-resizing');
    elRef.current?.classList.remove('is-dragging');
    onCommit(d.latest);
  };

  const nudge = (delta: number) => onCommit(clampColumnWidth(width + delta, bounds));

  return (
    <div
      ref={elRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      tabIndex={0}
      title={`${label}（拖动调整，双击复位）`}
      className={`split-handle ${className}`}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0)
          return; // left button only
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        el.classList.add('is-dragging');
        document.body.classList.add('is-col-resizing');
        drag.current = { startX: e.clientX, startWidth: width, latest: width };
      }}
      onPointerMove={e => move(e.clientX)}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onCommit(clampColumnWidth(defaultWidth, bounds))}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          nudge(e.shiftKey ? -KEY_STEP_LARGE : -KEY_STEP);
        }
        else if (e.key === 'ArrowRight') {
          e.preventDefault();
          nudge(e.shiftKey ? KEY_STEP_LARGE : KEY_STEP);
        }
      }}
    />
  );
}
