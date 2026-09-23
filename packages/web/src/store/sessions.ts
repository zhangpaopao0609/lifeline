import type {
  ChatElement,
  CommandResult,
  HumanMessage,
  IdeKind,
  SessionBodyPayload,
  SessionMissingPayload,
  SessionPatchPayload,
  SessionSyncPayload,
} from '../net/protocol';
import { create } from 'zustand';
import { mergeById, mergeEarlierPage, mergeTailPage } from '../lib/session-page';
import { parseIde } from '../net/protocol';

/**
 * sessionBodies cache + pendingSend reconcile.
 * Semantics match production src/client/app.js item by item:
 *  - key sessionBodyKey = `${ide}:${sessionId}`
 *  - optimistic bubble id = `pending-send:${commandId}`
 *  - pruneResolvedPending: pop bubbles against the set of real human texts (reconcile = end-to-end confirm)
 *  - mergeById (lib/session-page): de-dupe by id (replace if present, else push); tail/earlier page merge also uses it
 *  - paging: when the server only sent the tail, `pageMeta` stores the cursor; scrolling up asks for the earlier page (`beginEarlier`)
 *  - **full body kept**: this is the data layer, history is never dropped; "how much to render" is Timeline's per-viewport job
 *    (the old version truncated to 120 items, which deleted everything before 120 from memory)
 *  - after reconcile pops a bubble, also GC pendingSends meta so the Map does not grow monotonically
 */

/** After popping bubbles, GC pendingSends: drop entries whose bubble is no longer in the corresponding body (failed bubbles are still in the body, unaffected). */
function gcPendingSends(
  bodies: Record<string, ChatElement[]>,
  pendingSends: Record<string, PendingSendInfo>,
): Record<string, PendingSendInfo> {
  let changed = false;
  const next: Record<string, PendingSendInfo> = {};
  for (const [commandId, info] of Object.entries(pendingSends)) {
    const alive = (bodies[info.key] ?? []).some(m => m.id === info.id);
    if (alive)
      next[commandId] = info;
    else changed = true;
  }
  return changed ? next : pendingSends;
}

function payloadIde(payload: { ide?: IdeKind }): IdeKind {
  return parseIde(payload.ide);
}

export function sessionBodyKey(sessionId: string, ide: IdeKind): string {
  return `${ide}:${sessionId}`;
}

/** The reconcile point only advances on a number from the server; older servers (undefined) leave it alone. */
function nextBodySeq(
  bodySeq: Record<string, number>,
  key: string,
  seq: number | undefined,
): Record<string, number> {
  if (seq === undefined || bodySeq[key] === seq)
    return bodySeq;
  return { ...bodySeq, [key]: seq };
}

export function isPendingSend(msg: ChatElement | undefined | null): boolean {
  return !!msg && msg.type === 'human' && msg.id.startsWith('pending-send:');
}

function realHumanTexts(list: ChatElement[]): Set<string> {
  const real = new Set<string>();
  for (const m of list) {
    if (m && m.type === 'human' && !isPendingSend(m))
      real.add(m.text);
  }
  return real;
}

function pruneResolvedPending(list: ChatElement[]): ChatElement[] {
  const real = realHumanTexts(list);
  return list.filter(m => !(isPendingSend(m) && real.has((m as HumanMessage).text)));
}

/** When full arrives, splice currently unresolved pending bubbles back into incoming, then reconcile. */
function mergeIncomingWithPending(incoming: ChatElement[], current: ChatElement[]): ChatElement[] {
  const next = incoming.slice();
  const real = realHumanTexts(next);
  for (const p of current) {
    if (!isPendingSend(p) || real.has((p as HumanMessage).text))
      continue;
    if (next.some(m => m && m.id === p.id))
      continue;
    next.push(p);
  }
  return pruneResolvedPending(next);
}

export type PendingSendState = 'sending' | 'delivered' | 'failed';

