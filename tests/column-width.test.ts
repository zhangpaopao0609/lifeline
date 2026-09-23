import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clampColumnWidth,
  COLUMN_DEFAULT_WIDTH,
  COLUMN_LIMITS,
  COLUMN_STORAGE_PREFIX,
  columnBounds,
  columnStorageKey,
  loadColumnWidth,
  MAIN_MIN_WIDTH,
  saveColumnWidth,
} from '../packages/web/src/lib/column-width.ts';

/** In-memory storage only (throwing privacy-mode variants are built in place) */
function memoryStorage() {
  const bag: Record<string, string> = {};
  return {
    getItem: (k: string) => bag[k] ?? null,
    setItem: (k: string, v: string) => {
      bag[k] = v;
    },
  };
}

describe('columnBounds', () => {
  it('caps at the hard max on a wide screen', () => {
    assert.deepEqual(columnBounds('rail', 1600, COLUMN_DEFAULT_WIDTH.sess), { min: 200, max: 320 });
    assert.deepEqual(columnBounds('sess', 1600, COLUMN_DEFAULT_WIDTH.rail), { min: 220, max: 420 });
  });

  it('leaves MAIN_MIN_WIDTH for the main column when the other column is wide', () => {
    // After dragging the session pane to 320, the rail cap is only 1024 - 320 - 480 = 224 —
    // tighter than both the share cap (256) and the hard cap (320)
    const bounds = columnBounds('rail', 1024, 320);
    assert.equal(bounds.max, 224);
    assert.equal(1024 - bounds.max - 320, MAIN_MIN_WIDTH);
  });

  it('applies the viewport share when it is the tightest cap', () => {
    // 1100 * 0.25 = 275 < hard cap 320, and also < remaining space 340
    assert.equal(columnBounds('rail', 1100, COLUMN_DEFAULT_WIDTH.sess).max, 275);
  });

  it('keeps the default layout inside MAIN_MIN_WIDTH on the smallest desktop', () => {
    // 1024 (desktop breakpoint) + default rail: session pane max 1024 - 240 - 480 = 304 (share 409 / hard cap 420 are both looser)
    assert.equal(columnBounds('sess', 1024, COLUMN_DEFAULT_WIDTH.rail).max, 304);
  });

  it('never lets max fall below min', () => {
    const bounds = columnBounds('rail', 700, COLUMN_DEFAULT_WIDTH.sess);
    assert.equal(bounds.max, COLUMN_LIMITS.rail.min);
  });
});

describe('clampColumnWidth', () => {
  const bounds = { min: 200, max: 320 };

  it('rounds to whole pixels', () => {
    assert.equal(clampColumnWidth(283.6, bounds), 284);
  });

  it('clamps to both ends', () => {
    assert.equal(clampColumnWidth(9999, bounds), 320);
    assert.equal(clampColumnWidth(1, bounds), 200);
  });

  it('falls back to min for NaN', () => {
    assert.equal(clampColumnWidth(Number.NaN, bounds), 200);
  });
});

describe('column width storage', () => {
  it('builds a stable key', () => {
    assert.equal(columnStorageKey('sess'), `${COLUMN_STORAGE_PREFIX}sess`);
  });

  it('returns null when the user has never dragged', () => {
    assert.equal(loadColumnWidth({ getItem: () => null }, 'rail'), null);
  });

  it('round-trips a dragged width', () => {
    const storage = memoryStorage();
    saveColumnWidth(storage, 'rail', 301.4);
    assert.equal(loadColumnWidth(storage, 'rail'), 301);
  });

  it('ignores garbage and non-positive values', () => {
    assert.equal(loadColumnWidth({ getItem: () => 'wide' }, 'rail'), null);
    assert.equal(loadColumnWidth({ getItem: () => '-5' }, 'rail'), null);
    assert.equal(loadColumnWidth({ getItem: () => '0' }, 'rail'), null);
  });

  it('survives a storage that throws (隐私模式)', () => {
    const storage = {
      getItem: () => {
        throw new Error('denied');
      },
    };
    assert.equal(loadColumnWidth(storage, 'sess'), null);
  });
});
