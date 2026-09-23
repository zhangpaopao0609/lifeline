import type { PlanBlock, PlanFullData, PlanModelOption, PlanTodo } from '../net/protocol';
import { CaretDown, X } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { sendCommand, sendCommandAwaitResult } from '../net/socket';
import { useIdesStore } from '../store/ides';
import { useUiStore } from '../store/ui';
import { FloatLayer } from './FloatLayer';
import { MarkdownView } from './MessageBubble';

const TODO_DOT: Record<PlanTodo['status'], string> = {
  pending: 'var(--text-weak)',
  in_progress: 'var(--accent)',
  completed: 'var(--ok)',
};

/**
 * P7 Plan detail (spec P7): centered desktop dialog (max 760px overlay); full-screen page on phone.
 * Body loads via command:get_plan_full ({todos, body} markdown); skeleton while loading.
 */
export function PlanView({ msg, onClose }: { msg: PlanBlock; onClose: () => void }) {
  const isDesktop = useIsDesktop();
  const selectedIde = useIdesStore(s => s.selectedIde);
  const pushToast = useUiStore(s => s.pushToast);
  const [full, setFull] = useState<PlanFullData | null>(null);
  const [loading, setLoading] = useState(true);
  const [rawView, setRawView] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<PlanModelOption[] | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void sendCommandAwaitResult('command:get_plan_full', { ide: selectedIde, planLabel: msg.label })
      .then((r) => {
        if (!alive)
          return;
        if (r.ok && r.data && typeof r.data === 'object')
          setFull(r.data as PlanFullData);
        else pushToast(r.error || 'Plan 加载失败', 'error');
      })
      .catch(() => {
        if (alive)
          pushToast('Plan 加载超时', 'error');
      })
      .finally(() => {
        if (alive)
          setLoading(false);
      });
    return () => { alive = false; };
  }, [msg.label, selectedIde, pushToast]);

  const openModelPicker = () => {
    setModelPickerOpen(true);
    if (modelOptions !== null || !msg.modelDropdownSelectorPath)
      return;
    void sendCommandAwaitResult('command:get_plan_model_options', { ide: selectedIde, selectorPath: msg.modelDropdownSelectorPath })
      .then((r) => {
        const data = r.data as { options?: PlanModelOption[] } | undefined;
        if (r.ok && Array.isArray(data?.options))
          setModelOptions(data.options);
        else pushToast(r.error || '模型列表加载失败', 'error');
      })
      .catch(() => pushToast('模型列表加载超时', 'error'));
  };

  const pickModel = (opt: PlanModelOption) => {
    setModelPickerOpen(false);
    sendCommand('command:set_plan_model', {
      ide: selectedIde,
      selectorPath: msg.modelDropdownSelectorPath,
      planModelId: opt.id,
      planLabel: msg.label,
    });
    pushToast(`Plan model: ${opt.label}`);
  };

  const build = msg.actions?.find(a => a.type === 'build');
  const todos = full?.todos ?? msg.todos ?? [];
  const pct = msg.todosTotal > 0 ? Math.round((msg.todosCompleted / msg.todosTotal) * 100) : 0;

  const header = (
    <div className="flex items-start gap-2.5 border-b border-[var(--hairline)] px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="eyebrow !text-[var(--text-weak)]">{msg.label}</div>
        <div className="mt-0.5 font-semibold">{msg.title}</div>
      </div>
      <button type="button" aria-label="关闭" onClick={onClose} className="icon-btn">
        <X size={18} />
      </button>
    </div>
  );

  const bodyBlock = loading
    ? (
        <div className="p-4">
          {[80, 95, 60].map((w, i) => (
            <div key={i} className="skel-bar opacity-60" style={{ width: `${w}%` }} />
          ))}
        </div>
      )
    : (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="progress-track mb-2.5">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          {todos.map((t, i) => (
            <div
              key={i}
              className={`flex items-center gap-2 py-0.5 text-[length:var(--text-chrome)] ${t.status === 'completed' ? 'text-[var(--text-weak)]' : 'text-[var(--text-secondary)]'}`}
            >
              <span className="dot-sm" style={{ background: TODO_DOT[t.status] }} />
              {t.text}
            </div>
          ))}
          {full?.body && (
            <div className="mt-3.5 border-t border-[var(--hairline)] pt-3">
              {rawView
                ? (
                    <pre className="mono m-0 whitespace-pre-wrap text-xs text-[var(--text-secondary)]">{full.body}</pre>
                  )
                : (
                    <MarkdownView text={full.body} />
                  )}
            </div>
          )}
        </div>
      );

  const footer = (
    <div className="flex items-center gap-2.5 border-t border-[var(--hairline)] px-4 py-2.5">
      {build && (
        <button
          type="button"
          onClick={() => { sendCommand('command:click_action', { ide: selectedIde, selectorPath: build.selectorPath, actionLabel: build.label }); onClose(); }}
          className="btn btn-primary"
        >
          {build.label || 'Build'}
        </button>
      )}
      {msg.modelDropdownSelectorPath && (
        <FloatLayer
          open={modelPickerOpen}
          onOpenChange={o => (o ? openModelPicker() : setModelPickerOpen(false))}
          label="Model"
          trigger={(
            <button type="button" className="btn btn-ghost inline-flex items-center gap-1">
              <span className="mono">{msg.model ?? 'plan model'}</span>
              <CaretDown size={12} />
            </button>
          )}
        >
          {modelOptions === null && <div className="p-2.5 text-[length:var(--text-chrome)] text-[var(--text-weak)]">加载中…</div>}
          {modelOptions?.map(opt => (
            <button key={opt.id} type="button" onClick={() => pickModel(opt)} className="menu-item">
              {opt.label}
              {opt.selected ? ' ✓' : ''}
            </button>
          ))}
        </FloatLayer>
      )}
      {full?.body && (
        <button type="button" onClick={() => setRawView(v => !v)} className="btn btn-ghost ml-auto">
          {rawView ? 'View 渲染' : 'View 原文'}
        </button>
      )}
    </div>
  );

  if (!isDesktop) {
    return (
      <div className="fixed inset-0 z-[70] flex flex-col bg-[var(--bg-0)]">
        {header}
        {bodyBlock}
        {footer}
      </div>
    );
  }

  return (
    <div className="anim-overlay modal-scrim" onClick={onClose}>
      <div className="anim-popover modal-card" onClick={e => e.stopPropagation()}>
        {header}
        {bodyBlock}
        {footer}
      </div>
    </div>
  );
}
