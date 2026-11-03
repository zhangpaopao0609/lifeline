import { CircleNotch } from '@phosphor-icons/react';
import { usePendingNewChat } from '../hooks/usePendingNewChat';
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
  // Create in flight: same truth as the rail row and the pane, so the header must not keep naming the old session.
  const pendingNew = usePendingNewChat();
  const ideLabel = IDE_LABELS[selectedIde];
  // Window name is optimistic like the title: switching to a session in another window changes the name immediately, without waiting for state.
  const windowTitle = viewedWindowOf(state, pendingHere)?.title;

  // "Running" is the row-level spinner (including the optimistic-switch target session); live is only fallback, so a long task no longer goes dark mid-run.
  const running = isActiveSessionWorking(state, pendingHere);
  // Multitask delegation: the session itself is done, only background sub-agents run
  // (the session row keeps its spinner like the IDE sidebar). Distinct hint instead of "进行中".
  const backgroundRunning = !running && !pendingHere && tab?.isActive === true && tab?.backgroundRunning === true;
  // The session being viewed finished, but the result hasn't been looked at (the dot on the IDE session tab) — the "completed" criterion.
  const unread = isTabUnread(viewedTabOf(state, pendingHere));
  const live = state?.agentActivityLive === true;
  const statusTone = !state?.connected
    ? 'bg-[var(--text-weak)]'
    : state?.agentStatus === 'error'
      ? 'bg-[var(--error)]'
      : running || backgroundRunning
        ? 'bg-[var(--accent)]'
        : 'bg-[var(--ok)]';
  // Copy follows the spinner (see targetBarStatusText: global idle must not cover row-level "running" and "finished unread").
  const statusText = backgroundRunning
    ? '后台任务运行中'
    : targetBarStatusText(state, running, unread, ideLabel);
  // A create / switch in flight owns the header: the old session's title and status would contradict the rail and pane.
  const title = pendingNew ? '新会话' : pendingHere ? (pendingHere.title || '（未命名）') : (tab?.title || '（无会话）');
  const inFlight = pendingNew ? '新建中…' : pendingHere ? '切换中…' : '';

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
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{title}</span>
        </div>
        <div className="mono overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[var(--text-weak)]">
          {ideLabel}
          {windowTitle ? ` · ${windowTitle}` : ''}
        </div>
      </div>
      {inFlight
        ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-[length:var(--text-chrome)] text-[var(--text-secondary)]">
              <span className="dot live-dot-pulse bg-[var(--accent)]" />
              {inFlight}
            </span>
          )
        : state && (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[length:var(--text-chrome)] text-[var(--text-secondary)]">
            <span className={`dot ${running || live || backgroundRunning ? 'live-dot-pulse' : ''} ${statusTone}`} />
            {statusText}
          </span>
        )}
    </div>
  );
}
