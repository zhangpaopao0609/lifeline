import './styles/tokens.css';
import type { ChatElement } from './net/protocol';
/**
 * Timeline reproduction harness (**dev only, not in production builds**; `vite` opens /harness.html directly).
 *
 * Goal: make "slide down on phone, view jumps back" windowing/scroll bugs **controllable to reproduce** —
 * a real-device session body can be fully replaced at any time, and switching sessions interrupts reproduction.
 * Here synthetic bodies (height variance deliberately large: tens-of-px tool rows + 10k+px body blocks) feed
 * the real `Timeline` component — the same code as production.
 *
 * Synthetic distribution tries to match the session that actually broke (calibrating the multi-IDE adapter):
 * 40000+ px, dozens of items, 1–2 giant 10k+px rows in the middle.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Timeline } from './components/Timeline';
import { useIdesStore } from './store/ides';
import { useMachinesStore } from './store/machines';
import { sessionBodyKey, useSessionsStore } from './store/sessions';

const SESSION_ID = 'harness-session';
const IDE = 'cursor' as const;
const KEY = sessionBodyKey(SESSION_ID, IDE);

/** 32-bit reproducible PRNG (same seed always grows the same body). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function paragraph(i: number, k: number): string {
  return `### 小节 ${k}\n\n第 ${i}-${k} 段正文。这一条刻意写得很长，用来模拟真实会话里那种几千到上万像素的正文块（代码块 / 计划卡 / 长回答）。`;
}

/** Synthetic body: giant blocks mixed with small rows (height variance is this windowing logic's stress source). */
function buildBody(count = 90, seed = 7, prefix = '', giantAt = -1): ChatElement[] {
  const rnd = mulberry32(seed);
  const out: ChatElement[] = [];
  let i = 0;
  while (out.length < count) {
    const r = rnd();
    if (r < 0.12) {
      out.push({
        type: 'human',
        id: `${prefix}h${i}`,
        flatIndex: i,
        text: `第 ${i} 条提问：把这一步收敛掉。`,
        mentions: [],
      });
      i += 1;
      // giantAt: plant a **~20,000 px** giant row (taller than 16 viewports) — reclaiming into it would cut the anchor.
      const blocks = out.length === giantAt ? 320 : 20 + Math.floor(rnd() * 60);
      out.push({
        type: 'assistant',
        id: `${prefix}a${i}`,
        flatIndex: i,
        text: Array.from({ length: blocks }, (_, k) => paragraph(i, k)).join('\n\n'),
      });
      i += 1;
    }
    else if (r < 0.55) {
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k += 1) {
        out.push({
          type: 'tool',
          id: `${prefix}t${i}`,
          flatIndex: i,
          toolCallId: `call-${prefix}${i}`,
          status: 'completed',
          action: 'ran command',
          toolName: 'Bash',
          details: `npx tsc --noEmit # ${i}`,
          filename: 'packages/server/src/relay.ts',
          additions: 3,
          deletions: 1,
          summaryText: 'exit 0',
        });
        i += 1;
      }
    }
    else {
      out.push({ type: 'assistant', id: `${prefix}a${i}`, flatIndex: i, text: `第 ${i} 条的简短回答。` });
      i += 1;
    }
  }
  return out;
}

/**
 * Timeline segment keys (same as `segmentize`: consecutive tools merge into one segment, key is the first item's id).
 * Used to compute "global index of the item at viewport top in the body" — index going backward is a real jump-back.
 */
function segmentKeys(body: ChatElement[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i].type === 'tool' && body[i - 1]?.type === 'tool')
      continue;
    keys.push(body[i].id);
  }
  return keys;
}

function applyBody(body: ChatElement[]): void {
  useSessionsStore.setState({
    bodies: { [KEY]: body },
    bodySeq: {},
    pageMeta: {},
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

declare global {
  interface Window {
    /** Full-body segment-key order (harness uses it to compute the global index of the item at viewport top). */
    __harnessKeys?: string[];
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
  return (
    <div className="shell-mobile">
      <div className="mobile-topbar">
        <span className="mono text-[length:var(--text-chrome)] text-[var(--text-secondary)]">
          timeline harness
        </span>
      </div>
      <Timeline />
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
      KEY,
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
