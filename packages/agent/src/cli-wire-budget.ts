import type { ChatElement } from '@lifeline/protocol';
import { wireBytes } from '@lifeline/protocol';

export interface CliWireMark {
  truncatedBefore?: true;
  firstRetainedFlatIndex?: number;
}

const TEXT_KEYS = new Set([
  'text',
  'detail',
  'action',
  'details',
  'summaryText',
  'title',
  'description',
  'label',
  'filename',
  'blocked',
  'duration',
  'toolName',
]);

interface TextLoc {
  parent: Record<string, unknown>;
  key: string;
  value: string;
}

/**
 * Drops the oldest messages until `build` fits `budget` (and `maxElements`, when set).
 * A single leftover message is shortened from the front of its longest text field so the tail stays.
 * Dropping a message or cutting that last message's text both set the trim markers.
 */
export function fitWireMessages<T extends { messages: ChatElement[] }>(options: {
  messages: readonly ChatElement[];
  truncatedBefore: boolean;
  firstRetainedFlatIndex: number | null;
  budget: number;
  maxElements?: number;
  build: (messages: ChatElement[], mark: CliWireMark) => T;
}): T {
  let kept = options.messages.slice();
  let truncated = options.truncatedBefore;
  let index = options.firstRetainedFlatIndex;

  const markOf = (): CliWireMark => {
    if (!truncated)
      return {};
    const mark: CliWireMark = { truncatedBefore: true };
    if (index != null)
      mark.firstRetainedFlatIndex = index;
    return mark;
  };

  const over = (payload: T, count: number) => {
    if (options.maxElements !== undefined && count > options.maxElements)
      return true;
    return wireBytes(payload) > options.budget;
  };

  let payload = options.build(kept, markOf());
  while (over(payload, kept.length) && kept.length > 1) {
    kept.shift();
    truncated = true;
    index = kept[0]?.flatIndex ?? null;
    payload = options.build(kept, markOf());
  }
  if (over(payload, kept.length) && kept.length === 1) {
    const only = kept[0]!;
    truncated = true;
    index = only.flatIndex;
    const shrunk = shrinkToFit(only, message => !over(options.build([message], markOf()), 1));
    if (shrunk) {
      kept = [shrunk];
    }
    else {
      kept = [];
      index = null;
    }
    payload = options.build(kept, markOf());
  }
  return payload;
}

function shrinkToFit(message: ChatElement, fits: (message: ChatElement) => boolean): ChatElement | null {
  if (fits(message))
    return message;
  const copy = structuredClone(message);
  const locs: TextLoc[] = [];
  collectText(copy, locs);
  const target = locs.reduce<TextLoc | undefined>((best, loc) => {
    if (!best || loc.value.length > best.value.length)
      return loc;
    return best;
  }, undefined);
  if (!target)
    return null;
  const original = target.value;
  let low = 0;
  let high = original.length;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    target.parent[target.key] = suffix(original, mid);
    if (fits(copy)) {
      best = mid;
      low = mid + 1;
    }
    else {
      high = mid - 1;
    }
  }
  if (best < 0)
    return null;
  target.parent[target.key] = suffix(original, best);
  return copy;
}

function suffix(text: string, maxChars: number): string {
  if (maxChars >= text.length)
    return text;
  if (maxChars <= 0)
    return '';
  return text.slice(alignCut(text, text.length - maxChars));
}

function alignCut(text: string, index: number): number {
  if (index <= 0)
    return 0;
  if (index >= text.length)
    return text.length;
  const code = text.charCodeAt(index);
  if (code >= 0xDC00 && code <= 0xDFFF)
    return index + 1;
  return index;
}

function collectText(value: unknown, out: TextLoc[]): void {
  if (Array.isArray(value)) {
    for (const item of value)
      collectText(item, out);
    return;
  }
  if (!isRecord(value))
    return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && TEXT_KEYS.has(key))
      out.push({ parent: value, key, value: child });
    else
      collectText(child, out);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
