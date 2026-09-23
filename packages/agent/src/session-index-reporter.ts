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

export interface ReportedRemoval {
  ide: IdeKind;
  sessionId: string;
}

export interface SessionsIndexDelta {
  sessions: SessionMeta[];
  removed: ReportedRemoval[];
  mode: 'delta';
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

  constructor(private readonly opts: SessionIndexReporterOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.send = opts.send;
    this.log = opts.log ?? (() => {});
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

  private tickSource(source: ContentSource): void {
    let signal: number | undefined;
    try {
      signal = source.indexSignal?.();
    }
    catch {
      signal = undefined;
    }
    if (signal !== undefined) {
      if (this.lastSignal.get(source.ide) === signal)
        return;
      this.lastSignal.set(source.ide, signal);
    }

    const heads = source.listSessionHeads?.() ?? source.listSessions();
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
    if (changed.length === 0 && removed.length === 0)
      return;

    this.log(`[session-index] ${source.ide}: +${changed.length} -${removed.length}`);
    this.send({
      sessions: changed,
      removed,
      mode: 'delta',
      reportedIdes: [source.ide],
    });
  }
}
