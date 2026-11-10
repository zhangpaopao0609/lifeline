import type { DragEndEvent } from '@dnd-kit/core';
import type { IdeKind, MachineInfo } from '../net/protocol';
import {
  closestCenter,
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowCircleUp, Cpu, Plus, TerminalWindow, WarningCircle } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import { machineNotice } from '../lib/duplicate-agent';
import { ideTitle } from '../lib/ide-label';
import { machineLabel } from '../lib/machine-name';
import { SESSION_SOURCE_LABEL, sessionSourceIdes } from '../lib/session-source';
import { noteUserSwitch } from '../lib/useViewState';
import { isOutdated } from '../lib/version';
import { visibleSlots } from '../lib/visible-slots';

import { cliRailDot, useCliStore, visibleCliSources } from '../store/cli';
import { useIdesStore } from '../store/ides';
import { useMachinesStore } from '../store/machines';
import { useUiStore } from '../store/ui';
import { EnrollDialog } from './EnrollDialog';
import { MachineRowMenu } from './MachineRowMenu';

export function MachineList({ onNavigate }: { onNavigate?: () => void }) {
  const machines = useMachinesStore(s => s.machines);
  const reorderMachines = useMachinesStore(s => s.reorderMachines);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const machineIds = machines.map(m => m.agentId);
  // A mouse/pen drag ends with a trailing click on the activator (dnd-kit does not swallow it —
  // pointerup preventDefault does not cancel click). Swallow it so a drag doesn't also open the
  // machine. Keyboard lift is disabled (see below), so this only ever guards pointer drags.
  const suppressClickRef = useRef(false);

  // Sensors (@dnd-kit): mouse/pen after 6px of movement (a plain click still opens the machine),
  // touch after a short hold (the row keeps its scroll gesture). No KeyboardSensor: its Space/Enter
  // lift would steal the native button activation (Enter/Space opens the machine — the primary
  // action; reordering is a rare admin task), so sorting stays pointer/touch only.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (event.activatorEvent instanceof PointerEvent)
      suppressClickRef.current = true;
    if (!over || active.id === over.id)
      return;
    const from = machineIds.indexOf(String(active.id));
    const to = machineIds.indexOf(String(over.id));
    if (from === -1 || to === -1)
      return;
    reorderMachines(arrayMove(machineIds, from, to));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      autoScroll
      accessibility={{
        screenReaderInstructions: {
          draggable: '机器支持排序：用鼠标按住这一行拖动，可以调整机器在列表里的位置',
        },
      }}
    >
      <SortableContext items={machineIds} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-0.5">
          {machines.map(m => (
            <SortableMachineBlock
              key={m.agentId}
              machine={m}
              onNavigate={onNavigate}
              suppressClickRef={suppressClickRef}
            />
          ))}

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
      </SortableContext>
    </DndContext>
  );
}

/**
 * One machine in the rail: the whole block (row + IDE sub-rows) is the sortable unit, the row
 * itself is the drag activator (grab cursor + hover tint; a plain click still opens the machine).
 * During a drag the library moves rows out of the way live — no drop indicator needed.
 */
