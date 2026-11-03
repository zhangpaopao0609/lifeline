import './styles/tokens.css';
/**
 * Timeline reproduction harness (**dev only, not in production builds**; `vite` opens /harness.html directly).
 *
 * Goal: make "slide down on phone, view jumps back" windowing/scroll bugs **controllable to reproduce** —
 * a real-device session body can be fully replaced at any time, and switching sessions interrupts reproduction.
 * Here synthetic bodies (height variance deliberately large: tens-of-px tool rows + 10k+px body blocks) feed
 * the real `Timeline` component — the same code as production.
 *
 * `setBody` bumps a remount nonce: it measures the true "open session" path (fresh mount → INITIAL_ITEMS
 * first frame → fill-in), which without a remount would degrade into the wholesale-replace path.
 * `prependPage` / `appendTail` / `replaceBody` keep the component mounted — those are the in-place update paths.
 *
 * Synthetic distribution tries to match the session that actually broke (calibrating the multi-IDE adapter):
 * 40000+ px, dozens of items, 1–2 giant 10k+px rows in the middle.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Timeline } from './components/Timeline';
import { runBattery } from './lib/harness-battery';
import { buildBody, segmentKeys } from './lib/harness-body';
import { useIdesStore } from './store/ides';
import { useMachinesStore } from './store/machines';
import { sessionBodyKey, useSessionsStore } from './store/sessions';

const SESSION_ID = 'harness-session';
const IDE = 'cursor' as const;
const KEY = sessionBodyKey(SESSION_ID, IDE);

/** Bumped by `__harness.setBody` so `Timeline` remounts = a true "open session" (fresh-mount) measurement. */
let bumpShell: (() => void) | null = null;

function applyBody(body: ChatElementLike[]): void {
  useSessionsStore.setState({
    bodies: { [KEY]: body },
    bodySeq: {},
    // Emulate the production tail page: a real session open arrives with hasMore/nextBefore from the server.
    pageMeta: { [KEY]: { hasMore: true, nextBefore: 1, loadingAt: 0 } },
    prependedItems: {},
    pendingSends: {},
    unavailable: {},
  });
  window.__harnessKeys = segmentKeys(body);
  // Feed only the fields Timeline actually reads (the rest is held by store types; skip with an assertion).
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

/** Structural copy of `ChatElement` for the synthetic body (kept local so the lib has no dependency on the net layer). */
type ChatElementLike = ReturnType<typeof buildBody>[number];

declare global {
  interface Window {
    /** Full-body segment-key order (harness uses it to compute the global index of the item at viewport top). */
    __harnessKeys?: string[];
    /** In-page scenario battery (see lib/harness-battery.ts). */
    __battery?: () => Promise<Record<string, unknown>>;
    __harness?: {
      setBody: (count?: number, seed?: number, giantAt?: number) => { len: number; height: number };
      /** Simulate "earlier page arrived": prepend a whole page (same store path). */
      prependPage: (count?: number, seed?: number) => { headAdded: number; bodyLen: number; prepended: number };
      /** Simulate "generating increment": append by seq (store applySessionAppend). */
      appendTail: (count?: number, seed?: number) => { n: number; bodyLen: number };
      /** Simulate "authoritative full body arrived": full replace (store applySessionFull, no isPage). */
      replaceBody: (count?: number, seed?: number, prefix?: string) => { n: number; bodyLen: number };
      /**
       * iOS mode: turn off **native overflow anchoring** (`overflow-anchor: none`).
       *
       * Chrome auto-compensates scrollTop when content above the viewport grows; iOS/WKWebView (incl. WeChat) **does not**.
       * Turning it off = restore the iOS criterion on desktop: any path that relies on the browser compensating will show the real displacement.
       */
      setIosMode: (on: boolean) => boolean;
      measure: () => {
        st: number;
        sh: number;
        ch: number;
        n: number;
        first: string;
        last: string;
      };
    };
  }
}

function Shell() {
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    bumpShell = () => setNonce(n => n + 1);
  });
  return (
    <div className="shell-mobile">
      <div className="mobile-topbar">
        <span className="mono text-[length:var(--text-chrome)] text-[var(--text-secondary)]">
          timeline harness（现状基线）
        </span>
      </div>
      <Timeline key={nonce} />
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

window.__harness = {
  setBody: (count = 90, seed = 7, giantAt = -1) => {
    const body = buildBody(count, seed, '', giantAt);
    applyBody(body);
    bumpShell?.(); // fresh open: remount so the measurement covers the true "open session" path
    const sc = document.querySelector('.tl-scroll');
    return { len: body.length, height: sc ? sc.scrollHeight : -1 };
  },
  prependPage: (count = 60, seed = 99) => {
    const state = useSessionsStore.getState();
    const local = state.bodies[KEY] ?? [];
    const page = buildBody(count, seed, 'p');
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
    window.__harnessKeys = segmentKeys(body);
    return {
      headAdded: page.length - 1,
      bodyLen: body.length,
      segments: window.__harnessKeys.length,
      prepended: after.prependedItems[KEY] ?? 0,
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
    window.__harnessKeys = segmentKeys(body);
    return { n: page.length, bodyLen: body.length };
  },
  replaceBody: (count = 90, seed = 7, prefix = '') => {
    const body = buildBody(count, seed, prefix);
    useSessionsStore
      .getState()
      .applySessionFull({ sessionId: SESSION_ID, ide: IDE, messages: body, seq: 0 }, KEY);
    window.__harnessKeys = segmentKeys(body);
    return { n: body.length, bodyLen: body.length };
  },
  setIosMode: (on = true) => {
    const sc = document.querySelector('.tl-scroll') as HTMLElement | null;
    if (!sc)
      return false;
    sc.style.overflowAnchor = on ? 'none' : '';
    return true;
  },
  measure: () => {
    const sc = document.querySelector('.tl-scroll')!;
    const list = sc.querySelector('.tl-list')!;
    const kids = list.children;
    return {
      st: Math.round(sc.scrollTop),
      sh: sc.scrollHeight,
      ch: sc.clientHeight,
      n: kids.length,
      first: String((kids[0] as HTMLElement | undefined)?.dataset.key ?? ''),
      last: String((kids[kids.length - 1] as HTMLElement | undefined)?.dataset.key ?? ''),
    };
  },
};

window.__battery = () => runBattery({
  setBody: window.__harness!.setBody,
  prependPage: window.__harness!.prependPage,
  appendTail: window.__harness!.appendTail,
  replaceBody: window.__harness!.replaceBody,
  setIosMode: window.__harness!.setIosMode,
  scrollerSelector: '.tl-scroll',
});
