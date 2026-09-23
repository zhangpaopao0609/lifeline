import type { MachineInfo } from '../net/protocol';
import { CaretLeft, DotsThree } from '@phosphor-icons/react';
import { useState } from 'react';
import { machineCommandOs, useInstallOs } from '../lib/enroll-os';
import { machineLabel } from '../lib/machine-name';
import { isOutdated } from '../lib/version';
import { uninstallCommand, updateCommand } from '../net/enroll';
import { socket } from '../net/socket';
import { useMachinesStore } from '../store/machines';
import { useUiStore } from '../store/ui';
import { CommandBlock } from './CommandBlock';
import { FloatLayer } from './FloatLayer';
import { MachineEditDialog } from './MachineEditDialog';
import { installOsHint, OsSwitch } from './OsSwitch';

/**
 * "← Back" row at the top of a sub-panel. After swapping content inside a popover there must be a way back —
 * "close then click ⋯ again" does not count (2026-09-20 feedback: after Uninstall you couldn't get back to the menu).
 */
function PanelBack({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-1.5 flex items-center gap-1 rounded-[var(--radius-sm)] border-0 bg-transparent px-1 py-0.5 text-[length:var(--text-chrome)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
    >
      <CaretLeft size={12} weight="bold" />
      {' '}
      返回
    </button>
  );
}

/** Machine-row ⋯ menu (spec P5): edit (dialog), version/update, uninstall-command overlay; forget an offline machine (two-step confirm, machine:forget ack). */
export function MachineRowMenu({ machine }: { machine: MachineInfo }) {
  const installOs = useInstallOs();
  // The command will run on **this machine**: if it reported an OS, use that; don't guess from the UA of the browser viewing the page
  // (clicking Uninstall on a Windows machine from a Mac must yield the PowerShell command).
  // Older agents that don't report a platform fall back to the OS switch.
  const machineOs = machineCommandOs(machine.platform);
  const os = machineOs ?? installOs;
  const osHint = installOsHint(os);
  const pushToast = useUiStore(s => s.pushToast);
  const cliLatest = useMachinesStore(s => s.cliLatest);
  const [open, setOpen] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [showUninstall, setShowUninstall] = useState(false);
  const [showUpdate, setShowUpdate] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  // Offer update only when we know the version and it is actually behind: older agents omit version, and an npm-installed
  // dev CLI is 0.0.0-dev — neither should be pushed to run install.sh (that would put another copy on PATH).
  const outdated = isOutdated(machine.cliVersion, cliLatest);

  /** Back to the menu root: shared by sub-panels (update / uninstall / delete confirm). */
  const closePanel = () => {
    setShowUpdate(false);
    setShowUninstall(false);
    setConfirmForget(false);
  };

  const forget = () => {
    socket.emit('machine:forget', { agentId: machine.agentId }, (r: { ok: boolean }) => {
      pushToast(r.ok ? `已删除 ${machineLabel(machine)}` : '删除失败', r.ok ? 'ok' : 'error');
    });
    setOpen(false);
    closePanel();
  };

  return (
    <>
      <FloatLayer
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Closing returns to the menu root: otherwise the next ⋯ click is still on the "Uninstall this computer" page.
          if (!next)
            closePanel();
        }}
        side="right"
        label={machineLabel(machine)}
        trigger={(
          <button type="button" aria-label={`${machineLabel(machine)} 操作`} className="icon-btn min-h-11 min-w-11 shrink-0">
            <DotsThree size={18} weight="bold" />
          </button>
        )}
      >
        {showUpdate ? (
          <div className="px-1 py-1.5">
            <PanelBack onClick={closePanel} />
            <div className="mb-1 font-semibold">更新这台电脑</div>
            <div className="mb-2.5 text-[length:var(--text-chrome)] text-[var(--text-weak)]">
              在该电脑上执行：下载新版 CLI，并重启守护进程生效。
              {machine.cliVersion && (
                <>
                  {' '}
                  当前
                  <span className="mono">
                    v
                    {machine.cliVersion}
                  </span>
                  {' → '}
                  <span className="mono">
                    v
                    {cliLatest}
                  </span>
                </>
              )}
            </div>
            {/* If the machine reported an OS, don't show the switch: picking the wrong one would ship the wrong command.
                Only older agents that omit it need a manual pick. Put the switch **above** the command (same reading
                order as the add-computer dialog: pick OS, then the command), and only then reserveHint — being able
                to switch OS means the hint row will change, so that line of height must be held. */}
            {machineOs === undefined && <OsSwitch />}
            <CommandBlock cmd={updateCommand(undefined, os)} hint={osHint} reserveHint={machineOs === undefined} />
          </div>
        ) : showUninstall ? (
          <div className="px-1 py-1.5">
            <PanelBack onClick={closePanel} />
            <div className="mb-1 font-semibold">卸载这台电脑</div>
            <div className="mb-2.5 text-[length:var(--text-chrome)] text-[var(--text-weak)]">
              在该电脑上执行：守护进程停止运行，并撤销 IDE 启动参数（CDP）。
            </div>
            {machineOs === undefined && <OsSwitch />}
            <CommandBlock cmd={uninstallCommand(undefined, os)} hint={osHint} reserveHint={machineOs === undefined} />
          </div>
        ) : (
          <>
            {machine.cliVersion && (
              <div className="px-2.5 py-1.5 text-[length:var(--text-chrome)] text-[var(--text-weak)]">
                agent
                {' '}
                <span className="mono">
                  v
                  {machine.cliVersion}
                </span>
                {outdated && (
                  <>
                    {' '}
                    · 可更新到
                    <span className="mono">
                      v
                      {cliLatest}
                    </span>
                  </>
                )}
              </div>
            )}
            {/* Name is only the first field: the entry is always "Edit"; later fields only touch MachineEditDialog, not this menu. */}
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                closePanel();
                setEditOpen(true);
              }}
            >
              编辑…
            </button>
            {outdated && (
              <button type="button" className="menu-item" onClick={() => setShowUpdate(true)}>
                更新这台电脑…
              </button>
            )}
            <button type="button" className="menu-item" onClick={() => setShowUninstall(true)}>
              卸载这台电脑…
            </button>
            {!machine.connected && (
              confirmForget
                ? (
                    <div className="px-2.5 py-2">
                      <div className="mb-2 text-[length:var(--text-chrome)] text-[var(--text-secondary)]">
                        删除
                        {' '}
                        {machineLabel(machine)}
                        ？服务端存的会话镜像会一起清掉；守护进程还在的话，下次连上会重新出现。
                      </div>
                      <div className="flex gap-2">
                        <button type="button" onClick={forget} className="btn btn-danger">
                          确认删除
                        </button>
                        <button type="button" onClick={() => setConfirmForget(false)} className="btn btn-ghost">
                          取消
                        </button>
                      </div>
                    </div>
                  )
                : (
                    <button type="button" className="menu-item text-[var(--error)]" onClick={() => setConfirmForget(true)}>
                      删除…
                    </button>
                  )
            )}
          </>
        )}
      </FloatLayer>
      {editOpen && <MachineEditDialog machine={machine} onClose={() => setEditOpen(false)} />}
    </>
  );
}
