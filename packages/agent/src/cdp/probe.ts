import type { CdpIssue, CdpIssueKind, CdpScope, IdeKind, NotCdpCause } from '../../../protocol/src/index.js';
import type { CdpPageTarget } from './bridge.js';
import { spawnSync } from 'node:child_process';
import { isWorkbenchPage } from './bridge.js';
import { cdpPortFromUrl } from './relaunch-engine.js';

export type ProbeFetch = typeof fetch;

/**
 * UA tokens for our own products. **Deliberately loose, no slash**: a product
 * upgrade that changes the suffix (`CursorNext/`) or an enterprise rebundle
 * that adds a prefix still matches. Tightening to `Cursor\/` would brick every
 * machine on a rename.
 */
const OUR_UA_TOKEN: Record<IdeKind, RegExp> = {
  cursor: /Cursor/i,
  codebuddy: /CodeBuddy/i,
};

/**
 * UA tokens that are clearly "not us": a browser, or another known VS Code-family product.
 *
 * Two taboos: **must not** use `Electron/` (our own UA has it too); **must not**
 * decide from `Chrome/` alone — first confirm the UA has none of our tokens
 * (Cursor's UA also carries `Chrome/`).
 */
const FOREIGN_UA_TOKEN = /HeadlessChrome\/|Chrome\/|Firefox\/|Edg\/| Code\/\d|VSCodium\/|Windsurf\/|Trae\//;

/**
 * Three-state identity. **`unknown` is not a reason to reject** — it only means
 * "unrecognized"; the layer above still proceeds to shape checks; only
 * `foreign` (clearly someone else's product) is blocked.
 */
export function identityOf(ua: string | undefined, ide: IdeKind): 'match' | 'foreign' | 'unknown' {
  if (!ua || !ua.trim())
    return 'unknown';
  if (OUR_UA_TOKEN[ide].test(ua))
    return 'match';
  if (FOREIGN_UA_TOKEN.test(ua))
    return 'foreign';
  return 'unknown';
}

/**
 * **Install-path** fragments that clearly belong to "someone else's IDE" (used on the workbench URL).
 *
 * This layer is enabled only when there is "no instance identity (uuid)", and
 * **unrecognized means accept** (prefer allow) — so the list must be conservative:
 * only things we are sure we will see. **Linux path shapes are unverified and
 * deliberately omitted** (a wrong `/usr/share/code/` would block us).
 * Spaces in the URL are percent-encoded (measured `/Applications/CodeBuddy%20CN.app/`);
 * decode before comparing.
 */
const FOREIGN_APP_PATH = /\/(Visual Studio Code|VSCodium|Windsurf|Trae|Google Chrome|Chromium)\.app\//;

/**
 * Take the app install path from a workbench URL.
 * Measured shape: `vscode-file://vscode-app/Applications/Cursor.app/Contents/Resources/app/out/vs/…/workbench.html`
 */
export function appPathOf(url: string): string {
  const m = /^vscode-file:\/\/vscode-app(\/.+)$/.exec(url);
  if (!m?.[1])
    return '';
  try { return decodeURIComponent(m[1]); }
  catch { return m[1]; }
}

/**
 * Take the browser uuid from `/json/version`'s `webSocketDebuggerUrl`.
 *
 * It is the **same value** as line 2 of `DevToolsActivePort`
 * (`/devtools/browser/<uuid>`), and is **regenerated on every process start** —
 * so "both sides match" means "this port belongs to the instance in the file",
 * independent of product name / UA / install path, and not forgeable.
 * **Recognition only; attach always uses the page `webSocketDebuggerUrl`, never this browser ws.**
 */
