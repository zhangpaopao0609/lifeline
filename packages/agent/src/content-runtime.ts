/**
 * Poll ContentSource.changeSignal, project the active session, emit
 * full / append. No sockets — Task 6 wires the timeline.
 * Do not list every disk composer; the web only follows the open session.
 */

import type { SessionWatermark } from './content-watermark.js';
import type { ContentSource } from './sources/content-source.js';
import type { IdeKind, MessageHeader, SessionMeta } from './sources/types.js';
import type { ChatElement } from './types.js';
import { existsSync, readdirSync } from 'node:fs';
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

/**
 * Does the CodeBuddy history contain `<root>/<uid>/<host dir>/` for this slot?
 *
 * This is the **content side** of the slot gate and it must not read
 * `~/.vscode/extensions`: a machine can hold the plugin's history without the
 * plugin being installed *here* (a restored data dir, a plugin that was removed,
 * a content-only box). Deciding adapters by the local install would leave
 * `session:get` with no runtime — and with no runtime the agent neither projects
 * nor answers `session:missing`, so the page sits on a skeleton forever.
 */
export function codeBuddyHostShardExists(
  ide: 'codebuddy' | 'vscode',
  root = DEFAULT_CODEBUDDY_ROOT,
): boolean {
  const hostDir = ide === 'vscode' ? 'VSCode' : 'CodeBuddyIDE';
  if (!existsSync(root))
    return false;
  try {
    for (const uid of readdirSync(root, { withFileTypes: true })) {
      if (uid.isDirectory() && existsSync(join(root, uid.name, hostDir)))
        return true;
    }
  }
  catch {
    return false;
  }
  return false;
}

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
  opts?: { includeProcess?: boolean; ide?: 'codebuddy' | 'vscode' },
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
  liveTail?: { sessionId: string; messageId?: string; text: string };
}

const DEFAULT_INTERVAL_MS = 300;

/**
 * How many ticks an indexed-but-unreadable message body is retried before it is left alone. The
 * plugin's index write leads its message write by milliseconds, so one or two retries cover the race;
 * an unbounded retry would keep re-reading rows that never produce an element of their own.
 */
const UNRESOLVED_RETRY_LIMIT = 3;

/** Disk-write throttle: a tick is 300ms; do not write every round */
const WATERMARK_SAVE_DEBOUNCE_MS = 3000;
/**
 * Bump whenever the same Cursor rows project to different wire elements.
 * Persisted watermarks survive daemon upgrades; without this prefix an upgraded agent can answer
 * "sync" from an old semantic projection and leave stale server rows in place indefinitely.
 */
