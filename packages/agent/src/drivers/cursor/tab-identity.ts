/**
 * True identity of a sidebar session row.
 *
 * Cursor sidebar rows have no data-composer-id (only class names and
 * data-selected etc.). In one window, a real composerId is readable in only
 * two places:
 *   - `div.composer-bar.editor[data-composer-id]` — the currently open session;
 *   - `.tabs-container .tab[role=tab][data-resource-name]` — already-open Chat tabs.
 *
 * Full identity lives in Cursor's own state.vscdb:
 * `composerHeaders(composerId, workspaceId, name, recency)`.
 * Sidebar order = recency descending (measured), so "row i in a same-name
 * group" can be converted to a real id by aligning the two sequences on an
 * anchor (the currently active row) — a renamed title or same-name rows
 * bumping each other does not matter.
 *
 * If we cannot read it (no DB / names do not match / no anchor), keep the
 * extractor's placeholder id (tab-N); the click side still converges via
 * "click → re-read composer bar to verify". Functionality does not depend on
 * this succeeding.
 */

import type Database from 'better-sqlite3';
import type { ChatTab, CursorState } from '../../types.js';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyDerivedActivityToState } from '../../activity-derive.js';
import { loadBetterSqlite3 } from '../../load-sqlite.js';
import { cursorVscdbPath } from '../../win-paths.js';

/** Placeholder id: a position number the extractor assigns to a row with no real id (unique only within one extract; drifts if the list reorders). */
export function isPlaceholderComposerId(id: string | undefined | null): boolean {
  return !id || /^tab-\d+$/.test(id);
}

export interface ComposerMeta {
  composerId: string;
  workspaceId: string;
  name: string;
  recency: number;
}

/** Name comparison key: collapse whitespace + lowercase (sidebar title vs DB name differ only in whitespace). */
export function nameKey(name: string): string {
  return (name || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Three default locations of Cursor's state.vscdb (use if present; if none, fall back to placeholder ids).
 *
 * The Windows entry **goes through `win-paths.cursorVscdbPath()`** (reads
 * `%APPDATA%`, injectable): it used to hard-join `home/AppData/Roaming/...`,
 * which on a machine with `%APPDATA%` redirected pointed at a different place
 * than `DEFAULT_CURSOR_VSCDB` in `content-runtime.ts` — two sources of truth
 * on one machine. On macOS / Linux the `win-paths` fallback is **byte-identical**
 * to the old literals; behavior is unchanged.
 */
export function cursorVscdbCandidates(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb'),
    cursorVscdbPath(env, home),
    join(home, '.config/Cursor/User/globalStorage/state.vscdb'),
  ];
}

const WORKSPACE_TTL_MS = 2000;
/** Retry interval when the DB cannot be opened: Cursor may be installed later; do not give up forever after one failure. */
const OPEN_RETRY_MS = 60_000;

interface WorkspaceCache {
  at: number;
  rows: ComposerMeta[];
}

const workspaceCache = new Map<string, WorkspaceCache>();
const workspaceIdByComposer = new Map<string, string>();
let db: Database.Database | null = null;
let dbNextAttemptAt = 0;
let dbWarned = false;

function openDb(): Database.Database | null {
  if (db)
    return db;
  const now = Date.now();
  if (now < dbNextAttemptAt)
    return null;
  dbNextAttemptAt = now + OPEN_RETRY_MS;
  const path = cursorVscdbCandidates().find(p => existsSync(p));
  if (!path) {
    if (!dbWarned) {
      dbWarned = true;
      console.warn('[tab-identity] Cursor state.vscdb not found — 会话行只能用占位 id');
    }
    return null;
  }
  try {
    const Database = loadBetterSqlite3();
    db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 3000');
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!dbWarned) {
      dbWarned = true;
      console.warn(`[tab-identity] Cursor DB unavailable (${message}) — 会话行只能用占位 id`);
    }
    db = null;
  }
  return db;
}

/** For tests/probes: inject a fake "read DB / look up workspace" impl so tests never touch the real DB. */
let headerReader: ((workspaceId: string) => ComposerMeta[]) | null = null;
let workspaceResolver: ((composerId: string) => string) | null = null;

export function setComposerHeaderReader(
  reader: ((workspaceId: string) => ComposerMeta[]) | null,
  resolver: ((composerId: string) => string) | null = null,
): void {
  headerReader = reader;
  workspaceResolver = resolver;
  workspaceCache.clear();
  workspaceIdByComposer.clear();
}

