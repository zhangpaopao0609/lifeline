import { CloudArrowDown, FileDashed, Plug } from '@phosphor-icons/react';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useLiveSessionKey } from '../hooks/useLiveSessionKey';
import { usePendingNewChat } from '../hooks/usePendingNewChat';
import { IDE_LABELS } from '../net/protocol';
import { socket } from '../net/socket';
import { isDraftTab, useIdesStore, viewedTabOf } from '../store/ides';
import { useMachinesStore } from '../store/machines';
import { useSessionsStore } from '../store/sessions';
import { useUiStore } from '../store/ui';
import { CopyButton } from './CopyButton';
import { segmentize } from './timeline-segments';
import { TIMELINE_PROBE_ON, TimelineProbe } from './TimelineProbe';
import { TimelineVirtuoso } from './TimelineVirtuoso';

function IdeDisconnected({ ideLabel, error }: { ideLabel: string; error: string | null }) {
  const fixText = `${ideLabel} 未连接：先确认它开着 —— lifeline 会自动退出并用调试参数重新打开它（约 2 秒），不需要手动操作。手动"退出再打开"没用：这个版本不读 argv.json。`;
  return (
    <div className="tl-hint">
      <Plug size={28} color="var(--text-weak)" />
      <div className="text-[length:var(--text-body)] text-[var(--text-secondary)]">
        {ideLabel}
        {' '}
        未连接
      </div>
      <div className="max-w-[420px] leading-[1.6]">
        确认
        {' '}
        {ideLabel}
        {' '}
        已经打开 —— lifeline 会自动退出并用调试参数重新打开它（约 2 秒），不需要手动操作。
        <div className="text-[var(--text-weak)]">
          手动「退出再打开」没有用：这个版本不读
          {' '}
          <span className="mono">argv.json</span>
          。
        </div>
        {error && (
          <div className="mono mt-1.5 text-[11px]">
            最近错误：
            {error}
          </div>
        )}
      </div>
      <CopyButton text={fixText} label="复制修复说明" />
    </div>
  );
}

/**
 * The content source explicitly answered "this machine has no such session": do not keep drawing a skeleton and waiting.
 * The cause is not knowable from here — usually a freshly created session with no first message yet; for a remote (SSH)
 * window the session lives on the remote host's disk, which this machine cannot read unless the remote host also runs lifeline.
 * One copy covers both ("通常" / "如果"): remote detection from window title/url is heuristic and can silently miss.
 * Rendered as a centered card (tl-hint fills the timeline) so the composer stays docked at the bottom.
 */
function SessionMissingNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="tl-hint">
      <div className="surface-card w-full max-w-[440px] px-4 py-3.5 text-center">
        <div className="flex items-center justify-center gap-2 text-[var(--text-primary)]">
          <FileDashed size={18} color="var(--text-secondary)" />
          <span className="font-medium">这台电脑上还没有这个会话的内容</span>
        </div>
        <div className="mt-2 text-[length:var(--text-chrome)] leading-[1.7] text-[var(--text-secondary)]">
          如果这是远程（SSH）窗口的会话：需要远程机器和本机都安装并运行 lifeline 才能看到。
        </div>
        <div className="mt-2.5 flex justify-center">
          <button type="button" onClick={onRetry} className="btn btn-ghost">
            重试
          </button>
        </div>
      </div>
    </div>
  );
}

/** P8d: timeline source unavailable — inline card (live state and sending are unaffected; dual-lane UI expression) */
function SourceUnavailable({ reason, onRetry }: { reason: string; onRetry: () => void }) {
  return (
    <div className="surface-card mx-4 mt-2.5 flex items-center gap-2.5 px-3.5 py-3 text-[length:var(--text-chrome)]">
      <CloudArrowDown size={18} color="var(--text-weak)" />
      <div className="flex-1">
        <div className="text-[var(--text-secondary)]">会话内容暂不可用</div>
        <div className="mono text-[11px] text-[var(--text-weak)]">{reason}</div>
      </div>
      <button type="button" onClick={onRetry} className="btn btn-ghost">
        重试
      </button>
    </div>
  );
}

/** Wait before showing the skeleton: a cache/prefetch fast reply should not flash (same as P0 launch-state anti-flicker) */
const SKELETON_APPEAR_AFTER_MS = 200;

/**
 * Skeleton while the body is fetching: laid out with the real rhythm (peer body full-width, own right bubble) and pinned to the bottom,
 * so the visual landing matches when the body arrives; the last row reuses the timeline's three-dot breathing to say "still fetching".
 */
function TimelineSkeleton() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(setShown, SKELETON_APPEAR_AFTER_MS, true);
    return () => window.clearTimeout(t);
  }, []);
  // Placeholder until the threshold so the whole block does not jump in height when the body arrives
  if (!shown)
    return <div className="flex min-h-0 flex-1 flex-col" />;
  return (
    <div className="tl-skel" role="status">
      <span className="sr-only">会话加载中…</span>
      <div className="content-col flex flex-col gap-2.5 px-4" aria-hidden>
        <div className="tl-skel-line w-[58%]" />
        <div className="tl-skel-line w-[86%]" />
        <div className="tl-skel-line w-[46%]" />
      </div>
      <div className="content-col mt-3.5 flex justify-end px-4" aria-hidden>
        <div className="tl-skel-bubble w-[52%]" />
      </div>
      <div className="content-col mt-3.5 flex flex-col gap-2.5 px-4" aria-hidden>
        <div className="tl-skel-line w-[74%]" />
        <div className="tl-skel-line w-[40%]" />
      </div>
      <div className="content-col mt-3.5 flex justify-end px-4" aria-hidden>
        <div className="tl-skel-bubble w-[34%]" />
      </div>
      <div className="content-col mt-2 flex px-4" aria-hidden>
        <span className="tl-loading">
          <span />
          <span />
          <span />
        </span>
      </div>
    </div>
  );
}

