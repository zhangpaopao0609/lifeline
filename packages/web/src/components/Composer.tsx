import type { MessageAttachment } from '../net/protocol';
import type { ActiveTarget } from '../store/cli';
import { Paperclip, PaperPlaneRight, Square, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { usePendingNewChat } from '../hooks/usePendingNewChat';
import { cdpIssueCopy } from '../lib/cdp-issue-copy';
import { IDE_LABELS, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_ATTACHMENTS_TOTAL_BYTES } from '../net/protocol';
import { selectCliModel, selectCliThinking, sendCliMessage, sendUserMessage, stopCliSession, stopSession } from '../net/send';
import {
  canSendForTarget,
  cliCanStop,
  cliComposeBlock,
  cliSession,
  composerDraftBucket,
  readComposerDraft,
  useCliStore,
  writeComposerDraft,
} from '../store/cli';
import { activeTabOf, isActiveSessionWorking, isDraftTab, sendTargetOf, useIdesStore } from '../store/ides';
import { useMachinesStore } from '../store/machines';
import { useSessionsStore } from '../store/sessions';
import { useUiStore } from '../store/ui';
import { CliModelBar } from './CliModelBar';
import { ModeModelPicker } from './ModeModelPicker';
import { QueuePopover } from './QueuePopover';

const isTouchPrimary = () => window.matchMedia('(pointer: coarse)').matches;
const CDP_BANNER_DELAY_MS = 3000;

const MB = 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes >= MB)
    return `${(bytes / MB).toFixed(1)}MB`;
  if (bytes >= 1024)
    return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/** One picked file → wire attachment (base64 body; the `data:` prefix is dropped). */
