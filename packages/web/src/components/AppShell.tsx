import type { CSSProperties } from 'react';
import { CaretDown, Warning, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { COLUMN_DEFAULT_WIDTH } from '../lib/column-width';
import { machineLabel } from '../lib/machine-name';
import { useColumnWidths } from '../lib/useColumnWidths';
import { IDE_LABELS } from '../net/protocol';
import { useIdesStore, viewedWindowOf } from '../store/ides';
import { useMachinesStore } from '../store/machines';
import { useUiStore } from '../store/ui';
import { useUserStore } from '../store/user';
import { AccountContent } from './AccountContent';
import { ActionCenter } from './ActionCenter';
import { Avatar } from './Avatar';
import { CommandPalette } from './CommandPalette';
import { Composer } from './Composer';
import { MachineList } from './MachineList';
import { Rail } from './Rail';
import { SessionList } from './SessionList';
import { SplitHandle } from './SplitHandle';
import { TargetBar } from './TargetBar';
import { Timeline } from './Timeline';

function MobileSwitcher({ onClose }: { onClose: () => void }) {
  // Option order is "computers → sessions" (see below); default still lands on sessions — this panel is opened to switch sessions most of the time.
  const [seg, setSeg] = useState<'machines' | 'sessions'>('sessions');
  const [touchStartX, setTouchStartX] = useState(0);

  return (
    <div
      className="fullscreen-layer"
      onTouchStart={e => setTouchStartX(e.touches[0].clientX)}
      onTouchEnd={(e) => {
        const dx = e.changedTouches[0].clientX - touchStartX;
        if (touchStartX < 30 && dx > 60)
          onClose();
      }}
    >
      <div className="flex items-center gap-3 border-b border-[var(--hairline)] px-3 py-2.5">
        <button type="button" aria-label="关闭" onClick={onClose} className="icon-btn">
          <X size={20} />
        </button>
        <div className="flex rounded-[var(--radius-md)] bg-[var(--bg-2)] p-0.5">
          {/* Computers first, sessions second: computers are the outer scope (sessions hang under them), and it matches the desktop rail → session column and the top bar "hostname · IDE · session" reading order. */}
          {(['machines', 'sessions'] as const).map(key => (
            <button
              key={key}
              type="button"
              onClick={() => setSeg(key)}
              className={`cursor-pointer rounded-[var(--radius-sm)] border-0 px-4 py-1.5 text-[length:var(--text-chrome)] ${
                seg === key ? 'bg-[var(--bg-3)] text-[var(--text-primary)]' : 'bg-transparent text-[var(--text-secondary)]'
              }`}
            >
              {key === 'machines' ? '电脑' : '会话'}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {/* revealCurrent: opening the panel jumps to the current session so you don't have to scroll for the highlighted row. */}
        {seg === 'sessions'
          ? <SessionList onNavigate={onClose} revealCurrent />
          : (
              <div className="h-full overflow-y-auto p-2.5">
                <MachineList onNavigate={onClose} />
              </div>
            )}
      </div>
    </div>
  );
}

function MobileAccount({ onClose }: { onClose: () => void }) {
  return (
    <div className="fullscreen-layer">
      <div className="flex items-center gap-3 border-b border-[var(--hairline)] px-3 py-2.5">
        <button type="button" aria-label="关闭" onClick={onClose} className="icon-btn">
          <X size={20} />
        </button>
        <span className="font-semibold">我的</span>
      </div>
      <div className="overflow-y-auto p-3">
        <AccountContent />
      </div>
    </div>
  );
}

function OfflineBanner() {
  const machines = useMachinesStore(s => s.machines);
  const selectedAgentId = useMachinesStore(s => s.selectedAgentId);
  const machine = machines.find(m => m.agentId === selectedAgentId);
  if (!machine || machine.connected)
    return null;
  return (
    <div className="banner-offline">
      <Warning size={14} weight="fill" />
      {machineLabel(machine)}
      {' '}
      已离线 · 显示最后镜像（只读）
    </div>
  );
}

function DesktopShell({ paletteOpen, onClosePalette }: { paletteOpen: boolean; onClosePalette: () => void }) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const { widths, bounds, preview, commit } = useColumnWidths(shellRef);

  return (
    <div
      ref={shellRef}
      className="shell-desktop"
      // Column widths go through CSS variables: grid column width and both split-handle positions read them (see tokens.css).
      style={{ '--rail-w': `${widths.rail}px`, '--sess-w': `${widths.sess}px` } as CSSProperties}
    >
      <Rail />
      <div className="shell-col border-r border-[var(--hairline)]">
        <SessionList />
      </div>
      <main className="shell-main">
        <TargetBar />
        <OfflineBanner />
        <Timeline />
        <ActionCenter />
        <Composer />
      </main>
      {/* Both seams are draggable; default widths stay, drag has bounds (see lib/column-width.ts);
          absolutely positioned on the seam, not in the grid flow. */}
      <SplitHandle
        className="split-rail"
        label="调整电脑栏宽度"
        width={widths.rail}
        defaultWidth={COLUMN_DEFAULT_WIDTH.rail}
        bounds={bounds.rail}
        onPreview={px => preview('rail', px)}
        onCommit={px => commit('rail', px)}
      />
      <SplitHandle
        className="split-sess"
        label="调整会话栏宽度"
        width={widths.sess}
        defaultWidth={COLUMN_DEFAULT_WIDTH.sess}
        bounds={bounds.sess}
        onPreview={px => preview('sess', px)}
        onCommit={px => commit('sess', px)}
      />
      {paletteOpen && <CommandPalette onClose={onClosePalette} />}
    </div>
  );
}

function MobileShell({
  paletteOpen,
  onClosePalette,
}: {
  paletteOpen: boolean;
  onClosePalette: () => void;
}) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const machines = useMachinesStore(s => s.machines);
  const selectedAgentId = useMachinesStore(s => s.selectedAgentId);
  const ides = useIdesStore(s => s.ides);
  const selectedIde = useIdesStore(s => s.selectedIde);
  const userId = useUserStore(s => s.userId);
  const avatar = useUserStore(s => s.avatar);
  const machine = machines.find(m => m.agentId === selectedAgentId);
  const machineName = machine ? machineLabel(machine) : '（无机器）';
  const ideLabel = IDE_LABELS[selectedIde];
  const ideState = ides[selectedIde];
  const pendingSwitch = useUiStore(s => s.pendingSwitch);
  const pendingHere = pendingSwitch && pendingSwitch.ide === selectedIde ? pendingSwitch : null;
  // The top bar is "machine · IDE · window" context (session name is in the next TargetBar):
  // machine / IDE read selected state; window is "the one being viewed" (the target window during an optimistic switch) — changes immediately on click, without waiting for state.
  const windowTitle = ideState ? viewedWindowOf(ideState, pendingHere)?.title : '';

  return (
    <div className="shell-mobile">
      <div className="mobile-topbar">
        <button
          type="button"
          onClick={() => setSwitcherOpen(true)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 border-0 bg-transparent py-1.5 text-left font-[inherit] text-[var(--text-primary)]"
        >
          {/* ⌄ must be shrink-0, text must be flex-1 min-w-0: when a long window name ellipsizes,
              otherwise the icon is squeezed from 16px to ~12px and the whole label shifts left 4px;
              switching to a different-length window/session is a "top-bar jitter" (2026-09-16 feedback). */}
          <CaretDown size={16} className="shrink-0" />
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
            {machineName}
            {' '}
            ·
            {ideLabel}
            {' '}
            ·
            {windowTitle || '（无窗口）'}
          </span>
        </button>
        <button type="button" aria-label="我的" onClick={() => setAccountOpen(true)} className="shrink-0 cursor-pointer border-0 bg-transparent p-0">
          <Avatar src={avatar} name={userId} size={28} />
        </button>
      </div>

      <TargetBar />
      <OfflineBanner />
      <Timeline />
      <ActionCenter />
      <Composer />

      {switcherOpen && <MobileSwitcher onClose={() => setSwitcherOpen(false)} />}
      {accountOpen && <MobileAccount onClose={() => setAccountOpen(false)} />}
      {paletteOpen && <CommandPalette onClose={onClosePalette} />}
    </div>
  );
}

export function AppShell() {
  const isDesktop = useIsDesktop();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onClosePalette = () => setPaletteOpen(false);
  if (isDesktop)
    return <DesktopShell paletteOpen={paletteOpen} onClosePalette={onClosePalette} />;
  return <MobileShell paletteOpen={paletteOpen} onClosePalette={onClosePalette} />;
}
