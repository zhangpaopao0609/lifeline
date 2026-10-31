import type { ChatElement } from '../net/protocol';
import type { ActiveTarget } from '../store/cli';
import { cliSession, cliSourceLabel, cliStatusLabel, dispatchCli, useCliStore } from '../store/cli';
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
  return (
    <div className="flex flex-col overflow-y-auto" style={{ flex: 1, minHeight: 0 }}>
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
      <div className="content-col flex flex-col gap-2 px-4 py-3">
        {session?.messages.map(message => (
          <CliMessage key={message.id} message={message} />
        ))}
      </div>
    </div>
  );
}