export function parseBrowserUuid(webSocketDebuggerUrl: string | undefined): string | undefined {
  const raw = /\/devtools\/browser\/([^/?#]+)/.exec(webSocketDebuggerUrl ?? '')?.[1];
  return raw && BROWSER_UUID_RE.test(raw) ? raw : undefined;
}

/**
 * Canonical uuid (the shape Chromium generates).
 *
 * **Must be strict**: a loose parse turns "could not parse" into "mismatch" —
 * we hit this once: the file contained `/devtools/browser/restored`, the old
 * loose regex accepted it, so "expected id = restored" did not match the real
 * uuid → **a healthy Cursor was blocked**. Non-canonical values always return
 * undefined = "this layer is unavailable", not mismatch.
 */
const BROWSER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseOccupantLsof(stdout: string): string | undefined {
  for (const line of stdout.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 2 && cols[0])
      return `${cols[0]} (pid ${cols[1]})`;
  }
  return undefined;
}

/**
 * Take the PID **listening** on this port from `netstat -ano` output (Windows).
 *
 * **Must filter `LISTENING` first**: measured, the same port also has TIME_WAIT /
 * ESTABLISHED rows whose PID is `0` —
 * `TCP 127.0.0.1:54811 127.0.0.1:54464 TIME_WAIT 0`.
 * Without the filter we get PID 0, or treat a **remote port** as a local listen port.
 *
 * Columns: proto / local / remote / state / PID (the state string is English even
 * on Chinese Windows). **Do not hard-code the state column index**; filter by
 * token: `LISTENING` cannot appear in proto or address columns, and token
 * filtering tolerates whitespace jitter.
 *
 * ⚠️ **Returns a bare PID (string), not human occupant copy** — **different**
 * from sibling `parseOccupantLsof()` (returns `"Google (pid 65600)"`). The
 * image name needs `tasklist`, so the two steps are separate. Do not stuff
 * this return value into `CdpIssue.occupant`.
 */
export function parseOccupantNetstat(stdout: string, port: number): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5)
      continue; // drop truncated/malformed rows by column count (real LISTENING rows are always 5 cols)
    // The header row is **also exactly 5 columns**, so it is dropped by the token filter below, not by column count
    if (!cols.includes('LISTENING'))
      continue;
    if (!(cols[1] ?? '').endsWith(`:${port}`))
      continue;
    const pid = cols[cols.length - 1] ?? '';
    if (/^\d+$/.test(pid) && pid !== '0')
      return pid;
  }
  return undefined;
}

/**
 * `tasklist /FI "PID eq N" /FO CSV /NH` → image name in the first field.
 *
 * The first field **has quotes** (`"Cursor.exe","7824",…`); strip them.
 * On no match, tasklist prints `INFO: No tasks are running which match the specified criteria.`
 * — that line does not start with a quote, so naturally returns undefined;
 * do not treat it as "a process with that name".
 */
export function parseTasklistImage(stdout: string): string | undefined {
  const first = stdout.split(/\r?\n/)[0]?.trim() ?? '';
  return /^"([^"]+)"/.exec(first)?.[1];
}

/**
 * Exec options for the Windows branch.
 *
 * `timeout` is deliberately shorter than the POSIX one: `spawnSync` is
 * **synchronous** and stalls the entire agent event loop (the other IDE slot,
 * uplink heartbeat, HTTP all stop). In steady state `not-cdp` reconnect
 * doubles to 30s, so we may block this long every 30s — diagnostic copy is
 * not worth that. `windowsHide` prevents a console flash when the daemon
 * spawns a console program.
 */
const WIN_RUN_OPTS = { encoding: 'utf8', timeout: 1000, windowsHide: true } as const;

export interface OccupantDeps {
  /** Injection point: tests feed dead data; **tests must not actually call netstat / tasklist**. */
  run?: typeof spawnSync;
  platform?: NodeJS.Platform;
  warn?: (msg: string) => void;
}

/**
 * Best-effort: who is listening on this TCP port.
 *
 * - macOS / Linux: `lsof -nP -iTCP:<port> -sTCP:LISTEN`
 * - Windows: `netstat -ano` finds the `LISTENING` row's PID, then `tasklist`
 *   turns it into a human-readable image name (`lsof` does not exist on
 *   Windows → ENOENT)
 *
 * Used only for **diagnostic copy** (`CdpIssue.occupant`); return `undefined`
 * if we cannot get it; **never affects connect decisions** — so every failure
 * path here is swallowed, with a log only.
 */
