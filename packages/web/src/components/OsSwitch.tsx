import type { InstallOs } from '../lib/enroll-os';
import { setInstallOs, useInstallOs } from '../lib/enroll-os';

/**
 * OS switch for the enroll-command area (`macOS/Linux | Windows`).
 *
 * Initial value comes from the browser UA, so a Windows user sees their own command on first open without hunting docs.
 * Built as a **one-row** segmented control (track + selected block, same kit as `MobileSwitcher`): no extra height on phone.
 * Module-level singleton + `useSyncExternalStore`, so switching here syncs all 5 render sites.
 */
export function OsSwitch() {
  const os = useInstallOs();
  const option = (value: InstallOs, label: string) => (
    <button
      type="button"
      onClick={() => setInstallOs(value)}
      // Selected state must not rely on color alone (color-vision / high-contrast modes would lose the information).
      aria-pressed={os === value}
      className={
        `rounded-[var(--radius-sm)] border-0 px-2.5 py-1 transition-colors ${
          os === value
            ? 'bg-[var(--bg-3)] text-[var(--text-primary)]'
            : 'bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`
      }
    >
      {label}
    </button>
  );
  return (
    // Track uses the darkest bg-0 + a hairline: this control sits on both bg-1 (card / dialog) and bg-2 (machine-row menu overlay).
    // `w-fit` is required: dialog (flex column) / landing (grid) parents stretch children by default; without it the track goes full-bleed
    // — previously there was no track fill so it was invisible; with fill it would become a bar across the whole row.
    <div
      role="group"
      aria-label="命令对应的系统"
      className="mb-3 inline-flex w-fit items-center gap-0.5 rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--bg-0)] p-0.5 text-[length:var(--text-chrome)]"
    >
      {option('unix', 'macOS/Linux')}
      {option('windows', 'Windows')}
    </div>
  );
}

/**
 * Hint next to Windows commands. `irm` / `iex` exist only in PowerShell; pasting into cmd errors immediately,
 * so this line is not decoration.
 */
export function installOsHint(os: InstallOs): string | null {
  return os === 'windows' ? '在 PowerShell 中运行（不是 cmd）' : null;
}
