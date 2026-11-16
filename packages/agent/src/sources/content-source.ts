import type { ChatElement } from '../types.js';
import type { IdeKind, MessageHeader, SessionMeta, SourceProbe } from './types.js';

export interface ContentSource {
  readonly ide: IdeKind;
  probe: () => SourceProbe;
  changeSignal: () => number;
  listSessions: () => SessionMeta[];
  enrichMeta: (meta: SessionMeta) => SessionMeta;
  readIndex: (sessionId: string) => MessageHeader[];
  /** When `ids` is set, project only those index bubbles (keyed reads). */
  projectSession: (sessionId: string, ids?: string[]) => ChatElement[];
  /**
   * Which of `ids` have a readable body right now. The index can name a bubble whose body file is
   * still being written (CodeBuddy writes `index.json` and `messages/<id>.json` separately), and a
   * keyed read for such an id returns nothing at all. The runtime retries exactly those ids a bounded
   * number of times instead of guessing from "did an element with this id come out" (tool rows emit
   * their card under the toolCallId, so that guess is wrong for them).
   * Absent = every requested id is readable (adapters that read from a DB).
   */
  readableIds?: (sessionId: string, ids: string[]) => string[];
  /**
   * Whether this session actually exists on this machine's disk. In the
   * cross-machine case (IDE here, data on a remote dev box), a machine that
   * is asked but does not have the session locally must stay silent: empty
   * body would be treated as authoritative by the server/web and wipe the
   * body pushed from the content machine (2026-09-16 production incident).
   * Default (adapter without this method / single-machine) is "has it".
   */
  hasSession?: (sessionId: string) => boolean;
  /** Cursor children are read alongside their parent, rather than becoming the IDE-active session. */
  isSubagentSession?: (sessionId: string) => boolean;
  /** PK `length(value)` per index bubble — skip projectSession when unchanged. */
  bubbleSizes?: (sessionId: string) => Map<string, number>;
  /** Fallback fingerprint when `bubbleSizes` is absent (e.g. CodeBuddy mtimes). */
  sessionBodySignal?: (sessionId: string) => string;
  /** Narrow disk watches to the DOM-active session. */
  setWatchedSession?: (sessionId: string | null) => void;
  /**
   * Structural fingerprint for the session census (sessions:index): session
   * add/remove/header changes only, not body writes.
   * Default falls back to `changeSignal()` (may fire often on body writes).
   */
  indexSignal?: () => number;
  /**
   * Lightweight census list: id/title/time only, **does not read message files**.
   * Default falls back to `listSessions()` — CodeBuddy's version reads messages
   * per session and must not enter the poll loop.
   */
  listSessionHeads?: () => SessionMeta[];
  close?: () => void;
}
