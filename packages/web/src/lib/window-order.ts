import type { ChatTab, CursorState, CursorWindow } from '../net/protocol';

export const WINDOW_ORDER_PREFIX = 'ar:windowOrder:';

export function storageKey(agentId: string, ide: string): string {
  return `${WINDOW_ORDER_PREFIX}${agentId}:${ide}`;
}

/** Pinned order wins; ids that newly appear in incoming are appended; ids that disappeared are dropped. */
export function mergeIncoming(pinned: string[], incoming: string[]): string[] {
  if (pinned.length === 0)
    return incoming.slice();
  const incomingSet = new Set(incoming);
  const kept = pinned.filter(id => incomingSet.has(id));
  const keptSet = new Set(kept);
  const added = incoming.filter(id => !keptSet.has(id));
  return [...kept, ...added];
}

export function reorderIds(ids: string[], fromId: string, toId: string): string[] {
  const next = ids.slice();
  const from = next.indexOf(fromId);
  const to = next.indexOf(toId);
  if (from < 0 || to < 0 || from === to)
    return ids;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function loadSavedOrder(storage: Pick<Storage, 'getItem'>, key: string): string[] | null {
  try {
    const raw = storage.getItem(key);
    if (!raw)
      return null;
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr) || arr.length === 0)
      return null;
    const ids = arr.filter((x): x is string => typeof x === 'string');
    return ids.length > 0 ? ids : null;
  }
  catch {
    return null;
  }
}

export function saveOrder(storage: Pick<Storage, 'setItem'>, key: string, ids: string[]): void {
  storage.setItem(key, JSON.stringify(ids));
}

export interface TabGroup {
  windowId: string;
  title: string;
  tabs: ChatTab[];
}

/**
 * Build buckets from windows[], then pour in chatTabs / per-window chatTabs.
 * Don't use "a Map keyed by first chatTabs insertion" — that would push the focused window to the front.
 */
export function groupTabsByWindow(state: Pick<CursorState, 'chatTabs' | 'windows' | 'activeWindowId'>): TabGroup[] {
  const windows: CursorWindow[] = state.windows ?? [];
  const buckets = new Map<string, ChatTab[]>();
  for (const w of windows) buckets.set(w.id, []);

  const push = (t: ChatTab) => {
    const wid = t.windowId || state.activeWindowId || windows[0]?.id || 'home';
    let arr = buckets.get(wid);
    if (!arr) {
      arr = [];
      buckets.set(wid, arr);
    }
    if (!arr.some(x => x.composerId === t.composerId && x.title === t.title))
      arr.push(t);
  };
  for (const t of state.chatTabs ?? []) push(t);
  for (const w of windows) {
    for (const t of w.chatTabs ?? []) push(t);
  }

  const ids: string[] = windows.map(w => w.id);
  for (const id of buckets.keys()) {
    if (!ids.includes(id))
      ids.push(id);
  }

  return ids.map(windowId => ({
    windowId,
    title: windows.find(w => w.id === windowId)?.title ?? '当前窗口',
    tabs: buckets.get(windowId) ?? [],
  }));
}

/**
 * Rows in the Agents window are aggregated by secondary group (repo/workspace), keeping the IDE's row order.
 * Same-named sections may not be adjacent (the IDE orders them itself), so only **adjacent** same-section rows are merged.
 */
export function groupTabsBySection(tabs: ChatTab[]): Array<{ section: string; tabs: ChatTab[] }> {
  const out: Array<{ section: string; tabs: ChatTab[] }> = [];
  for (const tab of tabs) {
    const section = tab.section ?? '';
    const last = out[out.length - 1];
    if (last && last.section === section)
      last.tabs.push(tab);
    else out.push({ section, tabs: [tab] });
  }
  return out;
}

export function orderGroups(groups: TabGroup[], order: string[]): TabGroup[] {
  const byId = new Map(groups.map(g => [g.windowId, g]));
  const incoming = groups.map(g => g.windowId);
  return mergeIncoming(order, incoming)
    .map(id => byId.get(id))
    .filter((g): g is TabGroup => Boolean(g));
}