/**
 * Timeline: thin wrapper around the react-virtuoso core (`TimelineVirtuoso`).
 *
 * Owns the empty/loading states (disconnected / missing / source-unavailable / skeleton / draft) and the
 * store derivation; all scroll/windowing/paging/position concerns live in the core. The AppShell remounts
 * this whole tree per session via `key={liveKey}` — a session switch starts from clean component state
 * (no leaked window state; the core restores the reading position from its snapshot).
 */
const EMPTY_KEYS: string[] = [];

export function Timeline() {
  const selectedIde = useIdesStore(s => s.selectedIde);
  const state = useIdesStore(s => s.ides[selectedIde]);
  const machineContentOnly = useMachinesStore(
    s => s.machines.find(m => m.agentId === s.selectedAgentId)?.contentOnly === true,
  );
  const pendingSwitch = useUiStore(s => s.pendingSwitch);
  const pendingHere = pendingSwitch && pendingSwitch.ide === selectedIde ? pendingSwitch : null;
  const pendingNewHere = usePendingNewChat();
  const viewedTab = viewedTabOf(state, pendingHere);
  const liveKey = useLiveSessionKey();
  const body = useSessionsStore(s => (liveKey ? s.bodies[liveKey] : undefined));
  const sessionMissing = useSessionsStore(s => (liveKey ? s.unavailable[liveKey] === true : false));
  const pendingSends = useSessionsStore(s => s.pendingSends);
  const scrollerRef = useRef<HTMLElement | null>(null);

  // Delivered pending sends: refresh their elapsed-time display every 3s (same as the old implementation)
  const hasDelivered = Object.values(pendingSends).some(p => p.state === 'delivered');
  const [, forceTick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!hasDelivered)
      return;
    const t = window.setInterval(forceTick, 3000);
    return () => window.clearInterval(t);
  }, [hasDelivered]);

  // Send → jump to the bottom (Composer's requestScrollToBottom)
  const bottomNonce = useUiStore(s => s.bottomNonce);
  useEffect(() => {
    if (bottomNonce === 0)
      return;
    const sc = scrollerRef.current;
    if (sc)
      sc.scrollTop = sc.scrollHeight;
  }, [bottomNonce]);

  // Probe (live-capture mode) keys — only allocate when the probe is on
  const segKeys = useMemo(
    () => (TIMELINE_PROBE_ON ? segmentize(body ?? []).map(s => s.key) : EMPTY_KEYS),
    [body],
  );

  if (state && state.connected === false && !machineContentOnly)
    return <IdeDisconnected ideLabel={IDE_LABELS[selectedIde]} error={state.lastExtractionError ?? null} />;

  if (!liveKey) {
    // Create in flight (the ＋ was just clicked): show the empty-session hint now instead of the previous session's
    // body or a "no session open" line — the row in the rail already says 新会话.
    if (pendingNewHere) {
      return (
        <div className="tl-hint">
          新会话（草稿）—— 在下方输入框发一条消息就能开始。
        </div>
      );
    }
    if (isDraftTab(viewedTab)) {
      return (
        <div className="tl-hint">
          {viewedTab?.draftText
            ? '新会话（草稿）—— 草稿里的文字已填进下方输入框，可以直接发送。'
            : '新会话（草稿）—— 在下方输入框发一条消息就能开始。'}
        </div>
      );
    }
    return (
      <div className="tl-hint">
        当前没有打开的会话 —— 从左侧选一台机器，或点窗口分组头部的 ＋ 新建会话。
      </div>
    );
  }

  const sourceUnavailable = state?.contentSource === 'unavailable';
  const retrySource = () => {
    const sessionId = liveKey.slice(liveKey.indexOf(':') + 1);
    socket.emit('session:get', { sessionId, ide: selectedIde, force: true });
  };

  if (!body) {
    if (sessionMissing)
      return <SessionMissingNotice onRetry={retrySource} />;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {sourceUnavailable && <SourceUnavailable reason={state?.lastExtractionError ?? '内容源读取失败'} onRetry={retrySource} />}
        <TimelineSkeleton />
      </div>
    );
  }

  // Empty session (body === []): keep the legacy hint instead of a blank pane (core returns null on zero segments)
  if (body.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {sourceUnavailable && <SourceUnavailable reason={state?.lastExtractionError ?? '内容源读取失败'} onRetry={retrySource} />}
        <div className="tl-hint">
          {sourceUnavailable ? '恢复后可继续浏览与发送' : '会话为空 —— 在下方输入框发一条消息试试。'}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sourceUnavailable && <SourceUnavailable reason={state?.lastExtractionError ?? '内容源读取失败'} onRetry={retrySource} />}
      {TIMELINE_PROBE_ON && <TimelineProbe keys={segKeys} />}
      <TimelineVirtuoso sessionKey={liveKey} bindScroller={el => (scrollerRef.current = el)} />
    </div>
  );
}