export function describePortOccupant(port: number, deps: OccupantDeps = {}): string | undefined {
  const run = deps.run ?? spawnSync;
  const platform = deps.platform ?? process.platform;
  const warn = deps.warn ?? ((msg: string) => console.warn(msg));

  if (platform === 'win32') {
    try {
      const ns = run('netstat', ['-ano'], WIN_RUN_OPTS);
      // The command itself is unavailable (slim image / old OS without netstat):
      // leave a clue so "port in use but we cannot name who" is not an unsolvable mystery.
      if (ns.error) {
        warn(`[cdp-probe] netstat unavailable (${ns.error.message}); cannot name the port occupant`);
        return undefined;
      }
      const pid = parseOccupantNetstat(ns.stdout ?? '', port);
      if (!pid)
        return undefined;

      const tl = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], WIN_RUN_OPTS);
      if (tl.error) {
        warn(`[cdp-probe] tasklist unavailable (${tl.error.message}); showing the bare pid`);
        return `pid ${pid}`;
      }
      const image = parseTasklistImage(tl.stdout ?? '');
      // If we cannot get the image name (permissions / process just exited), fall
      // back to a bare pid — still more useful than nothing, and `formatCdpStatusLine`
      // renders `occupied by pid 7824`, which reads.
      return image ? `${image} (pid ${pid})` : `pid ${pid}`;
    }
    catch (err) {
      warn(`[cdp-probe] port occupant lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  // POSIX branch: command, args, and timeout stay as they were (macOS behavior unchanged).
  try {
    const r = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 1500,
    });
    return parseOccupantLsof(r.stdout ?? '');
  }
  catch {
    return undefined;
  }
}

export function toCdpIssue(probed: ProbeResult, scope: CdpScope): CdpIssue {
  const kind: CdpIssueKind = probed.kind === 'ok' ? 'no-workbench' : probed.kind;
  return {
    kind,
    scope,
    cdpUrl: probed.cdpUrl,
    port: probed.port,
    detail: probed.kind === 'ok' ? '没有可接的 workbench' : probed.detail,
    occupant: probed.occupant,
    browser: probed.browser,
    notCdpCause: probed.notCdpCause,
    at: probed.at,
  };
}

export interface ProbeResult {
  kind: CdpIssueKind | 'ok';
  cdpUrl: string;
  port: number;
  detail: string;
  target?: CdpPageTarget;
  occupant?: string;
  browser?: string;
  /** Browser uuid from `/json/version` (diagnostics; kinship is decided internally). */
  browserUuid?: string;
  notCdpCause?: NotCdpCause;
  at: number;
}

export interface ProbeExpectation {
  /** Browser uuid parsed from line 2 of `DevToolsActivePort`. Passing it enables the "instance identity" layer. */
  browserUuid?: string;
}

export async function probeCdpEndpoint(
  cdpUrl: string,
  ide: IdeKind,
  opts?: {
    fetch?: ProbeFetch;
    lookupOccupant?: (port: number) => string | undefined;
    now?: () => number;
    /** Expected instance identity (from `DevToolsActivePort`). */
    expect?: ProbeExpectation;
  },
): Promise<ProbeResult> {
  const fetchImpl = opts?.fetch ?? fetch;
  const now = opts?.now ?? Date.now;
  const port = cdpPortFromUrl(cdpUrl);
  const base = { cdpUrl, port, at: now() };
  const jsonUrl = `${cdpUrl.replace(/\/$/, '')}/json`;
  const versionUrl = `${cdpUrl.replace(/\/$/, '')}/json/version`;

  let raw: Response;
  try {
    raw = await fetchImpl(jsonUrl, { signal: AbortSignal.timeout(5000) });
  }
  catch (err) {
    const e = err as Error & { cause?: { code?: string }; name?: string };
    const code = e.cause?.code ?? '';
    if (e.name === 'AbortError' || e.name === 'TimeoutError' || /aborted/i.test(e.message)) {
      return { ...base, kind: 'unknown', detail: e.message };
    }
    if (/ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i.test(`${code} ${e.message}`)) {
      return { ...base, kind: 'no-listener', detail: `${code || e.message} ${jsonUrl}` };
    }
    return { ...base, kind: 'unknown', detail: e.message };
  }

  if (!raw.ok) {
    return {
      ...base,
      kind: 'not-cdp',
      notCdpCause: 'http',
      detail: `CDP target discovery failed: HTTP ${raw.status}`,
      occupant: opts?.lookupOccupant?.(port),
    };
  }

  let list: unknown;
  try { list = await raw.json(); }
  catch {
    return { ...base, kind: 'not-cdp', notCdpCause: 'http', detail: '/json 不是 JSON', occupant: opts?.lookupOccupant?.(port) };
  }
  if (!Array.isArray(list)) {
    return { ...base, kind: 'not-cdp', notCdpCause: 'http', detail: '/json 不是数组', occupant: opts?.lookupOccupant?.(port) };
  }

  let version: { 'Browser'?: string; 'User-Agent'?: string; 'webSocketDebuggerUrl'?: string } | undefined;
  try {
    const v = await fetchImpl(versionUrl, { signal: AbortSignal.timeout(2000) });
    if (v.ok)
      version = await v.json() as { 'Browser'?: string; 'User-Agent'?: string; 'webSocketDebuggerUrl'?: string };
  }
  catch { /* identity unknown */ }

  const targets = list as CdpPageTarget[];
  const pages = targets.filter(t => isWorkbenchPage(t) && Boolean(t.webSocketDebuggerUrl));
  const browser = version?.Browser;
  const versionUuid = parseBrowserUuid(version?.webSocketDebuggerUrl);
  const expectedUuid = opts?.expect?.browserUuid;
  const noWindowKind: CdpIssueKind = targets.length === 0 ? 'no-window' : 'no-workbench';
  const noWindowDetail = targets.length === 0 ? '0 个 target' : '没有可接的 workbench';

  // ── Rule 1: instance identity (strongest evidence) ──
  //     Matching `DevToolsActivePort` uuid with `/json/version` browser ws path
  //     = that instance; a rename or Chrome/ in the UA still attaches.
  //     **Missing either side means this layer does not exist** (`/json/version`
  //     can flap); never write "could not read" as mismatch — that would block
  //     a healthy machine.
  if (expectedUuid && versionUuid) {
    if (versionUuid !== expectedUuid) {
      return {
        ...base,
        kind: 'not-cdp',
        notCdpCause: 'foreign',
        detail: '端口上的实例 id 与 DevToolsActivePort 里记的不一致（该端口已被别的进程接手）',
        browser,
        browserUuid: versionUuid,
        occupant: opts?.lookupOccupant?.(port),
      };
    }
    if (pages.length > 0) {
      return {
        ...base,
        kind: 'ok',
        detail: `${pages.length} workbench（实例 id 一致）`,
        target: pages[0],
        browser,
        browserUuid: versionUuid,
      };
    }
    // Instance matched, just no window: a normal state; do not look at UA.
    return { ...base, kind: noWindowKind, detail: `实例 id 一致，但${noWindowDetail}`, browser, browserUuid: versionUuid };
  }

  // ── Rule 2: there is an attachable workbench, but this layer has no uuid → use **install path** to recognize others ──
  //     Unrecognized means accept (prefer allow): a wrong path shape costs "user fully blocked", far worse than "attached to someone else's window".
  if (pages.length > 0) {
    const appPath = appPathOf(pages[0].url);
    if (appPath && FOREIGN_APP_PATH.test(appPath)) {
      return {
        ...base,
        kind: 'not-cdp',
        notCdpCause: 'foreign',
        detail: `可接的 workbench 来自别家产品：${/\/([^/]+\.app)\//.exec(appPath)?.[1] ?? appPath}`,
        browser,
        occupant: opts?.lookupOccupant?.(port),
      };
    }
    return { ...base, kind: 'ok', detail: `${pages.length} workbench`, target: pages[0], browser };
  }

  // ── Rule 3: neither instance identity nor an attachable workbench → UA, and only to split these three classes ──
  const ident = identityOf(version?.['User-Agent'], ide);
  if (ident === 'match') {
    return { ...base, kind: noWindowKind, detail: noWindowDetail, browser };
  }
  if (ident === 'foreign') {
    return {
      ...base,
      kind: 'not-cdp',
      notCdpCause: 'foreign',
      detail: `UA mismatch for ${ide}`,
      browser,
      occupant: opts?.lookupOccupant?.(port),
    };
  }
  return {
    ...base,
    kind: 'unknown',
    detail: '没有可接的 workbench，也认不出端口上的产品（UA 缺失 / 不可达 / 未知）',
    browser,
    occupant: opts?.lookupOccupant?.(port),
  };
}
