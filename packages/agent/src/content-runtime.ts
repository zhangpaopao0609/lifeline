/**
 * Poll ContentSource.changeSignal, project the active session, emit
 * full / append. No sockets — Task 6 wires the timeline.
 * Do not list every disk composer; the web only follows the open session.
 */

import type { SessionWatermark } from './content-watermark.js';
import type { ContentSource } from './sources/content-source.js';
import type { IdeKind, MessageHeader, SessionMeta } from './sources/types.js';
import type { ChatElement } from './types.js';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  pruneWatermarks,

  WATERMARK_MAX_HEADERS,
} from './content-watermark.js';
import { CodeBuddyAdapter } from './sources/codebuddy-adapter.js';
import { CursorAdapter } from './sources/cursor-adapter.js';
import { timingLastBubble, timingLog } from './timing-log.js';
import { codeBuddyDataRoot, cursorVscdbPath } from './win-paths.js';

/**
 * Platform-aware path pure functions (`env` / `home` / `platform` injectable for tests).
 *
 * Windows values come from measured conclusions in `win-paths.ts`; **do not
 * assemble them again here**:
 *  - Cursor's DB is `%APPDATA%\Cursor\User\globalStorage\state.vscdb`;
 *  - CodeBuddy's **content root** is not userDataDir; it is
 *    `%LOCALAPPDATA%\CodeBuddyExtension\Data`.
 *
 * Parameter order is **`(env, home, platform)`**, **different** from
 * `cdp-endpoint.ts` / `cdp-argv-file.ts` `(home, platform, env)` — those keep
 * existing positional args; do not copy them.
 */
export function defaultCursorVscdb(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'darwin') {
    return join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  }
  if (platform === 'win32')
    return cursorVscdbPath(env, home);
  return join(home, '.config/Cursor/User/globalStorage/state.vscdb');
}

/** The CodeBuddy extension writes into the XDG data dir on Linux, `%LOCALAPPDATA%` on Windows. */
export function defaultCodeBuddyRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'darwin') {
    return join(home, 'Library/Application Support/CodeBuddyExtension/Data');
  }
  if (platform === 'win32')
    return codeBuddyDataRoot(env, home);
  return join(home, '.local/share/CodeBuddyExtension/Data');
}

/**
 * Computed at module load for the **current** platform.
 *
 * Production / default paths use these two constants (they are the defaults of
 * `tryOpen*Adapter`); only use the pure functions above when injecting
 * `env` / `home` / another platform (tests, probes).
 * A unit test pins "constant === calling the function with defaults"; do not
 * revert to hardcoding.
 */
export const DEFAULT_CURSOR_VSCDB = defaultCursorVscdb();
export const DEFAULT_CODEBUDDY_ROOT = defaultCodeBuddyRoot();

/** Open Cursor's state.vscdb. On failure: log and return null — never crash. */
export function tryOpenCursorAdapter(
  dbPath = DEFAULT_CURSOR_VSCDB,
  opts?: { includeProcess?: boolean },
): CursorAdapter | null {
  try {
    return new CursorAdapter(dbPath, opts);
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[content-live] Failed to open Cursor DB at ${dbPath}: ${message}`);
    return null;
  }
}

/** Open CodeBuddy JSON history. Missing root: warn and return null — never throw. */
export function tryOpenCodeBuddyAdapter(
  root = DEFAULT_CODEBUDDY_ROOT,
  opts?: { includeProcess?: boolean },
): CodeBuddyAdapter | null {
  try {
    if (!existsSync(root)) {
      console.warn(`[content-live] CodeBuddy history root missing at ${root}`);
      return null;
    }
    return new CodeBuddyAdapter(root, opts);
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[content-live] Failed to open CodeBuddy history at ${root}: ${message}`);
    return null;
  }
}

/** Mark the outgoing CursorState when the disk source is down; probe once on success. */
export function applyContentSource(
  adapter: ContentSource | null,
  setContentSource: (source: 'ok' | 'unavailable') => void,
): void {
  if (!adapter) {
    setContentSource('unavailable');
    return;
  }
  setContentSource('ok');
  const probe = adapter.probe();
  if (probe.versionMismatch) {
    console.warn(
      `[content-live] ${adapter.ide} schema version mismatch (_v=${String(probe.schemaVersion)})`,
    );
  }
}