export interface PendingSendInfo {
  id: string;
  text: string;
  key: string;
  /** Tri-state (spec §7 send flow): … sending → ✓ delivered → reconcile pops / 10s unconfirmed badge; failure red border. */
  state: PendingSendState;
  deliveredAt: number;
}

/** Outcome of an append: gap = a packet was skipped in the middle; caller should refill with a full. */
export type AppendOutcome = 'applied' | 'stale' | 'gap';

/** Retry interval when the earlier page never came back (disconnect / server doesn't have it): at the deadline, automatically allow the next request. */
const EARLIER_RETRY_MS = 10_000;

export interface PageMeta {
  hasMore: boolean;
  nextBefore?: number;
  /** Timestamp of the last page request (0 = no in-flight request). */
  loadingAt: number;
}

interface SessionsStore {
  bodies: Record<string, ChatElement[]>;
  /**
   * Body seq received per session (reconcile point).
   * Written only when the server actually sent a seq — older servers keep undefined, skipping gap detection.
   */
  bodySeq: Record<string, number>;
  /** How much is still unfetched when the server only sent the tail/earlier page (key = sessionBodyKey). */
  pageMeta: Record<string, PageMeta>;
  /**
   * Cumulative prepended **element count** (monotonic).
   *
   * ⚠️ Don't use it as render-window displacement: window indices are **segment** indices; consecutive tools
   * are merged by `segmentize` into one segment, so the two units are not equivalent (59 elements may be 23 segments).
   * Timeline computes segment displacement from the body's first item itself (see `segmentsPrepended` in `Timeline.tsx`).
   * This count is kept for diagnostics and tests only.
   */
  prependedItems: Record<string, number>;
  pendingSends: Record<string, PendingSendInfo>;
  /** Failed text waiting to be restored (spec §6: auto-fill if the input is empty, otherwise toast offers "restore"). */
  pendingRestore: string | null;
  /** Content source has said "this session doesn't exist": don't auto-retry (key = sessionBodyKey). */
  unavailable: Record<string, true>;
  applySessionUnavailable: (payload: SessionMissingPayload) => void;
  applySessionFull: (payload: SessionBodyPayload, liveKey: string) => void;
  applySessionAppend: (payload: SessionBodyPayload, liveKey: string) => AppendOutcome;
  /** Incremental fill from a content machine: merge by id, push the reconcile point straight to seq. */
  applySessionPatch: (payload: SessionPatchPayload, liveKey: string) => void;
  /** Request earlier page: returns the `before` to send; null when we shouldn't (at the top / in flight). */
  beginEarlier: (key: string) => { before: number } | null;
  /** seq check passed: only advance the reconcile point, don't touch the body. */
  applySessionSync: (payload: SessionSyncPayload) => void;
  echoPendingSend: (text: string, commandId: string, key: string) => void;
  /** command:result reconcile: ok → delivered, wait to pop; fail → failed + pendingRestore. */
  resolveCommandResult: (result: CommandResult) => void;
  /** Drop the pending bubble and its meta (used after retry / restore). */
  removePendingBubble: (commandId: string) => void;
  /** Read and clear pendingRestore. */
  takePendingRestore: () => string | null;
  setPendingRestore: (text: string) => void;
  clearPendingRestore: () => void;
  clearBodies: () => void;
}

