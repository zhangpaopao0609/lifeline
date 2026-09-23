import { CaretDown, Check } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { sendCommandAwaitResult } from '../net/socket';
import { useIdesStore } from '../store/ides';
import { useUiStore } from '../store/ui';
import { FloatLayer } from './FloatLayer';

interface ModelOption {
  id: string;
  label: string;
  selected?: boolean;
}

export function ModeModelPicker() {
  const ides = useIdesStore(s => s.ides);
  const selectedIde = useIdesStore(s => s.selectedIde);
  const applyStatePatch = useIdesStore(s => s.applyStatePatch);
  const pushToast = useUiStore(s => s.pushToast);
  const [open, setOpen] = useState<null | 'mode' | 'model'>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[] | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setModelOptions(null);
    setModelError(null);
  }, [selectedIde]);

  const state = ides[selectedIde];
  if (!state)
    return null;
  const { mode, model } = state;

  const loadModelOptions = (force = false) => {
    if (loading)
      return;
    if (!force && modelOptions !== null && modelOptions.length > 0)
      return;
    setLoading(true);
    setModelError(null);
    void sendCommandAwaitResult('command:get_model_options', { ide: selectedIde })
      .then((r) => {
        const data = r.data as { options?: ModelOption[] } | undefined;
        if (r.ok && Array.isArray(data?.options) && data.options.length > 0) {
          setModelOptions(data.options);
          return;
        }
        setModelOptions(null);
        setModelError(r.error || '模型列表为空');
      })
      .catch((err: unknown) => {
        setModelOptions(null);
        setModelError(err instanceof Error ? err.message : '模型列表加载超时');
      })
      .finally(() => setLoading(false));
  };

  const openModelPicker = () => {
    setOpen('model');
    loadModelOptions();
  };

  const pickMode = (id: string, label: string) => {
    setOpen(null);
    if (id === mode.available.find(m => m.label === mode.current)?.id)
      return;
    const prev = mode.current;
    applyStatePatch({ ide: selectedIde, patch: { mode: { ...mode, current: label } } });
    void sendCommandAwaitResult('command:set_mode', { ide: selectedIde, modeId: id })
      .then((r) => {
        if (r.ok) {
          pushToast(`Mode: ${label}`);
        }
        else {
          applyStatePatch({ ide: selectedIde, patch: { mode: { ...mode, current: prev } } });
          pushToast(r.error || '设置失败', 'error');
        }
      })
      .catch(() => {
        applyStatePatch({ ide: selectedIde, patch: { mode: { ...mode, current: prev } } });
        pushToast('设置超时', 'error');
      });
  };

  const pickModel = (opt: ModelOption) => {
    setOpen(null);
    if (opt.id === model.currentId)
      return;
    const prev = { ...model };
    applyStatePatch({ ide: selectedIde, patch: { model: { current: opt.label, currentId: opt.id } } });
    void sendCommandAwaitResult('command:set_model', { ide: selectedIde, modelId: opt.id })
      .then((r) => {
        if (r.ok) {
          pushToast(`Model: ${opt.label}`);
        }
        else {
          applyStatePatch({ ide: selectedIde, patch: { model: prev } });
          pushToast(r.error || '设置失败', 'error');
        }
      })
      .catch(() => {
        applyStatePatch({ ide: selectedIde, patch: { model: prev } });
        pushToast('设置超时', 'error');
      });
  };

  return (
    <>
      <FloatLayer
        open={open === 'mode'}
        onOpenChange={o => setOpen(o ? 'mode' : null)}
        label="Mode"
        trigger={(
          <button type="button" className="pill">
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{mode?.current || 'Agent'}</span>
            <CaretDown size={12} />
          </button>
        )}
      >
        {(mode?.available ?? []).map(m => (
          <button key={m.id} type="button" onClick={() => pickMode(m.id, m.label)} className="menu-item">
            <span className="flex-1">{m.label}</span>
            {m.label === mode.current && <Check size={14} color="var(--accent)" />}
          </button>
        ))}
        {(mode?.available?.length ?? 0) === 0 && <div className="p-2.5 text-[length:var(--text-chrome)] text-[var(--text-weak)]">无可用 mode</div>}
      </FloatLayer>

      <FloatLayer
        open={open === 'model'}
        onOpenChange={o => (o ? openModelPicker() : setOpen(null))}
        label="Model"
        trigger={(
          <button type="button" className="pill">
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{model?.current || 'Auto'}</span>
            <CaretDown size={12} />
          </button>
        )}
      >
        {loading && (
          <>
            {[0, 1, 2].map(i => (
              <div key={i} className="m-1 h-[34px] rounded-[var(--radius-md)] bg-[var(--bg-3)] opacity-50" />
            ))}
          </>
        )}
        {!loading && modelOptions?.map(opt => (
          <button key={opt.id} type="button" onClick={() => pickModel(opt)} className="menu-item">
            <span className="flex-1">{opt.label}</span>
            {(opt.id === model.currentId || opt.selected) && <Check size={14} color="var(--accent)" />}
          </button>
        ))}
        {!loading && modelError && (
          <div className="flex flex-col gap-2 p-2.5">
            <span className="text-[length:var(--text-chrome)] text-[var(--text-weak)]">模型列表加载失败</span>
            <span className="mono break-all text-[11px] text-[var(--text-weak)]">{modelError}</span>
            <button type="button" onClick={() => loadModelOptions(true)} className="menu-item justify-center border border-[var(--hairline-strong)]">
              重试
            </button>
          </div>
        )}
      </FloatLayer>
    </>
  );
}
