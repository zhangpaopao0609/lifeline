/* eslint-disable react-refresh/only-export-components -- dev-only bench: one file, fast refresh is not wanted here */
import './styles/tokens.css';
import type { ChatElement, ChatTab } from './net/protocol';
/**
 * Whole-console performance bench (**dev only**, `vite` serves /perf.html). Not imported by production code.
 * `vite.config.ts` has no extra rollup input, so only `index.html` is ever built — this cannot reach production.
 *
 * Why it exists: the 2026-10-31 feedback was "the page got slow after the update" — switching sessions and the
 * ＋ felt laggy. That cannot be answered by reading code, so this page mounts the **real** `AppShell` with the
 * **real** stores, seeded with a realistic workload (dozens of sessions, cached + cold bodies), and exposes
 * `window.__perf` so Playwright can drive interactions and record Event Timing / long tasks / frame deltas.
 *
 * `mode` reproduces the two placements of `useViewState`:
 *  - `inline`  = today: the hook lives in the shell's parent, so every state patch re-renders the whole tree
 *  - `child`   = after the fix: the hook lives in a null-rendering bridge
 *  - `off`     = no mirroring at all (lower bound)
 *
 * Side effects to keep in mind (same origin as the dev console): the real `useViewState` writes `ar:view` to
 * localStorage, so the next `/console` load tries to restore this seeded `agent-perf` view; and `net/socket` connects
 * to the relay on import. Don't leave this page open while testing "last viewed" behavior.
 */
