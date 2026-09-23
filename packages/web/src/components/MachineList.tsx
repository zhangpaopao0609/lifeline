import type { IdeKind } from '../net/protocol';
import { ArrowCircleUp, Cpu, Database, Plus, WarningCircle } from '@phosphor-icons/react';
import { useState } from 'react';
import { machineLabel } from '../lib/machine-name';
import { isOutdated } from '../lib/version';
import { IDE_KINDS, IDE_LABELS } from '../net/protocol';
import { useIdesStore } from '../store/ides';
import { useMachinesStore } from '../store/machines';
import { EnrollDialog } from './EnrollDialog';
import { MachineRowMenu } from './MachineRowMenu';

export function MachineList({ onNavigate }: { onNavigate?: () => void }) {
  const machines = useMachinesStore(s => s.machines);
  const selectedAgentId = useMachinesStore(s => s.selectedAgentId);
  // Server-published version: if the machine's agent is behind, badge "updatable" (command is in the ⋯ menu).
  const cliLatest = useMachinesStore(s => s.cliLatest);
  const selectMachine = useMachinesStore(s => s.selectMachine);
  const ides = useIdesStore(s => s.ides);
  const selectedIde = useIdesStore(s => s.selectedIde);
  const setSelectedIde = useIdesStore(s => s.setSelectedIde);
  const [enrollOpen, setEnrollOpen] = useState(false);
  // Content-only machines (remote dev boxes) don't occupy a machine slot: they have no live state, so they go in the "content sources" group, expandable to manage.
  const [showContentSources, setShowContentSources] = useState(false);
  const liveMachines = machines.filter(m => !m.contentOnly);
  const contentSources = machines.filter(m => m.contentOnly);

  const approvalsOf = (ide: IdeKind) => ides[ide]?.pendingApprovals?.length ?? 0;
  const ideConnected = (ide: IdeKind) => ides[ide]?.connected === true;

  return (
    <div className="flex flex-col gap-0.5">
      {liveMachines.map((m) => {
        const selected = m.agentId === selectedAgentId;
        return (
          <div key={m.agentId}>
            {/* Don't absolutely-position ⋯ over the row: a 44px hit area would cover the trailing "offline / updatable"
                copy and steal clicks from the IDE sub-rows below. Selection highlight is on the whole-row container,
                not the machine-name button — ⋯ is part of the row; highlighting only the button would leave a gap on the right. */}
            <div
              className={`flex items-center gap-0.5 rounded-[var(--radius-md)] transition-colors duration-[var(--duration-fast)] ${
                selected ? 'bg-[var(--accent-soft)]' : ''
              }`}
            >
              <button
                type="button"
                onClick={() => { selectMachine(m.agentId); onNavigate?.(); }}
                className={`flex min-w-0 flex-1 items-center gap-2 self-stretch border-0 bg-transparent px-2.5 py-2 text-left ${
                  m.connected ? 'text-[var(--text-primary)]' : 'text-[var(--text-weak)]'
                }`}
              >
                <span className={`dot ${m.connected ? 'bg-[var(--ok)]' : 'bg-[var(--text-weak)]'}`} />
                {/* If an alias was set, show the alias (hover reveals the real hostname): in a 240px rail the hostname
                    is often clipped to "paopaode...", which is exactly what the alias is for. */}
                <span
                  className="mono min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
                  title={m.displayName ? m.hostname : undefined}
                >
                  {machineLabel(m)}
                </span>
                {/* Offline machines don't show "updatable": you can't install now, and it would crowd hostname off next to "offline";
                    version and the update entry live in the ⋯ menu, so the info isn't lost. */}
                {m.connected && isOutdated(m.cliVersion, cliLatest) && (
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-[length:var(--text-chrome)] text-[var(--accent)]">
                    <ArrowCircleUp size={12} weight="fill" />
                    可更新
                  </span>
                )}
                {!m.connected && <span className="text-[length:var(--text-chrome)] text-[var(--text-weak)]">离线</span>}
              </button>
              <MachineRowMenu machine={m} />
            </div>

            {/* IDE sub-rows are expanded by default: you can see each IDE's status and pending approvals without clicking the machine. */}
            <div className="mt-1 flex flex-col gap-0.5">
              {IDE_KINDS.map((ide) => {
                // The selected machine uses the live store (faster); others only have the summary from machines:list.
                const status = selected
                  ? { connected: ideConnected(ide), pendingApprovals: approvalsOf(ide) }
                  : m.ides?.[ide];
                const n = status?.pendingApprovals ?? 0;
                // When the machine is offline, IDE status is frozen and a green dot would be a lie.
                const ideOnline = m.connected && status?.connected === true;
                const active = selected && ide === selectedIde;
                return (
                  <button
                    key={ide}
                    type="button"
                    onClick={() => { selectMachine(m.agentId); setSelectedIde(ide); onNavigate?.(); }}
                    className={`ml-5 flex w-[calc(100%-20px)] items-center gap-2 rounded-[var(--radius-md)] border-0 px-2.5 py-1.5 text-left text-[length:var(--text-chrome)] text-[var(--text-secondary)] ${
                      active ? 'bg-[var(--bg-3)]' : 'bg-transparent'
                    }`}
                  >
                    <Cpu size={14} />
                    <span className="flex-1">{IDE_LABELS[ide]}</span>
                    {/* No summary (older server): don't draw a dot. Not drawing = unknown, more honest than a gray dot. */}
                    {status && (
                      <span className={`dot-sm ${ideOnline ? 'bg-[var(--ok)]' : 'bg-[var(--text-weak)]'}`} />
                    )}
                    {n > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-[11px] text-[var(--accent)]">
                        <WarningCircle size={12} weight="fill" />
                        {n}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {contentSources.length > 0 && (
        <div className="mt-1 flex flex-col gap-0.5">
          <button
            type="button"
            aria-expanded={showContentSources}
            onClick={() => setShowContentSources(v => !v)}
            className="flex min-h-11 w-full items-center gap-2 rounded-[var(--radius-md)] border-0 bg-transparent px-2.5 py-2 text-left text-[length:var(--text-chrome)] text-[var(--text-weak)]"
          >
            <Database size={14} />
            <span className="flex-1">
              内容源 ·
              {contentSources.length}
            </span>
            <span>{showContentSources ? '收起' : '展开'}</span>
          </button>
          {showContentSources && contentSources.map((m) => {
            const selected = m.agentId === selectedAgentId;
            // Content sources must also be selectable: the server delivers body and conversation index for "the currently selected machine",
            // so you could never see this machine's sessions. Also switch to an IDE it actually has content for,
            // otherwise the list filters by the current IDE → it looks like "this machine has no sessions".
            const onSelect = () => {
              const ide = m.contentIdes?.[0];
              if (ide && !m.contentIdes?.includes(selectedIde))
                setSelectedIde(ide);
              selectMachine(m.agentId);
              onNavigate?.();
            };
            return (
              <div key={m.agentId} className="ml-5 flex items-center gap-1">
                <button
                  type="button"
                  onClick={onSelect}
                  className={`flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-md)] border-0 px-2.5 py-1.5 text-left transition-colors duration-[var(--duration-fast)] ${
                    selected ? 'bg-[var(--accent-soft)]' : 'bg-transparent'
                  }`}
                >
                  <span className={`dot-sm ${m.connected ? 'bg-[var(--ok)]' : 'bg-[var(--text-weak)]'}`} />
                  <span className="mono min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--text-chrome)] text-[var(--text-secondary)]">
                    {machineLabel(m)}
                  </span>
                  <span className="text-[length:var(--text-chrome)] text-[var(--text-weak)]">仅内容</span>
                </button>
                <MachineRowMenu machine={m} />
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        onClick={() => setEnrollOpen(true)}
        className="mt-1.5 flex min-h-11 w-full items-center gap-2 rounded-[var(--radius-md)] border border-dashed border-[var(--hairline-strong)] bg-transparent px-2.5 py-2 text-left text-[var(--text-secondary)]"
      >
        <Plus size={14} />
        {' '}
        添加电脑
      </button>

      {enrollOpen && <EnrollDialog onClose={() => setEnrollOpen(false)} />}
    </div>
  );
}
