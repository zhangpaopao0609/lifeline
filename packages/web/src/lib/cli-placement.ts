/** Drop a trailing slash so `/proj` and `/proj/` name the same folder. Root stays `/`. */
export function normalizeCliCwd(cwd: string): string {
  const trimmed = cwd.trim();
  if (trimmed === '/' || trimmed === '')
    return trimmed;
  return trimmed.replace(/\/+$/, '');
}

/**
 * Group CLI sessions by directory. A session is not a child of an IDE window:
 * the window list and this list are peers under the machine.
 */
export function groupCliByCwd<T extends { cwd: string }>(
  sessions: readonly T[],
): Array<{ cwd: string; rows: T[] }> {
  const blocks: Array<{ cwd: string; rows: T[] }> = [];
  const at = new Map<string, { cwd: string; rows: T[] }>();
  for (const row of sessions) {
    const cwd = normalizeCliCwd(row.cwd);
    const found = at.get(cwd);
    if (found) {
      found.rows.push(row);
      continue;
    }
    const block = { cwd, rows: [row] };
    at.set(cwd, block);
    blocks.push(block);
  }
  return blocks;
}