/**
 * Monotonic sequence of the body stream: full resets to 0, append increments.
 * The web uses `seq === last + 1` to detect a missed packet; a miss needs one
 * full to catch up. The sequence is not part of the content; old clients can
 * ignore it (backward compatible).
 */
export interface ContentLiveHandlers {
  onIndex: (sessions: SessionMeta[]) => void;
  onSessionFull: (sessionId: string, messages: ChatElement[], ide: IdeKind, seq: number) => void;
  onSessionAppend: (sessionId: string, messages: ChatElement[], ide: IdeKind, seq: number) => void;
  /** Requester's checkpoint is behind: after this batch, its checkpoint is seq (merge by id; not part of append continuity). */
  onSessionPatch?: (sessionId: string, messages: ChatElement[], ide: IdeKind, seq: number) => void;
  /** Requester's seq matches local — no body to send, just an ack. */
  onSessionSync?: (sessionId: string, ide: IdeKind, seq: number) => void;
}

export interface ContentLiveTickOpts {
  liveTail?: { sessionId: string; text: string };
}

const DEFAULT_INTERVAL_MS = 300;

/** Disk-write throttle: a tick is 300ms; do not write every round */
const WATERMARK_SAVE_DEBOUNCE_MS = 3000;

export class ContentLiveRuntime {
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastDataVersion: number | undefined;
  private activeSessionId: string | null = null;
  private liveTail: ContentLiveTickOpts['liveTail'];
  private readonly fullSent = new Set<string>();
  private readonly lastIndex = new Map<string, MessageHeader[]>();
  private readonly lastEmitted = new Map<string, ChatElement[]>();
  private readonly lastDiskSig = new Map<string, string>();
  private readonly lastSizes = new Map<string, Map<string, number>>();
  /** Max seq already sent per session; reset to 0 on full. */
  private readonly seqBySession = new Map<string, number>();
  /** Sessions that do not exist locally (cross-machine) — log once, do not spam every tick. */
  private readonly missingSessions = new Set<string>();
  /** Watermark for disk (seq + index + fingerprints); only recently viewed sessions */
  private readonly watermarks = new Map<string, SessionWatermark>();
  private readonly onWatermark?: (snapshot: Record<string, SessionWatermark>) => void;
  private watermarkTimer: ReturnType<typeof setTimeout> | undefined;
  private ticksPaused = false;

  constructor(
    private readonly adapter: ContentSource,
    private readonly handlers: ContentLiveHandlers,
    opts?: {
      intervalMs?: number;
      /** Watermark last process wrote to disk (first request after restart can send only a diff) */
      watermark?: Record<string, SessionWatermark>;
      /** Callback when a disk write is needed (after throttle) */
      onWatermark?: (snapshot: Record<string, SessionWatermark>) => void;
    },
  ) {
    this.intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onWatermark = opts?.onWatermark;
    for (const [sessionId, wm] of Object.entries(opts?.watermark ?? {})) {
      this.seqBySession.set(sessionId, wm.seq);
      this.fullSent.add(sessionId);
      this.lastIndex.set(sessionId, wm.headers);
      this.lastDiskSig.set(sessionId, wm.diskSig);
      if (wm.sizes)
        this.lastSizes.set(sessionId, new Map(Object.entries(wm.sizes)));
      this.watermarks.set(sessionId, wm);
    }
  }

  start(): void {
    if (this.timer !== undefined)
      return;
    this.tick({ liveTail: this.liveTail });
    this.timer = setInterval(() => this.tick({ liveTail: this.liveTail }), this.intervalMs);
  }

