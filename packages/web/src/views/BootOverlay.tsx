import { Broadcast } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { useConnectionStore } from '../store/connection';

type Phase = 'idle' | 'waiting' | 'shown' | 'fading' | 'done';

const APPEAR_AFTER_MS = 300;
const MIN_STAY_MS = 400;
const FADE_MS = 200;

/**
 * P0 boot-state anti-flicker (spec P0, three rules):
 * 1. Render the app skeleton first (SkeletonShell); content fades in in place when data arrives — no full-screen swap;
 * 2. Brand lockup + `connecting…` only appear if connecting takes >300ms;
 * 3. Once shown, stay at least 400ms, then a 200ms crossfade out.
 */
export function BootOverlay() {
  const status = useConnectionStore(s => s.status);
  const [phase, setPhase] = useState<Phase>('idle');
  const shownAt = useRef(0);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const clear = () => { timers.current.forEach(t => window.clearTimeout(t)); timers.current = []; };
    if (status === 'connecting') {
      setPhase(p => (p === 'done' ? p : 'waiting'));
      timers.current.push(window.setTimeout(() => {
        shownAt.current = Date.now();
        setPhase('shown');
      }, APPEAR_AFTER_MS));
      return clear;
    }
    setPhase((p) => {
      if (p === 'idle' || p === 'waiting' || p === 'done')
        return 'done';
      const remain = Math.max(0, MIN_STAY_MS - (Date.now() - shownAt.current));
      timers.current.push(window.setTimeout(() => {
        setPhase('fading');
        timers.current.push(window.setTimeout(setPhase, FADE_MS, 'done'));
      }, remain));
      return p;
    });
    return clear;
  }, [status]);

  if (phase !== 'shown' && phase !== 'fading')
    return null;

  return (
    <div
      className="boot-overlay"
      style={{
        opacity: phase === 'fading' ? 0 : 1,
        transition: `opacity ${FADE_MS}ms var(--ease-spring)`,
        pointerEvents: phase === 'fading' ? 'none' : 'auto',
      }}
    >
      <div className="flex items-center gap-2 font-bold tracking-wide">
        <Broadcast size={20} color="var(--accent)" />
        Lifeline
      </div>
      <div className="mono text-[length:var(--text-chrome)] text-[var(--text-weak)]">connecting…</div>
    </div>
  );
}

/** P0 app skeleton: empty shells for rail / session column / main pane (the bed content fades into once data arrives). */
export function SkeletonShell() {
  const isDesktop = useIsDesktop();

  if (!isDesktop) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-[var(--hairline)] bg-[var(--bg-1)] px-4 py-3.5">
          <div className="skel-bar mb-0 h-3.5 w-[55%]" />
        </div>
        <div className="flex-1 p-4">
          <div className="skel-bar h-4 w-[70%]" />
          <div className="skel-bar w-[92%]" />
          <div className="skel-bar w-[84%]" />
        </div>
        <div className="border-t border-[var(--hairline)] p-4">
          <div className="skel-bar mb-0 h-10 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="shell-desktop">
      <div className="border-r border-[var(--hairline)] bg-[var(--bg-1)] p-4">
        <div className="skel-bar mb-[18px] h-3.5 w-[60%]" />
        <div className="skel-bar w-[85%]" />
        <div className="skel-bar w-[70%]" />
        <div className="skel-bar w-[78%]" />
      </div>
      <div className="border-r border-[var(--hairline)] bg-[var(--bg-1)] p-4">
        <div className="skel-bar mb-3.5 h-[34px] w-full" />
        <div className="skel-bar w-[88%]" />
        <div className="skel-bar w-[72%]" />
      </div>
      <div className="bg-[var(--bg-0)] p-5">
        <div className="skel-bar mb-5 h-4 w-[45%]" />
        <div className="skel-bar w-[90%]" />
        <div className="skel-bar w-[96%]" />
        <div className="skel-bar w-[80%]" />
      </div>
    </div>
  );
}
