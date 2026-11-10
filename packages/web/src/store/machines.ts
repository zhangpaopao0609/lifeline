import type { MachineInfo } from '../net/protocol';
import { create } from 'zustand';
import { currentViewHint } from '../lib/view-state';
import { socket } from '../net/socket';
import { visibleCliSources } from './cli';
import { useIdesStore } from './ides';
import { useUiStore } from './ui';

interface MachinesStore {
  machines: MachineInfo[];
  /** agent:uplink — whether any agent is online in server mode. */
  uplinkConnected: boolean;
  selectedAgentId: string;
  /** Server-published version (from machines:list) — used to decide if a machine is "updatable"; older servers send ''. */
  cliLatest: string;
  applyMachinesList: (list: MachineInfo[], cliLatest?: string) => void;
  applyUplink: (connected: boolean) => void;
  /** Set selection + notify the server; server replies with state:full (+ sessions:index). */
  selectMachine: (agentId: string) => void;
  /** Re-emit machine:select after a socket reconnect (used by bind.ts). */
  reselect: () => void;
  /** Drag sorting: apply the new rail order optimistically; the server ack confirms (revert on refusal). */
  reorderMachines: (orderedAgentIds: string[]) => void;
}

export const useMachinesStore = create<MachinesStore>()((set, get) => ({
  machines: [],
  uplinkConnected: false,
  selectedAgentId: '',
  cliLatest: '',

  applyMachinesList: (list, cliLatest) => {
    const { selectedAgentId } = get();
    const stillValid = list.some(m => m.agentId === selectedAgentId);
    if (stillValid) {
      set({ machines: list, cliLatest: cliLatest ?? '' });
      releaseCliTarget();
      return;
    }
    // No valid selection: restore the last machine first (even if offline — P8b does not jump to another machine);
    // only pick the first connected one if there is no record. Content-only machines (remote dev boxes) are not candidates —
    // selecting one would have no live state to show.
    const selectable = list.filter(m => !m.contentOnly);
    const remembered = currentViewHint().agentId;
    const first
      = (remembered ? selectable.find(m => m.agentId === remembered) : undefined)
        ?? selectable.find(m => m.connected)
        ?? selectable[0]
        ?? list[0];
    set({ machines: list, cliLatest: cliLatest ?? '', selectedAgentId: first?.agentId ?? '' });
    if (first)
      socket.emit('machine:select', { agentId: first.agentId });
    releaseCliTarget();
  },

  applyUplink: connected => set({ uplinkConnected: connected }),

  selectMachine: (agentId) => {
    if (!agentId || get().selectedAgentId === agentId)
      return;
    set({ selectedAgentId: agentId });
    socket.emit('machine:select', { agentId });
    releaseCliTarget();
  },

  reselect: () => {
    const { selectedAgentId } = get();
    if (selectedAgentId)
      socket.emit('machine:select', { agentId: selectedAgentId });
  },

  reorderMachines: (orderedAgentIds) => {
    const prev = get().machines;
    const byId = new Map(prev.map(m => [m.agentId, m]));
    const next = orderedAgentIds.map(id => byId.get(id));
    // A stale order (machine set changed under us) is not applied locally — the server broadcast wins.
    if (next.length !== prev.length || next.some(m => !m))
      return;
    // No-op (e.g. keyboard ↑ at the first slot): don't touch state or emit — the server would
    // broadcast machines:list to every open client for nothing.
    if (next.every((m, i) => m === prev[i]))
      return;
    set({ machines: next as MachineInfo[] });
    socket.emit('machines:reorder', { agentIds: orderedAgentIds }, (r?: { ok?: boolean }) => {
      // Server refusal (stale set / unknown id): snap back to the previous order if ours is still showing.
      if (r?.ok || get().machines.map(m => m.agentId).join('\u0000') !== orderedAgentIds.join('\u0000'))
        return;
      set({ machines: prev });
    });
  },
}));

function releaseCliTarget(): void {
  const { machines, selectedAgentId } = useMachinesStore.getState();
  const machine = machines.find(item => item.agentId === selectedAgentId);
  const allowed = visibleCliSources(machine);
  const target = useUiStore.getState().activeTarget;
  if (target.kind === 'cli-home') {
    if (target.agentId !== selectedAgentId)
      useUiStore.getState().showIde(useIdesStore.getState().selectedIde);
    return;
  }
  if (target.kind !== 'cli')
    return;
  if (target.agentId === selectedAgentId && allowed.some(row => row.source === target.source))
    return;
  useUiStore.getState().showIde(useIdesStore.getState().selectedIde);
}
