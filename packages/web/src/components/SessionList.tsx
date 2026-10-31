import type { Ref } from 'react';
import type { ChatTab, CliSource, CursorState } from '../net/protocol';
import type { CliSessionState } from '../store/cli';
import {
  AppWindow,
  CaretDown,
  CaretRight,
  CircleNotch,
  DotsSixVertical,
  MagnifyingGlass,
  Plus,
  Robot,
  TerminalWindow,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { groupCliByCwd, normalizeCliCwd } from '../lib/cli-placement';
import { noteUserSwitch } from '../lib/useViewState';
import { useWindowOrder } from '../lib/useWindowOrder';
import { groupTabsBySection, groupTabsByWindow } from '../lib/window-order';
import { closeCliSession, sendCliStart } from '../net/send';
import { sendCommand, socket } from '../net/socket';
import { cliAgentLabel, cliStatusLabel, sessionsOf, useCliStore, visibleCliSources } from '../store/cli';
import {
  isDraftTab,
  isRowWorking,
  isSyntheticComposerId,
  isTabUnread,
  isViewingTab,
  pendingMatchesTab,
  useIdesStore,
} from '../store/ides';
import { useMachinesStore } from '../store/machines';
import { sessionBodyKey, useSessionsStore } from '../store/sessions';
import { useUiStore } from '../store/ui';
import { CliNewDialog } from './CliNewDialog';

/**
 * Running → spinner (IDE sidebar row-level status is canonical; only a row without a status of its own — old agent / extraction gap — falls back to the live session state so the spinner stays on after a switch);
 * Waiting for approval → badge; finished but not yet viewed → green dot (the one on the IDE session tab); read → no marker.
 * `viewing` (counts as soon as an optimistic switch starts) is the equivalent of "this window's active row".
 *
 * The spinner only means "this session is running" — it does not light up during a switch. The switch itself is shown by the row highlight + the top "Switching…" chrome;
 * otherwise switching to a session that already stopped would flash a spinner first, looking like it started running again (2026-09-15 feedback).
 */
function tabBadge(tab: ChatTab, state: CursorState, isActiveWindow: boolean) {
  const spinner = (
    <CircleNotch size={13} weight="bold" color="var(--accent)" className="shrink-0 animate-spin" aria-label="进行中" />
  );
  /** Active row in this window: the row's own status wins; the window-level live state only stands in while the row has none (see isRowWorking) */
  const viewingHere = tab.isActive && isActiveWindow;
  if (isRowWorking(tab, state, viewingHere))
    return spinner;
  if (viewingHere) {
    const n = state.pendingApprovals?.length ?? 0;
    if (n > 0) {
      return (
        <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-[var(--accent)]">
          <WarningCircle size={12} weight="fill" />
          {n}
        </span>
      );
    }
  }
  else if (tab.status === 'waiting_approval') {
    return <WarningCircle size={12} weight="fill" color="var(--accent)" className="shrink-0" />;
  }
  // Draft (the row created by tapping + / New Agent): neither running nor "finished but unread".
  // Row status comes from `status === 'draft'` (Agents window); the project-window row uses `isDraft`.
  if (isDraftTab(tab)) {
    return <span className="sess-chip shrink-0">草稿</span>;
  }
  // Finished, result not yet viewed (the dot on the IDE session tab): disappears once read (switching into this session)
  if (isTabUnread(tab)) {
    return (
      <span
        className="dot shrink-0 bg-[var(--ok)]"
        role="img"
        aria-label="已完成，有新结果"
        title="已完成，有新结果"
      />
    );
  }
  return null;
}

function GroupNewChatButton({ windowTitle, onNewChat }: { windowTitle: string; onNewChat: () => void }) {
  return (
    <button
      type="button"
      aria-label={`在「${windowTitle}」新建会话`}
      // The whole group header is clickable (accordion); + must not also collapse the group
      onClick={(e) => { e.stopPropagation(); onNewChat(); }}
      className="sess-add"
    >
      <Plus size={13} weight="bold" />
    </button>
  );
}

/**
 * When opening the phone switcher, bring the "current session" into view (`revealCurrent`): with many sessions the panel always paints from the top,
 * so the user has to scroll around and hunt for the highlighted row — "every switch means scrolling forever" (2026-09-17 feedback).
 *
 * Landing: leave about 3 rows above the current row (neither centered nor flush to the top) — those rows above signal "there's more content",
 * and the rest of the screen is for the target to switch to (thumb zone); flush-to-top would clip the window group header entirely.
 * Instant jump: the panel just appeared, so there is no continuity of "where we were"; smooth-scrolling a long list takes forever.
 * Jump once: afterwards leave the user's own scrolling alone; do not jump while searching (a filter should be read from the top).
 */
const REVEAL_ABOVE_ROWS = 3;

/** Session rail: search + live tabs grouped by window. Window order is pinned in memory; write localStorage only after a drag completes. */
export function SessionList({
  onNavigate,
  revealCurrent = false,
}: {
  onNavigate?: () => void;
  /** When opening this screen, scroll to the current session (phone switcher; the desktop column is always visible, so jumping with selection is jarring) */
  revealCurrent?: boolean;
}) {
  const ides = useIdesStore(s => s.ides);
  const selectedIde = useIdesStore(s => s.selectedIde);
  const state = ides[selectedIde];
  const isDesktop = useIsDesktop();
  const agentId = useMachinesStore(s => s.selectedAgentId);
  // Sessions on a content-source machine (no IDE) still need to be openable: tapping one must not go through the "switch tab" command.
  const contentOnlyMachine = useMachinesStore(
    s => s.machines.find(m => m.agentId === s.selectedAgentId)?.contentOnly === true,
  );
  const pendingSwitch = useUiStore(s => s.pendingSwitch);
  const setPendingSwitch = useUiStore(s => s.setPendingSwitch);
  const [query, setQuery] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // Accordion starts collapsed. Open keys are "machine:IDE:window" and "...:section", so machines don't leak, and a refresh returns to folded.
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set());
  const cliMachine = useMachinesStore(s => s.machines.find(item => item.agentId === s.selectedAgentId));
  const cliSources = visibleCliSources(cliMachine);
  const cliAgent = useCliStore(s => agentId ? s.cli.agents[agentId] : undefined);
  const activeTarget = useUiStore(s => s.activeTarget);
  const showCli = useUiStore(s => s.showCli);
  const pushToast = useUiStore(s => s.pushToast);
  const [cliDialogOpen, setCliDialogOpen] = useState(false);
  /** Directory fixed by that row's +. Absent when the header + opened a blank dialog. */
  const [cliDraftCwd, setCliDraftCwd] = useState<string | undefined>();
  const cliStartLockRef = useRef(false);

  const rawGroups = useMemo(() => (state ? groupTabsByWindow(state) : []), [state]);
  const { groups, reorder } = useWindowOrder(agentId, selectedIde, rawGroups);
  const cliSessions = sessionsOf(cliAgent);
  const q = query.trim().toLowerCase();
  const cliSurface = (activeTarget.kind === 'cli' || activeTarget.kind === 'cli-home')
    && activeTarget.agentId === agentId;
  const pendingHere = pendingSwitch && pendingSwitch.ide === selectedIde ? pendingSwitch : null;

  // Folded-by-default + desktop = a session is open on the right while the list shows nothing selected anywhere (2026-10-20 feedback;
  // the default flipped to folded and only the phone switcher force-opened the current group).
  // Unfold the group (and the Agents-window section) holding the session currently on screen.
  // Only when the "current group" changes: folding it by hand must stick until the user switches into another session.
  const autoExpandKeys = useMemo(() => {
    if (!state)
      return [];
    for (const g of groups) {
      const tab = g.tabs.find(t => isViewingTab(t, g.windowId, selectedIde, state, pendingSwitch));
      if (!tab)
        continue;
      const key = `${agentId}:${selectedIde}:${g.windowId}`;
      return tab.section ? [key, `${key}:${tab.section}`] : [key];
    }
    return [];
  }, [groups, state, selectedIde, pendingSwitch, agentId]);
  const autoExpandSig = autoExpandKeys.join('\n');
  // layoutEffect: unfold before the first paint, so the desktop column never shows "session open, every group folded" for a frame
  useLayoutEffect(() => {
    if (!autoExpandSig)
      return;
    const keys = autoExpandSig.split('\n');
    setOpenKeys((prev) => {
      const missing = keys.filter(k => !prev.has(k));
      return missing.length ? new Set([...prev, ...missing]) : prev;
    });
  }, [autoExpandSig]);

  const listRef = useRef<HTMLDivElement | null>(null);
  const currentRowRef = useRef<HTMLButtonElement | null>(null);
  const revealed = useRef(false);
  const scrolledCliSessionRef = useRef('');

  // layoutEffect: place the scroll position as soon as the panel mounts; don't paint a frame of "list head" then jump (looks like a flicker)
  useLayoutEffect(() => {
    if (!revealCurrent || revealed.current || q)
      return;
    const row = currentRowRef.current;
    const box = listRef.current;
    if (!row || !box)
      return; // Row not here yet (state arrives later): try again on the next extraction
    revealed.current = true;
    // Row position relative to the scroll box uses rect difference: offsetTop depends on offsetParent, and is wrong if nothing in the chain is positioned
    const rowTop = row.getBoundingClientRect().top - box.getBoundingClientRect().top;
    const max = Math.max(0, box.scrollHeight - box.clientHeight);
    const next = Math.min(max, Math.max(0, box.scrollTop + rowTop - Math.round(row.offsetHeight * REVEAL_ABOVE_ROWS)));
    if (Math.abs(next - box.scrollTop) < 2)
      return; // Already landed there (first few rows / list not long enough): leave it
    box.scrollTop = next;
  }, [revealCurrent, q, state, pendingSwitch]);

  useLayoutEffect(() => {
    if (activeTarget.kind !== 'cli' || q)
      return;
    if (scrolledCliSessionRef.current === activeTarget.sessionId)
      return;
    const row = currentRowRef.current;
    const box = listRef.current;
    if (!row || !box)
      return;
    scrolledCliSessionRef.current = activeTarget.sessionId;
    const rowTop = row.getBoundingClientRect().top - box.getBoundingClientRect().top;
    const max = Math.max(0, box.scrollHeight - box.clientHeight);
    box.scrollTop = Math.min(max, Math.max(0, box.scrollTop + rowTop - Math.round(row.offsetHeight * REVEAL_ABOVE_ROWS)));
  }, [activeTarget, q, cliSessions]);

  const directoryChoices = useMemo(() => {
    const seen = new Set<string>();
    const choices: Array<{ cwd: string; title: string }> = [];
    for (const group of groups) {
      if (group.kind === 'agents' || !group.workspacePath)
        continue;
      const cwd = normalizeCliCwd(group.workspacePath);
      if (!cwd.startsWith('/') || seen.has(cwd))
        continue;
      seen.add(cwd);
      choices.push({ cwd, title: group.title || workspaceTitle(cwd) });
    }
    return choices;
  }, [groups]);

  const groupKey = (windowId: string) => `${agentId}:${selectedIde}:${windowId}`;
  const toggleKey = (key: string) => {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key))
        next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const startCli = (source: CliSource, cwd: string, choice?: { modelId?: string; thinking?: string }) => {
    const trimmed = cwd.trim();
    if (!trimmed.startsWith('/')) {
      pushToast('工作目录需要绝对路径', 'error');
      return false;
    }
    if (cliStartLockRef.current)
      return false;
    cliStartLockRef.current = true;
    void sendCliStart(source, trimmed, choice).then((result) => {
      if (!result.ok)
        pushToast(`无法新建：${result.error ?? '失败'}`, 'error');
    }).catch(() => {
      pushToast('无法新建：请求超时', 'error');
    }).finally(() => {
      cliStartLockRef.current = false;
    });
    return true;
  };

  const newChat = (windowId: string, section?: string) => {
    noteUserSwitch();
    // The Agents-window "+" sits on the section header (= IDE New Agent, created into that repo); project windows omit section
    sendCommand('command:new_chat', { ide: selectedIde, windowId, ...(section ? { section } : {}) });
    // Phone: tapping + means go to this new session — leaving the full-screen switcher up covers the input for the whole screen,
    // so the user sees "the new session is already there" but cannot type (2026-09-16 feedback). Desktop has no onNavigate.
    onNavigate?.();
  };

  const switchTab = (tab: ChatTab, windowId: string) => {
    useUiStore.getState().showIde(selectedIde);
    const wid = tab.windowId || windowId;
    // Selecting a row dismisses the overlay (the phone P3 full-screen switcher: "pick a session → close and land").
    // Must run before the two early returns: tapping the row that is already current / whose switch command is still in flight
    // correctly skips sending another command, but the overlay still has to close — otherwise it looks like "tap did nothing,
    // I still have to tap ✕ by hand to see that session" (2026-09-16 feedback).
    onNavigate?.();
    // A content-source machine has no switchable IDE: skip the "already current session, short-circuit" path and the switch command,
    // and just land "current session" in local state, fetching the body if needed.
    if (!contentOnlyMachine) {
      // isActive is "each window's own active tab": if we're still looking at another window, we have to switch to this one
      if (tab.isActive && wid === state?.activeWindowId)
        return;
      // Already the optimistic-switch target: a repeat tap must not send another command (the server would click the sidebar again and state would jitter)
      if (pendingHere && pendingMatchesTab(pendingHere, tab, wid))
        return;
    }
    noteUserSwitch();
    if (contentOnlyMachine) {
      useIdesStore.getState().markLocalActive(selectedIde, wid, tab.composerId);
    }
    // Sidebar rows have no id: composerId is "which session to switch to"; same-title index + windowId is "which row was tapped".
    // After clicking, the server re-reads the composer bar to verify; the reply carries landedComposerId — no more false success.
    // Content-source machines cannot switch tabs (no IDE), so this command is not sent.
    const commandId = contentOnlyMachine
      ? ''
      : sendCommand('command:switch_tab', {
          ide: selectedIde,
          tabTitle: tab.title,
          windowId: wid,
          ...(tab.composerId && !isSyntheticComposerId(tab.composerId) ? { composerId: tab.composerId } : {}),
          ...(typeof tab.sameTitleIndex === 'number' ? { sameTitleIndex: tab.sameTitleIndex } : {}),
          // Agents-window rows can share a title across repos: include the nested section when switching
          ...(tab.section ? { section: tab.section } : {}),
          ...(tab.selectorPath ? { selectorPath: tab.selectorPath } : {}),
        });
    // Optimistic: list/timeline paint the target session immediately; reconcile when state returns, roll back on failure/timeout
    if (tab.composerId) {
      if (!contentOnlyMachine) {
        setPendingSwitch({
          commandId,
          ide: selectedIde,
          composerId: tab.composerId,
          sameTitleIndex: tab.sameTitleIndex,
          windowId: wid,
          title: tab.title,
          startedAt: Date.now(),
        });
      }
      // Prefetch the session body so content is there after the switch. Drafts excluded: not on disk yet, so a body request would go nowhere
      // (2026-09-20: the other half of "newly created session spins forever" — click-prefetch was also asking for a session that does not exist).
      const key = sessionBodyKey(tab.composerId, selectedIde);
      if (
        !isSyntheticComposerId(tab.composerId)
        && !isDraftTab(tab)
        && !useSessionsStore.getState().bodies[key]
      ) {
        socket.emit('session:get', { sessionId: tab.composerId, ide: selectedIde });
      }
    }
  };

  return (
    <div className="flex h-full flex-col bg-[var(--bg-1)]">
      <div className="flex flex-col gap-2 border-b border-[var(--hairline)] p-2.5">
        <div className="flex items-center gap-2">
          <label className="flex flex-1 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--hairline)] px-2.5 py-1.5 text-[var(--text-weak)]">
            <MagnifyingGlass size={14} />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="搜索会话"
              className="min-w-0 flex-1 border-0 bg-transparent font-[inherit] text-[length:var(--text-chrome)] text-[var(--text-primary)] outline-none"
            />
          </label>
          {isDesktop && <kbd className="mono shrink-0 text-[11px] text-[var(--text-weak)]">⌘K</kbd>}
        </div>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto px-2 py-2">
        {cliSurface
          ? (
              <CliWorkspaceList
                sessions={filterCliRows(cliSessions, q)}
                sources={cliSources}
                active={activeTarget}
                agentId={agentId}
                rowRef={currentRowRef}
                onOpenDraft={() => {
                  setCliDraftCwd(undefined);
                  setCliDialogOpen(true);
                }}
                onNewInDirectory={(cwd) => {
                  setCliDraftCwd(cwd);
                  setCliDialogOpen(true);
                }}
                onOpen={(row) => {
                  noteUserSwitch();
                  showCli({
                    kind: 'cli',
                    agentId,
                    epoch: row.epoch,
                    source: row.source,
                    sessionId: row.sessionId,
                  });
                  onNavigate?.();
                }}
              />
            )
          : (
              <>
                {!state && <div className="p-2.5 text-[length:var(--text-chrome)] text-[var(--text-weak)]">该 IDE 无状态</div>}
                {groups.map((g) => {
                  const tabs = q ? g.tabs.filter(t => t.title.toLowerCase().includes(q)) : g.tabs;
                  if (tabs.length === 0)
                    return null;
                  const dropping = overId === g.windowId && dragId !== null && dragId !== g.windowId;
                  const viewingInGroup = revealCurrent && !!state && tabs.some(t => isViewingTab(t, g.windowId, selectedIde, state, pendingSwitch));
                  const folded = !q && !viewingInGroup && !openKeys.has(groupKey(g.windowId));
                  // Agents window (Cursor's global agent list): subdivide the group by repo, matching the IDE
                  const isAgents = (state?.windows.find(w => w.id === g.windowId)?.kind ?? 'project') === 'agents';
                  const renderRow = (t: ChatTab) => {
                    // Exactly one current session: during a switch the target owns it, and the old active row demotes immediately (2026-09-15 dual-active feedback)
                    const viewing = isViewingTab(t, g.windowId, selectedIde, state, pendingSwitch);
                    return (
                      <button
                        key={`${t.composerId}:${t.title}`}
                        ref={revealCurrent && viewing ? currentRowRef : undefined}
                        type="button"
                        onClick={() => switchTab(t, g.windowId)}
                        className={`sess-tab ${viewing ? 'is-viewing' : t.isActive ? 'is-window-live' : ''} ${t.isActive ? 'cursor-default' : 'cursor-pointer'}`}
                      >
                        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{t.title || '（未命名）'}</span>
                        {state && tabBadge(t, state, g.windowId === state.activeWindowId)}
                      </button>
                    );
                  };
                  return (
                    <div
                      key={g.windowId}
                      onDragOver={(e) => {
                        if (!dragId || dragId === g.windowId)
                          return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        setOverId(g.windowId);
                      }}
                      onDragLeave={() => setOverId(v => (v === g.windowId ? null : v))}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragId && dragId !== g.windowId)
                          reorder(dragId, g.windowId);
                        setDragId(null);
                        setOverId(null);
                      }}
                      className={`sess-group ${folded ? 'is-collapsed' : ''} ${dragId === g.windowId ? 'opacity-40' : ''} ${dropping ? 'shadow-[inset_0_2px_0_var(--accent)]' : ''}`}
                    >
                      <div
                        className="sess-head"
                        role="button"
                        tabIndex={0}
                        aria-expanded={!folded}
                        aria-label={`${folded ? '展开' : '收起'}窗口「${g.title}」`}
                        onClick={() => toggleKey(groupKey(g.windowId))}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' && e.key !== ' ')
                            return;
                          e.preventDefault();
                          toggleKey(groupKey(g.windowId));
                        }}
                      >
                        <span className="sess-head-icon" aria-hidden>
                          {isAgents
                            ? <Robot className="ico-window" size={14} weight="bold" />
                            : <AppWindow className="ico-window" size={14} />}
                          <CaretDown className="ico-toggle ico-open" size={12} weight="fill" />
                          <CaretRight className="ico-toggle ico-closed" size={12} weight="fill" />
                        </span>
                        <span className="sess-head-title">{g.title}</span>
                        <button
                          type="button"
                          className="drag-handle sess-head-drag"
                          draggable
                          aria-label={`拖动窗口「${g.title}」`}
                          title="拖动调整窗口顺序"
                          onClick={e => e.stopPropagation()}
                          onDragStart={(e) => {
                            setDragId(g.windowId);
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', g.windowId);
                          }}
                          onDragEnd={() => {
                            setDragId(null);
                            setOverId(null);
                          }}
                        >
                          <DotsSixVertical size={14} weight="bold" />
                        </button>
                        <GroupNewChatButton windowTitle={g.title} onNewChat={() => newChat(g.windowId)} />
                      </div>
                      {!folded && (isAgents
                        ? groupTabsBySection(tabs).map((sec, secIdx) => {
                            const secKey = `${groupKey(g.windowId)}:${sec.section}`;
                            const viewingInSection = revealCurrent && !!state && sec.tabs.some(t => isViewingTab(t, g.windowId, selectedIde, state, pendingSwitch));
                            const secFolded = !q && !viewingInSection && !openKeys.has(secKey);
                            // Collapse state is keyed by section name (secKey), but the React key needs another identity layer:
                            // groupTabsBySection only merges **adjacent** same-named sections (the IDE's own order can leave same names non-adjacent),
                            // so "two workspace.json sections in the Agents window" is valid input — using secKey alone would collide keys
                            // (React duplicate-key warning; on re-render children can be duplicated/dropped; empirically 378 console lines when rapidly tapping sessions).
                            const secRowKey = `${secKey}:${sec.tabs[0]?.composerId ?? secIdx}`;
                            return (
                              <div key={secRowKey} className="sess-section">
                                {/* Section header is not a button (it still needs a + inside, so we cannot nest buttons) — same as the window header, use role=button */}
                                <div
                                  className="sess-section-head"
                                  role="button"
                                  tabIndex={0}
                                  aria-expanded={!secFolded}
                                  aria-label={`${secFolded ? '展开' : '收起'}「${sec.section || '其他'}」`}
                                  onClick={() => toggleKey(secKey)}
                                  onKeyDown={(e) => {
                                    if (e.key !== 'Enter' && e.key !== ' ')
                                      return;
                                    e.preventDefault();
                                    toggleKey(secKey);
                                  }}
                                >
                                  {secFolded
                                    ? <CaretRight size={10} weight="fill" />
                                    : <CaretDown size={10} weight="fill" />}
                                  <span className="sess-section-title">{sec.section || '其他'}</span>
                                  <span className="sess-section-count">{sec.tabs.length}</span>
                                  {/* IDE section headers each have New Agent: create into that repo.
                              Remote creates always flip Run on to This Mac (a cloud agent's body is not readable on this machine,
                              see spec 3.6) — so the "No Repo" section is also safe to create in. */}
                                  <button
                                    type="button"
                                    className="sess-add"
                                    aria-label={`在「${sec.section || '其他'}」新建 agent`}
                                    title="在该仓库新建 agent（远程新建跑在本机）"
                                    onClick={(e) => { e.stopPropagation(); newChat(g.windowId, sec.section); }}
                                  >
                                    <Plus size={12} weight="bold" />
                                  </button>
                                </div>
                                {!secFolded && sec.tabs.map(renderRow)}
                              </div>
                            );
                          })
                        : tabs.map(renderRow))}
                    </div>
                  );
                })}
                {state && groups.every(g => g.tabs.length === 0) && (
                  <div className="p-2.5 text-[length:var(--text-chrome)] text-[var(--text-weak)]">暂无会话 —— 点窗口分组头部的 ＋ 新建。</div>
                )}
              </>
            )}
      </div>
      {cliDialogOpen && (
        <CliNewDialog
          sources={cliSources}
          directories={directoryChoices}
          initialCwd={cliDraftCwd}
          onClose={() => {
            setCliDialogOpen(false);
            setCliDraftCwd(undefined);
          }}
          onSubmit={startCli}
        />
      )}
    </div>
  );
}

