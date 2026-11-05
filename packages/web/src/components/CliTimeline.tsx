import type { ChatElement } from '../net/protocol';
import type { ActiveTarget } from '../store/cli';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cliScrollState, tailAppendCount } from '../lib/cli-scroll';
import { pillCount } from '../lib/new-message-pill';
import { cliSession, cliSourceLabel, cliStatusLabel, dispatchCli, useCliStore } from '../store/cli';
import { useUiStore } from '../store/ui';
import { ThoughtRow } from './ThoughtRow';

export function CliMessage({ message }: { message: ChatElement }) {
  if (message.type === 'human') {
    return <div className="bubble-human self-end whitespace-pre-wrap">{message.text}</div>;
  }
  if (message.type === 'assistant') {
    return <div className="whitespace-pre-wrap text-[length:var(--text-body)] text-[var(--text-primary)]">{message.text}</div>;
  }
  if (message.type === 'thought')
    return <ThoughtRow el={message} />;
  return <div className="text-[length:var(--text-chrome)] text-[var(--text-weak)]">{messageText(message)}</div>;
}

export function messageText(message: ChatElement): string {
  if (message.type === 'human' || message.type === 'assistant')
    return message.text;
  if (message.type === 'tool')
    return message.summaryText || message.action || '工具';
  if (message.type === 'thought')
    return message.action || message.detail || '';
  if (message.type === 'plan' || message.type === 'todo_list')
    return message.title;
  if (message.type === 'run_command')
    return message.description;
  if (message.type === 'loading')
    return message.text ?? '';
  if (message.type === 'notification')
    return message.title;
  return '';
}

export function CliTimeline({ target }: { target: Extract<ActiveTarget, { kind: 'cli' }> }) {
  const session = useCliStore(s => cliSession(s.cli, target.agentId, target.sessionId));
  const syncStatus = useCliStore(s => s.cli.agents[target.agentId]?.syncStatus ?? 'idle');
  const bottomNonce = useUiStore(s => s.bottomNonce);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // The component remounts per session (AppShell keys it), so opening a session starts here:
  // land on the latest output, then follow new output while the reader stays near the bottom.
  const followRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [pill, setPill] = useState(0);
  const messages = session?.messages;
  const prevIdsRef = useRef<string[]>(messages?.map(m => m.id) ?? []);

  const scrollToBottom = useCallback(() => {
    followRef.current = true;
    const sc = scrollerRef.current;
    if (sc)
      sc.scrollTop = sc.scrollHeight;
  }, []);

  // Pin whenever content or viewport changes size while following: the first full sync, appends,
  // streamed text growing in place, the phone keyboard resizing the viewport.
  useLayoutEffect(() => {
    const sc = scrollerRef.current;
    const list = listRef.current;
    if (!sc || !list)
      return;
    const pin = () => {
      if (followRef.current)
        sc.scrollTop = sc.scrollHeight;
    };
    pin();
    if (typeof ResizeObserver === 'undefined')
      return;
    const observer = new ResizeObserver(pin);
    observer.observe(list);
    observer.observe(sc);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const ids = messages?.map(m => m.id) ?? [];
    const grew = tailAppendCount(prevIdsRef.current, ids);
    prevIdsRef.current = ids;
    const sc = scrollerRef.current;
    if (sc && followRef.current)
      sc.scrollTop = sc.scrollHeight;
    else if (grew > 0)
      setPill(p => pillCount(p, { type: 'append', n: grew }));
  }, [messages]);

  // Sending from the composer jumps to the bottom (same contract as the IDE timeline).
  useEffect(() => {
    if (bottomNonce !== 0)
      scrollToBottom();
  }, [bottomNonce, scrollToBottom]);

  const onScroll = () => {
    const sc = scrollerRef.current;
    if (!sc)
      return;
    const state = cliScrollState(sc);
    followRef.current = state.follow;
    setShowJump(state.showJump);
    setPill(p => pillCount(p, { type: 'bottom', atBottom: state.follow }));
  };

  return (
    <div className="relative flex flex-col" style={{ flex: 1, minHeight: 0 }}>
      {/* tl-scroll: vertical-only scroller (overflow-x hidden) so a wide row cannot pan the session sideways on a phone. */}
      <div ref={scrollerRef} className="tl-scroll flex flex-col" onScroll={onScroll}>
        {syncStatus === 'sync-error' && (
          <div className="content-col mx-4 mt-2.5 flex items-center gap-2 text-[length:var(--text-chrome)] text-[var(--error)]">
            <span className="flex-1">同步失败</span>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => dispatchCli({ type: 'manual-retry', now: Date.now() })}
            >
              重试
            </button>
          </div>
        )}
        {!session && (
          <div className="tl-hint">这条命令行会话已经不在了。</div>
        )}
        {session?.status === 'starting' && (
          <div className="content-col px-4 pt-3 text-[length:var(--text-chrome)] text-[var(--text-weak)]">正在启动命令行…</div>
        )}
        {session?.awaitingFull && session.status !== 'starting' && (
          <div className="content-col px-4 pt-3 text-[length:var(--text-chrome)] text-[var(--text-weak)]">正在同步会话…</div>
        )}
        {session && session.messages.length === 0 && !session.awaitingFull && (
          <div className="tl-hint">
            {cliSourceLabel(target.source)}
            {' · '}
            {cliStatusLabel(session.status)}
            。在下方输入框发一条消息试试。
          </div>
        )}
        {/* mt-auto: a short session sits right above the composer (same as .tl-list in the IDE timeline).
            overflow-wrap: an unbreakable run (path / URL / hash) wraps inside the column, as .tl-item does. */}
        <div
          ref={listRef}
          className="content-col mt-auto flex flex-col gap-2 px-4 py-3"
          style={{ overflowWrap: 'anywhere' }}
        >
          {messages?.map(message => (
            <CliMessage key={message.id} message={message} />
          ))}
        </div>
      </div>
      {(showJump || pill > 0) && (
        <button
          type="button"
          className="btn btn-primary absolute bottom-3 right-4 z-10 rounded-full px-3.5 py-1.5 shadow-md"
          onClick={scrollToBottom}
        >
          {pill > 1 ? `${pill} 条新消息` : '回到底部'}
        </button>
      )}
    </div>
  );
}
