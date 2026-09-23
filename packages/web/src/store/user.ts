import type { UserInfo } from '../net/protocol';
import { create } from 'zustand';

/**
 * currentUser is stored separately from IDE state (inherited decision 4):
 * only user:info writes here; state:full / state:patch never touch it.
 * In local mode userId is empty (no SSO). authKind is the server's auth method (older servers omit it).
 */
interface UserStore {
  userId: string;
  avatar: string;
  authKind?: UserInfo['authKind'];
  setUser: (info: UserInfo) => void;
}

export const useUserStore = create<UserStore>()(set => ({
  userId: '',
  avatar: '',
  setUser: info =>
    set({ userId: info.userId ?? '', avatar: info.avatar ?? '', authKind: info.authKind }),
}));