function filterCliRows(rows: CliSessionState[], query: string): CliSessionState[] {
  if (!query)
    return rows;
  return rows.filter(row => `${row.title ?? ''} ${row.cwd}`.toLowerCase().includes(query));
}

function CliSessionRow({
  session,
  viewing,
  onOpen,
  onClose,
  rowRef,
}: {
  session: CliSessionState;
  viewing: boolean;
  onOpen: () => void;
  onClose: () => void;
  rowRef?: Ref<HTMLButtonElement>;
}) {
  const label = session.title || session.cwd.split('/').filter(Boolean).pop() || session.cwd;
  return (
    <div className={`sess-tab ${viewing ? 'is-viewing' : ''}`}>
      <button
        ref={rowRef}
        type="button"
        className="sess-tab-open"
        onClick={onOpen}
      >
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{session.title || session.cwd}</span>
        <span className="sess-chip shrink-0">{cliAgentLabel(session.source)}</span>
        <span className="sess-chip shrink-0">{cliStatusLabel(session.status)}</span>
      </button>
      <button
        type="button"
        className="sess-close"
        aria-label={`关闭「${label}」`}
        title="关闭会话"
        onClick={onClose}
      >
        <X size={13} weight="bold" />
      </button>
    </div>
  );
}

function workspaceTitle(cwd: string): string {
  const name = cwd.split('/').filter(Boolean).pop();
  return name || cwd || '（未填写目录）';
}

