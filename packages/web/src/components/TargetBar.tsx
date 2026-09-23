import { CircleNotch } from '@phosphor-icons/react';
import { IDE_LABELS } from '../net/protocol';
import {
  activeTabOf,
  isActiveSessionWorking,
  isTabUnread,
  targetBarStatusText,
  useIdesStore,
  viewedTabOf,
  viewedWindowOf,
} from '../store/ides';
import { useUiStore } from '../store/ui';

export function TargetBar() {
  const ides = useIdesStore(s => s.ides);
  const selectedIde = useIdesStore(s => s.selectedIde);
  const pendingSwitch = useUiStore(s => s.pendingSwitch);
  const state = ides[selectedIde];
  const tab = state ? activeTabOf(state) : null;
  const pendingHere = pendingSwitch && pendingSwitch.ide === selectedIde ? pendingSwitch : null;
  const ideLabel = IDE_LABELS[selectedIde];
  // Window name is optimistic like the title: switching to a session in another window changes the name immediately, without waiting for state.
  const windowTitle = viewedWindowOf(state, pendingHere)?.title;

  // "Running" is the row-level spinner (including the optimistic-switch target session); live is only fallback, so a long task no longer goes dark mid-run.
  const running = isActiveSessionWorking(state, pendingHere);
  // The session being viewed finished, but the result hasn't been looked at (the dot on the IDE session tab) — the "completed" criterion.
  const unread = isTabUnread(viewedTabOf(state, pendingHere));
  const live = state?.agentActivityLive === true;
  const statusTone = !state?.connected
    ? 'bg-[var(--text-weak)]'
    : state?.agentStatus === 'error'
      ? 'bg-[var(--error)]'
      : running
        ? 'bg-[var(--accent)]'
        : 'bg-[var(--ok)]';
  // Copy follows the spinner (see targetBarStatusText: global idle must not cover row-level "running" and "finished unread").
  const statusText = targetBarStatusText(state, running, unread, ideLabel);

  return (
    <div className="flex min-h-11 items-center gap-2.5 border-b border-[var(--hairline)] bg-[var(--bg-1)] px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 font-semibold">
          {running && (
            <CircleNotch
              size={14}
              weight="bold"
              color="var(--accent)"
              className="shrink-0 animate-spin"
              aria-label="会话进行中"
            />
          )}
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">
            {pendingHere ? (pendingHere.title || '（未命名）') : (tab?.title || '（无会话）')}
          </span>
        </div>
        <div className="mono overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[var(--text-weak)]">
          {ideLabel}
          {windowTitle ? ` · ${windowTitle}` : ''}
        </div>
      </div>
      {pendingHere
        ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-[length:var(--text-chrome)] text-[var(--text-secondary)]">
              <span className="dot live-dot-pulse bg-[var(--accent)]" />
              切换中…
            </span>
          )
        : state && (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[length:var(--text-chrome)] text-[var(--text-secondary)]">
            <span className={`dot ${running || live ? 'live-dot-pulse' : ''} ${statusTone}`} />
            {statusText}
          </span>
        )}
    </div>
  );
}
