import type { SessionGroup, SessionGroupsState } from '../net/protocol';
import { create } from 'zustand';

/**
 * 会话分组（网页会话列的手动分组）。按登录用户存（服务端 SQLite），跨机器/跨设备一致：
 * 数据随连接推送（relay 在连接建立时 emit 一次），put 成功后服务端向 user room 广播，
 * 所有打开页面走同一条 `applyList`。
 *
 * 归属键是 `composerId`（= 会话 id，磁盘上的 conversation uuid）：草稿和合成 id 不参与
 * 分组（拖进分组也没有意义 —— 会话还没落盘，id 都不稳）。
 */
interface SessionGroupsStore extends SessionGroupsState {
  /** 服务端是否已经推过至少一次（推过之前 UI 不渲染分组区，避免闪一个空区块）。 */
  loaded: boolean;
  applyList: (state: SessionGroupsState | undefined | null) => void;
  /** 本地乐观写入（put 前先落地，界面即时响应）；失败时由调用方重新 get 拉回权威状态。 */
  putLocal: (state: SessionGroupsState) => void;
}

function sanitize(state: SessionGroupsState | undefined | null): Pick<SessionGroupsState, 'groups' | 'assignments'> | null {
  if (!state || typeof state !== 'object')
    return null;
  const groups = Array.isArray(state.groups)
    ? state.groups.filter((g): g is SessionGroup => !!g && typeof g === 'object' && typeof g.id === 'string' && typeof g.name === 'string')
    : [];
  const assignments: Record<string, string> = {};
  if (state.assignments && typeof state.assignments === 'object') {
    for (const [sessionId, groupId] of Object.entries(state.assignments)) {
      if (typeof groupId === 'string' && groupId)
        assignments[sessionId] = groupId;
    }
  }
  return { groups, assignments };
}

export const useSessionGroupsStore = create<SessionGroupsStore>()(set => ({
  groups: [],
  assignments: {},
  loaded: false,

  applyList: (state) => {
    const clean = sanitize(state);
    if (!clean)
      return;
    set({ ...clean, loaded: true });
  },

  putLocal: (state) => {
    const clean = sanitize(state);
    if (clean)
      set({ ...clean, loaded: true });
  },
}));

/** 组名查找（行 chip / picker 用）；组不存在返回 undefined。 */
export function groupNameById(groups: SessionGroup[], id: string): string | undefined {
  return groups.find(g => g.id === id)?.name;
}

/**
 * 本地构造下一次 put 的完整状态。纯函数：给现有 state 加/改名/删组/移动归属，返回新
 * 对象（不原地改，方便乐观更新 + 测试）。
 */
export function withGroups(
  state: SessionGroupsState,
  mutate: (draft: { groups: SessionGroup[]; assignments: Record<string, string> }) => void,
): SessionGroupsState {
  const draft = {
    groups: state.groups.map(g => ({ ...g })),
    assignments: { ...state.assignments },
  };
  mutate(draft);
  // 归属指向不存在的组 = 脏数据：剔除（删组时调用方可以不清理，这里兜底）。
  const known = new Set(draft.groups.map(g => g.id));
  for (const [sessionId, groupId] of Object.entries(draft.assignments)) {
    if (!known.has(groupId))
      delete draft.assignments[sessionId];
  }
  return { groups: draft.groups, assignments: draft.assignments };
}
