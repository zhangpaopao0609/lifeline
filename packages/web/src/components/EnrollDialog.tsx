import { useInstallOs } from '../lib/enroll-os';
import { installCommand, setupCommand } from '../net/enroll';
import { CommandBlock } from './CommandBlock';
import { FloatLayer } from './FloatLayer';
import { installOsHint, OsSwitch } from './OsSwitch';

/** ＋ Add a computer (spec P5): reuses the P1 wizard — centered overlay on desktop / bottom sheet on phone. */
export function EnrollDialog({ onClose }: { onClose: () => void }) {
  const installOs = useInstallOs();
  return (
    <FloatLayer
      variant="modal"
      label="添加电脑"
      onOpenChange={(o) => {
        if (!o)
          onClose();
      }}
    >
      <div className="mb-1 font-semibold">添加电脑</div>
      <div className="mb-3 text-[length:var(--text-chrome)] text-[var(--text-weak)]">
        在要接入的电脑上执行以下命令，上线后自动出现在机器列表。
      </div>
      <OsSwitch />

      <CommandBlock
        className="mb-3.5"
        title="① 安装 CLI"
        cmd={installCommand(undefined, installOs)}
        hint={installOsHint(installOs)}
        reserveHint
      />
      <CommandBlock className="mb-3.5" title="② 启动并登录" cmd={setupCommand()} />
      <div className="text-[length:var(--text-chrome)] text-[var(--text-weak)]">
        接入会写入 IDE 启动参数，需完全退出再打开一次。
      </div>
    </FloatLayer>
  );
}
