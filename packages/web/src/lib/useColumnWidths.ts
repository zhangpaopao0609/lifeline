import type { RefObject } from 'react';
import type { ColumnBounds, ColumnKind } from './column-width';
import { useEffect, useState } from 'react';
import {
  clampColumnWidth,
  COLUMN_DEFAULT_WIDTH,
  columnBounds,

  loadColumnWidth,
  saveColumnWidth,
} from './column-width';

/** CSS variable written on `.shell-desktop`: grid column width and split-handle position both read it (see tokens.css). */
const CSS_VAR: Record<ColumnKind, string> = { rail: '--rail-w', sess: '--sess-w' };

export interface ColumnWidths {
  /** Currently displayed width (user preference after clamp to the current viewport). */
  widths: Record<ColumnKind, number>;
  bounds: Record<ColumnKind, ColumnBounds>;
  /** During a drag / keyboard nudge: write CSS variables only, no re-render. */
  preview: (kind: ColumnKind, px: number) => void;
  /** Commit (pointer-up / double-click / keyboard): write the variable + commit state + persist to localStorage. */
  commit: (kind: ColumnKind, px: number) => void;
}

/**
 * Three-column widths. state only updates on commit: during a drag every frame writes CSS
 * variables directly — the shell hosts the whole session list and timeline, and a per-frame
 * setState re-render would make the drag feel sluggish.
 *
 * state stores "user preference"; displayed value = preference clamped to the current viewport:
 * a temporarily narrower window only shrinks the display (does not overwrite preference), and
 * stretching back restores the width the user dragged to.
 */
export function useColumnWidths(shellRef: RefObject<HTMLElement>): ColumnWidths {
  const [preferred, setPreferred] = useState<Record<ColumnKind, number>>(() => ({
    rail: loadColumnWidth(window.localStorage, 'rail') ?? COLUMN_DEFAULT_WIDTH.rail,
    sess: loadColumnWidth(window.localStorage, 'sess') ?? COLUMN_DEFAULT_WIDTH.sess,
  }));
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // The two columns constrain each other (each subtracts the width the other occupies) — must come from the same preference snapshot, or they inflate each other.
  const bounds: Record<ColumnKind, ColumnBounds> = {
    rail: columnBounds('rail', viewportWidth, preferred.sess),
    sess: columnBounds('sess', viewportWidth, preferred.rail),
  };
  const widths: Record<ColumnKind, number> = {
    rail: clampColumnWidth(preferred.rail, bounds.rail),
    sess: clampColumnWidth(preferred.sess, bounds.sess),
  };

  const preview = (kind: ColumnKind, px: number) => {
    shellRef.current?.style.setProperty(CSS_VAR[kind], `${px}px`);
  };

  const commit = (kind: ColumnKind, px: number) => {
    const next = clampColumnWidth(px, bounds[kind]);
    preview(kind, next);
    setPreferred(prev => (prev[kind] === next ? prev : { ...prev, [kind]: next }));
    try {
      saveColumnWidth(window.localStorage, kind, next);
    }
    catch {
      /* Private mode: still in effect for this session. */
    }
  };

  return { widths, bounds, preview, commit };
}
