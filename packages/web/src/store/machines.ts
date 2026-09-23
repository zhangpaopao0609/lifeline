import type { MachineInfo } from '../net/protocol';
import { create } from 'zustand';
import { currentViewHint } from '../lib/view-state';
import { socket } from '../net/socket';

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
  },

  applyUplink: connected => set({ uplinkConnected: connected }),

  selectMachine: (agentId) => {
    if (!agentId || get().selectedAgentId === agentId)
      return;
    set({ selectedAgentId: agentId });
    socket.emit('machine:select', { agentId });
  },

  reselect: () => {
    const { selectedAgentId } = get();
    if (selectedAgentId)
      socket.emit('machine:select', { agentId: selectedAgentId });
  },
}));