function readAttachment(file: File): Promise<MessageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      const comma = url.indexOf(',');
      if (comma === -1) {
        reject(new Error(`无法读取：${file.name}`));
        return;
      }
      resolve({ name: file.name, size: file.size, data: url.slice(comma + 1) });
    };
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取：${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function Composer() {
  const target = useUiStore(s => s.activeTarget);
  return (
    <>
      <div style={{ display: target.kind === 'ide' ? 'contents' : 'none' }}>
        <IdeComposer />
      </div>
      {target.kind === 'cli' ? <CliComposer target={target} /> : null}
    </>
  );
}

function IdeComposer() {
  const ides = useIdesStore(s => s.ides);
  const selectedIde = useIdesStore(s => s.selectedIde);
  const selectedAgentId = useMachinesStore(s => s.selectedAgentId);
  const machines = useMachinesStore(s => s.machines);
  const pendingSwitch = useUiStore(s => s.pendingSwitch);
  const pendingRestore = useSessionsStore(s => s.pendingRestore);
  const takePendingRestore = useSessionsStore(s => s.takePendingRestore);
  const clearPendingRestore = useSessionsStore(s => s.clearPendingRestore);
  const [draft, setDraft] = useState('');
  /** Files picked but not sent yet (bytes already read: the send path stays synchronous). */
  const [files, setFiles] = useState<MessageAttachment[]>([]);
  /**
   * The same list, readable synchronously. Reading is async, so two picks in flight would both decide
   * against the pre-pick count and could exceed the limit — every mutation goes through `commitFiles`.
   */
  const filesRef = useRef<MessageAttachment[]>([]);
  const commitFiles = (next: MessageAttachment[]) => {
    filesRef.current = next;
    setFiles(next);
  };
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pushToast = useUiStore(s => s.pushToast);

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
  /**
   * Optimistic create: the chat does not exist on the IDE yet, so `sendTargetOf` still points at the previous
   * session — sending now would post the first message into the wrong conversation. Lock until state catches up
   * (usually a few hundred ms; the row/pane are already painted optimistically, see store/ui PendingNewChat).
   */
  const pendingNewHere = usePendingNewChat();
  // Session in progress (thinking/generating/running tools): lock input so we don't send into a half-done session.
  // Same criterion as title/session-row loading (row-level spinner wins); a long task doesn't unlock mid-run.
  const working = isActiveSessionWorking(state, pendingHere);
  // Multitask delegation: the session itself is done, only background sub-agents still
  // run (row spinner). Input stays usable — same as the IDE composer — with a hint.
  const backgroundRunning = !working && tab?.isActive === true && tab?.backgroundRunning === true;
  const ideConnected = state?.connected === true;
  /** Same gate as the textarea: a file can only be attached when the machine can take a send. */
  const attachDisabled = !ideConnected || machineOffline || machineContentOnly || working;
  // Files alone are enough to send (a bare screenshot is a normal message).
  const canSend
    = (draft.trim().length > 0 || files.length > 0) && !!target && !machineOffline && !machineContentOnly && !pendingHere && !pendingNewHere && !working && ideConnected;
  // While generating, the send key becomes a stop key (same place, same action as the one in the IDE).
  // Both IDEs are enrolled: CodeBuddy uses fiber onCancel; Cursor uses the composer's
  // `[data-stop-button="true"]` / `aria-label="Stop generation"` (when not generating the agent returns
  // `Not generating`, explained in a toast — not a silent failure).
  const canStop
    = working && !!target && !machineOffline && !machineContentOnly && !pendingHere && !pendingNewHere && ideConnected;

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

  /**
   * Pick files: limits are the protocol's (the agent re-checks them) and are reported as toasts rather
   * than silently dropping the pick. Bytes are read here, so `send` stays synchronous and the same
   * payload is reusable by "重试".
   */
  const addFiles = (picked: FileList | null) => {
    if (!picked || picked.length === 0)
      return;
    const incoming = Array.from(picked);
    /** Same three checks, against whatever the list holds *now* (a pick may still be reading). */
    const rejectOver = (current: MessageAttachment[]): boolean => {
      if (current.length + incoming.length > MAX_ATTACHMENTS) {
        pushToast(`附件最多 ${MAX_ATTACHMENTS} 个`, 'error');
        return true;
      }
      const oversized = incoming.find(f => f.size > MAX_ATTACHMENT_BYTES);
      if (oversized) {
        pushToast(`「${oversized.name}」超过 ${Math.round(MAX_ATTACHMENT_BYTES / MB)}MB`, 'error');
        return true;
      }
      const total = current.reduce((sum, f) => sum + f.size, 0) + incoming.reduce((sum, f) => sum + f.size, 0);
      if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
        pushToast(`附件总大小超过 ${Math.round(MAX_ATTACHMENTS_TOTAL_BYTES / MB)}MB`, 'error');
        return true;
      }
      return false;
    };
    if (rejectOver(filesRef.current))
      return;
    void Promise.all(incoming.map(readAttachment))
      .then((next) => {
        if (rejectOver(filesRef.current))
          return;
        commitFiles([...filesRef.current, ...next]);
      })
      .catch((err: unknown) => {
        pushToast(err instanceof Error ? err.message : String(err), 'error');
      });
  };

  const send = () => {
    const current = filesRef.current;
    if ((!draft.trim() && current.length === 0) || !target || !state || machineContentOnly || pendingHere || pendingNewHere || working || !state.connected)
      return;
    if (!sendUserMessage(draft, current))
      return;
    setDraft('');
    commitFiles([]);
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

  const placeholder = pendingNewHere
    ? '正在新建会话…'
    : pendingHere
      ? `正在切换到「${pendingHere.title || '未命名'}」…`
      : working
        ? '会话进行中…'
        : backgroundRunning
          ? '后台任务运行中，可继续发送'
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
      {files.length > 0 && (
        <div className="content-col mb-1.5 flex flex-wrap items-center gap-1.5">
          {files.map((f, i) => (
            <span
              key={`${f.name}-${i}`}
              className="inline-flex max-w-[220px] items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--bg-3)] py-0.5 pr-1 pl-2 text-[length:var(--text-chrome)] text-[var(--text-secondary)]"
            >
              <span className="truncate">{f.name}</span>
              <span className="shrink-0 text-[var(--text-weak)]">{formatSize(f.size)}</span>
              <button
                type="button"
                aria-label={`移除 ${f.name}`}
                onClick={() => commitFiles(filesRef.current.filter((_, index) => index !== i))}
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-weak)] hover:text-[var(--text-primary)]"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="content-col composer-box">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            // Reset so picking the same file again still fires onChange.
            e.target.value = '';
          }}
        />
        <button
          type="button"
          aria-label="添加文件"
          title={`添加文件（最多 ${MAX_ATTACHMENTS} 个，单个 ${Math.round(MAX_ATTACHMENT_BYTES / MB)}MB）`}
          onClick={() => fileRef.current?.click()}
          disabled={attachDisabled}
          className="send-btn bg-transparent text-[var(--text-weak)] hover:text-[var(--text-primary)] disabled:opacity-40"
        >
          <Paperclip size={16} />
        </button>
        <textarea
          ref={taRef}
          value={draft}
          rows={1}
          onChange={(e) => { setDraft(e.target.value); autoGrow(); }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={attachDisabled}
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

let cliDrafts: Record<string, string> = {};

function CliComposer({ target }: { target: Extract<ActiveTarget, { kind: 'cli' }> }) {
  const bucket = composerDraftBucket(target);
  const [draftBucket, setDraftBucket] = useState(bucket);
  const [draft, setDraft] = useState(() => readComposerDraft(cliDrafts, target));
  const taRef = useRef<HTMLTextAreaElement>(null);
  const session = useCliStore(s => cliSession(s.cli, target.agentId, target.sessionId));
  const uplinkConnected = useMachinesStore(s => s.uplinkConnected);
  const machineConnected = useMachinesStore(s => s.machines.find(machine => machine.agentId === target.agentId)?.connected === true);
  const requestScrollToBottom = useUiStore(s => s.requestScrollToBottom);
  if (draftBucket !== bucket) {
    setDraftBucket(bucket);
    setDraft(readComposerDraft(cliDrafts, target));
  }

  const update = (text: string) => {
    cliDrafts = writeComposerDraft(cliDrafts, target, text);
    setDraft(text);
  };
  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta)
      return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  };
  const gate = {
    draft,
    ideConnected: false,
    contentOnly: false,
    machineOffline: !machineConnected,
    uplinkConnected,
    machineConnected,
    pendingSwitch: false,
    working: false,
    hasIdeTarget: false,
    cliStatus: session?.status ?? null,
  };
  const canSend = canSendForTarget(target, gate);
  const canStop = cliCanStop(gate);
  const block = cliComposeBlock(session?.status ?? null);
  const placeholder = !uplinkConnected
    ? '本机未连接，无法发送'
    : !machineConnected
        ? '机器已离线，无法发送'
        : !session
            ? '这条命令行会话已经不在了'
            : block === 'busy'
              ? (session.status === 'waiting_approval' ? '等待审批…' : '会话进行中…')
              : session.status === 'starting'
                ? '会话启动中…'
                : session.status === 'error'
                  ? '这条会话出错了'
                  : session.status === 'idle'
                    ? '发给命令行会话'
                    : '这条会话已经结束';

  const send = () => {
    if (!canSend)
      return;
    if (!sendCliMessage({ kind: 'cli', source: target.source, sessionId: target.sessionId }, draft))
      return;
    update('');
    requestAnimationFrame(autoGrow);
    requestScrollToBottom();
  };

  // Cursor ACP writes ~/.cursor/acp-sessions/<id>. `cursor-agent --resume`
  // reads ~/.cursor/chats/<cwd-hash>/<id>. Same id, two transcripts, so the
  // copied command does not open this session. Leave the button off until
  // there is a real handoff. CodeBuddy resume reads the file this session wrote.
  const resumeCommand = target.source === 'cursor-cli' ? undefined : session?.resumeCommand;
  return (
    <div className="composer-dock">
      {session && (session.catalog || resumeCommand)
        ? (
            <CliModelBar
              catalog={session.catalog}
              resumeCommand={resumeCommand}
              showThinking={target.source !== 'cursor-cli'}
              onModel={session.catalog && session.status === 'idle'
                ? modelId => void selectCliModel(target, modelId)
                : undefined}
              onThinking={session.catalog && session.status === 'idle' && target.source !== 'cursor-cli'
                ? thinking => void selectCliThinking(target, thinking)
                : undefined}
            />
          )
        : null}
      <div className="content-col composer-box">
        <textarea
          ref={taRef}
          value={draft}
          rows={1}
          onChange={(event) => { update(event.target.value); autoGrow(); }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey)
              return;
            if (event.metaKey || event.ctrlKey || !isTouchPrimary()) {
              event.preventDefault();
              send();
            }
          }}
          placeholder={placeholder}
          disabled={!uplinkConnected || !machineConnected || session?.status !== 'idle'}
          className="min-w-0 flex-1 resize-none border-0 bg-transparent px-0 py-1.5 font-[inherit] text-[var(--text-primary)] outline-none disabled:opacity-60"
        />
        {canStop
          ? (
              <button
                type="button"
                aria-label="停止生成"
                title="停止生成"
                onClick={() => stopCliSession({ kind: 'cli', source: target.source, sessionId: target.sessionId })}
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