  stop(): void {
    if (this.timer === undefined)
      return;
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.watermarkTimer !== undefined) {
      clearTimeout(this.watermarkTimer);
      this.watermarkTimer = undefined;
    }
    // Persist once before exit: otherwise the last round's watermark is lost
    this.onWatermark?.(this.watermarkSnapshot());
  }

  /** Skip disk projection while a CDP command owns the event loop. */
  pauseTicks(): void {
    this.ticksPaused = true;
  }

  resumeTicks(): void {
    this.ticksPaused = false;
  }

  /** DOM activeComposerId; empty means wait for the next live state, do not scan the disk session table */
  setActiveSession(sessionId: string | null): void {
    if (this.activeSessionId === sessionId)
      return;
    timingLog('content:active', {
      ide: this.adapter.ide,
      from: this.activeSessionId ?? '',
      to: sessionId ?? '',
    });
    this.activeSessionId = sessionId;
    this.adapter.setWatchedSession?.(sessionId);
  }

  getActiveSession(): string | null {
    return this.activeSessionId;
  }

  /** Last-assistant DOM textContent for R1 overlay. Not HTML → ChatElement. */
  setLiveTail(liveTail?: { sessionId: string; text: string }): void {
    this.liveTail = liveTail;
  }

  getLiveTail(): { sessionId: string; text: string } | undefined {
    return this.liveTail;
  }

  /**
   * Answer to session:get. Four tiers, cheap to expensive:
   *  - seq matches and the disk fingerprint is unchanged → sync (zero body);
   *  - no sinceSeq, or never sent → full (keeps sendFullState / no-baseline re-request);
   *  - seq matches but fingerprint changed → patch (delta vs lastIndex / watermark);
   *  - seq is behind → patch-all (current full projection; never empty-diff→sync against lastEmitted).
   * Comparing seq alone without the fingerprint is not enough: after the daemon
   * paused and the disk wrote more, seq lies.
   * The behind tier sends the whole projection, not a delta, because `remember()`
   * advances `lastEmitted` after send: the peer may never have received those
   * packets, so a diff against it is empty, and syncing would treat the gap as
   * "already aligned".
   */
  /**
   * @returns false = this machine has no such session (caller should return
   *          session:missing, do not let the web wait and retry);
   *          true = an answer path ran (one of sync / full / patch, or projection already registered).
   */
  requestSession(sessionId: string, sinceSeq?: number): boolean {
    if (!this.sessionExists(sessionId)) {
      if (!this.missingSessions.has(sessionId)) {
        this.missingSessions.add(sessionId);
        timingLog('content:missing', { ide: this.adapter.ide, sessionId });
      }
      return false;
    }
    if (sinceSeq !== undefined && this.seqBySession.get(sessionId) === sinceSeq && this.upToDate(sessionId)) {
      timingLog('content:sync', { ide: this.adapter.ide, sessionId, seq: sinceSeq });
      this.handlers.onSessionSync?.(sessionId, this.adapter.ide, sinceSeq);
      return true;
    }
    // Include liveTail: while the on-disk sentence is not fully written, do
    // not let this answer roll the tail text back to the disk version
    // (same handling as the first full of a tick; already applied is a no-op)
    if (sinceSeq === undefined || !this.fullSent.has(sessionId)) {
      this.emitProjected(sessionId, this.liveTail, 'full');
      return true;
    }
    if (sinceSeq === this.seqBySession.get(sessionId)) {
      this.emitProjected(sessionId, this.liveTail, 'patch');
      return true;
    }
    this.emitProjected(sessionId, this.liveTail, 'patch-all');
    return true;
  }

  /** Is the on-disk copy identical to last send? One fingerprint read, cheap enough (only when requested). */
  private upToDate(sessionId: string): boolean {
    if (!this.fullSent.has(sessionId))
      return false;
    try {
      const index = this.adapter.readIndex(sessionId);
      const sizes = this.adapter.bubbleSizes?.(sessionId);
      return (
        diskSignature(index, sizes, this.adapter.sessionBodySignal?.(sessionId))
        === this.lastDiskSig.get(sessionId)
      );
    }
    catch {
      return false;
    }
  }

  private nextSeq(sessionId: string): number {
    const next = (this.seqBySession.get(sessionId) ?? 0) + 1;
    this.seqBySession.set(sessionId, next);
    return next;
  }

  /** The adapter must recognize the session for it to count as local; old adapters (no hasSession, single-machine) treated as "has it". */
  private sessionExists(sessionId: string): boolean {
    const has = this.adapter.hasSession;
    if (!has)
      return true;
    try {
      return has.call(this.adapter, sessionId);
    }
    catch {
      return true;
    }
  }

  tick(opts?: ContentLiveTickOpts): void {
    try {
      this.tickBody(opts);
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[content-live] tick failed: ${message}`);
    }
  }

  private tickBody(opts?: ContentLiveTickOpts): void {
    if (this.ticksPaused)
      return;

    const liveTail = opts?.liveTail ?? this.liveTail;
    const dv = this.adapter.changeSignal();
    const changed
      = this.lastDataVersion === undefined || dv !== this.lastDataVersion;
    if (changed) {
      this.lastDataVersion = dv;
    }

    const active = this.activeSessionId;
    if (!active) {
      if (changed) {
        timingLog('content:tick', { ide: this.adapter.ide, changed: true, active: '' });
      }
      return;
    }

    if (!this.fullSent.has(active)) {
      timingLog('content:tick', { ide: this.adapter.ide, changed, active, needDisk: true });
      this.emitProjected(active, liveTail);
      return;
    }

    if (!changed) {
      this.emitLiveTailOnly(active, liveTail);
      return;
    }

    const index = this.adapter.readIndex(active);
    const sizes = this.adapter.bubbleSizes?.(active);
    const sig = diskSignature(index, sizes, this.adapter.sessionBodySignal?.(active));
    if (sig === this.lastDiskSig.get(active)) {
      this.emitLiveTailOnly(active, liveTail);
      return;
    }

    timingLog('content:tick', { ide: this.adapter.ide, changed, active, needDisk: true });
    this.emitProjected(active, liveTail, undefined, { index, sizes });
  }

  private emitProjected(
    sessionId: string,
    liveTail?: ContentLiveTickOpts['liveTail'],
    force?: 'full' | 'patch' | 'patch-all',
    hint?: { index: MessageHeader[]; sizes?: Map<string, number> },
  ): void {
    // Do not speak if this session is not local: an empty full would be treated
    // as authoritative by the server/web and wipe the real body pushed from the
    // content machine (the remote dev box's disk) — 2026-09-16 production incident.
    if (!this.sessionExists(sessionId)) {
      if (!this.missingSessions.has(sessionId)) {
        this.missingSessions.add(sessionId);
        timingLog('content:missing', { ide: this.adapter.ide, sessionId });
      }
      return;
    }
    this.missingSessions.delete(sessionId);

    const started = Date.now();
    const index = hint?.index ?? this.adapter.readIndex(sessionId);
    const sizes = hint?.sizes ?? this.adapter.bubbleSizes?.(sessionId);
    const wantFull = force === 'full' || force === 'patch-all' || !this.fullSent.has(sessionId);

    let messages: ChatElement[];
    if (wantFull) {
      messages = applyLiveTail(
        this.adapter.projectSession(sessionId),
        liveTail,
        sessionId,
      );
    }
    else {
      const prevIndex = this.lastIndex.get(sessionId) ?? [];
      const prevMessages = this.lastEmitted.get(sessionId) ?? [];
      const toFetch = idsToFetch(index, prevIndex, sizes, this.lastSizes.get(sessionId));
      if (toFetch.length === 0) {
        messages = applyLiveTail(prevMessages, liveTail, sessionId);
      }
      else {
        const patch = this.adapter.projectSession(sessionId, toFetch);
        messages = applyLiveTail(mergeEmitted(prevMessages, patch), liveTail, sessionId);
      }
    }

    if (wantFull && force !== 'patch-all') {
      // full is a baseline reset: seq goes to 0, the web resets its checkpoint too.
      this.seqBySession.set(sessionId, 0);
      timingLog('content:full', {
        ide: this.adapter.ide,
        sessionId,
        n: messages.length,
        ms: Date.now() - started,
        last: timingLastBubble(messages) || undefined,
        seq: 0,
      });
      this.handlers.onSessionFull(sessionId, messages, this.adapter.ide, 0);
      this.remember(sessionId, index, messages, sizes);
      return;
    }
    const toAppend
      = force === 'patch-all'
        ? messages
        : diffAppend(
            index,
            messages,
            this.lastIndex.get(sessionId) ?? [],
            this.lastEmitted.get(sessionId) ?? [],
          );
    if (toAppend.length > 0) {
      // patch-all is already on the "behind" path; seq is the current value, do not +1 again
      const seq
        = force === 'patch-all' ? this.seqBySession.get(sessionId) ?? 0 : this.nextSeq(sessionId);
      if (force === 'patch' || force === 'patch-all') {
        timingLog('content:patch', {
          ide: this.adapter.ide,
          sessionId,
          n: toAppend.length,
          ms: Date.now() - started,
          last: timingLastBubble(toAppend) || undefined,
          seq,
        });
        this.handlers.onSessionPatch?.(sessionId, toAppend, this.adapter.ide, seq);
      }
      else {
        timingLog('content:append', {
          ide: this.adapter.ide,
          sessionId,
          n: toAppend.length,
          ms: Date.now() - started,
          last: timingLastBubble(toAppend) || undefined,
          seq,
        });
        this.handlers.onSessionAppend(sessionId, toAppend, this.adapter.ide, seq);
      }
    }
    else if (force === 'patch') {
      // Empty sync is allowed only for the seq-matching incremental tier. patch-all
      // must still send messages even if the diff is empty (above, toAppend=messages, never reaches here)
      // idsToFetch empty but diskSig already mismatches (CodeBuddy sessionBodySignal is mtime): do not sync, fall back to one projection
      if (!this.upToDate(sessionId)) {
        this.emitProjected(sessionId, liveTail, 'patch-all');
        return;
      }
      this.handlers.onSessionSync?.(sessionId, this.adapter.ide, this.seqBySession.get(sessionId) ?? 0);
    }
    this.remember(sessionId, index, messages, sizes);
  }

  private emitLiveTailOnly(
    sessionId: string,
    liveTail?: ContentLiveTickOpts['liveTail'],
  ): void {
    const prev = this.lastEmitted.get(sessionId);
    if (!prev || !liveTail)
      return;
    const next = applyLiveTail(prev, liveTail, sessionId);
    if (next === prev)
      return;
    const changed = next.filter((m, i) => m !== prev[i]);
    if (changed.length === 0)
      return;
    const seq = this.nextSeq(sessionId);
    timingLog('content:livetail', {
      ide: this.adapter.ide,
      sessionId,
      n: changed.length,
      last: timingLastBubble(changed) || undefined,
      seq,
    });
    this.handlers.onSessionAppend(sessionId, changed, this.adapter.ide, seq);
    this.lastEmitted.set(sessionId, next);
  }

  private remember(
    sessionId: string,
    index: MessageHeader[],
    messages: ChatElement[],
    sizes?: Map<string, number>,
  ): void {
    const nextSizes = sizes ?? this.adapter.bubbleSizes?.(sessionId);
    this.fullSent.add(sessionId);
    this.lastIndex.set(sessionId, index);
    this.lastEmitted.set(sessionId, messages);
    this.lastDiskSig.set(
      sessionId,
      diskSignature(index, nextSizes, this.adapter.sessionBodySignal?.(sessionId)),
    );
    if (nextSizes)
      this.lastSizes.set(sessionId, nextSizes);
    this.watermarks.set(sessionId, {
      seq: this.seqBySession.get(sessionId) ?? 0,
      headers: index.length > WATERMARK_MAX_HEADERS ? index.slice(-WATERMARK_MAX_HEADERS) : index,
      ...(nextSizes ? { sizes: Object.fromEntries(nextSizes) } : {}),
      diskSig: this.lastDiskSig.get(sessionId) ?? '',
      updatedAt: Date.now(),
    });
    this.scheduleWatermarkSave();
  }

  private scheduleWatermarkSave(): void {
    if (!this.onWatermark || this.watermarkTimer !== undefined)
      return;
    this.watermarkTimer = setTimeout(() => {
      this.watermarkTimer = undefined;
      this.onWatermark?.(this.watermarkSnapshot());
    }, WATERMARK_SAVE_DEBOUNCE_MS);
  }

  /** Snapshot for disk / tests (already pruned). */
  watermarkSnapshot(): Record<string, SessionWatermark> {
    return pruneWatermarks(Object.fromEntries(this.watermarks));
  }
}

function indexFingerprint(index: MessageHeader[]): string {
  if (index.length === 0)
    return '0';
  const last = index[index.length - 1];
  return `${index.length}:${last.messageId}:${last.complete ? 1 : 0}`;
}

function sizesFingerprint(sizes?: Map<string, number>): string {
  if (!sizes || sizes.size === 0)
    return '';
  return [...sizes.entries()]
    .map(([id, n]) => `${id}:${n}`)
    .join(',');
}

function diskSignature(
  index: MessageHeader[],
  sizes?: Map<string, number>,
  bodySignal?: string,
): string {
  return `${indexFingerprint(index)}|${sizesFingerprint(sizes)}|${bodySignal ?? ''}`;
}

function idsToFetch(
  index: MessageHeader[],
  prevIndex: MessageHeader[],
  sizes?: Map<string, number>,
  prevSizes?: Map<string, number>,
): string[] {
  const prevById = new Map(prevIndex.map(h => [h.messageId, h]));
  const want = new Set<string>();
  for (const h of index) {
    const prev = prevById.get(h.messageId);
    if (!prev)
      want.add(h.messageId);
    else if (prev.complete !== h.complete)
      want.add(h.messageId);
    if (!h.complete)
      want.add(h.messageId);
    if (sizes && prevSizes && sizes.get(h.messageId) !== prevSizes.get(h.messageId)) {
      want.add(h.messageId);
    }
  }
  if (want.size === 0 && sizes && prevSizes) {
    for (const [id, n] of sizes) {
      if (prevSizes.get(id) !== n)
        want.add(id);
    }
  }
  if (want.size === 0 && (!sizes || !prevSizes)) {
    return index.map(h => h.messageId);
  }
  return [...want];
}

function mergeEmitted(prev: ChatElement[], patch: ChatElement[]): ChatElement[] {
  if (prev.length === 0)
    return patch;
  if (patch.length === 0)
    return prev;
  const byId = new Map(prev.map(m => [m.id, m]));
  for (const m of patch) byId.set(m.id, m);
  const seen = new Set<string>();
  const out: ChatElement[] = [];
  for (const m of prev) {
    const next = byId.get(m.id);
    if (!next || seen.has(m.id))
      continue;
    out.push(next);
    seen.add(m.id);
  }
  for (const m of patch) {
    if (seen.has(m.id))
      continue;
    out.push(m);
    seen.add(m.id);
  }
  return out;
}

function applyLiveTail(
  messages: ChatElement[],
  liveTail: ContentLiveTickOpts['liveTail'],
  sessionId: string,
): ChatElement[] {
  if (!liveTail || liveTail.sessionId !== sessionId)
    return messages;
  if (messages.length === 0)
    return messages;
  const lastIdx = messages.length - 1;
  const el = messages[lastIdx];
  if (el.type !== 'assistant')
    return messages;
  if (el.text.length >= liveTail.text.length)
    return messages;
  const next = messages.slice();
  next[lastIdx] = { ...el, text: liveTail.text };
  return next;
}

function elementBubbleId(id: string): string {
  return id.endsWith(':think') ? id.slice(0, -':think'.length) : id;
}

function diffAppend(
  index: MessageHeader[],
  messages: ChatElement[],
  prevIndex: MessageHeader[],
  prevMessages: ChatElement[],
): ChatElement[] {
  const prevIds = new Set(prevIndex.map(h => h.messageId));
  const want = new Set(
    index.filter(h => !prevIds.has(h.messageId)).map(h => h.messageId),
  );
  const last = index[index.length - 1];
  if (last && !last.complete)
    want.add(last.messageId);

  const prevById = new Map(prevMessages.map(m => [m.id, m]));
  return messages.filter((m) => {
    if (want.has(elementBubbleId(m.id)))
      return true;
    const prev = prevById.get(m.id);
    if (!prev)
      return true;
    return JSON.stringify(m) !== JSON.stringify(prev);
  });
}
