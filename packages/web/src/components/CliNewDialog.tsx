import type { CliModelCatalog, CliSource, CliThinkingLevel, CommandResult } from '../net/protocol';
import { useEffect, useState } from 'react';
import { readCliCatalog, writeCliCatalog } from '../lib/cli-catalog-cache';
import { sendCliCatalog } from '../net/send';
import { cliAgentLabel } from '../store/cli';
import { FieldSelect } from './FieldSelect';
import { FloatLayer } from './FloatLayer';

const FIELD = 'w-full border border-[var(--hairline)] bg-transparent px-2 py-1.5 text-[length:var(--text-chrome)] text-[var(--text-primary)]';

/**
 * Last model list for this page, also kept in sessionStorage.
 * Reopening the dialog, including after a refresh, shows that list at once, then asks again.
 */
const catalogCache = new Map<string, CliModelCatalog>();

export function CliNewDialog({
  sources,
  directories,
  initialCwd,
  onClose,
  onSubmit,
}: {
  sources: Array<{ source: CliSource }>;
  directories: Array<{ cwd: string; title: string }>;
  /** Set when the dialog was opened from one directory's +. That path stays put. */
  initialCwd?: string;
  onClose: () => void;
  onSubmit: (source: CliSource, cwd: string, choice: { modelId?: string; thinking?: string }) => boolean;
}) {
  const lockedCwd = initialCwd?.startsWith('/') ? initialCwd : undefined;
  const [cwd, setCwd] = useState(lockedCwd ?? '');
  const [source, setSource] = useState<CliSource | ''>('');
  const [loaded, setLoaded] = useState<LoadedCatalog | undefined>();
  /** null follows the catalog's current model. '' is 使用默认. */
  const [modelChoice, setModelChoice] = useState<string | null>(null);
  const [thinking, setThinking] = useState('');
  const trimmed = cwd.trim();
  const askKey = source;
  const cached = source ? readCliCatalog(source, catalogCache, catalogStorage()) : undefined;
  const current = loaded?.key === askKey
    ? loaded
    : cached
      ? { key: askKey, phase: 'ready' as const, catalog: cached }
      : undefined;

  useEffect(() => {
    if (source !== 'cursor-cli')
      return;
    return watchCatalog(source, undefined, source, setLoaded);
  }, [source]);

  // CodeBuddy and Codex report models from `session/new` in the chosen directory.
  useEffect(() => {
    if ((source !== 'codebuddy-cli' && source !== 'codex-cli') || !trimmed.startsWith('/'))
      return;
    return watchCatalog(source, trimmed, source, setLoaded);
  }, [source, trimmed]);

  const phase = dialogPhase(source, trimmed, current);
  const catalog = current?.catalog;
  const modelsReady = phase === 'ready' && catalog != null;
  const levelModelId = modelChoice || catalog?.currentModelId || '';
  const thinkingLevels = modelsReady ? levelsForModel(catalog, levelModelId) : [];
  const thinkingReady = thinkingLevels.length > 0;
  const thinkingValue = thinkingLevels.some(level => level.value === thinking) ? thinking : '';
  const modelId = modelChoice ?? catalog?.currentModelId ?? '';
  const canCreate = source !== '' && modelId !== '';

  return (
    <FloatLayer
      variant="modal"
      label="新建 CLI 会话"
      contentClassName="!overflow-visible"
      onOpenChange={(open) => {
        if (!open)
          onClose();
      }}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canCreate || !source)
            return;
          const choice = {
            ...(modelId ? { modelId } : {}),
            ...(thinkingValue ? { thinking: thinkingValue } : {}),
          };
          if (onSubmit(source, cwd, choice))
            onClose();
        }}
      >
        <div className="font-semibold">新建</div>
        <label className="flex flex-col gap-1 text-[length:var(--text-chrome)] text-[var(--text-secondary)]">
          工作目录
          <input
            value={cwd}
            onChange={event => setCwd(event.target.value)}
            placeholder="绝对路径"
            aria-label="工作目录"
            readOnly={lockedCwd !== undefined}
            title={cwd}
            className={FIELD}
          />
        </label>
        {lockedCwd === undefined && directories.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {directories.map(dir => (
              <button
                key={dir.cwd}
                type="button"
                title={dir.cwd}
                onClick={() => setCwd(dir.cwd)}
                className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-transparent px-2 py-1 text-[length:var(--text-chrome)] text-[var(--text-secondary)]"
              >
                {dir.title}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-1 text-[length:var(--text-chrome)] text-[var(--text-secondary)]">
          <span id="cli-agent-label">Agent</span>
          <FieldSelect
            labelledBy="cli-agent-label"
            value={source}
            placeholder="选择 Agent"
            options={[
              { id: '', label: '选择 Agent' },
              ...sources.map(row => ({ id: row.source, label: cliAgentLabel(row.source) })),
            ]}
            onChange={(id) => {
              setSource(id as CliSource | '');
              setModelChoice(null);
              setThinking('');
              setLoaded(undefined);
            }}
          />
        </div>
        <div className="flex flex-col gap-1 text-[length:var(--text-chrome)] text-[var(--text-secondary)]">
          <span id="cli-model-label">模型</span>
          <FieldSelect
            labelledBy="cli-model-label"
            loading={phase === 'loading'}
            disabled={!modelsReady}
            placeholder={modelPlaceholder(phase)}
            busyLabel="正在读取模型"
            value={modelId}
            searchable
            searchLabel="搜索模型"
            showId
            options={modelsReady ? [{ id: '', label: '使用默认' }, ...catalog.models] : []}
            onChange={setModelChoice}
          />
        </div>
        {thinkingReady && (
          <div className="flex flex-col gap-1 text-[length:var(--text-chrome)] text-[var(--text-secondary)]">
            <span id="cli-thinking-label">思考强度</span>
            <FieldSelect
              labelledBy="cli-thinking-label"
              value={thinkingValue}
              placeholder="使用默认"
              options={[
                { id: '', label: '使用默认' },
                ...thinkingLevels.map(level => ({ id: level.value, label: level.label })),
              ]}
              onChange={setThinking}
            />
          </div>
        )}
        <p className="text-[length:var(--text-chrome)] text-[var(--text-weak)]">
          {phaseText(phase, thinkingReady, modelsReady && catalogHasPerModelThinking(catalog))}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn !px-3 !py-1.5" onClick={onClose}>取消</button>
          <button type="submit" className="btn btn-primary !px-3 !py-1.5 disabled:cursor-not-allowed" disabled={!canCreate}>新建</button>
        </div>
      </form>
    </FloatLayer>
  );
}

function watchCatalog(
  source: CliSource,
  cwd: string | undefined,
  key: string,
  setLoaded: (value: LoadedCatalog) => void,
): () => void {
  let cancelled = false;
  const timer = setTimeout(() => {
    void sendCliCatalog(source, cwd).then((result) => {
      if (cancelled)
        return;
      const next = catalogFromResult(result);
      if (!result.ok || !next) {
        if (catalogCache.has(key))
          return;
        setLoaded({ key, phase: result.ok ? 'empty' : 'error' });
        return;
      }
      writeCliCatalog(key, next, catalogCache, catalogStorage());
      setLoaded({ key, phase: 'ready', catalog: next });
    }).catch(() => {
      if (!cancelled && !catalogCache.has(key))
        setLoaded({ key, phase: 'error' });
    });
  }, cwd === undefined ? 0 : 400);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

function catalogStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  }
  catch {
    return undefined;
  }
}

interface LoadedCatalog {
  key: string;
  phase: 'ready' | 'empty' | 'error';
  catalog?: CliModelCatalog;
}

function dialogPhase(
  source: CliSource | '',
  cwd: string,
  current: LoadedCatalog | undefined,
): 'idle' | 'need-cwd' | 'loading' | 'ready' | 'empty' | 'error' {
  if (!source)
    return 'idle';
  if (source !== 'cursor-cli' && !cwd.startsWith('/'))
    return 'need-cwd';
  return current?.phase ?? 'loading';
}

function modelPlaceholder(phase: 'idle' | 'need-cwd' | 'loading' | 'ready' | 'empty' | 'error'): string {
  if (phase === 'need-cwd')
    return '先填工作目录';
  if (phase === 'empty' || phase === 'error')
    return '使用默认';
  return '选择 Agent 后读取';
}

function levelsForModel(catalog: CliModelCatalog, modelId: string): CliThinkingLevel[] {
  const model = catalog.models.find(item => item.id === modelId);
  if (model?.thinking)
    return model.thinking.levels;
  if (catalog.models.some(item => item.thinking))
    return [];
  return catalog.thinking?.levels ?? [];
}

function catalogHasPerModelThinking(catalog: CliModelCatalog | undefined): boolean {
  return catalog?.models.some(model => model.thinking != null) ?? false;
}

function phaseText(
  phase: 'idle' | 'need-cwd' | 'loading' | 'ready' | 'empty' | 'error',
  hasThinking: boolean,
  perModel: boolean,
): string {
  if (phase === 'need-cwd')
    return '先填一个绝对路径，再读取这个 Agent 的模型和思考强度。';
  if (phase === 'loading')
    return '正在读取这个 Agent 报出的模型。';
  if (phase === 'ready' && perModel) {
    if (hasThinking)
      return '这是当前这个模型自己的思考强度。换一个模型，列表会跟着变。';
    return '这个模型没有单独的思考强度。换一个模型后再看。';
  }
  if (phase === 'ready' && !hasThinking)
    return '思考强度写在模型名字里，例如 grok-4.7-high。可以搜索。换 Agent 后这份列表会重来。';
  if (phase === 'ready')
    return '换 Agent 后这份列表会重来。';
  if (phase === 'empty')
    return '这个 Agent 没有报出模型，新建会用它自己的默认。';
  if (phase === 'error')
    return '没有读到模型，新建会用它自己的默认。';
  return '先选一个 Agent。选完后读取它报出的模型。';
}

function catalogFromResult(result: CommandResult): CliModelCatalog | undefined {
  if (!result.ok || result.data == null || typeof result.data !== 'object')
    return undefined;
  const catalog = (result.data as { catalog?: CliModelCatalog }).catalog;
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0)
    return undefined;
  return catalog;
}
