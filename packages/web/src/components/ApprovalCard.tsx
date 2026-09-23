import type { Approval } from '../net/protocol';
import { sendCommand } from '../net/socket';
import { useIdesStore } from '../store/ides';

export function ApprovalCard({ approval }: { approval: Approval }) {
  const selectedIde = useIdesStore(s => s.selectedIde);
  const approves = approval.actions.filter(a => a.type === 'approve');
  const approveAlls = approval.actions.filter(a => a.type === 'approve_all');
  const rejects = approval.actions.filter(a => a.type === 'reject');

  const act = (event: 'command:approve' | 'command:reject' | 'command:approve_all', selectorPath: string) => {
    sendCommand(event, { ide: selectedIde, approvalId: approval.id, selectorPath });
  };

  return (
    <div className="rounded-b-[var(--radius-md)] border-t-2 border-[var(--warning)] bg-[var(--bg-2)] px-3.5 pb-3 pt-2.5">
      <div className="eyebrow mb-1 !text-[var(--warning)]">待审批</div>
      <div className="whitespace-pre-wrap text-[length:var(--text-body)] text-[var(--text-primary)] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:4] overflow-hidden">
        {approval.description}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {/* There can be more than one accept (Cursor's Run / Always Run 'pnpm'): draw them all,
            first as the primary button, the rest as soft buttons. Drawing only the first would make the allowlist unreachable. */}
        {approves.map((a, i) => (
          <button
            key={a.selectorPath}
            type="button"
            onClick={() => act('command:approve', a.selectorPath)}
            className={i === 0 ? 'btn btn-primary min-h-11 lg:min-h-8 px-[18px]' : 'btn btn-soft min-h-11 lg:min-h-8'}
          >
            {a.label || 'Accept'}
          </button>
        ))}
        {approveAlls.map(a => (
          <button key={a.selectorPath} type="button" onClick={() => act('command:approve_all', a.selectorPath)} className="btn btn-soft min-h-11 lg:min-h-8">
            {a.label || '全部接受'}
          </button>
        ))}
        {rejects.map(reject => (
          <button key={reject.selectorPath} type="button" onClick={() => act('command:reject', reject.selectorPath)} className="btn btn-ghost min-h-11 lg:min-h-8">
            {reject.label || 'Reject'}
          </button>
        ))}
      </div>
    </div>
  );
}