function SortableMachineBlock({
  machine,
  onNavigate,
  suppressClickRef,
}: {
  machine: MachineInfo;
  onNavigate?: () => void;
  suppressClickRef: { current: boolean };
}) {
  const selectedAgentId = useMachinesStore(s => s.selectedAgentId);
  const cliLatest = useMachinesStore(s => s.cliLatest);
  const selectMachine = useMachinesStore(s => s.selectMachine);
  const ides = useIdesStore(s => s.ides);
  const cliAgents = useCliStore(s => s.cli.agents);
  const selectedIde = useIdesStore(s => s.selectedIde);
  const setSelectedIde = useIdesStore(s => s.setSelectedIde);
  const activeTarget = useUiStore(s => s.activeTarget);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: machine.agentId,
  });

  const selected = machine.agentId === selectedAgentId;
  const notice = machineNotice(machine);
  const cliAgent = cliAgents[machine.agentId];
  const cliSources = visibleCliSources(machine);
  const liveSessions = selected && cliAgent?.epoch ? cliAgent.order.length : undefined;
  const cliDot = cliRailDot(machine.connected, cliSources, liveSessions);
  const readOnlyIdes = machine.contentOnly ? sessionSourceIdes(machine.contentIdes) : [];
  // A controllable machine always offers Agent CLI. A read-only machine offers it only when this agent declared sources.
  const showCli = !machine.contentOnly || cliSources.length > 0;
  const approvalsOf = (ide: IdeKind) => ides[ide]?.pendingApprovals?.length ?? 0;
  const ideConnected = (ide: IdeKind) => ides[ide]?.connected === true;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative rounded-[var(--radius-md)] ${isDragging ? 'z-10 shadow-[var(--shadow-overlay)]' : ''}`}
    >
      {/* Don't absolutely-position ⋯ over the row: a 44px hit area would cover the trailing "offline / updatable"
          copy and steal clicks from the IDE sub-rows below. Selection highlight is on the whole-row container,
          not the machine-name button — ⋯ is part of the row; highlighting only the button would leave a gap on the right. */}
      <div
        className={`flex items-center gap-0.5 rounded-[var(--radius-md)] transition-colors duration-[var(--duration-fast)] ${
          selected ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-2)]'
        }`}
      >
        <button
          type="button"
          {...attributes}
          {...listeners}
          onClick={() => {
            if (suppressClickRef.current) {
              suppressClickRef.current = false;
              return;
            }
            openMachine(machine, selectedIde, setSelectedIde, selectMachine, onNavigate);
          }}
          className={`machine-row-drag flex min-w-0 flex-1 items-center gap-2 self-stretch border-0 bg-transparent px-2.5 py-2 text-left ${
            machine.connected ? 'text-[var(--text-primary)]' : 'text-[var(--text-weak)]'
          }`}
        >
          <span className={`dot ${machine.connected ? 'bg-[var(--ok)]' : 'bg-[var(--text-weak)]'}`} />
          {/* If an alias was set, show the alias (hover reveals the real hostname): in a 240px rail the hostname
              is often clipped to "paopaode...", which is exactly what the alias is for. */}
          <span
            className="mono min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
            title={machine.displayName ? machine.hostname : undefined}
          >
            {machineLabel(machine)}
          </span>
          {/* Offline machines don't show "updatable": you can't install now, and it would crowd hostname off next to "offline";
              version and the update entry live in the ⋯ menu, so the info isn't lost. */}
          {machine.connected && isOutdated(machine.cliVersion, cliLatest) && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-[length:var(--text-chrome)] text-[var(--accent)]">
              <ArrowCircleUp size={12} weight="fill" />
              可更新
            </span>
          )}
          {/* A takeover means this row's state is not from the agent the reader started: say so at the
              "可更新" chip's level, and keep the tone neutral — it is not an error of the machine. */}
          {notice.displaced && (
            <span
              className="shrink-0 text-[length:var(--text-chrome)] text-[var(--text-weak)]"
              title="记录里的那个进程已被顶替、不再上报；当前这一行由占用槽位的 agent 上报"
            >
              {notice.displaced}
            </span>
          )}
          {notice.devBuild && (
            <span
              className="shrink-0 text-[length:var(--text-chrome)] text-[var(--text-weak)]"
              title="这台机器上报的不是发布版本（例如 dev 构建）"
            >
              dev
            </span>
          )}
          {!machine.connected && <span className="text-[length:var(--text-chrome)] text-[var(--text-weak)]">离线</span>}
        </button>
        <MachineRowMenu machine={machine} />
      </div>

      {/* IDE sub-rows are expanded by default: you can see each IDE's status and pending approvals without clicking the machine. */}
      <div className="mt-1 flex flex-col gap-0.5">
        {machine.contentOnly
          ? readOnlyIdes.map(ide => (
              <SessionSourceRow
                key={ide}
                ide={ide}
                active={selected && activeTarget.kind === 'ide' && ide === selectedIde}
                onOpen={() => {
                  noteUserSwitch();
                  setSelectedIde(ide);
                  selectMachine(machine.agentId);
                  useUiStore.getState().showIde(ide);
                  onNavigate?.();
                }}
              />
            ))
          : visibleSlots(Object.keys(selected && Object.keys(ides).length > 0 ? ides : (machine.ides ?? {}))).map((ide) => {
              // The selected machine uses the live store (faster); others only have the summary from machines:list.
              const status = selected
                ? { connected: ideConnected(ide), pendingApprovals: approvalsOf(ide), host: ides[ide]?.host }
                : machine.ides?.[ide];
              const n = status?.pendingApprovals ?? 0;
              // When the machine is offline, IDE status is frozen and a green dot would be a lie.
              const ideOnline = machine.connected && status?.connected === true;
              const active = selected && activeTarget.kind === 'ide' && ide === selectedIde;
              return (
                <button
                  key={ide}
                  type="button"
                  onClick={() => { noteUserSwitch(); selectMachine(machine.agentId); setSelectedIde(ide); useUiStore.getState().showIde(ide); onNavigate?.(); }}
                  className={`ml-5 flex w-[calc(100%-20px)] items-center gap-2 rounded-[var(--radius-md)] border-0 px-2.5 py-1.5 text-left text-[length:var(--text-chrome)] text-[var(--text-secondary)] ${
                    active ? 'bg-[var(--bg-3)]' : 'bg-transparent'
                  }`}
                >
                  <Cpu size={14} />
                  {/* `truncate`: the plugin label ("CodeBuddy · VS Code 插件") is ~2x the name — the rail is 240px and must not wrap. */}
                  <span className="flex-1 truncate">{ideTitle(ide, status?.host)}</span>
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
        {showCli && (
          <CliEntryRow
            active={selected && (activeTarget.kind === 'cli' || activeTarget.kind === 'cli-home') && activeTarget.agentId === machine.agentId}
            dot={cliDot}
            onOpen={() => {
              noteUserSwitch();
              selectMachine(machine.agentId);
              useUiStore.getState().showCliHome(machine.agentId);
              onNavigate?.();
            }}
          />
        )}
      </div>
    </div>
  );
}

function openMachine(
  machine: MachineInfo,
  selectedIde: IdeKind,
  setSelectedIde: (ide: IdeKind) => void,
  selectMachine: (agentId: string) => void,
  onNavigate?: () => void,
): void {
  if (!machine.contentOnly) {
    selectMachine(machine.agentId);
    onNavigate?.();
    return;
  }
  // The session list is filtered by the current IDE. Land on one this machine actually has,
  // otherwise a Linux box looks empty until the matching row is clicked.
  noteUserSwitch();
  const sources = sessionSourceIdes(machine.contentIdes);
  const nextIde = sources.includes(selectedIde) ? selectedIde : (sources[0] ?? selectedIde);
  if (nextIde !== selectedIde)
    setSelectedIde(nextIde);
  selectMachine(machine.agentId);
  useUiStore.getState().showIde(nextIde);
  onNavigate?.();
}

function SessionSourceRow({ ide, active, onOpen }: { ide: IdeKind; active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`ml-5 flex w-[calc(100%-20px)] items-center gap-2 rounded-[var(--radius-md)] border-0 px-2.5 py-1.5 text-left text-[length:var(--text-chrome)] text-[var(--text-secondary)] ${
        active ? 'bg-[var(--bg-3)]' : 'bg-transparent'
      }`}
    >
      <Cpu size={14} />
      <span className="min-w-0 flex-1 truncate">{ideTitle(ide)}</span>
      <span className="shrink-0 text-[length:var(--text-chrome)] text-[var(--text-weak)]">{SESSION_SOURCE_LABEL}</span>
    </button>
  );
}

/** "Agent CLI" sub-row under a machine. */
function CliEntryRow({ active, dot, onOpen }: { active: boolean; dot: ReturnType<typeof cliRailDot>; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`ml-5 flex w-[calc(100%-20px)] items-center gap-2 rounded-[var(--radius-md)] border-0 px-2.5 py-1.5 text-left text-[length:var(--text-chrome)] text-[var(--text-secondary)] ${
        active ? 'bg-[var(--bg-3)]' : 'bg-transparent'
      }`}
    >
      <TerminalWindow size={14} />
      <span className="flex-1">Agent CLI</span>
      {dot !== 'hidden' && (
        <span className={`dot-sm ${dot === 'on' ? 'bg-[var(--ok)]' : 'bg-[var(--text-weak)]'}`} />
      )}
    </button>
  );
}
