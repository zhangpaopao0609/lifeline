import './styles/tokens.css';
import type { VirtuosoHandle } from 'react-virtuoso';
/**
 * PoC harness for the react-virtuoso timeline (**dev only**; `vite` opens /harness-virtuoso.html directly).
 *
 * Feeds the **same synthetic bodies** (shared `lib/harness-body.ts`, same seeds) as `harness.tsx` into
 * `TimelineVirtuoso`, so the two pages can be driven by the **same measurement script** and compared 1:1.
 *
 * `__hv` mirrors `__harness` (setBody = fresh open via remount; prependPage / appendTail / replaceBody = in-place
 * updates) and adds the knobs the PoC needs: `goto(index)` (scrollToIndex), `fireUserGesture()` (arm the page gate),
 * `setPageGate(bool)`, `autoPaging` (chain pages when startReached fires).
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TimelineVirtuoso } from './components/TimelineVirtuoso';
import { runBattery } from './lib/harness-battery';
import { buildBody, segmentKeys } from './lib/harness-body';
import { clearTimelineSnapshot } from './lib/timeline-persist';
import { useIdesStore } from './store/ides';
import { useMachinesStore } from './store/machines';
import { sessionBodyKey, useSessionsStore } from './store/sessions';

const SESSION_ID = 'harness-session';
const IDE = 'cursor' as const;
const KEY = sessionBodyKey(SESSION_ID, IDE);

let bumpShell: (() => void) | null = null;
let setPageGateState: ((on: boolean) => void) | null = null;
/** The live Virtuoso handle (bound by Shell's `bindHandle`; read by `__hv.goto`). */
let virtuosoHandle: VirtuosoHandle | null = null;
/** Monotonic seed/prefix source for `prependPage` so chained calls generate fresh ids. */
let pageSeq = 0;

function applyBody(body: ReturnType<typeof buildBody>): void {
  useSessionsStore.setState({
    bodies: { [KEY]: body },
    bodySeq: {},
    // Emulate the production tail page: a real session open arrives with hasMore/nextBefore from the server.
    pageMeta: { [KEY]: { hasMore: true, nextBefore: 1, loadingAt: 0 } },
    prependedItems: {},
    pendingSends: {},
    unavailable: {},
  });
  window.__hvKeys = segmentKeys(body);
  useIdesStore.setState({
    selectedIde: IDE,
    ides: {
      [IDE]: ({
        connected: true,
        activeWindowId: 'w-harness',
        activeComposerId: SESSION_ID,
        agentStatus: 'idle',
        windows: [{ id: 'w-harness', title: 'harness', url: '' }],
        chatTabs: [
          {
            composerId: SESSION_ID,
            title: 'harness 会话',
            isActive: true,
            status: 'idle',
            selectorPath: '#harness',
            windowId: 'w-harness',
          },
        ],
      }) as never,
    },
  });
  useMachinesStore.setState({
    machines: [{ agentId: 'agent-harness', hostname: 'harness', connected: true } as never],
    selectedAgentId: 'agent-harness',
  });
}

declare global {
  interface Window {
    __hvKeys?: string[];
    /** In-page scenario battery (see lib/harness-battery.ts). */
    __battery?: () => Promise<Record<string, unknown>>;
    __hv?: {
      /** Fresh open: rebuild the body and remount the list (true "open session" path; clears the remembered position). */
      setBody: (count?: number, seed?: number, giantAt?: number) => { len: number; height: number };
      /** Remount with the same body (session switch back) — the remembered position must restore. */
      remount: () => boolean;
      prependPage: (count?: number, seed?: number) => { headAdded: number; bodyLen: number; segments: number };
      appendTail: (count?: number, seed?: number) => { n: number; bodyLen: number };
      /** In-place wholesale replace (the "black screen" class: same mount, new body). */
      replaceBody: (count?: number, seed?: number, prefix?: string) => { n: number; bodyLen: number };
      setIosMode: (on: boolean) => boolean;
      measure: () => { st: number; sh: number; ch: number; n: number; first: string; last: string };
      /** scrollToIndex on the Virtuoso handle. */
      goto: (index: number, align?: 'start' | 'center' | 'end') => void;
      /** Arm the "user has interacted" gate without a real gesture (scripted chaining test). */
      fireUserGesture: () => void;
      /** false = startReached pages without a gesture (scripting); production keeps the gate on. */
      setPageGate: (on: boolean) => void;
      /** Chain pages while startReached keeps firing (drives `__hv.prependPage`). */
      autoPaging: boolean;
    };
  }
}