/** Sessions of this workspace (filter archived/subagent/anonymous), recency descending — same source as sidebar order. */
export function readWorkspaceComposers(workspaceId: string): ComposerMeta[] {
  if (!workspaceId)
    return [];
  if (headerReader)
    return headerReader(workspaceId);
  const cached = workspaceCache.get(workspaceId);
  const now = Date.now();
  if (cached && now - cached.at < WORKSPACE_TTL_MS)
    return cached.rows;
  const handle = openDb();
  if (!handle)
    return cached?.rows ?? [];
  try {
    const rows = handle
      .prepare(
        `SELECT composerId AS composerId,
                workspaceId AS workspaceId,
                COALESCE(json_extract(value, '$.name'), '') AS name,
                COALESCE(recency, createdAt, 0) AS recency
           FROM composerHeaders
          WHERE workspaceId = ?
            AND isSubagent = 0
            AND isArchived = 0
            AND COALESCE(json_extract(value, '$.name'), '') <> ''
          ORDER BY recency DESC`,
      )
      .all(workspaceId) as ComposerMeta[];
    workspaceCache.set(workspaceId, { at: now, rows });
    return rows;
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[tab-identity] composerHeaders read failed: ${message}`);
    return cached?.rows ?? [];
  }
}

/**
 * Every workspaceId that has appeared in the DB (Agents window repo groups use it to reverse-lookup which workspace a row belongs to).
 * Shares the same read-only connection and retry policy as readWorkspaceComposers; return [] if unreadable.
 */
const WORKSPACE_IDS_TTL_MS = 10_000;
let workspaceIdsCache: { at: number; ids: string[] } | null = null;

export function listWorkspaceIds(): string[] {
  const now = Date.now();
  if (workspaceIdsCache && now - workspaceIdsCache.at < WORKSPACE_IDS_TTL_MS) {
    return workspaceIdsCache.ids;
  }
  const handle = openDb();
  if (!handle)
    return workspaceIdsCache?.ids ?? [];
  try {
    const rows = handle
      .prepare('SELECT workspaceId AS workspaceId FROM composerHeaders GROUP BY workspaceId')
      .all() as { workspaceId: string }[];
    const ids = rows.map(r => r.workspaceId).filter(Boolean);
    workspaceIdsCache = { at: now, ids };
    return ids;
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[tab-identity] workspace list read failed: ${message}`);
    return workspaceIdsCache?.ids ?? [];
  }
}

/**
 * **Cloud-agent name list** in local records (`cloudAgentRepository.agents.*` in
 * `ItemTable`, a JSON array).
 *
 * Why: Cursor Cloud Agent runs on a cloud VM, body is not local, but in the
 * Agents window sidebar it is **mixed into the same `No Repo` group** as
 * "local sessions with no project", and the DOM looks identical (no cloud
 * badge) — we can only match this list by name (see CLOUD_SECTION_IDS in
 * agents-window.ts).
 *
 * Archived ones do not count: after archive the IDE does not list them
 * (measured: the row vanishes after `isArchived=1`); leaving them in the list
 * would only injure a same-named local session.
 * Return `null` = could not read (no DB / query failed) — the caller takes
 * the conservative branch; do not treat null as "this machine has no cloud agents".
 */
const CLOUD_AGENTS_TTL_MS = 30_000;
let cloudAgentNamesCache: { at: number; names: string[] } | null = null;
let cloudAgentNameReader: (() => string[] | null) | null = null;

/** For tests/probes: inject a fake cloud-list reader (null = could not read). */
export function setCloudAgentNameReader(reader: (() => string[] | null) | null): void {
  cloudAgentNameReader = reader;
  cloudAgentNamesCache = null;
}

export interface CloudAgentRecord {
  name: string;
  archived: number;
}

/**
 * Expand `cloudAgentRepository.agents.*`. **Pitfall**: that key's value is an
 * **array** (one agent per element) — must `json_each` then take `$.name` of
 * each element; `json_extract(value, '$.name')` on an array (taking `.name`
 * of the array) silently returns NULL, so the list is always empty
 * (hit 2026-09-17: local rows were treated as cloud rows and the whole section hidden).
 */
export function selectCloudAgentRecords(handle: Database.Database): CloudAgentRecord[] {
  return handle
    .prepare(
      `SELECT COALESCE(json_extract(agent.value, '$.name'), '') AS name,
              COALESCE(json_extract(agent.value, '$.isArchived'), 0) AS archived
         FROM ItemTable AS entry, json_each(entry.value) AS agent
        WHERE entry.key LIKE 'cloudAgentRepository.agents%'`,
    )
    .all() as CloudAgentRecord[];
}

