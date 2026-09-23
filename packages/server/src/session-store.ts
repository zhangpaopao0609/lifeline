/**
 * Server-side mirror of projected transcripts. One SQLite file for the whole site.
 * Not Cursor's state.vscdb — never open the user's live Cursor DB.
 */

import type Database from 'better-sqlite3';
import type { IdeKind, SessionMeta } from '../../protocol/src/index.js';
import type { LifelineDb } from './db/open.js';
import type { SessionPage } from './pages/session-page.js';
import type { ChatElement } from './types.js';
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import {

  isIdeKind,
  parseIde,
  SESSION_PAGE_ITEMS,

} from '../../protocol/src/index.js';
import { openDrizzle } from './db/open.js';
import { messages, sessions, sessionSeq } from './db/schema.js';

const STRIP_KEYS = new Set(['actions', 'selectorPath']);

function stripSensitive(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(stripSensitive);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (STRIP_KEYS.has(key))
        continue;
      out[key] = stripSensitive(child);
    }
    return out;
  }
  return value;
}

function payloadJson(message: ChatElement): string {
  return JSON.stringify(stripSensitive(message));
}

function sessionIde(session: SessionMeta): IdeKind {
  return parseIde(session.ref?.ide);
}

function reportedIdeSet(sessionList: SessionMeta[], reportedIdes?: Iterable<string>): Set<IdeKind> {
  if (reportedIdes) {
    const out = new Set<IdeKind>();
    for (const ide of reportedIdes) {
      if (isIdeKind(ide))
        out.add(ide);
    }
    if (out.size > 0)
      return out;
  }
  return new Set(sessionList.map(s => sessionIde(s)));
}

/** Cursor composerHeaders.lastUpdatedAt is often NULL. The server column is NOT NULL. */
export function sessionIndexTimestamp(session: {
  lastUpdatedAt?: number | null;
  createdAt?: number | null;
}): number {
  for (const raw of [session.lastUpdatedAt, session.createdAt]) {
    const n = Number(raw);
    if (Number.isFinite(n))
      return n;
  }
  return 0;
}

export class SessionStore {
  private readonly sqlite: Database.Database;
  private readonly orm: LifelineDb;

  constructor(dbPath: string) {
    const opened = openDrizzle(dbPath);
    this.sqlite = opened.sqlite;
    this.orm = opened.orm;
  }

  close(): void {
    this.sqlite.close();
  }

  writeIndex(agentId: string, sessionList: SessionMeta[], reportedIdes?: Iterable<string>): void {
    const reported = reportedIdeSet(sessionList, reportedIdes);
    const keep = new Set(sessionList.map(s => `${sessionIde(s)}\0${s.ref.sessionId}`));
    const existing = this.orm
      .select({ ide: sessions.ide, sessionId: sessions.sessionId })
      .from(sessions)
      .where(eq(sessions.agentId, agentId))
      .all();

    const apply = this.sqlite.transaction(() => {
      for (const row of existing) {
        if (!reported.has(row.ide as IdeKind))
          continue;
        const key = `${row.ide}\0${row.sessionId}`;
        if (keep.has(key))
          continue;
        this.orm
          .delete(messages)
          .where(
            and(
              eq(messages.agentId, agentId),
              eq(messages.ide, row.ide),
              eq(messages.sessionId, row.sessionId),
            ),
          )
          .run();
        this.orm
          .delete(sessions)
          .where(
            and(
              eq(sessions.agentId, agentId),
              eq(sessions.ide, row.ide),
              eq(sessions.sessionId, row.sessionId),
            ),
          )
          .run();
      }
      for (const session of sessionList) {
        const ide = sessionIde(session);
        this.orm
          .insert(sessions)
          .values({
            agentId,
            ide,
            sessionId: session.ref.sessionId,
            metaJson: JSON.stringify(session),
            lastUpdatedAt: sessionIndexTimestamp(session),
          })
          .onConflictDoUpdate({
            target: [sessions.agentId, sessions.ide, sessions.sessionId],
            set: {
              metaJson: sql`excluded.meta_json`,
              lastUpdatedAt: sql`excluded.last_updated_at`,
            },
          })
          .run();
      }
    });
    apply();
  }

