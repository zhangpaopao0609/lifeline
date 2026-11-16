import { ArrowLeft } from '@phosphor-icons/react';
import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect } from 'react';
import { socket } from '../net/socket';
import { sessionBodyKey, useSessionsStore } from '../store/sessions';
import { TimelineVirtuoso } from './TimelineVirtuoso';

/** Read saved Cursor children without switching the IDE or exposing its composer. */
export function SubagentView({ sessionId, title, onClose }: { sessionId: string; title: string; onClose: () => void }) {
  const key = sessionBodyKey(sessionId, 'cursor');
  const body = useSessionsStore(s => s.bodies[key]);
  const unavailable = useSessionsStore(s => s.unavailable[key]);

  const request = useCallback((force = false) => {
    const sessions = useSessionsStore.getState();
    if (!socket.connected || document.hidden || (!force && sessions.unavailable[key]))
      return;
    socket.emit('session:get', { sessionId, ide: 'cursor', sinceSeq: sessions.bodySeq[key], ...(force ? { force } : {}) });
  }, [key, sessionId]);

  useEffect(() => {
    const refresh = () => request();
    refresh();
    // Renew the agent's bounded follow window; unchanged bodies reconcile with seq only.
    const timer = window.setInterval(refresh, 30_000);
    socket.on('connect', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      socket.off('connect', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [request]);

  return (
    <Dialog.Root open onOpenChange={open => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-[70] flex flex-col bg-[var(--bg-0)] lg:inset-auto lg:left-1/2 lg:top-1/2 lg:h-[85dvh] lg:w-[min(900px,90vw)] lg:-translate-x-1/2 lg:-translate-y-1/2 lg:rounded-[var(--radius-lg)] lg:border lg:border-[var(--hairline)]"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--hairline)] px-3 py-2.5">
            <button type="button" onClick={onClose} aria-label="返回父会话" className="icon-btn">
              <ArrowLeft size={20} />
            </button>
            <Dialog.Title className="min-w-0 flex-1 truncate font-semibold">{title}</Dialog.Title>
            <span className="text-[length:var(--text-chrome)] text-[var(--text-weak)]">子会话 · 只读</span>
          </div>
          {body?.length
            ? <TimelineVirtuoso key={key} sessionKey={key} />
            : (
                <div role="status" className="tl-hint">
                  {unavailable ? '子会话内容暂不可用' : body ? '子会话暂无内容' : '正在加载子会话…'}
                  <button type="button" onClick={() => request(true)} className="btn btn-ghost">刷新</button>
                </div>
              )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