/** Unarchived cloud-agent names (after archive the IDE does not list them; keeping them would only injure a same-named local session). */
export function cloudAgentNamesFromRecords(rows: CloudAgentRecord[]): string[] {
  return rows.filter(r => r.name && !r.archived).map(r => r.name);
}

export function listCloudAgentNames(): string[] | null {
  if (cloudAgentNameReader)
    return cloudAgentNameReader();
  const now = Date.now();
  if (cloudAgentNamesCache && now - cloudAgentNamesCache.at < CLOUD_AGENTS_TTL_MS) {
    return cloudAgentNamesCache.names;
  }
  const handle = openDb();
  if (!handle)
    return null;
  try {
    const names = cloudAgentNamesFromRecords(selectCloudAgentRecords(handle));
    cloudAgentNamesCache = { at: now, names };
    return names;
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[tab-identity] cloud agent names read failed: ${message}`);
    return cloudAgentNamesCache?.names ?? null;
  }
}

/** Which workspace a session belongs to (used to fetch the same-name sequence). */
export function workspaceIdOf(composerId: string): string {
  if (isPlaceholderComposerId(composerId))
    return '';
  if (workspaceResolver)
    return workspaceResolver(composerId);
  const known = workspaceIdByComposer.get(composerId);
  if (known)
    return known;
  const handle = openDb();
  if (!handle)
    return '';
  try {
    const row = handle
      .prepare('SELECT workspaceId AS workspaceId FROM composerHeaders WHERE composerId = ?')
      .get(composerId) as { workspaceId?: string } | undefined;
    const id = row?.workspaceId ?? '';
    if (id)
      workspaceIdByComposer.set(composerId, id);
    return id;
  }
  catch {
    return '';
  }
}

/**
 * Session ids of the same name (same workspace), recency descending — the
 * click side uses this sequence + an anchor to convert "target id" into
 * "which sidebar row". Return [] if unreadable (degrade to clicking by same-name index only).
 */
export function sameNameIdsFor(composerId: string, title: string): string[] {
  const workspaceId = workspaceIdOf(composerId);
  if (!workspaceId)
    return [];
  const key = nameKey(title);
  return readWorkspaceComposers(workspaceId)
    .filter(c => nameKey(c.name) === key)
    .map(c => c.composerId);
}

export interface IdentityRow {
  title: string;
  isActive: boolean;
}

export interface TabIdentity {
  composerId: string;
  /** dom = authoritative id read live (composer bar / editor Chat tab); db = inferred by aligning sequences. */
  source: 'dom' | 'db';
}

export interface ResolveIdentityOptions {
  /** Id of the currently open session (composer bar), the most reliable anchor. */
  activeComposerId?: string;
  /** Editor Chat tabs (already-open sessions): title + real id. */
  editorChatTabs?: Array<{ title: string; composerId: string }>;
  /** Sessions of this workspace; must already be recency descending. */
  headers?: ComposerMeta[];
}

/**
 * Pair each row with a real id. Returns an array the same length as rows;
 * unmatched entries are null (keep the placeholder id).
 *
 * 1. Editor Chat tabs: only dare to match by name when "that title has only
 *    one sidebar row" (same-name rows cannot be told apart by name).
 * 2. Anchor: the selected row = the composer-bar session.
 * 3. DB alignment: compute an offset from the anchor inside the same-name
 *    group, then assign ids by position.
 */
export function resolveRowIdentities(
  rows: IdentityRow[],
  opts: ResolveIdentityOptions = {},
): Array<TabIdentity | null> {
  const out: Array<TabIdentity | null> = rows.map(() => null);
  const byName = new Map<string, number[]>();
  rows.forEach((row, i) => {
    const key = nameKey(row.title);
    if (!key)
      return;
    const list = byName.get(key);
    if (list)
      list.push(i);
    else byName.set(key, [i]);
  });

  for (const tab of opts.editorChatTabs ?? []) {
    if (isPlaceholderComposerId(tab.composerId))
      continue;
    const idxs = byName.get(nameKey(tab.title));
    if (idxs && idxs.length === 1)
      out[idxs[0]] = { composerId: tab.composerId, source: 'dom' };
  }

  const activeComposerId = opts.activeComposerId ?? '';
  if (!isPlaceholderComposerId(activeComposerId)) {
    const activeIdx = rows.findIndex(row => row.isActive);
    if (activeIdx >= 0)
      out[activeIdx] = { composerId: activeComposerId, source: 'dom' };
  }

  const headers = opts.headers ?? [];
  if (headers.length === 0)
    return out;

  for (const [key, idxs] of byName) {
    const dbIds = headers.filter(h => nameKey(h.name) === key).map(h => h.composerId);
    if (dbIds.length === 0)
      continue;
    // Inside the group, find a known id as an offset anchor (prefer the selected row = composer-bar one)
    let anchorPos = idxs.findIndex(i => out[i] && rows[i].isActive);
    if (anchorPos < 0)
      anchorPos = idxs.findIndex(i => out[i]);
    let offset = 0;
    if (anchorPos >= 0) {
      const dbPos = dbIds.indexOf(out[idxs[anchorPos]]!.composerId);
      if (dbPos >= 0)
        offset = dbPos - anchorPos;
    }
    idxs.forEach((rowIdx, pos) => {
      if (out[rowIdx])
        return;
      const dbPos = pos + offset;
      if (dbPos >= 0 && dbPos < dbIds.length)
        out[rowIdx] = { composerId: dbIds[dbPos], source: 'db' };
    });
  }
  return out;
}

/** Base status from the extractor (waiting_approval is re-decided here by id). */
function baseStatus(tab: ChatTab): string {
  return tab.status === 'waiting_approval'
    ? tab.isActive ? 'active' : 'idle'
    : tab.status;
}

function sameTitleIndexes(tabs: ChatTab[]): number[] {
  const seen = new Map<string, number>();
  return tabs.map((tab) => {
    const key = nameKey(tab.title);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n;
  });
}

/**
 * Fill real ids / position keys on one extract's chatTabs, and decide
 * "waiting for approval" by id.
 *
 * Waiting-for-approval used to match by title: same-name rows all got the
 * badge (2026-09-15 report). Now prefer composerId (editor Chat tab
 * data-resource-name); only if none hit by id (old environments where id is
 * unavailable) fall back to title match.
 */
export function applyTabIdentities(state: CursorState): CursorState {
  const tabs = state.chatTabs ?? [];
  if (tabs.length === 0)
    return state;

  const editorChatTabs = state._rawSignals?.editorChatTabs ?? [];
  const activeComposerId = isPlaceholderComposerId(state.activeComposerId) ? '' : state.activeComposerId;
  const anchorId = activeComposerId
    || editorChatTabs.find(t => !isPlaceholderComposerId(t.composerId))?.composerId
    || '';
  const workspaceId = anchorId ? workspaceIdOf(anchorId) : '';
  const headers = workspaceId ? readWorkspaceComposers(workspaceId) : [];

  const ids = resolveRowIdentities(
    tabs.map(tab => ({ title: tab.title, isActive: tab.isActive })),
    { activeComposerId, editorChatTabs, headers },
  );

  const idxByTitle = sameTitleIndexes(tabs);
  const awaitingIds = new Set(
    editorChatTabs.filter(t => t.awaiting && !isPlaceholderComposerId(t.composerId)).map(t => t.composerId),
  );
  const awaitingTitles = new Set(editorChatTabs.filter(t => t.awaiting).map(t => nameKey(t.title)));
  const idHit = ids.some(id => !!id && awaitingIds.has(id.composerId));
  const hasAwaitingInfo = editorChatTabs.length > 0;

  let changed = false;
  const nextTabs: ChatTab[] = tabs.map((tab, i) => {
    const id = ids[i];
    const awaiting = id
      ? awaitingIds.has(id.composerId) || (!idHit && awaitingTitles.has(nameKey(tab.title)))
      : !idHit && awaitingTitles.has(nameKey(tab.title));
    const next: ChatTab = {
      ...tab,
      rowIndex: tab.rowIndex ?? i,
      sameTitleIndex: tab.sameTitleIndex ?? idxByTitle[i],
    };
    if (id) {
      next.composerId = id.composerId;
      next.composerIdSource = id.source;
    }
    if (hasAwaitingInfo)
      next.status = awaiting ? 'waiting_approval' : baseStatus(tab);
    if (
      next.composerId !== tab.composerId
      || next.status !== tab.status
      || next.sameTitleIndex !== tab.sameTitleIndex
      || next.rowIndex !== tab.rowIndex
      || next.composerIdSource !== tab.composerIdSource
    ) {
      changed = true;
    }
    return next;
  });

  if (!changed)
    return state;
  return { ...state, chatTabs: nextTabs };
}

/** Full post-process of one extract: live derivation + session identity. Both Cursor extract entries go through here. */
export function postProcessCursorState(state: CursorState): CursorState {
  return applyTabIdentities(applyDerivedActivityToState(state));
}
