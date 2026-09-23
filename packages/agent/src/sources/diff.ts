/**
 * Line-level diff for composer.content before/after snapshots.
 * Spec path B: do not use codeBlockPartialInlineDiffFates.
 */

import type { DiffLineKind } from '../types.js';

export interface DiffOp {
  kind: DiffLineKind;
  text: string;
}

/** Context lines kept around the changed span. */
const CTX = 3;
/** LCS size cap; beyond this, fall back to delete-all + insert-all. */
const LCS_LIMIT = 4_000_000;

export function diffLines(before: string, after: string): DiffOp[] {
  if (before === after)
    return [];
  const a = before.split('\n');
  const b = after.split('\n');

  // Trim shared prefix/suffix so LCS only sees the edited middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const out: DiffOp[] = [];

  for (let i = Math.max(0, start - CTX); i < start; i++) {
    out.push({ kind: 'ctx', text: a[i] });
  }

  if (midA.length * midB.length > LCS_LIMIT) {
    for (const l of midA) out.push({ kind: 'rem', text: l });
    for (const l of midB) out.push({ kind: 'add', text: l });
  }
  else {
    out.push(...lcs(midA, midB));
  }

  for (let i = endA; i < Math.min(a.length, endA + CTX); i++) {
    out.push({ kind: 'ctx', text: a[i] });
  }

  return out;
}

/** Standard LCS backtrack. */
function lcs(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0)
    return [];
  if (n === 0)
    return b.map(t => ({ kind: 'add' as const, text: t }));
  if (m === 0)
    return a.map(t => ({ kind: 'rem' as const, text: t }));

  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j]
        = a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i] });
      i++;
      j++;
    }
    else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'rem', text: a[i++] });
    }
    else {
      out.push({ kind: 'add', text: b[j++] });
    }
  }
  while (i < n) out.push({ kind: 'rem', text: a[i++] });
  while (j < m) out.push({ kind: 'add', text: b[j++] });
  return out;
}