  mergeIndex(
    agentId: string,
    sessionList: SessionMeta[],
    removed: Array<{ ide: IdeKind; sessionId: string }> = [],
  ): void {
    const apply = this.sqlite.transaction(() => {
      for (const row of removed) {
        this.orm
          .delete(messages)
          .where(
            and(
              eq(messages.agentId, agentId),
              eq(messages.ide, row.ide),
              eq(messages.sessionId, row.sessionId),
            ),
          )
          .run();
        this.orm
          .delete(sessions)
          .where(
            and(
              eq(sessions.agentId, agentId),
              eq(sessions.ide, row.ide),
              eq(sessions.sessionId, row.sessionId),
            ),
          )
          .run();
      }
      for (const session of sessionList) {
        this.orm
          .insert(sessions)
          .values({
            agentId,
            ide: sessionIde(session),
            sessionId: session.ref.sessionId,
            metaJson: JSON.stringify(session),
            lastUpdatedAt: sessionIndexTimestamp(session),
          })
          .onConflictDoUpdate({
            target: [sessions.agentId, sessions.ide, sessions.sessionId],
            set: {
              metaJson: sql`excluded.meta_json`,
              lastUpdatedAt: sql`excluded.last_updated_at`,
            },
          })
          .run();
      }
    });
    apply();
  }

  readIndex(agentId: string): SessionMeta[] {
    return this.orm
      .select({ metaJson: sessions.metaJson })
      .from(sessions)
      .where(eq(sessions.agentId, agentId))
      .orderBy(sql`${sessions.lastUpdatedAt} DESC`)
      .all()
      .map(row => JSON.parse(row.metaJson) as SessionMeta);
  }

  findSessionOwners(sessionId: string, ide: IdeKind): string[] {
    return this.orm
      .select({ agentId: sessions.agentId })
      .from(sessions)
      .where(and(eq(sessions.ide, ide), eq(sessions.sessionId, sessionId)))
      .orderBy(sql`${sessions.lastUpdatedAt} DESC`)
      .all()
      .map(row => row.agentId);
  }

  moveAgent(oldAgentId: string, newAgentId: string): void {
    const apply = this.sqlite.transaction(() => {
      this.orm.update(sessions).set({ agentId: newAgentId }).where(eq(sessions.agentId, oldAgentId)).run();
      this.orm.update(messages).set({ agentId: newAgentId }).where(eq(messages.agentId, oldAgentId)).run();
      this.orm.update(sessionSeq).set({ agentId: newAgentId }).where(eq(sessionSeq.agentId, oldAgentId)).run();
    });
    apply();
  }

  dropAgent(agentId: string): void {
    const apply = this.sqlite.transaction(() => {
      this.orm.delete(sessions).where(eq(sessions.agentId, agentId)).run();
      this.orm.delete(messages).where(eq(messages.agentId, agentId)).run();
      this.orm.delete(sessionSeq).where(eq(sessionSeq.agentId, agentId)).run();
    });
    apply();
  }

  writeSession(
    agentId: string,
    sessionId: string,
    body: ChatElement[],
    ide: IdeKind,
    seq?: number,
  ): void {
    const apply = this.sqlite.transaction(() => {
      this.orm
        .delete(messages)
        .where(
          and(eq(messages.agentId, agentId), eq(messages.ide, ide), eq(messages.sessionId, sessionId)),
        )
        .run();
      for (const message of body) {
        this.orm
          .insert(messages)
          .values({
            agentId,
            ide,
            sessionId,
            messageId: message.id,
            flatIndex: message.flatIndex,
            payload: payloadJson(message),
          })
          .run();
      }
      if (seq !== undefined)
        this.upsertSeq(agentId, ide, sessionId, seq);
    });
    apply();
  }