function CliWorkspaceList({
  sessions,
  sources,
  active,
  agentId,
  onOpenDraft,
  onNewInDirectory,
  onOpen,
  rowRef,
}: {
  sessions: CliSessionState[];
  sources: Array<{ source: CliSource }>;
  active: { kind: string; agentId?: string; sessionId?: string; epoch?: string; source?: string };
  agentId: string;
  onOpenDraft: () => void;
  onNewInDirectory: (cwd: string) => void;
  onOpen: (session: CliSessionState) => void;
  rowRef?: Ref<HTMLButtonElement>;
}) {
  const blocks = groupCliByCwd(sessions);
  const viewingRow = (row: CliSessionState) => active.kind === 'cli'
    && active.agentId === agentId
    && active.sessionId === row.sessionId
    && active.epoch === row.epoch
    && active.source === row.source;
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 px-1 py-1">
        <span className="min-w-0 flex-1 text-[length:var(--text-chrome)] text-[var(--text-weak)]">工作目录</span>
        {sources.length > 0 && (
          <button
            type="button"
            className="sess-add"
            aria-label="新建工作目录"
            title="新建工作目录"
            onClick={onOpenDraft}
          >
            <Plus size={13} weight="bold" />
          </button>
        )}
      </div>
      {blocks.length === 0 && (
        <div className="p-2.5 text-[length:var(--text-chrome)] text-[var(--text-weak)]">
          {sources.length > 0 ? '还没有工作目录。点 + 新建一个。' : '这台机器还没有可用的命令行。'}
        </div>
      )}
      {blocks.map(block => (
        <div key={block.cwd || '__blank__'} className="sess-group">
          <div className="sess-head">
            <span className="sess-head-icon" aria-hidden>
              <TerminalWindow className="ico-window" size={14} />
            </span>
            <span className="sess-head-title" title={block.cwd}>{workspaceTitle(block.cwd)}</span>
            {block.cwd.startsWith('/') && (
              <button
                type="button"
                className="sess-add"
                aria-label={`在「${workspaceTitle(block.cwd)}」新建会话`}
                title="在此目录新建"
                onClick={() => onNewInDirectory(block.cwd)}
              >
                <Plus size={13} weight="bold" />
              </button>
            )}
          </div>
          {block.rows.map(row => (
            <CliSessionRow
              key={row.key}
              session={row}
              rowRef={viewingRow(row) ? rowRef : undefined}
              viewing={viewingRow(row)}
              onOpen={() => onOpen(row)}
              onClose={() => closeCliSession({
                kind: 'cli',
                agentId,
                source: row.source,
                sessionId: row.sessionId,
              })}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
