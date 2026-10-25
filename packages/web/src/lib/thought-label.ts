import type { ThoughtBlock } from '../net/protocol';

/**
 * Cursor's thinking clock. Under 500ms is "briefly"; otherwise rounded seconds ("1s", "90s").
 */
export function formatThoughtDuration(duration: string): string {
  const raw = duration.trim();
  const ms = /^(\d+)ms$/.exec(raw);
  if (!ms)
    return raw;
  const n = Number(ms[1]);
  if (!Number.isFinite(n) || n <= 0)
    return '';
  if (n < 500)
    return 'briefly';
  const seconds = Math.round(n / 1000);
  if (seconds === 0)
    return `${(n / 1000).toFixed(1)}s`;
  return `${seconds}s`;
}

/**
 * Collapsed header. Cursor shows the verb and the clock separately: "Thought" + "1s".
 * The thinking body stays behind the toggle.
 */
export function thoughtHeader(el: Pick<ThoughtBlock, 'action' | 'duration' | 'detail'>): string {
  const duration = formatThoughtDuration(el.duration ?? '');
  const action = el.action?.trim() ?? '';
  const hasBody = (el.detail?.trim() ?? '') !== '' || action !== '';
  const label = action || (hasBody ? 'Thought' : 'Thinking');
  if (!hasBody)
    return duration ? `Thought ${duration}` : 'Thinking';
  return duration ? `${label} ${duration}` : label;
}
