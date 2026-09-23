import type { ChatTab, CursorState, IdeKind } from '../net/protocol';
import { isIdeKind } from '../net/protocol';

/**
 * "Last viewed" = machine + IDE + session.
 *
 * The session itself is the server's active tab (clicking a session really switches the IDE), so this record
 * does not fight the server: it only answers "where to return on refresh / reopen"; authority stays on the
 * server (a manual switch in the IDE is followed — see the one-shot restore in useViewState). Like window
 * order, it stays in this browser and never goes to the server.
 *
 * On the address bar it is the `/console?m=…&ide=…&s=…` query (the route owns pathname; this owns query).
 * Pure functions, no window — the environment entry is currentViewHint().
 */
export const VIEW_STORAGE_KEY = 'ar:view';

export interface ViewState {
  agentId: string;
  ide: IdeKind;
  sessionId: string;
}

/** A record may be partial: only a machine, only an IDE, or nothing. */
export type ViewHint = Partial<ViewState>;

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Strict parse (unknown → null, drop anything unrecognized): use this for user-editable input like URL
 * params / localStorage. Don't use protocol's parseIde — that is lenient normalize (unknown falls back to cursor).
 * Named differently from protocol's parseIde on purpose.
 */
export function parseIdeParam(raw: unknown): IdeKind | null {
  return isIdeKind(raw) ? raw : null;
}

/** Query shaped `?m=<agentId>&ide=<ide>&s=<composerId>` (hung on `/console`); unrecognized fields are dropped. */
export function parseViewQuery(search: string): ViewHint {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (!raw)
    return {};
  const params = new URLSearchParams(raw);
  const out: ViewHint = {};
  const agentId = params.get('m');
  const sessionId = params.get('s');
  const ide = parseIdeParam(params.get('ide'));
  if (agentId)
    out.agentId = agentId;
  if (sessionId)
    out.sessionId = sessionId;
  if (ide)
    out.ide = ide;
  return out;
}

/** Build the query hung after `/console` (`?m=…&ide=…&s=…`); empty if nothing is set. */
export function formatViewQuery(view: ViewHint): string {
  const params = new URLSearchParams();
  if (view.agentId)
    params.set('m', view.agentId);
  if (view.ide)
    params.set('ide', view.ide);
  if (view.sessionId)
    params.set('s', view.sessionId);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function readStoredView(storage: StorageLike): ViewHint {
  try {
    const raw = storage.getItem(VIEW_STORAGE_KEY);
    if (!raw)
      return {};
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object')
      return {};
    const out: ViewHint = {};
    if (typeof parsed.agentId === 'string' && parsed.agentId)
      out.agentId = parsed.agentId;
    if (typeof parsed.sessionId === 'string' && parsed.sessionId)
      out.sessionId = parsed.sessionId;
    const ide = parseIdeParam(parsed.ide);
    if (ide)
      out.ide = ide;
    return out;
  }
  catch {
    return {};
  }
}

export function writeStoredView(storage: StorageLike, view: ViewHint): void {
  try {
    storage.setItem(VIEW_STORAGE_KEY, JSON.stringify(view));
  }
  catch {
    /* Private mode: still usable this session, just lost on refresh. */
  }
}

/**
 * Query wins (shareable, each tab has its own); only fall back to localStorage when there is no query.
 * Don't mix: a machine from the query paired with a session from localStorage would be a mismatch.
 */
export function resolveInitialView(search: string, storage: StorageLike): ViewHint {
  const fromUrl = parseViewQuery(search);
  if (fromUrl.agentId || fromUrl.ide || fromUrl.sessionId)
    return fromUrl;
  return readStoredView(storage);
}

/** Browser "last viewed"; non-browser environments (tests) return empty. */
export function currentViewHint(): ViewHint {
  if (typeof window === 'undefined')
    return {};
  try {
    return resolveInitialView(window.location.search, window.localStorage);
  }
  catch {
    return {};
  }
}

/**
 * Is the target session in the list (including each window's sidebar)? If yes, return it with windowId filled in,
 * ready as a command:switch_tab target; if not, return null (the session is gone).
 */
export function findTabByComposerId(state: CursorState | undefined, composerId: string): ChatTab | null {
  if (!state || !composerId)
    return null;
  const fromGlobal = (state.chatTabs ?? []).find(t => t.composerId === composerId);
  if (fromGlobal)
    return withWindowId(fromGlobal, state);
  for (const w of state.windows ?? []) {
    const hit = (w.chatTabs ?? []).find(t => t.composerId === composerId);
    if (hit)
      return withWindowId(hit, state, w.id);
  }
  return null;
}

function withWindowId(tab: ChatTab, state: CursorState, fallback?: string): ChatTab {
  if (tab.windowId)
    return tab;
  const windowId = fallback || state.activeWindowId || '';
  return windowId ? { ...tab, windowId } : tab;
}
