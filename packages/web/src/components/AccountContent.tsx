import type { AuthKind } from '@lifeline/protocol';
import { ArrowRight } from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { APP_VERSION } from '../lib/app-version';
import { LANDING_PATH } from '../lib/routes';
import { useUserStore } from '../store/user';
import { Avatar } from './Avatar';

const SHORTCUTS: [string, string][] = [
  ['⌘K', '命令面板'],
  ['Enter', '发送'],
  ['Shift+Enter', '换行'],
  ['⌘↩ / Ctrl+↩', '发送（触屏键盘）'],
];

/** Login-method label: driven by authKind from the server; older servers omit it, so fall back to whether userId is set. */
function authLabel(userId: string, authKind?: AuthKind): string {
  switch (authKind) {
    case 'password':
      return '密码登录';
    case 'trusted-header':
      return '网关登录';
    case 'none':
      return '本机模式';
    default:
      return userId ? '已登录' : '未登录';
  }
}

export function AccountContent() {
  const userId = useUserStore(s => s.userId);
  const avatar = useUserStore(s => s.avatar);
  const authKind = useUserStore(s => s.authKind);
  const isDesktop = useIsDesktop();

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3 px-2.5 pb-3.5 pt-1.5">
        <Avatar src={avatar} name={userId} size={40} />
        <div>
          <div className="font-semibold">{userId || '本地模式'}</div>
          <div className="text-[length:var(--text-chrome)] text-[var(--text-weak)]">{authLabel(userId, authKind)}</div>
        </div>
      </div>

      {isDesktop && (
        <div className="border-t border-[var(--hairline)] p-2.5">
          <div className="mb-1.5 text-[length:var(--text-chrome)] text-[var(--text-weak)]">键盘快捷键</div>
          {SHORTCUTS.map(([key, desc]) => (
            <div key={key} className="flex justify-between py-0.5 text-[length:var(--text-chrome)]">
              <span className="text-[var(--text-secondary)]">{desc}</span>
              <kbd className="mono text-[var(--text-weak)]">{key}</kbd>
            </div>
          ))}
        </div>
      )}

      <Link to={LANDING_PATH} className="menu-item border-t border-[var(--hairline)]">
        Lifeline 是什么
        <ArrowRight size={14} className="ml-auto text-[var(--text-weak)]" />
      </Link>

      <div className="border-t border-[var(--hairline)] p-2.5 text-[length:var(--text-chrome)] text-[var(--text-weak)]">
        Lifeline v
        {APP_VERSION}
        {' '}
        · 把你的 IDE 装进口袋
      </div>
    </div>
  );
}
