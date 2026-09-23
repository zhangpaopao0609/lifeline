/**
 * Body-page merge (pure functions, unit-testable).
 *
 * Alignment is always by `id` (on-disk bubbleId): `flatIndex` is a dense counter rewritten on every
 * projection (a thin projection shifts the whole document), so using it as an anchor misaligns after a projection swap.
 */
import type { ChatElement } from '../net/protocol';

/** Merge by id: replace in place if present, otherwise append. */
export function mergeById(target: ChatElement[], incoming: ChatElement[]): ChatElement[] {
  const next = target.slice();
  const indexById = new Map<string, number>();
  for (let i = 0; i < next.length; i++) indexById.set(next[i].id, i);
  for (const msg of incoming) {
    if (!msg || !msg.id)
      continue;
    const at = indexById.get(msg.id);
    if (at !== undefined) {
      next[at] = msg;
    }
    else {
      indexById.set(msg.id, next.length);
      next.push(msg);
    }
  }
  return next;
}

/**
 * Tail page: the first element of the page is the boundary; keep the local prefix before it, replace everything after with this page.
 * If the boundary doesn't match (local too old / projection swapped) → null, and the caller replaces with the authoritative full body.
 */
export function mergeTailPage(local: ChatElement[], page: ChatElement[]): ChatElement[] | null {
  if (page.length === 0)
    return null;
  const at = local.findIndex(m => m.id === page[0].id);
  if (at < 0)
    return null;
  return mergeById(local.slice(0, at), page);
}

/**
 * Earlier page: the last item of the page must already be local (under closed-interval paging it's the local first item / overlap token);
 * insert items from the page that local doesn't have in front of it. If it doesn't join (concurrent replace / page-order scramble)
 * → null, drop this page (the next scroll retries with the **original** nextBefore; don't move the cursor).
 */
export function mergeEarlierPage(
  local: ChatElement[],
  page: ChatElement[],
): { body: ChatElement[]; headAdded: number } | null {
  if (page.length === 0)
    return null;
  const anchorId = page[page.length - 1].id;
  const at = local.findIndex(m => m.id === anchorId);
  if (at < 0)
    return null;
  const have = new Set(local.map(m => m.id));
  const fresh = page.filter(m => !have.has(m.id));
  if (fresh.length === 0)
    return { body: local, headAdded: 0 };
  return { body: [...local.slice(0, at), ...fresh, ...local.slice(at)], headAdded: fresh.length };
}
