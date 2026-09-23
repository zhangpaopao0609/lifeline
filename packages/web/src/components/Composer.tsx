import { PaperPlaneRight, Square } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { cdpIssueCopy } from '../lib/cdp-issue-copy';
import { IDE_LABELS } from '../net/protocol';
import { sendUserMessage, stopSession } from '../net/send';
import { activeTabOf, isActiveSessionWorking, isDraftTab, sendTargetOf, useIdesStore } from '../store/ides';
import { useMachinesStore } from '../store/machines';
import { useSessionsStore } from '../store/sessions';
import { useUiStore } from '../store/ui';
import { ModeModelPicker } from './ModeModelPicker';
import { QueuePopover } from './QueuePopover';

const isTouchPrimary = () => window.matchMedia('(pointer: coarse)').matches;
const CDP_BANNER_DELAY_MS = 3000;

export function Composer() {
  const ides = useIdesStore(s => s.ides);
  const selectedIde = useIdesStore(s => s.selectedIde);
  const selectedAgentId = useMachinesStore(s => s.selectedAgentId);
  const machines = useMachinesStore(s => s.machines);
  const pendingSwitch = useUiStore(s => s.pendingSwitch);
  const pendingRestore = useSessionsStore(s => s.pendingRestore);
  const takePendingRestore = useSessionsStore(s => s.takePendingRestore);
  const clearPendingRestore = useSessionsStore(s => s.clearPendingRestore);
  const [draft, setDraft] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (pendingRestore !== null && draft.trim() === '') {
      setDraft(takePendingRestore() ?? '');
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`; }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRestore]);

  const state = ides[selectedIde];
  const tab = state ? activeTabOf(state) : null;
  const target = state ? sendTargetOf(state) : null;
  const selectedMachine = machines.find(m => m.agentId === selectedAgentId);
  const machineOffline = selectedMachine?.connected === false;
  // Content-only machine (remote dev box) has no IDE: sessions are readable, but input/approvals cannot be taken over.
  const machineContentOnly = selectedMachine?.contentOnly === true;
  const ideLabel = IDE_LABELS[selectedIde];
  const cdpIssue = state?.cdpIssue ?? null;
  const liveIssue = cdpIssue ? null : (state?.liveIssue ?? null);
  const issue = cdpIssue ?? liveIssue;
  const [bannerVisible, setBannerVisible] = useState(false);
  // Passive disconnect uses these 3s to hide flicker; occupier / detail refresh must not reset the timer.
  useEffect(() => {
    setBannerVisible(false);
    if (!issue)
      return;
    const t = window.setTimeout(setBannerVisible, CDP_BANNER_DELAY_MS, true);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key is scope+kind, not detail
  }, [issue?.scope, issue?.kind]);
  // Optimistic "switching": the server hasn't switched yet, so a send would hit the old session — lock first.
  const pendingHere = pendingSwitch && pendingSwitch.ide === selectedIde ? pendingSwitch : null;
  // Session in progress (thinking/generating/running tools): lock input so we don't send into a half-done session.
  // Same criterion as title/session-row loading (row-level spinner wins); a long task doesn't unlock mid-run.
  const working = isActiveSessionWorking(state, pendingHere);
  const ideConnected = state?.connected === true;
  const canSend
    = draft.trim().length > 0 && !!target && !machineOffline && !machineContentOnly && !pendingHere && !working && ideConnected;
  // While generating, the send key becomes a stop key (same place, same action as the one in the IDE).
  // Both IDEs are enrolled: CodeBuddy uses fiber onCancel; Cursor uses the composer's
  // `[data-stop-button="true"]` / `aria-label="Stop generation"` (when not generating the agent returns
  // `Not generating`, explained in a toast — not a silent failure).
  const canStop
    = working && !!target && !machineOffline && !machineContentOnly && !pendingHere && ideConnected;

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta)
      return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  };

  /**
   * Draft text (created via ＋ / New Agent, no first message yet): already typed in the IDE composer;
   * the extractor puts it on `tab.draftText` (the Agents-window draft row title is this text, but newlines
   * are flattened, so it cannot be the send payload). Fill it into the input — a draft is no longer just
   * a list row, but **text you can send** (2026-09-18 feedback).
   *
   * Two guards: fill only when the input is empty (don't overwrite what the user is typing), and only once
   * per draft (re-stuffing text the user cleared is the most annoying). Identify the draft by
   * "window + section + title + same-title index" — drafts have no real id (Agents window uses tab-N placeholders that drift as rows change).
   */
  const draftKey = tab && isDraftTab(tab)
    ? `${selectedIde}:${tab.windowId ?? ''}:${tab.section ?? ''}:${tab.title}:${tab.sameTitleIndex ?? 0}`
    : '';
  const draftText = tab && isDraftTab(tab) ? (tab.draftText ?? '') : '';
  const prefilledDraftRef = useRef('');
  useEffect(() => {
    // Leaving a draft clears the "already filled" memory: next time in (empty input) we fill the text again.
    if (!draftKey) {
      prefilledDraftRef.current = '';
      return;
    }
    if (!draftText || draft.trim() !== '')
      return;
    if (prefilledDraftRef.current === draftKey)
      return;
    prefilledDraftRef.current = draftKey;
    setDraft(draftText);
    requestAnimationFrame(autoGrow);
  }, [draftKey, draftText, draft]);

  const requestScrollToBottom = useUiStore(s => s.requestScrollToBottom);

  const send = () => {
    if (!draft.trim() || !target || !state || machineContentOnly || pendingHere || working || !state.connected)
      return;
    if (!sendUserMessage(draft))
      return;
    setDraft('');
    requestAnimationFrame(autoGrow);
    requestScrollToBottom();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter')
      return;
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); send(); return; }
    if (e.shiftKey)
      return;
    if (isTouchPrimary())
      return;
    e.preventDefault(); send();
  };

  const placeholder = pendingHere
    ? `正在切换到「${pendingHere.title || '未命名'}」…`
    : working
      ? '会话进行中…'
      : !state
          ? '该 IDE 无状态'
          : cdpIssue
            ? cdpIssueCopy(cdpIssue, ideLabel).text
            : machineContentOnly
              ? '内容源（只读）：这台机器不接管输入'
              : machineOffline
                ? '机器已离线，无法发送'
                : isDraftTab(tab)
                // Draft: the title is the draft text (or still New Agent); don't splice it into "send to …".
                  ? (draftText ? '草稿里的文字已填好，可直接发送' : '新会话（草稿）—— 发第一条消息')
                  : target
                    ? `发给 ${tab?.title ?? target.tabTitle}`
                    : '无可用发送目标';

  const bannerCopy = bannerVisible && issue ? cdpIssueCopy(issue, ideLabel) : null;
  const bannerText = bannerCopy
    ? (liveIssue ? `能看但不能发送/审批：${bannerCopy.text}` : bannerCopy.text)
    : '';
  const bannerClass = bannerCopy?.tone === 'warn'
    ? 'text-[var(--error)]'
    : 'text-[var(--text-weak)]';

  return (
    <div className="composer-dock">
      {pendingRestore !== null && draft.trim() !== '' && (
        <div className="content-col mb-2 flex items-center gap-3 text-[length:var(--text-chrome)] text-[var(--error)]">
          发送失败，原内容可填回
          <button
            type="button"
            onClick={() => {
              const t = takePendingRestore(); if (t !== null)
                setDraft(t);
            }}
            className="btn btn-outline !py-0.5 !px-2.5"
          >
            填回
          </button>
          <button type="button" onClick={clearPendingRestore} className="text-[length:var(--text-chrome)] text-[var(--text-weak)]">
            忽略
          </button>
        </div>
      )}
      {bannerCopy && (
        <div className={`content-col mb-2 text-[length:var(--text-chrome)] ${bannerClass}`}>
          {bannerText}
        </div>
      )}
      <div className="content-col mb-1.5 flex items-center gap-2">
        <ModeModelPicker />
        <QueuePopover />
      </div>
      <div className="content-col composer-box">
        <textarea
          ref={taRef}
          value={draft}
          rows={1}
          onChange={(e) => { setDraft(e.target.value); autoGrow(); }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={!ideConnected || machineOffline || machineContentOnly || working}
          className="min-w-0 flex-1 resize-none border-0 bg-transparent px-0 py-1.5 font-[inherit] text-[var(--text-primary)] outline-none disabled:opacity-60"
        />
        {canStop
          ? (
              <button
                type="button"
                aria-label="停止生成"
                title="停止生成"
                onClick={() => { stopSession(); }}
                className="send-btn bg-transparent text-[var(--text-primary)]"
              >
                <Square size={16} weight="fill" />
              </button>
            )
          : (
              <button
                type="button"
                aria-label="发送"
                onClick={send}
                disabled={!canSend}
                className={`send-btn ${canSend ? 'bg-[var(--accent)] text-[var(--text-inverse)]' : 'bg-transparent text-[var(--text-weak)]'}`}
              >
                <PaperPlaneRight size={18} weight="fill" />
              </button>
            )}
      </div>
    </div>
  );
}