  readSessionSeq(agentId: string, sessionId: string, ide: IdeKind): number | null {
    const row = this.orm
      .select({ lastSeq: sessionSeq.lastSeq })
      .from(sessionSeq)
      .where(
        and(
          eq(sessionSeq.agentId, agentId),
          eq(sessionSeq.ide, ide),
          eq(sessionSeq.sessionId, sessionId),
        ),
      )
      .get();
    return row ? row.lastSeq : null;
  }

  private upsertSeq(agentId: string, ide: IdeKind, sessionId: string, seq: number): void {
    this.orm
      .insert(sessionSeq)
      .values({ agentId, ide, sessionId, lastSeq: seq })
      .onConflictDoUpdate({
        target: [sessionSeq.agentId, sessionSeq.ide, sessionSeq.sessionId],
        set: { lastSeq: sql`excluded.last_seq` },
      })
      .run();
  }

  readSession(agentId: string, sessionId: string, ide: IdeKind): ChatElement[] | null {
    const rows = this.orm
      .select({ payload: messages.payload })
      .from(messages)
      .where(
        and(eq(messages.agentId, agentId), eq(messages.ide, ide), eq(messages.sessionId, sessionId)),
      )
      .orderBy(messages.flatIndex)
      .all();
    if (rows.length === 0)
      return null;
    return rows.map(row => JSON.parse(row.payload) as ChatElement);
  }

  /**
   * Tail-first page: with no before, take the last limit items; with before, take the last limit items
   * whose flat_index <= before (closed interval: the page tail is an overlap token so the page can
   * join onto its local first item by id. A left-open < would leave every page unjoinable).
   * Read one extra row to decide hasMore (avoids a second query); nextBefore is only set when hasMore.
   * Uses the messages_order (agent_id, ide, session_id, flat_index) index; cost is independent of session length.
   */
  readSessionPage(
    agentId: string,
    sessionId: string,
    ide: IdeKind,
    opts?: { before?: number; limit?: number },
  ): SessionPage | null {
    const raw = opts?.limit;
    // Treat 0 / NaN / negatives as "use the cap"? No — the floor is 1 (`limit: 0` must clamp to 1, not silently become a full page)
    const limit
      = typeof raw === 'number' && Number.isFinite(raw)
        ? Math.max(1, Math.min(Math.floor(raw), SESSION_PAGE_ITEMS))
        : SESSION_PAGE_ITEMS;
    const before = opts?.before;
    const scope = and(
      eq(messages.agentId, agentId),
      eq(messages.ide, ide),
      eq(messages.sessionId, sessionId),
    );
    const rows = this.orm
      .select({ payload: messages.payload, flatIndex: messages.flatIndex })
      .from(messages)
      .where(before === undefined ? scope : and(scope, lte(messages.flatIndex, before)))
      .orderBy(desc(messages.flatIndex))
      .limit(limit + 1)
      .all();
    if (rows.length === 0)
      return null;
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    return {
      messages: page.map(row => JSON.parse(row.payload) as ChatElement),
      hasMore,
      nextBefore: hasMore ? page[0].flatIndex : undefined,
    };
  }

  appendSession(
    agentId: string,
    sessionId: string,
    incoming: ChatElement[],
    ide: IdeKind,
    seq?: number,
  ): ChatElement[] {
    const apply = this.sqlite.transaction(() => {
      for (const message of incoming) {
        this.orm
          .insert(messages)
          .values({
            agentId,
            ide,
            sessionId,
            messageId: message.id,
            flatIndex: message.flatIndex,
            payload: payloadJson(message),
          })
          .onConflictDoUpdate({
            target: [messages.agentId, messages.ide, messages.sessionId, messages.messageId],
            set: {
              flatIndex: sql`excluded.flat_index`,
              payload: sql`excluded.payload`,
            },
          })
          .run();
      }
      if (seq !== undefined)
        this.upsertSeq(agentId, ide, sessionId, seq);
    });
    apply();
    return this.readSession(agentId, sessionId, ide) ?? [];
  }
}