export const useSessionsStore = create<SessionsStore>()((set, get) => ({
  bodies: {},
  bodySeq: {},
  pageMeta: {},
  prependedItems: {},
  pendingSends: {},
  pendingRestore: null,
  unavailable: {},

  applySessionUnavailable: (payload) => {
    const sessionId = payload?.sessionId;
    if (!sessionId)
      return;
    const key = sessionBodyKey(sessionId, payloadIde(payload));
    set(s => (s.unavailable[key] ? s : { unavailable: { ...s.unavailable, [key]: true } }));
  },

  applySessionFull: (payload, liveKey) => {
    const sessionId = payload?.sessionId;
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    if (!sessionId)
      return;
    const key = sessionBodyKey(sessionId, payloadIde(payload));
    // An empty packet must not wipe an existing body (last line of the same defense as the server); a first-confirmed empty session still lands as usual,
    // bodies[key] = [] makes Timeline take the "session is empty" branch instead of hanging on a skeleton screen.
    if (messages.length === 0 && (get().bodies[key]?.length ?? 0) > 0)
      return;
    const seq = typeof payload?.seq === 'number' ? payload.seq : undefined;
    const isLive = key === liveKey;
    const isPage = payload?.isPage === true;
    const current = get().bodies[key] ?? [];

    let copy: ChatElement[];
    let headAdded = 0;
    let keepPageMetaOnDrop = false;
    if (!isPage) {
      // Authoritative full body: replace wholesale (old semantics) and clear paging state — otherwise window indices stay at the post-prepend values and a short body paints empty and freezes
      copy = isLive ? mergeIncomingWithPending(messages, current) : messages.slice();
    }
    else if (payload.before !== undefined) {
      // Earlier page: prepend; if it does not meet the anchor, drop this page (keep local + the original nextBefore, retry on the next scroll)
      const merged = mergeEarlierPage(current, messages);
      if (merged) {
        copy = merged.body;
        headAdded = merged.headAdded;
      }
      else {
        copy = current;
        keepPageMetaOnDrop = true;
      }
    }
    else {
      // Tail page: keep the earlier prefix; if the boundary does not match, replace wholesale (local too old / projection changed)
      copy = mergeTailPage(current, messages) ?? messages.slice();
      if (isLive)
        copy = mergeIncomingWithPending(copy, current);
    }
    const pageMeta: PageMeta = keepPageMetaOnDrop
      ? { ...(get().pageMeta[key] ?? { hasMore: false, loadingAt: 0 }), loadingAt: 0 }
      : {
          hasMore: payload?.hasMore === true,
          nextBefore: payload?.nextBefore,
          loadingAt: 0,
        };
    set((s) => {
      const bodies = { ...s.bodies, [key]: copy };
      const prependedItems = !isPage
        ? (() => {
            const n = { ...s.prependedItems };
            delete n[key];
            return n;
          })()
        : headAdded > 0
          ? { ...s.prependedItems, [key]: (s.prependedItems[key] ?? 0) + headAdded }
          : s.prependedItems;
      const nextMeta = { ...s.pageMeta, [key]: pageMeta };
      if (!isPage)
        delete nextMeta[key];
      // Body is present: clear the "this session does not exist" mark
      const unavailable = { ...s.unavailable };
      delete unavailable[key];
      return {
        bodies,
        bodySeq: nextBodySeq(s.bodySeq, key, seq),
        pageMeta: nextMeta,
        prependedItems,
        pendingSends: gcPendingSends(bodies, s.pendingSends),
        unavailable,
      };
    });
  },

  applySessionAppend: (payload, liveKey) => {
    const sessionId = payload?.sessionId;
    const incoming = Array.isArray(payload?.messages) ? payload.messages : [];
    if (!sessionId)
      return 'stale';
    const key = sessionBodyKey(sessionId, payloadIde(payload));
    const seq = typeof payload?.seq === 'number' ? payload.seq : undefined;
    const last = get().bodySeq[key];
    if (seq !== undefined && last !== undefined) {
      // Stale/duplicate packet: content is already in the body, do not merge again
      if (seq <= last)
        return 'stale';
      // A packet was skipped in the middle: do not apply this one yet (avoids splicing the body out of order); let the upper layer refill with a full
      if (seq > last + 1)
        return 'gap';
    }
    const cached = get().bodies[key] ?? [];
    let merged = mergeById(cached, incoming);
    if (key === liveKey)
      merged = pruneResolvedPending(merged);
    set((s) => {
      const bodies = { ...s.bodies, [key]: merged };
      return {
        bodies,
        bodySeq: nextBodySeq(s.bodySeq, key, seq),
        pendingSends: gcPendingSends(bodies, s.pendingSends),
      };
    });
    return 'applied';
  },

  applySessionPatch: (payload, liveKey) => {
    const sessionId = payload?.sessionId;
    const incoming = Array.isArray(payload?.messages) ? payload.messages : [];
    const seq = typeof payload?.seq === 'number' ? payload.seq : undefined;
    if (!sessionId || seq === undefined)
      return;
    const key = sessionBodyKey(sessionId, payloadIde(payload));
    const cached = get().bodies[key] ?? [];
    let merged = mergeById(cached, incoming);
    if (key === liveKey)
      merged = pruneResolvedPending(merged);
    set((s) => {
      const bodies = { ...s.bodies, [key]: merged };
      return {
        bodies,
        // A patch pushes the reconcile point straight to seq (does not participate in append continuity checks)
        bodySeq: nextBodySeq(s.bodySeq, key, seq),
        pendingSends: gcPendingSends(bodies, s.pendingSends),
      };
    });
  },

  beginEarlier: (key) => {
    const meta = get().pageMeta[key];
    if (!meta?.hasMore || meta.nextBefore === undefined)
      return null;
    if (meta.loadingAt !== 0 && Date.now() - meta.loadingAt < EARLIER_RETRY_MS)
      return null;
    set(s => ({ pageMeta: { ...s.pageMeta, [key]: { ...meta, loadingAt: Date.now() } } }));
    return { before: meta.nextBefore };
  },

  applySessionSync: (payload) => {
    const sessionId = payload?.sessionId;
    const seq = payload?.seq;
    if (!sessionId || typeof seq !== 'number')
      return;
    const key = sessionBodyKey(sessionId, payloadIde(payload));
    set(s => ({ bodySeq: nextBodySeq(s.bodySeq, key, seq) }));
  },

  echoPendingSend: (text, commandId, key) => {
    const pending: HumanMessage = {
      type: 'human',
      id: `pending-send:${commandId}`,
      flatIndex: (get().bodies[key] ?? []).length,
      text,
      mentions: [],
      pending: true,
    };
    set(s => ({
      bodies: { ...s.bodies, [key]: [...(s.bodies[key] ?? []), pending] },
      pendingSends: {
        ...s.pendingSends,
        [commandId]: { id: pending.id, text, key, state: 'sending' as const, deliveredAt: 0 },
      },
    }));
  },

  resolveCommandResult: (result) => {
    const info = get().pendingSends[result.commandId];
    if (!info)
      return;
    if (result.ok) {
      // ✓ Delivered: keep the bubble until reconcile pops it (session:full/append text match); if it has not popped after 10s the UI shows an '已提交，未确认' badge
      set(s => ({
        pendingSends: {
          ...s.pendingSends,
          [result.commandId]: { ...info, state: 'delivered' as const, deliveredAt: Date.now() },
        },
      }));
      return;
    }
    // Failure: mark the bubble failed (red border + retry/restore), record pendingRestore
    set(s => ({
      pendingSends: {
        ...s.pendingSends,
        [result.commandId]: { ...info, state: 'failed' as const, deliveredAt: 0 },
      },
      pendingRestore: info.text,
    }));
  },

  removePendingBubble: (commandId) => {
    const info = get().pendingSends[commandId];
    if (!info)
      return;
    set((s) => {
      const pendingSends = { ...s.pendingSends };
      delete pendingSends[commandId];
      const body = (s.bodies[info.key] ?? []).filter(m => m.id !== info.id);
      return { pendingSends, bodies: { ...s.bodies, [info.key]: body } };
    });
  },

  takePendingRestore: () => {
    const text = get().pendingRestore;
    if (text !== null)
      set({ pendingRestore: null });
    return text;
  },

  setPendingRestore: text => set({ pendingRestore: text }),

  clearPendingRestore: () => set({ pendingRestore: null }),

  clearBodies: () =>
    set({
      bodies: {},
      bodySeq: {},
      pageMeta: {},
      prependedItems: {},
      pendingSends: {},
      pendingRestore: null,
      unavailable: {},
    }),
}));
