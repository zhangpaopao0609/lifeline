import type { CliModelCatalog } from '@lifeline/protocol';
import { CaretDown, Check, Copy } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { FloatLayer } from './FloatLayer';

/**
 * Models and thinking levels can be chosen while the session is idle.
 * Menus open upward: the bar sits on the bottom edge of the screen.
 */
export function CliModelBar({
  catalog,
  onModel,
  onThinking,
  resumeCommand,
  showThinking = true,
}: {
  catalog?: CliModelCatalog;
  onModel?: (modelId: string) => void;
  onThinking?: (thinking: string) => void;
  /** Shell line for this session. Copied onto the machine's terminal. */
  resumeCommand?: string;
  /**
   * Cursor keeps effort and speed inside the model id, so the bar is one list.
   * CodeBuddy still has its own thinking control.
   */
  showThinking?: boolean;
}) {
  const current = catalog?.models.find(model => model.id === catalog.currentModelId);
  const thinking = showThinking ? (current?.thinking ?? catalog?.thinking) : undefined;
  const currentValue = current?.thinking?.current ?? catalog?.thinking?.current;
  const currentLevel = thinking?.levels.find(level => level.value === currentValue);
  if (!catalog && !resumeCommand)
    return null;
  return (
    <div className="content-col mb-1.5 flex flex-wrap items-center gap-2">
      {catalog
        ? (
            <ChoiceList
              label="可用模型"
              wide={!showThinking}
              current={current?.label ?? `${catalog.models.length} 个模型`}
              choices={catalog.models.map(model => ({
                id: model.id,
                label: model.label,
                selected: model.id === catalog.currentModelId,
              }))}
              onPick={onModel}
            />
          )
        : null}
      {thinking && thinking.levels.length > 0
        ? (
            <ChoiceList
              label="思考强度"
              current={currentLevel?.label ?? '思考强度'}
              choices={thinking.levels.map(level => ({
                id: level.value,
                label: level.label,
                selected: level.value === currentValue,
              }))}
              onPick={onThinking}
            />
          )
        : null}
      {resumeCommand ? <ResumeCopy command={resumeCommand} /> : null}
    </div>
  );
}

function ResumeCopy({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
    }
    catch {
      const area = document.createElement('textarea');
      area.value = command;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setCopied(true);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(setCopied, 1500, false);
  };
  return (
    <button type="button" className="pill shrink-0" style={{ maxWidth: 'none' }} onClick={() => void copy()}>
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? '已复制' : '复制到终端'}
    </button>
  );
}

function ChoiceList({
  label,
  current,
  choices,
  onPick,
  wide = false,
}: {
  label: string;
  current: string;
  choices: Array<{ id: string; label: string; selected: boolean }>;
  onPick?: (id: string) => void;
  /** Cursor's one pill is the whole model id, so it is not clipped at 180px. */
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <FloatLayer
      open={open}
      onOpenChange={setOpen}
      label={label}
      side="top"
      trigger={(
        <button type="button" className="pill" aria-label={label} style={wide ? { maxWidth: 'none' } : undefined}>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{current}</span>
          <CaretDown size={12} />
        </button>
      )}
    >
      {choices.map(choice => onPick
        ? (
            <button
              key={choice.id}
              type="button"
              className="menu-item cursor-pointer font-[inherit]"
              aria-current={choice.selected ? 'true' : undefined}
              onClick={() => {
                if (choice.selected)
                  return;
                onPick(choice.id);
                setOpen(false);
              }}
            >
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{choice.label}</span>
              {choice.selected ? <Check size={14} color="var(--accent)" /> : null}
            </button>
          )
        : (
            <div
              key={choice.id}
              className="menu-item cursor-default"
              aria-current={choice.selected ? 'true' : undefined}
            >
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{choice.label}</span>
              {choice.selected ? <Check size={14} color="var(--accent)" /> : null}
            </div>
          ))}
    </FloatLayer>
  );
}
