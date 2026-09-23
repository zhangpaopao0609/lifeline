import { Broadcast, DotsThree } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LANDING_PATH } from '../lib/routes';
import { useConnectionStore } from '../store/connection';
import { useUserStore } from '../store/user';
import { AccountContent } from './AccountContent';
import { Avatar } from './Avatar';
import { MachineList } from './MachineList';

function ConnStatus() {
  const status = useConnectionStore(s => s.status);
  const text = status === 'online' ? '已连接' : status === 'connecting' ? '连接中…' : '已断开';
  return (
    <span className="inline-flex items-center gap-1.5 text-[length:var(--text-chrome)] text-[var(--text-secondary)]">
      <span className={`dot ${status === 'online' ? 'bg-[var(--ok)]' : status === 'connecting' ? 'bg-[var(--accent)]' : 'bg-[var(--error)]'}`} />
      {text}
    </span>
  );
}

/** Desktop left rail: brand + connection state + machine list + account strip at the bottom (spec P2). */
export function Rail() {
  const userId = useUserStore(s => s.userId);
  const avatar = useUserStore(s => s.avatar);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen)
      return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-[var(--hairline)] bg-[var(--bg-1)]">
      <div className="border-b border-[var(--hairline)] px-3 pb-2.5 pt-3.5">
        {/* Brand slot is the landing-page entry: a real link, middle-click opens a new tab; coming back, the console is unchanged. */}
        <Link to={LANDING_PATH} className="brand-mark" title="Lifeline 是什么">
          <Broadcast size={18} color="var(--accent)" />
          Lifeline
        </Link>
        <div className="mt-1.5"><ConnStatus /></div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2.5">
        <div className="px-2.5 pb-1.5 text-[length:var(--text-chrome)] text-[var(--text-weak)]">机器</div>
        <MachineList />
      </div>

      <div ref={menuRef} className="relative border-t border-[var(--hairline)] p-2">
        {/* Account popover does not follow the rail's 240px: fixed 320px and overflow toward the session column, or everything is crammed together (2026-09-15 iteration feedback). */}
        {menuOpen && (
          <div className="anim-popover absolute bottom-full left-2 z-30 mb-1 w-[320px] rounded-[var(--radius-lg)] border border-[var(--hairline)] bg-[var(--bg-2)] p-2 shadow-[var(--shadow-overlay)]">
            <AccountContent />
          </div>
        )}
        <div className="flex items-center gap-2 px-1.5 py-1">
          <Avatar src={avatar} name={userId} size={28} />
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--text-chrome)]">
            {userId || '本地模式'}
          </span>
          <button
            type="button"
            aria-label="账户菜单"
            onClick={() => setMenuOpen(v => !v)}
            className="icon-btn"
          >
            <DotsThree size={20} weight="bold" />
          </button>
        </div>
      </div>
    </aside>
  );
}
