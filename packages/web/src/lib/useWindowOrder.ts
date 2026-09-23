import type { TabGroup } from './window-order';
import { useEffect, useMemo, useState } from 'react';
import {
  loadSavedOrder,
  mergeIncoming,
  orderGroups,
  reorderIds,
  saveOrder,
  storageKey,

} from './window-order';

/**
 * Never dragged: the first incoming order is pinned in memory.
 * After a drag: localStorage wins, and it survives refresh.
 * Incoming reshuffles caused by clicks do not change the UI order.
 */
export function useWindowOrder(agentId: string | undefined, ide: string, groups: TabGroup[]): {
  groups: TabGroup[];
  reorder: (fromId: string, toId: string) => void;
} {
  const key = storageKey(agentId ?? '', ide);
  const incomingIds = useMemo(() => groups.map(g => g.windowId), [groups]);
  const incomingSig = incomingIds.join('\0');

  const [epoch, setEpoch] = useState(key);
  const [dragged, setDragged] = useState<string[] | null>(null);
  const [sessionPin, setSessionPin] = useState<string[]>([]);

  if (epoch !== key) {
    setEpoch(key);
    setDragged(null);
    setSessionPin([]);
  }

  let stored: string[] | null = dragged;
  if (stored === null) {
    try {
      stored = loadSavedOrder(window.localStorage, key);
    }
    catch {
      stored = null;
    }
  }

  useEffect(() => {
    if (stored)
      return;
    const incoming = incomingSig ? incomingSig.split('\0').filter(Boolean) : [];
    setSessionPin(prev => (prev.length === 0 ? incoming.slice() : mergeIncoming(prev, incoming)));
  }, [incomingSig, stored, key]);

  const order = stored ?? sessionPin;
  const orderedGroups = useMemo(() => orderGroups(groups, order), [groups, order]);

  const reorder = (fromId: string, toId: string) => {
    const ids = orderedGroups.map(g => g.windowId);
    const next = reorderIds(ids, fromId, toId);
    setDragged(next);
    try {
      saveOrder(window.localStorage, key, next);
    }
    catch {
      /* Private mode: the in-memory order is still there. */
    }
  };

  return { groups: orderedGroups, reorder };
}
