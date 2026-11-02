import type { CliApproval, CliApprovalOption } from '../net/protocol';
import type { CliApprovalCardState } from '../store/cli';

export function CliApprovalCard({
  approval,
  card,
  onChoose,
  onCancel,
}: {
  approval: CliApproval;
  card: CliApprovalCardState;
  onChoose: (option: CliApprovalOption) => void;
  onCancel: () => void;
}) {
  const hasReject = approval.options.some(option => option.kind === 'reject_once');
  return (
    <fieldset disabled={card.disabled} className="m-0 min-w-0 border-0 p-0">
      <div className="rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--bg-2)] px-3.5 py-2.5">
        <div className="eyebrow mb-1 !text-[var(--warning)]">待审批</div>
        <div className="whitespace-pre-wrap break-words text-[length:var(--text-body)] text-[var(--text-primary)]">{approval.title}</div>
        {card.notice === 'already-resolved' && (
          <p className="mt-1 text-[length:var(--text-chrome)] text-[var(--text-secondary)]">该审批已处理</p>
        )}
        {card.notice === 'unsupported-permission-option' && (
          <p className="mt-1 text-[length:var(--text-chrome)] text-[var(--text-secondary)]">不支持这个选项</p>
        )}
        <div className="mt-2.5 flex flex-wrap gap-2">
          {approval.options.map(option => (
            <button
              key={option.optionId}
              type="button"
              disabled={card.disabled || option.kind === 'unknown'}
              onClick={() => onChoose(option)}
              className={option.kind === 'reject_once' || option.kind === 'unknown'
                ? 'btn btn-ghost min-h-11 lg:min-h-8'
                : 'btn btn-primary min-h-11 lg:min-h-8 px-[18px]'}
            >
              {option.label}
            </button>
          ))}
          {!hasReject && (
            <button type="button" onClick={onCancel} className="btn btn-ghost min-h-11 lg:min-h-8">
              取消请求
            </button>
          )}
        </div>
      </div>
    </fieldset>
  );
}
