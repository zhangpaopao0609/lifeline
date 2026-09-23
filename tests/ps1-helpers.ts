/**
 * Assertion helpers shared by the two PowerShell scripts.
 */

/**
 * Find lines that violate "`Join-Path` takes only two positional arguments" (PowerShell 5.1 limit).
 *
 * ⚠️ **Do not split tokens on whitespace**: the space in `'CodeBuddy CN\argv.json'` would count
 * one argument as two (`'CodeBuddy` + `CN\argv.json'`); that was only fixed in the third revision.
 * Split on whitespace that is outside quotes and at parenthesis depth 0 — `(Join-Path $a $b)` is **one** argument.
 */
export function joinPathArityViolations(src: string): string[] {
  const bad: string[] = [];
  for (const line of src.split(/\r?\n/)) {
    const m = /Join-Path\s+(.+)$/.exec(line);
    if (!m)
      continue;
    if (countPositionalArgs(m[1]!) > 2)
      bad.push(line.trim());
  }
  return bad;
}

function countPositionalArgs(rest: string): number {
  let depth = 0;
  let quote: string | null = null;
  let inToken = false;
  let count = 0;
  for (const ch of rest) {
    if (quote) {
      if (ch === quote)
        quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      inToken = true;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      continue;
    }
    if (/\s/.test(ch) && depth === 0) {
      inToken = false;
      continue;
    }
    if (!inToken) {
      count += 1;
      inToken = true;
    }
  }
  return count;
}
