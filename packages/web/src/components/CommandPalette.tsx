import { ArrowBendDownLeft, ArrowDown, ArrowUp } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useInstallOs } from '../lib/enroll-os';
import { machineLabel } from '../lib/machine-name';
import { noteUserSwitch } from '../lib/useViewState';
import { installCommand, setupCommand } from '../net/enroll';
import { IDE_KINDS, IDE_LABELS } from '../net/protocol';
import { sendCommand, sendCommandAwaitResult } from '../net/socket';
import { activeTabOf, useIdesStore } from '../store/ides';
import { useMachinesStore } from '../store/machines';
import { useUiStore } from '../store/ui';

interface CmdItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface ModelOption {
  id: string;
  label: string;
  selected?: boolean;
}

/**
 * ⌘K command palette (spec P2): switch machine/IDE/window/session, change mode/model, new session, copy enroll command — fuzzy search to jump.
 * Desktop soul interaction: ⌘K toggles, ↑↓ navigates, Enter runs, Esc closes.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const installOs = useInstallOs();
  const machines = useMachinesStore(s => s.machines);
  const selectedAgentId = useMachinesStore(s => s.selectedAgentId);
  const selectMachine = useMachinesStore(s => s.selectMachine);
  const ides = useIdesStore(s => s.ides);
  const selectedIde = useIdesStore(s => s.selectedIde);
  const setSelectedIde = useIdesStore(s => s.setSelectedIde);
  const applyStatePatch = useIdesStore(s => s.applyStatePatch);
  const pushToast = useUiStore(s => s.pushToast);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [modelOptions, setModelOptions] = useState<ModelOption[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const state = ides[selectedIde];
  const finish = (fn: () => void) => () => { fn(); onClose(); };

  useEffect(() => {
    void sendCommandAwaitResult('command:get_model_options', { ide: selectedIde })
      .then((r) => {
        const data = r.data as { options?: ModelOption[] } | undefined;
        if (r.ok && Array.isArray(data?.options))
          setModelOptions(data.options);
      })
      .catch(() => { /* Silent inside the palette; the model group is not shown. */ });
  }, [selectedIde]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const items = useMemo<CmdItem[]>(() => {
    const out: CmdItem[] = [];

    out.push({
      id: 'op:new-chat',
      group: '操作',
      label: '新会话',
      run: finish(() => { noteUserSwitch(); sendCommand('command:new_chat', { ide: selectedIde }); }),
    });
    out.push({
      id: 'op:copy-enroll',
      group: '操作',
      label: '复制接入命令',
      run: finish(() => {
        void navigator.clipboard.writeText(`${installCommand(undefined, installOs)}\n${setupCommand()}`);
        pushToast('接入命令已复制');
      }),
    });

    for (const tab of state?.chatTabs ?? []) {
      out.push({
        id: `tab:${tab.composerId}:${tab.title}`,
        group: '会话',
        label: tab.title || '（未命名）',
        hint: tab.isActive ? '当前' : undefined,
        run: finish(() => {
          const wid = tab.windowId || state?.activeWindowId;
          // isActive is "the active tab of each window": if we're still looking at another window, we have to switch.
          if (tab.isActive && wid === state?.activeWindowId)
            return;
          noteUserSwitch();
          sendCommand('command:switch_tab', {
            ide: selectedIde,
            tabTitle: tab.title,
            windowId: wid,
            ...(tab.selectorPath ? { selectorPath: tab.selectorPath } : {}),
          });
        }),
      });
    }

    for (const w of state?.windows ?? []) {
      out.push({
        id: `win:${w.id}`,
        group: '窗口',
        label: w.title || w.id,
        hint: w.id === state?.activeWindowId ? '当前' : undefined,
        run: finish(() => sendCommand('command:switch_window', { ide: selectedIde, windowId: w.id })),
      });
    }

    IDE_KINDS.forEach((ide) => {
      out.push({
        id: `ide:${ide}`,
        group: 'IDE',
        label: IDE_LABELS[ide],
        hint: ide === selectedIde ? '当前' : undefined,
        run: finish(() => setSelectedIde(ide)),
      });
    });

    machines.forEach((m) => {
      out.push({
        id: `machine:${m.agentId}`,
        group: '机器',
        label: machineLabel(m),
        // If an alias was set, put the real hostname in the hint: ⌘K is the "find a machine by name" entry, both names must match.
        hint: `${m.connected ? '在线' : '离线'}${m.displayName ? ` · ${m.hostname}` : ''}${m.agentId === selectedAgentId ? ' · 当前' : ''}`,
        run: finish(() => selectMachine(m.agentId)),
      });
    });

    for (const m of state?.mode?.available ?? []) {
      out.push({
        id: `mode:${m.id}`,
        group: 'Mode',
        label: `Mode: ${m.label}`,
        hint: m.label === state?.mode?.current ? '当前' : undefined,
        run: finish(() => {
          sendCommand('command:set_mode', { ide: selectedIde, modeId: m.id });
          pushToast(`Mode: ${m.label}`);
        }),
      });
    }

    for (const opt of modelOptions ?? []) {
      out.push({
        id: `model:${opt.id}`,
        group: 'Model',
        label: `Model: ${opt.label}`,
        hint: opt.id === state?.model?.currentId ? '当前' : undefined,
        run: finish(() => {
          const prev = state?.model;
          if (prev)
            applyStatePatch({ ide: selectedIde, patch: { model: { current: opt.label, currentId: opt.id } } });
          void sendCommandAwaitResult('command:set_model', { ide: selectedIde, modelId: opt.id })
            .then((r) => {
              if (r.ok) {
                pushToast(`Model: ${opt.label}`);
              }
              else {
                if (prev)
                  applyStatePatch({ ide: selectedIde, patch: { model: prev } });
                pushToast(r.error || '设置失败', 'error');
              }
            })
            .catch(() => {
              if (prev)
                applyStatePatch({ ide: selectedIde, patch: { model: prev } });
              pushToast('设置超时', 'error');
            });
        }),
      });
    }

    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machines, selectedAgentId, state, selectedIde, modelOptions]);

  const q = query.trim().toLowerCase();
  const filtered = q ? items.filter(i => `${i.group} ${i.label}`.toLowerCase().includes(q)) : items;

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(v => Math.min(filtered.length - 1, v + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(v => Math.max(0, v - 1)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      filtered[active]?.run();
    }
  };

  const tabTitle = state ? activeTabOf(state)?.title : null;
  void tabTitle;

  return (
    <div className="anim-overlay palette-scrim" onClick={onClose}>
      <div className="anim-popover palette" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="切机器 / 会话 / 模式 / 模型…"
          className="palette-input"
        />
        <div ref={listRef} className="max-h-[46vh] overflow-y-auto p-1.5">
          {filtered.length === 0 && <div className="p-3.5 text-[length:var(--text-chrome)] text-[var(--text-weak)]">无匹配</div>}
          {filtered.map((item, i) => {
            const showGroup = i === 0 || filtered[i - 1].group !== item.group;
            return (
              <div key={item.id}>
                {showGroup && <div className="px-2.5 pb-0.5 pt-2 text-[11px] text-[var(--text-weak)]">{item.group}</div>}
                <button
                  type="button"
                  data-idx={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={item.run}
                  className={`menu-item ${i === active ? 'bg-[var(--bg-3)]' : ''}`}
                >
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{item.label}</span>
                  {item.hint && <span className="shrink-0 text-[11px] text-[var(--text-weak)]">{item.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex gap-3.5 border-t border-[var(--hairline)] px-3.5 py-2 text-[11px] text-[var(--text-weak)]">
          <span>
            <ArrowUp size={10} />
            <ArrowDown size={10} />
            {' '}
            选择
          </span>
          <span>
            <ArrowBendDownLeft size={10} />
            {' '}
            执行
          </span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
