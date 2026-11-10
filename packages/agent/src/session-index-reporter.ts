/**
 * Census: report session ids on this machine's disk to the server (id/title/time
 * only, not body). The server uses this to know "which machine owns a session"
 * so the web can find where content lives when a session is opened.
 *
 * Keep it cheap (even 1000 sessions must not hurt):
 * 1. Each tick first compares the structural fingerprint `adapter.indexSignal()`:
 *    unchanged → skip the whole round — idle cost is a few stats;
 * 2. Rebuild the list only when the fingerprint changes, via `listSessionHeads()`
 *    (heads only, no message files);
 * 3. Send a delta only: add/update/delete, tens of bytes, never a full dump.
 */
import type { ContentSource } from './sources/content-source.js';
import type { IdeKind, SessionMeta } from './sources/types.js';
import { existsSync } from 'node:fs';

export interface ReportedRemoval {
  ide: IdeKind;
  sessionId: string;
}

export interface SessionsIndexDelta {
  /** Delta: only the changed rows. First round / after `reset()`: the slot's complete set. */
  sessions: SessionMeta[];
  removed: ReportedRemoval[];
  /**
   * Omitted on the **authoritative** round (first round of a process, and after
   * `reset()`): the server then rewrites that slot's index instead of merging, so
   * rows it can no longer explain — e.g. the `VSCode/` sessions an older agent
   * labelled `codebuddy` — are deleted rather than lingering forever.
   */
  mode?: 'delta';
  reportedIdes: IdeKind[];
}

export interface SessionIndexReporterOptions {
  sources: ContentSource[];
  send: (payload: SessionsIndexDelta) => void;
  intervalMs?: number;
  log?: (msg: string) => void;
}

interface ReportedRow {
  fingerprint: string;
  meta: SessionMeta;
}

const DEFAULT_INTERVAL_MS = 2000;

function metaKey(meta: SessionMeta): string {
  return `${meta.ref.ide}\0${meta.ref.sessionId}`;
}

/** Re-report when any head field changes (server refreshes last_updated_at; do not read body when content is elsewhere). */
function metaFingerprint(meta: SessionMeta): string {
  return [meta.title, meta.lastUpdatedAt, meta.status, meta.messageCount, meta.isArchived ? 1 : 0].join('\0');
}

export class SessionIndexReporter {
  private readonly intervalMs: number;
  private readonly send: (payload: SessionsIndexDelta) => void;
  private readonly log: (msg: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly lastSignal = new Map<IdeKind, number>();
  private readonly reported = new Map<string, ReportedRow>();
  /**
   * Slots whose **next** round is authoritative (see `SessionsIndexDelta.mode`).
   *
   * Per source, not one global counter: a source that throws or is unreadable on its
   * first round must keep the flag, otherwise it silently loses its only authoritative
   * round and the ledger never gets rewritten.
   */
  private readonly pendingFull = new Set<IdeKind>();

  constructor(private readonly opts: SessionIndexReporterOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.send = opts.send;
    this.log = opts.log ?? (() => {});
    for (const source of opts.sources)
      this.pendingFull.add(source.ide);
  }

  start(): void {
    if (this.timer)
      return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer)
      return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The server no longer has this machine's ledger (first connect / just deleted
   * on the web): clear fingerprint and cache, then re-report the full set next
   * round. If we don't, an unchanged fingerprint skips every round and the
   * server stays empty.
   */
  reset(): void {
    this.lastSignal.clear();
    this.reported.clear();
    // The server lost (or deleted) the ledger: re-report as authoritative, or an
    // unchanged fingerprint would skip every round and the page stays empty.
    for (const source of this.opts.sources)
      this.pendingFull.add(source.ide);
  }

  /** One round: return immediately if the fingerprint is unchanged; otherwise rebuild the list and send a delta. */
  tick(): void {
    for (const source of this.opts.sources) {
      try {
        this.tickSource(source);
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`[session-index] ${source.ide} tick failed: ${message}`);
      }
    }
  }

  /**
   * Can this source be read **at all** right now? `probe().ok` is not the right signal:
   * the CodeBuddy adapter answers `ok: false` for a readable root with no `history/`
   * (the plugin-only machine), which is exactly the empty-but-authoritative case. The
   * root's existence is.
   */
  private rootReachable(source: ContentSource): boolean {
    try {
      return existsSync(source.probe().rootPath);
    }
    catch {
      return false;
    }
  }

  private tickSource(source: ContentSource): void {
    let signal: number | undefined;
    try {
      signal = source.indexSignal?.();
    }
    catch {
      signal = undefined;
    }
    const authoritative = this.pendingFull.has(source.ide);
    // The fingerprint shortcut must not swallow a pending authoritative round: that is
    // the one round a slot cannot afford to skip, and its signal is unchanged by design.
    if (!authoritative && signal !== undefined && this.lastSignal.get(source.ide) === signal)
      return;

    const heads = source.listSessionHeads?.() ?? source.listSessions();

    // A transiently unreachable root (unmounted disk, permissions) must not delete the
    // ledger: an authoritative round would prune the whole slot, and an "everything
    // disappeared" delta would send removals for every row. Checked **before** the
    // fingerprint/ledger are touched, so the next round retries instead of being skipped
    // as "unchanged".
    if ((authoritative || (heads.length === 0 && this.reportedFor(source.ide) > 0)) && !this.rootReachable(source)) {
      this.log(`[session-index] ${source.ide}: root unreachable, holding the round`);
      return;
    }
    if (signal !== undefined)
      this.lastSignal.set(source.ide, signal);

    const seen = new Set<string>();
    const changed: SessionMeta[] = [];
    for (const meta of heads) {
      const key = metaKey(meta);
      seen.add(key);
      const fingerprint = metaFingerprint(meta);
      const prev = this.reported.get(key);
      if (prev && prev.fingerprint === fingerprint)
        continue;
      changed.push(meta);
      this.reported.set(key, { fingerprint, meta });
    }

    const removed: ReportedRemoval[] = [];
    for (const [key, row] of this.reported) {
      // `reported` is a ledger shared across sources; `seen` holds keys for
      // **this source** this round only: a key from another IDE missing from
      // seen means "not this round's job", never a deletion — otherwise the
      // later IDE would wipe the earlier one (observed codebuddy: +572 -1007;
      // server mergeIndex then deleted cursor's 1007 mirrored rows).
      if (row.meta.ref.ide !== source.ide)
        continue;
      if (seen.has(key))
        continue;
      removed.push({ ide: row.meta.ref.ide, sessionId: row.meta.ref.sessionId });
      this.reported.delete(key);
    }
    if (!authoritative && changed.length === 0 && removed.length === 0)
      return;

    this.log(
      authoritative
        ? `[session-index] ${source.ide}: authoritative ${heads.length} row(s)`
        : `[session-index] ${source.ide}: +${changed.length} -${removed.length}`,
    );
    this.send(authoritative
      // The slot's complete set: the server's `writeIndex` deletes what is not in
      // here for this ide. `removed` is meaningless to that path, so it stays empty.
      ? { sessions: heads, removed: [], reportedIdes: [source.ide] }
      : { sessions: changed, removed, mode: 'delta', reportedIdes: [source.ide] });
    // Only now is the authoritative round actually delivered; a held round keeps the flag.
    this.pendingFull.delete(source.ide);
  }

  private reportedFor(ide: IdeKind): number {
    let n = 0;
    for (const row of this.reported.values()) {
      if (row.meta.ref.ide === ide)
        n += 1;
    }
    return n;
  }
}
