import { CopyButton } from './CopyButton';

/**
 * One "type this" command: title row (title left / copy right) + command body + hint row.
 *
 * Four render sites (landing page / empty enroll state / add-computer dialog / machine-row menu update·uninstall)
 * share this layout. The machine-row menu used to roll its own: copy button and OS switch sat on the same
 * inline-flex row, and the command was clipped at the 380px overlay (2026-09-20 feedback).
 */
export function CommandBlock({
  title,
  cmd,
  hint,
  reserveHint = false,
  className = '',
}: {
  /** Small title at top-left (e.g. `① 安装 CLI`). The two menu sites have no numbering; omit it and only the top-right copy button remains. */
  title?: string;
  cmd: string;
  /** Weak hint under the command (Windows: "run in PowerShell (not cmd)"). */
  hint?: string | null;
  /**
   * **Reserve one line of height** for the hint. The hint is OS-specific (Windows only): insert when present,
   * drop when absent. The overlay is centered, so switching OS would jump the whole dialog (2026-09-20 feedback).
   * Criterion = this panel can switch OS (has `OsSwitch`); no switch means no reserved height.
   */
  reserveHint?: boolean;
  className?: string;
}) {
  const hintText = hint ?? '';
  const showHint = reserveHint || hintText !== '';
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="text-[length:var(--text-chrome)] text-[var(--text-secondary)]">{title ?? ''}</span>
        <CopyButton text={cmd} />
      </div>
      <pre className="cmd-pre mono">{cmd}</pre>
      {showHint
        ? (
            <div
              className={`mt-1 text-[length:var(--text-chrome)] text-[var(--text-weak)] ${reserveHint ? 'min-h-[1.5em]' : ''}`}
            >
              {hintText}
            </div>
          )
        : null}
    </div>
  );
}