const PROJECTION_SIGNATURE_VERSION = 'projection-v3';

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
  /** ids whose text we pushed from liveTail: the disk is the truth, so re-read them until it wins. */
  private readonly tainted = new Map<string, Set<string>>();
  /** Ids fetched but not produced last tick (body missing/torn) → attempts so far, bounded. */
  private readonly unresolved = new Map<string, Map<string, number>>();
  /**
   * Ids whose body never showed up after the retry budget. They stay in the index (the server needs to
   * know they exist) but are never requested again until a full projection — otherwise the whole-index
   * fallback would keep re-reading them and restart the retry cycle.
   */
  private readonly abandoned = new Map<string, Set<string>>();
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
      // Restart must not forget the taint: unhealed ids keep being re-read from disk.
      if (wm.tainted?.length)
        this.tainted.set(sessionId, new Set(wm.tainted));
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
  setLiveTail(liveTail?: ContentLiveTickOpts['liveTail']): void {
    this.liveTail = liveTail;
  }

  getLiveTail(): ContentLiveTickOpts['liveTail'] {
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
    // Tainted ids carry text the disk never wrote: not "up to date" until healed.
    if ((this.tainted.get(sessionId)?.size ?? 0) > 0)
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

    // A non-empty taint set must reach emitProjected even when the disk looks
    // quiet: healing re-reads the tainted ids, and the shortcuts below never do.
    const taintedCount = this.tainted.get(active)?.size ?? 0;

    // A body we are still retrying may land without another disk change: keep ticking until the retry
    // budget is spent, otherwise a lost row would wait for the user to type again.
    const retryPending = (this.unresolved.get(active)?.size ?? 0) > 0;

    if (!changed && taintedCount === 0 && !retryPending) {
      this.emitLiveTailOnly(active, liveTail);
      return;
    }

    const index = this.adapter.readIndex(active);
    const sizes = this.adapter.bubbleSizes?.(active);
    const sig = diskSignature(index, sizes, this.adapter.sessionBodySignal?.(active));
    if (sig === this.lastDiskSig.get(active) && taintedCount === 0 && !retryPending) {
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
    // A session restored from the watermark has `fullSent` + `lastIndex` but **no `lastEmitted`** (the
    // emitted element array is not persisted). The incremental branch below merges the patch into
    // `lastEmitted`, so without it the "merged" array is only the new messages and `renumberFlatIndex`
    // numbers them from 0 — colliding with the rows the server already holds, which the server then
    // interleaves by flat_index (measured 2026-09-30: newest turns buried mid-session, tail stuck on
    // old messages). No baseline ⇒ project the whole session once; full is authoritative on the server.
    const hasBaseline = this.lastEmitted.has(sessionId);
    const wantFull
      = force === 'full' || force === 'patch-all' || !this.fullSent.has(sessionId) || !hasBaseline;

    // Ownership needs the freshest index available here: an id not in it counts as
    // complete (never overlay a message we cannot vouch for).
    const isComplete = (bubbleId: string): boolean =>
      index.find(h => h.messageId === bubbleId)?.complete ?? true;
    let messages: ChatElement[];
    let tainted: string[];
    let toFetch: string[] = [];
    /** Ids already counted as unreadable this tick (trackUnaccounted must not count them twice). */
    let countedMissing = new Set<string>();
    /** True when this tick only re-fetches rows we flagged — a repair tick must not rewrite delivered cards. */
    let repairOnly = false;
    if (wantFull) {
      ({ messages, tainted } = applyLiveTail(
        this.adapter.projectSession(sessionId),
        liveTail,
        sessionId,
        isComplete,
      ));
    }
    else {
      const prevIndex = this.lastIndex.get(sessionId) ?? [];
      const prevMessages = this.lastEmitted.get(sessionId) ?? [];
      toFetch = idsToFetch(
        index,
        prevIndex,
        sizes,
        this.lastSizes.get(sessionId),
        this.tainted.get(sessionId),
        this.unresolved.get(sessionId),
      );
      // Abandoned ids stay fetchable (the whole-index fallback must stay complete), they are simply no
      // longer seeded as retries — see `abandoned`.
      // A repair tick re-reads only rows that never produced an element (retry of an unreadable body, or
      // a header that legitimately emits nothing). Re-projecting such a subset can move a sibling's
      // flatIndex, which would look like "changed" JSON; those ticks must not rewrite delivered elements.
      const emittedIds = new Set(prevMessages.map(m => elementBubbleId(m.id)));
      repairOnly = toFetch.length > 0 && toFetch.every(id => !emittedIds.has(id));
      if (toFetch.length === 0) {
        ({ messages, tainted } = applyLiveTail(prevMessages, liveTail, sessionId, isComplete));
        this.unresolved.delete(sessionId);
      }
      else {
        // Decide readability BEFORE projecting. The plugin writes `index.json` and `messages/<id>.json`
        // as two writes, so a keyed read can come back empty for a row that is about to exist. Such a
        // tick is "no progress": emit nothing and advance nothing, so the next tick retries the same ids.
        // Pushing the partial projection instead would rewrite an already delivered tool card as
        // "loading", and remembering it would freeze that state (measured 2026-11-09 on the vscode slot:
        // the human turn vanished; the same shape here).
        const readable = this.adapter.readableIds
          ? new Set(this.adapter.readableIds(sessionId, toFetch))
          : new Set(toFetch);
        const goneNow = this.abandoned.get(sessionId);
        // A row we already gave up on must not block the tick forever.
        const missing = toFetch.filter(id => !readable.has(id) && !goneNow?.has(id));
        countedMissing = new Set(missing);
        if (missing.length > 0) {
          const prevAttempts = this.unresolved.get(sessionId) ?? new Map<string, number>();
          const attempts = new Map(prevAttempts); // keep rows still being retried from earlier ticks
          for (const id of missing) attempts.set(id, (prevAttempts.get(id) ?? 0) + 1);
          // An id that never becomes readable must not stall the session forever: after the budget, give
          // up on it and push what we have (the server upserts by id, so a degraded card is recoverable).
          const given = missing.filter(id => (attempts.get(id) ?? 0) > UNRESOLVED_RETRY_LIMIT);
          if (given.length === 0) {
            this.unresolved.set(sessionId, attempts);
            timingLog('content:incomplete', {
              ide: this.adapter.ide,
              sessionId,
              asked: toFetch.length,
              missing: missing.length,
              attempt: Math.max(0, ...attempts.values()),
            });
            return;
          }
          const gone = this.abandoned.get(sessionId) ?? new Set<string>();
          for (const id of given) {
            attempts.delete(id);
            gone.add(id);
          }
          this.abandoned.set(sessionId, gone);
          this.unresolved.set(sessionId, attempts);
        }
        const patch = this.adapter.projectSession(sessionId, toFetch);
        ({ messages, tainted } = applyLiveTail(mergeEmitted(prevMessages, patch), liveTail, sessionId, isComplete));
      }
    }
    // Taint recompute: every previously tainted id was re-read from disk this tick
    // (toFetch always includes them; full re-reads everything), so the new set is
    // exactly what applyLiveTail (re-)wrote. Cleared on convergence even when the
    // disk text ends up equal to the tainted text — "re-read", not "text differs".
    // Ids gone from the index are dropped too (deleted messages cannot heal).
    const indexIds = new Set(index.map(h => h.messageId));
    const modified = tainted.filter(id => indexIds.has(id));
    if (modified.length > 0)
      this.tainted.set(sessionId, new Set(modified));
    else
      this.tainted.delete(sessionId);
    // A full projection re-reads everything, so a row we gave up on deserves a fresh chance; ids that
    // left the index are dropped so the set cannot grow forever.
    if (wantFull) {
      this.abandoned.delete(sessionId);
      this.unresolved.delete(sessionId);
    }
    else {
      const gone = this.abandoned.get(sessionId);
      if (gone) {
        for (const id of [...gone]) {
          if (!indexIds.has(id))
            gone.delete(id);
        }
        if (gone.size === 0)
          this.abandoned.delete(sessionId);
      }
    }
    // A header with no element was NOT delivered, whatever the index says. That is the shape of the
    // lost-row bug: a full projection taken while the body is still being written remembers the header
    // and emits nothing, after which it counts as "not new" forever. Retry those ids a bounded number
    // of times and then give up, so rows that legitimately emit nothing (tool headers under
    // includeProcess, compaction notices) cannot be re-read forever.
    this.trackUnaccounted(sessionId, index, messages, countedMissing);

    // Wire format: the projection numbered flatIndex inside the requested subset;
    // the merged array is the truth — renumber so append/patch carry global order
    // (full was already global; renumbering it is an identity pass, one path only).
    messages = renumberFlatIndex(messages);

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
        : diffAppend(index, messages, this.lastEmitted.get(sessionId) ?? [], !repairOnly);
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
    // No disk read on this path: judge completeness by the last remembered index.
    const isComplete = (bubbleId: string): boolean =>
      (this.lastIndex.get(sessionId) ?? []).find(h => h.messageId === bubbleId)?.complete ?? true;
    const { messages: next, tainted } = applyLiveTail(prev, liveTail, sessionId, isComplete);
    // No disk read on this path → only grow the taint set, never clear it here.
    for (const id of tainted) {
      const set = this.tainted.get(sessionId) ?? new Set<string>();
      set.add(id);
      this.tainted.set(sessionId, set);
    }
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

  /**
   * Count headers that produced no element. They are retried (bounded) on the following ticks, so a row
   * whose body landed after the projection that would have carried it still gets another chance; after
   * the budget they are abandoned, which keeps rows that never emit an element from being re-read forever.
   */
  private trackUnaccounted(
    sessionId: string,
    index: MessageHeader[],
    messages: ChatElement[],
    skip: Set<string>,
  ): void {
    const emitted = new Set(messages.map(m => elementBubbleId(m.id)));
    const abandoned = this.abandoned.get(sessionId);
    const prev = this.unresolved.get(sessionId) ?? new Map<string, number>();
    const next = new Map<string, number>();
    // Ids already counted as unreadable this tick keep their count; they were not re-projected.
    for (const id of skip) {
      const n = prev.get(id);
      if (n != null && !emitted.has(id) && !abandoned?.has(id))
        next.set(id, n);
    }
    for (const h of index) {
      const id = h.messageId;
      if (emitted.has(id) || skip.has(id) || abandoned?.has(id))
        continue;
      const n = (prev.get(id) ?? 0) + 1;
      if (n <= UNRESOLVED_RETRY_LIMIT) {
        next.set(id, n);
        continue;
      }
      const gone = this.abandoned.get(sessionId) ?? new Set<string>();
      gone.add(id);
      this.abandoned.set(sessionId, gone);
      timingLog('content:abandon', { ide: this.adapter.ide, sessionId, id: id.slice(0, 8) });
    }
    if (next.size > 0)
      this.unresolved.set(sessionId, next);
    else
      this.unresolved.delete(sessionId);
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
      tainted: [...(this.tainted.get(sessionId) ?? [])],
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
  return `${PROJECTION_SIGNATURE_VERSION}|${indexFingerprint(index)}|${sizesFingerprint(sizes)}|${bodySignal ?? ''}`;
}

function idsToFetch(
  index: MessageHeader[],
  prevIndex: MessageHeader[],
  sizes?: Map<string, number>,
  prevSizes?: Map<string, number>,
  taintedIds?: Set<string>,
  unresolved?: Map<string, number>,
): string[] {
  const prevById = new Map(prevIndex.map(h => [h.messageId, h]));
  const want = new Set<string>(taintedIds ?? []);
  // The plugin writes index.json before messages/<id>.json, so a tick can index an id whose body is not
  // readable yet. Retry only ids that actually came back empty on an earlier tick — "indexed but never
  // emitted" is NOT a retry reason: rows that legitimately produce no element of their own (tool
  // headers, compaction notices) would otherwise be refetched on every changed tick, forever.
  const inIndex = new Set(index.map(h => h.messageId));
  for (const id of unresolved?.keys() ?? []) {
    if (inIndex.has(id))
      want.add(id);
  }
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

/** Projection numbers flatIndex inside the requested subset; the wire needs the merged, global order. */
function renumberFlatIndex(messages: ChatElement[]): ChatElement[] {
  return messages.map((m, i) => ((m as { flatIndex?: number }).flatIndex === i ? m : { ...m, flatIndex: i }));
}

function applyLiveTail(
  messages: ChatElement[],
  liveTail: ContentLiveTickOpts['liveTail'],
  sessionId: string,
  isComplete: (bubbleId: string) => boolean,
): { messages: ChatElement[]; tainted: string[] } {
  if (!liveTail || liveTail.sessionId !== sessionId)
    return { messages, tainted: [] };
  const targetId = liveTail.messageId;
  // No id → no ownership proof → never write (missing text beats wrong text).
  if (!targetId || isComplete(targetId))
    return { messages, tainted: [] };
  const idx = messages.findIndex(m => elementBubbleId(m.id) === targetId);
  if (idx < 0)
    return { messages, tainted: [] };
  const el = messages[idx];
  if (el.type !== 'assistant' || el.text.length >= liveTail.text.length)
    return { messages, tainted: [] };
  const next = messages.slice();
  next[idx] = { ...el, text: liveTail.text };
  return { messages: next, tainted: [targetId] };
}

function elementBubbleId(id: string): string {
  return id.endsWith(':think') ? id.slice(0, -':think'.length) : id;
}

function diffAppend(
  index: MessageHeader[],
  messages: ChatElement[],
  prevMessages: ChatElement[],
  allowReplace = true,
): ChatElement[] {
  // Delivered = an element was emitted for this id, not "it is in the index". A tick that could not
  // read every body it asked for never reaches here (emitProjected returns early), so a partial
  // projection can no longer rewrite a delivered element.
  const prevIds = new Set(prevMessages.map(m => elementBubbleId(m.id)));
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
    // A repair tick re-reads rows that never produced an element; re-projecting them can also change a
    // sibling's flatIndex. Only new rows may go out, or every retry would churn an already delivered card.
    return allowReplace && JSON.stringify(m) !== JSON.stringify(prev);
  });
}