import { StrictMode, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { buildBody } from './lib/harness-body';
import { useViewState } from './lib/useViewState';
import { useIdesStore } from './store/ides';
import { useMachinesStore } from './store/machines';
import { sessionBodyKey, useSessionsStore } from './store/sessions';

const IDE = 'cursor' as const;
const AGENT = 'agent-perf';
const WINDOWS = [
  { id: 'w-1', title: 'lifeline' },
  { id: 'w-2', title: 'lifeline-web' },
  { id: 'w-3', title: 'scratch' },
];

const BODY_CACHE = new Map<number, ChatElement[]>();
function bodyOf(seed: number, items: number): ChatElement[] {
  const key = seed * 10_000 + items;
  let body = BODY_CACHE.get(key);
  if (!body) {
    body = buildBody(items, seed, `s${seed}-`) as ChatElement[];
    BODY_CACHE.set(key, body);
  }
  return body;
}

interface SeedOptions {
  /** Session rows in the rail (default 30 — a busy machine). */
  sessions?: number;
  /** Elements in each cached transcript (default 160 — a few thousand pixels of markdown). */
  bodyItems?: number;
  /** How many sessions start with a cached body (the rest are "cold" → skeleton on switch). */
  cachedBodies?: number;
}

/** Seed the real stores with a realistic workload. Idempotent. */
function seed(options: SeedOptions = {}) {
  const sessions = options.sessions ?? 30;
  const bodyItems = options.bodyItems ?? 160;
  const cached = options.cachedBodies ?? 3;
  const tabs: ChatTab[] = [];
  for (let i = 0; i < sessions; i++) {
    const w = WINDOWS[i % WINDOWS.length]!;
    tabs.push({
      composerId: `c-${i}`,
      title: `会话 ${i} · ${w.title}`,
      isActive: i === 0,
      status: 'idle',
      selectorPath: '',
      windowId: w.id,
    });
  }
  const bodies: Record<string, ChatElement[]> = {};
  for (let i = 0; i < Math.min(cached, sessions); i++)
    bodies[sessionBodyKey(`c-${i}`, IDE)] = bodyOf(7 + i, bodyItems);
  useSessionsStore.setState({
    bodies,
    bodySeq: {},
    pageMeta: {},
    prependedItems: {},
    pendingSends: {},
    pendingRestore: null,
    unavailable: {},
  });
  useIdesStore.setState({
    selectedIde: IDE,
    ides: {
      [IDE]: {
        connected: true,
        activeWindowId: 'w-1',
        activeComposerId: 'c-0',
        agentStatus: 'idle',
        windows: WINDOWS.map(w => ({ id: w.id, title: w.title, url: '' })),
        chatTabs: tabs,
      } as never,
    },
  });
  useMachinesStore.setState({
    machines: [{ agentId: AGENT, hostname: 'perf-mac', connected: true, contentOnly: false, cli: [] } as never],
    selectedAgentId: AGENT,
    uplinkConnected: true,
  });
}

// ---- mode (inline / child / off) -------------------------------------------------------------
type Mode = 'inline' | 'child' | 'off';
let mode: Mode = 'inline';
const modeListeners = new Set<() => void>();
function setMode(next: Mode): void {
  mode = next;
  for (const listener of modeListeners)
    listener();
}
function subscribeMode(listener: () => void): () => void {
  modeListeners.add(listener);
  return () => modeListeners.delete(listener);
}

function ViewStateBridge() {
  useViewState();
  return null;
}

/** Today's shape: the hook runs in the shell's parent component. */
function ConsoleInline() {
  useViewState();
  return <AppShell />;
}

/** Fixed shape: the hook runs in a null child, so its re-renders stop at that boundary. */
function ConsoleChild() {
  return (
    <>
      <ViewStateBridge />
      <AppShell />
    </>
  );
}

function ConsoleOff() {
  return <AppShell />;
}

function PerfApp() {
  const current = useSyncExternalStore(subscribeMode, () => mode);
  if (current === 'child')
    return <ConsoleChild />;
  if (current === 'off')
    return <ConsoleOff />;
  return <ConsoleInline />;
}

// ---- measurements ----------------------------------------------------------------------------
interface StormResult {
  patches: number;
  longTasks: number[];
  totalBlockingMs: number;
  frames: number;
  frameP95: number;
  frameMax: number;
  framesOver50: number;
  wallMs: number;
}

/**
 * Push one `state:patch` every `every` ms — exactly what a running session does (the agent polls at 300ms and
 * only emits when something changed). Measures what one patch costs the whole page: long tasks + frame budget.
 */
async function patchStorm(options: { ms?: number; every?: number; field?: 'activity' | 'status' } = {}): Promise<StormResult> {
  const ms = options.ms ?? 4000;
  const every = options.every ?? 300;
  const longTasks: number[] = [];
  const frames: number[] = [];
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        longTasks.push(Math.round(entry.duration));
    });
    observer.observe({ type: 'longtask', buffered: false });
  }
  catch {
    observer = null;
  }
  let running = true;
  let last = performance.now();
  const onFrame = () => {
    const now = performance.now();
    frames.push(now - last);
    last = now;
    if (running)
      requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);
  let patches = 0;
  const started = performance.now();
  const timer = window.setInterval(() => {
    patches += 1;
    const patch = options.field === 'status'
      ? { agentStatus: patches % 2 ? 'generating' : 'idle' }
      : { agentActivityText: `正在读取 src/index.ts（${patches}）` };
    useIdesStore.getState().applyStatePatch({ ide: IDE, patch } as never);
  }, every);
  await new Promise(resolve => setTimeout(resolve, ms));
  running = false;
  window.clearInterval(timer);
  observer?.disconnect();
  const wallMs = performance.now() - started;
  const sorted = [...frames].sort((a, b) => a - b);
  return {
    patches,
    longTasks,
    totalBlockingMs: Math.round(longTasks.reduce((sum, d) => sum + Math.max(0, d - 50), 0)),
    frames: frames.length,
    frameP95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    frameMax: Math.round(sorted[sorted.length - 1] ?? 0),
    framesOver50: frames.filter(d => d > 50).length,
    wallMs: Math.round(wallMs),
  };
}

/**
 * Streaming session: one `session:append` every `every` ms on the **viewed** session. This is the other hot path —
 * the store merges by id + re-derives segments over the whole body, then the timeline re-renders. Cost grows with
 * transcript length, so it is measured at a realistic long-conversation size instead of the default fixture.
 */
