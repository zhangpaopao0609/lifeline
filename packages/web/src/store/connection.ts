import { create } from 'zustand';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

interface ConnectionStore {
  status: ConnectionStatus;
  /** Boot timing origin: used by the P0 anti-flicker rule (show connecting only after >300ms). */
  bootStartedAt: number;
  setStatus: (status: ConnectionStatus) => void;
}

export const useConnectionStore = create<ConnectionStore>()(set => ({
  status: 'connecting',
  bootStartedAt: Date.now(),
  setStatus: status => set({ status }),
}));
