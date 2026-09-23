import type { MachineInfo } from '../net/protocol';
import { useEffect, useRef, useState } from 'react';
import { MACHINE_NAME_MAX_LENGTH } from '../net/protocol';
import { socket } from '../net/socket';
import { useUiStore } from '../store/ui';
import { FloatLayer } from './FloatLayer';

/**
 * "Edit this computer" dialog (machine-row ⋯ menu → Edit…): centered desktop dialog / phone bottom sheet.
 *
 * Currently only the "name" field, **save submits immediately**; later fields (notes, tags…) stack below.
 * Don't put rename back as inline input in the ⋯ menu — one entry + one dialog, so adding fields doesn't touch the menu.
 * Sanitization and persistence live on the server (`machine:rename` → `normalizeMachineName`); this file only handles input.
 */
export function MachineEditDialog({
  machine,
  onClose,
}: {
  machine: MachineInfo;
  onClose: () => void;
}) {
  const pushToast = useUiStore(s => s.pushToast);
  const [name, setName] = useState(machine.displayName ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = `machine-name-${machine.agentId}`;

  useEffect(() => {
    // On open, put the caret in the field and select the old name: a rename is usually a full replace, so skip one delete.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const save = () => {
    const next = name.trim();
    if (next === (machine.displayName ?? '')) {
      onClose();
      return;
    }
    socket.emit(
      'machine:rename',
      { agentId: machine.agentId, displayName: next },
      (r: { ok: boolean }) => {
        if (!r?.ok) {
          // Don't close on failure: the input is still there, so a tweak can retry immediately.
          pushToast('重命名失败', 'error');
          return;
        }
        pushToast(next ? `已重命名为 ${next}` : `已恢复 ${machine.hostname}`, 'ok');
        onClose();
      },
    );
  };

  return (
    <FloatLayer
      variant="modal"
      label="编辑这台电脑"
      contentClassName="max-w-[440px]"
      onOpenChange={(o) => {
        if (!o)
          onClose();
      }}
    >
      <div className="mb-3.5 flex items-baseline justify-between gap-3">
        <div className="font-semibold">编辑这台电脑</div>
        {/* Hostname is this machine's real identity and can't be changed; sit it next to the title so the two line up at a glance. */}
        <span className="mono min-w-0 truncate text-[length:var(--text-chrome)] text-[var(--text-weak)]">
          {machine.hostname}
        </span>
      </div>

      <div className="mb-4 flex items-start gap-3">
        <label
          htmlFor={inputId}
          className="w-12 shrink-0 pt-2 text-[length:var(--text-chrome)] text-[var(--text-secondary)]"
        >
          名字
        </label>
        <div className="min-w-0 flex-1">
          <input
            id={inputId}
            ref={inputRef}
            value={name}
            maxLength={MACHINE_NAME_MAX_LENGTH}
            placeholder={machine.hostname}
            onChange={e => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter')
                save();
            }}
            className="w-full rounded-[var(--radius-md)] border border-[var(--hairline-strong)] bg-[var(--bg-0)] px-2.5 py-2 font-[inherit] text-[length:var(--text-body)] text-[var(--text-primary)] outline-none"
          />
          <div className="mt-1 text-[length:var(--text-chrome)] text-[var(--text-weak)]">
            留空 = 用机器名
            {' '}
            <span className="mono">{machine.hostname}</span>
            。只影响网页上怎么叫它，不动主机名、不影响归属。
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn btn-primary" onClick={save}>
          保存
        </button>
      </div>
    </FloatLayer>
  );
}
