import { Broadcast, CheckCircle } from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import { Avatar } from '../components/Avatar';
import { CommandBlock } from '../components/CommandBlock';
import { installOsHint, OsSwitch } from '../components/OsSwitch';
import { useInstallOs } from '../lib/enroll-os';
import { LANDING_PATH } from '../lib/routes';
import { installCommand, setupCommand } from '../net/enroll';
import { useConnectionStore } from '../store/connection';
import { useUserStore } from '../store/user';

export function OnboardingPage() {
  const installOs = useInstallOs();
  const userId = useUserStore(s => s.userId);
  const avatar = useUserStore(s => s.avatar);
  const connStatus = useConnectionStore(s => s.status);

  return (
    <div className="flex h-full justify-center overflow-y-auto p-4 sm:p-8">
      <div className="my-auto w-full max-w-[720px] rounded-[var(--radius-lg)] border border-[var(--hairline)] bg-[var(--bg-1)] p-6 sm:p-7">
        <div className="flex items-center gap-2 font-bold tracking-wide">
          <Broadcast size={20} color="var(--accent)" />
          Lifeline
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[var(--text-secondary)]">把你的 CodeBuddy / Cursor 装进口袋</span>
          <Link
            to={LANDING_PATH}
            className="border-0 bg-transparent p-0 text-[length:var(--text-chrome)] text-[var(--accent)]"
          >
            Lifeline 是什么 →
          </Link>
        </div>

        <div className="my-5 border-t border-[var(--hairline)]" />

        <OsSwitch />

        <CommandBlock
          className="mb-[18px]"
          title="① 安装 CLI"
          cmd={installCommand(undefined, installOs)}
          hint={installOsHint(installOs)}
          reserveHint
        />
        <CommandBlock className="mb-[18px]" title="② 启动并登录" cmd={setupCommand()} />

        <div className="flex items-center gap-2 text-[length:var(--text-chrome)]">
          {connStatus === 'online'
            ? (
                <>
                  <span className="tl-loading">
                    <span />
                    <span />
                    <span />
                  </span>
                  <span className="text-[var(--accent)]">③ 等待电脑上线 —— 检测到后自动进入，无需刷新</span>
                </>
              )
            : (
                <>
                  <CheckCircle size={14} color="var(--error)" />
                  <span className="text-[var(--error)]">③ 连接中断，重连中…</span>
                </>
              )}
        </div>

        <div className="my-5 border-t border-[var(--hairline)]" />

        <div className="flex items-center gap-2.5">
          <Avatar src={avatar} name={userId} size={28} />
          <span className="text-[length:var(--text-chrome)] text-[var(--text-secondary)]">
            {userId || '本地模式'}
            {' '}
            已登录
          </span>
        </div>
        <div className="mt-2.5 text-[length:var(--text-chrome)] text-[var(--text-weak)]">
          接入会写入 IDE 启动参数，需完全退出再打开一次。
        </div>
      </div>
    </div>
  );
}