function Shell() {
  const [nonce, setNonce] = useState(0);
  const [pageGate, setPageGate] = useState(true);
  useEffect(() => {
    bumpShell = () => setNonce(n => n + 1);
    setPageGateState = on => setPageGate(on);
  });
  return (
    <div className="shell-mobile">
      <div className="mobile-topbar">
        <span className="mono text-[length:var(--text-chrome)] text-[var(--text-secondary)]">
          timeline harness（virtuoso PoC）
        </span>
      </div>
      <TimelineVirtuoso
        key={nonce}
        sessionKey={KEY}
        bindHandle={(h) => { virtuosoHandle = h; }}
        pageGate={pageGate}
        onMaybePage={() => {
          if (window.__hv?.autoPaging)
            window.__hv.prependPage();
        }}
      />
      <div className="composer-dock">
        <div className="composer-box">
          <span className="text-[length:var(--text-chrome)] text-[var(--text-weak)]">发给 harness 会话</span>
        </div>
      </div>
    </div>
  );
}

applyBody(buildBody());
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);

window.__hv = {
  autoPaging: false,
  setBody: (count = 90, seed = 7, giantAt = -1) => {
    const body = buildBody(count, seed, '', giantAt);
    applyBody(body);
    // "Open a fresh session": its position is unknown (matches a new session in production).
    clearTimelineSnapshot(KEY);
    bumpShell?.();
    const sc = document.querySelector('[data-virtuoso-scroller]') as HTMLElement | null;
    return { len: body.length, height: sc ? sc.scrollHeight : -1 };
  },
  /** Remount with the SAME body (session switch back): the remembered position must restore. */
  remount: () => {
    bumpShell?.();
    return true;
  },
  prependPage: (count = 60, seed) => {
    const state = useSessionsStore.getState();
    const local = state.bodies[KEY] ?? [];
    // Unique seed per call: repeated chains must generate fresh ids, or mergeById folds the page into the body idempotently.
    const s = seed ?? 900 + (pageSeq += 7);
    const page = buildBody(count, s, `p${pageSeq}`);
    // Earlier page: the last item of the page must already be local (closed-interval paging overlap token).
    page[page.length - 1] = local[0];
    state.applySessionFull(
      {
        sessionId: SESSION_ID,
        ide: IDE,
        messages: page,
        seq: 0,
        isPage: true,
        before: 1,
        hasMore: true,
        nextBefore: 1,
      },
      KEY,
    );
    const after = useSessionsStore.getState();
    const body = after.bodies[KEY] ?? [];
    window.__hvKeys = segmentKeys(body);
    return {
      headAdded: page.length - 1,
      bodyLen: body.length,
      segments: window.__hvKeys.length,
    };
  },
  appendTail: (count = 3, seed = 31) => {
    const state = useSessionsStore.getState();
    const local = state.bodies[KEY] ?? [];
    const page = buildBody(count, seed, `n${local.length}-`);
    state.applySessionAppend(
      { sessionId: SESSION_ID, ide: IDE, messages: page, seq: (state.bodySeq[KEY] ?? 0) + 1 },
    );
    const after = useSessionsStore.getState();
    const body = after.bodies[KEY] ?? [];
    window.__hvKeys = segmentKeys(body);
    return { n: page.length, bodyLen: body.length };
  },
  replaceBody: (count = 90, seed = 7, prefix = '') => {
    const body = buildBody(count, seed, prefix);
    useSessionsStore
      .getState()
      .applySessionFull({ sessionId: SESSION_ID, ide: IDE, messages: body, seq: 0 }, KEY);
    window.__hvKeys = segmentKeys(body);
    return { n: body.length, bodyLen: body.length };
  },
  setIosMode: (on = true) => {
    const sc = document.querySelector('[data-virtuoso-scroller]') as HTMLElement | null;
    if (!sc)
      return false;
    sc.style.overflowAnchor = on ? 'none' : '';
    return true;
  },
  measure: () => {
    const sc = document.querySelector('[data-virtuoso-scroller]') as HTMLElement;
    const items = Array.from(sc.querySelectorAll<HTMLElement>('[data-key]'));
    return {
      st: Math.round(sc.scrollTop),
      sh: sc.scrollHeight,
      ch: sc.clientHeight,
      n: items.length,
      first: String(items[0]?.dataset.key ?? ''),
      last: String(items[items.length - 1]?.dataset.key ?? ''),
    };
  },
  goto: (index, align = 'start') => {
    virtuosoHandle?.scrollToIndex({ index, align, behavior: 'auto' });
  },
  fireUserGesture: () => {
    const sc = document.querySelector('[data-virtuoso-scroller]') as HTMLElement | null;
    sc?.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 }));
  },
  setPageGate: (on: boolean) => {
    setPageGateState?.(on);
  },
};

window.__battery = () => runBattery({
  setBody: window.__hv!.setBody,
  prependPage: window.__hv!.prependPage,
  appendTail: window.__hv!.appendTail,
  replaceBody: window.__hv!.replaceBody,
  setIosMode: window.__hv!.setIosMode,
  scrollerSelector: '[data-virtuoso-scroller]',
  gotoMid: () => window.__hv!.goto(Math.floor((window.__hvKeys ?? []).length / 2), 'start'),
});
