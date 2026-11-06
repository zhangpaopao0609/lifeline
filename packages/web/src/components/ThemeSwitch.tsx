import { Moon, Sun } from '@phosphor-icons/react';
import { switchTheme, useThemeStore } from '../store/theme';

const OPTIONS = [
  ['light', '浅色'],
  ['dark', '深色'],
  ['system', '跟随系统'],
] as const;

/** One click beside the account menu: dark shows a sun, light shows a moon. System stays in the menu. */
export function ThemeToggle({ className = 'icon-btn' }: { className?: string }) {
  const theme = useThemeStore(s => s.theme);
  const toLight = theme === 'dark';
  return (
    <button
      type="button"
      aria-label={toLight ? '切换到浅色' : '切换到深色'}
      title={toLight ? '浅色' : '深色'}
      onClick={() => switchTheme(toLight ? 'light' : 'dark')}
      className={className}
    >
      {toLight ? <Sun size={20} /> : <Moon size={20} />}
    </button>
  );
}

export function ThemeSwitch() {
  const preference = useThemeStore(s => s.preference);
  return (
    <div>
      <div className="mb-1.5 text-[length:var(--text-chrome)] text-[var(--text-weak)]">外观</div>
      <div role="group" aria-label="外观" className="flex gap-0.5 rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--bg-0)] p-0.5 text-[length:var(--text-chrome)]">
        {OPTIONS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={preference === value}
            onClick={() => switchTheme(value)}
            className={`min-h-11 flex-1 whitespace-nowrap rounded-[var(--radius-sm)] border-0 px-2.5 py-1 lg:min-h-9 ${
              preference === value
                ? 'bg-[var(--bg-3)] font-semibold text-[var(--text-primary)]'
                : 'bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