async function appendStorm(options: { ms?: number; every?: number; bodyItems?: number } = {}): Promise<StormResult> {
  const ms = options.ms ?? 4000;
  const every = options.every ?? 300;
  if (options.bodyItems) {
    useSessionsStore.setState(s => ({
      bodies: { ...s.bodies, [sessionBodyKey('c-0', IDE)]: bodyOf(99, options.bodyItems!) },
      bodySeq: { ...s.bodySeq, [sessionBodyKey('c-0', IDE)]: 0 },
    }));
  }
  const longTasks: number[] = [];
  const frames: number[] = [];
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        longTasks.push(Math.round(entry.duration));
    });
    observer.observe({ type: 'longtask', buffered: false });
  }
  catch {
    observer = null;
  }
  let running = true;
  let last = performance.now();
  const onFrame = () => {
    const now = performance.now();
    frames.push(now - last);
    last = now;
    if (running)
      requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);
  let patches = 0;
  const started = performance.now();
  const timer = window.setInterval(() => {
    patches += 1;
    useSessionsStore.getState().applySessionAppend({
      sessionId: 'c-0',
      ide: IDE,
      seq: patches,
      messages: [{
        type: 'assistant',
        id: `live-${patches}`,
        flatIndex: 0,
        text: `第 ${patches} 段流式输出：正在改写 src/components/Timeline.tsx 的窗口逻辑，这里刻意写长一点，模拟真实回答的 markdown 体积。`,
      }],
    } as never);
  }, every);
  await new Promise(resolve => setTimeout(resolve, ms));
  running = false;
  window.clearInterval(timer);
  observer?.disconnect();
  const wallMs = performance.now() - started;
  const sorted = [...frames].sort((a, b) => a - b);
  return {
    patches,
    longTasks,
    totalBlockingMs: Math.round(longTasks.reduce((sum, d) => sum + Math.max(0, d - 50), 0)),
    frames: frames.length,
    frameP95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    frameMax: Math.round(sorted[sorted.length - 1] ?? 0),
    framesOver50: frames.filter(d => d > 50).length,
    wallMs: Math.round(wallMs),
  };
}

/**
 * Emulate the extract that finally reports the created draft — the handover point for the optimistic row.
 * (The real one arrives via `state:patch` in net/bind.ts, which the bench does not register.)
 */
function pushDraft(windowId = 'w-1'): void {
  const state = useIdesStore.getState().ides[IDE];
  if (!state)
    return;
  const draft: ChatTab = {
    composerId: 'tab-9',
    title: 'New Agent',
    isActive: true,
    status: 'draft',
    selectorPath: '',
    windowId,
  };
  const tabs = [...(state.chatTabs ?? []).map(t => ({ ...t, isActive: false })), draft];
  useIdesStore.getState().applyStatePatch({ ide: IDE, patch: { chatTabs: tabs, activeWindowId: windowId } } as never);
}

/** One patch → next paint (double rAF). Includes the frame itself (~16.7ms on a 60Hz display). */
async function patchToPaint(): Promise<number> {
  const t0 = performance.now();
  useIdesStore.getState().applyStatePatch({ ide: IDE, patch: { agentActivityText: `paint-${t0}` } } as never);
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  return Math.round((performance.now() - t0) * 10) / 10;
}

/**
 * Event Timing for real clicks: `duration` runs from the input event to the next paint after the handlers, which is
 * exactly "点完到画面变化". Installed before the click, read afterwards.
 */
let eventEntries: Array<{ name: string; duration: number; processing: number }> = [];
let eventObserver: PerformanceObserver | null = null;
function watchClicks(): void {
  eventEntries = [];
  if (eventObserver)
    return;
  eventObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const timing = entry as PerformanceEntry & { processingStart?: number; processingEnd?: number };
      const processing = (timing.processingEnd ?? 0) - (timing.processingStart ?? 0);
      eventEntries.push({ name: entry.name, duration: Math.round(entry.duration * 10) / 10, processing: Math.round(processing * 10) / 10 });
    }
  });
  eventObserver.observe({ type: 'event', durationThreshold: 0, buffered: false } as PerformanceObserverInit);
}

declare global {
  interface Window {
    __perf: {
      relay: string;
      seed: (options?: SeedOptions) => void;
      setMode: (mode: Mode) => void;
      mode: () => Mode;
      patchStorm: typeof patchStorm;
      appendStorm: typeof appendStorm;
      pushDraft: typeof pushDraft;
      patchToPaint: typeof patchToPaint;
      watchClicks: () => void;
      clicks: () => typeof eventEntries;
      resetClicks: () => void;
    };
  }
}

window.__perf = {
  relay: (import.meta.env.VITE_RELAY_URL as string | undefined) ?? '(same origin)',
  seed,
  setMode,
  mode: () => mode,
  patchStorm,
  appendStorm,
  pushDraft,
  patchToPaint,
  watchClicks,
  clicks: () => eventEntries,
  resetClicks: () => { eventEntries = []; },
};

seed();

function Root() {
  // React StrictMode double-renders in dev and inflates every measurement; the bench runs it off on purpose.
  const [strict] = useState(false);
  return (
    <MemoryRouter initialEntries={['/console']}>
      {strict ? <StrictMode><PerfApp /></StrictMode> : <PerfApp />}
    </MemoryRouter>
  );
}

createRoot(document.getElementById('root')!).render(<Root />);
