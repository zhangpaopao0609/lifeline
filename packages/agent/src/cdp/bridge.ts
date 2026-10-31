import type { CdpEndpointSource, CdpIssue, CdpIssueKind } from '../../../protocol/src/index.js';
import type { AgentConfig, CursorWindow, IdeKind } from '../types.js';
import type { ProbeResult } from './probe.js';
import type { RelaunchResult } from './relaunch-engine.js';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { isAbsolute } from 'node:path';
import { createCursorCdpRelauncher, defaultCursorCdpRelaunchDeps } from '../drivers/cursor/relaunch.js';
import { timingLog } from '../timing-log.js';
import { CdpClient } from './client.js';
import { clearEndpointCache } from './endpoint.js';
import {
  describePortOccupant,
  probeCdpEndpoint,

  toCdpIssue,
} from './probe.js';
import {
  cdpPortFromUrl,
  nextReconnectDelay,

} from './relaunch-engine.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** Subset of a CDP /json target used to pick which Cursor page to attach to. */
export interface CdpPageTarget {
  id?: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/**
 * Prefer a named workbench (the project window) over the global Cursor Agents
 * page. `/json` order is unstable; Agents-first reconnects hide editor chats.
 * Workbench windows are type=page only — iframe/webview (coding-copilot) must not appear.
 */
export function isWorkbenchPage(t: CdpPageTarget): boolean {
  return t.type === 'page' && t.url.includes('workbench');
}

/** CDP title Cursor's Agents overview window uses (a name it chose; does not follow the project) */
const AGENTS_DASHBOARD_TITLE = 'cursor agents';

/**
 * Agents overview page (not a project window). Each IDE has one; recognition differs:
 *
 * - Cursor: the global agent list in the top-left; the page is still
 *   `workbench.html`, recognized by the title `Cursor Agents`.
 *   Its sidebar is a global rail mixed across repos, rows have no
 *   data-composer-id, the list is paginated (More rows in the middle) and
 *   regroups with the "current agent" — measured: clicking a row grew the
 *   list from 42 to 49 rows and the clicked row itself vanished.
 * - CodeBuddy: `workbench/agentManager.html` (title empty / a raw vscode-file
 *   string); only the workbench in the path lets isWorkbenchPage pick it up.
 *
 * Treating it as a project window in windows[]: the web session bar gets a
 * self-jittering extra list, and clicking it is always Tab not found
 * (`command:switch_tab` looks up by title in the currently connected window,
 * and that list re-pages / re-scopes itself). "Browse global agents" is a
 * different feature; see the spec: do not reuse the window model.
 */
export function isAgentsDashboardPage(t: CdpPageTarget): boolean {
  if (/agentmanager\.html/i.test(t.url))
    return true;
  return t.title.trim().toLowerCase() === AGENTS_DASHBOARD_TITLE;
}

/** A page that can be "a window": workbench and not the Agents overview */
export function isProjectWindowPage(t: CdpPageTarget): boolean {
  return isWorkbenchPage(t) && !isAgentsDashboardPage(t);
}

/** Display name of the Agents window in our UI (its own CDP title is `Cursor Agents`). */
export const AGENTS_WINDOW_TITLE = 'Agents';

/** CodeBuddy's Agents overview (`workbench/agentManager.html`): not attached this round; still treated as a non-window. */
export function isCodeBuddyAgentsManagerPage(t: CdpPageTarget): boolean {
  return /agentmanager\.html/i.test(t.url);
}

/** Cursor's Agents overview window (= the one we attach). */
export function isCursorAgentsWindow(t: CdpPageTarget): boolean {
  return isAgentsDashboardPage(t) && !isCodeBuddyAgentsManagerPage(t);
}

/**
 * Window kind. The Agents overview is a real window (CDP target, its own
 * current agent), but it has no project workspace and the sidebar is a
 * cross-repo global list, so extract/commands take a separate branch.
 */
export function windowKindOf(t: CdpPageTarget): 'project' | 'agents' {
  return isAgentsDashboardPage(t) ? 'agents' : 'project';
}

export function pickWorkbenchTarget(
  targets: CdpPageTarget[],
  preferredId?: string,
): CdpPageTarget | undefined {
  const pages = targets.filter(
    t => isWorkbenchPage(t) && Boolean(t.webSocketDebuggerUrl),
  );
  if (preferredId) {
    const preferred = pages.find(t => t.id === preferredId);
    if (preferred)
      return preferred;
  }
  const namedWorkspace = pages.find((t) => {
    const title = t.title.trim();
    return title.length > 0
      && !isAgentsDashboardPage(t)
      && !title.startsWith('vscode-file://');
  });
  return namedWorkspace ?? pages[0];
}

export interface WorkspaceIdentity {
  name: string;
  /** Present only for a local absolute folder. Remote authorities omit it. */
  localPath?: string;
}

/** Folder name for the window title, plus the local path used to prefill a CLI session. */
export function workspaceIdentityFromUri(
  input: { path?: unknown; authority?: unknown },
  includeQualifier = true,
): WorkspaceIdentity | null {
  if (typeof input.path !== 'string' || !input.path)
    return null;
  const authority = typeof input.authority === 'string' ? input.authority : '';
  const basename = input.path.split('/').filter(Boolean).pop() || input.path;
  const qualifier = includeQualifier ? authorityToQualifier(authority) : '';
  const name = qualifier ? `${basename} ${qualifier}` : basename;
  if (authority || !isAbsolute(input.path))
    return { name };
  return { name, localPath: input.path };
}

/**
 * Extract the workspace folder from a connected Cursor renderer page.
 * Uses vscode.context.configuration().workspace.uri which is available in every
 * Cursor/VS Code Electron renderer — stable across platforms and not affected
 * by the volatile document.title / CDP target title.
 */
export async function extractWorkspaceIdentity(client: CdpClient, includeQualifier = true): Promise<WorkspaceIdentity | null> {
  try {
    const raw = await client.evaluate(`
      (() => {
        try {
          const ws = vscode.context.configuration().workspace;
          if (!ws || !ws.uri) return null;
          return JSON.stringify({ path: ws.uri.path, authority: ws.uri.authority || '' });
        } catch { return null; }
      })()
    `, 3000);
    if (!raw || typeof raw !== 'string')
      return null;
    const parsed = JSON.parse(raw) as { path?: unknown; authority?: unknown };
    return workspaceIdentityFromUri(parsed, includeQualifier);
  }
  catch {
    return null;
  }
}

export async function extractWorkspaceName(client: CdpClient, includeQualifier = true): Promise<string | null> {
  const identity = await extractWorkspaceIdentity(client, includeQualifier);
  return identity?.name ?? null;
}

export const DEFAULT_TITLE_SUFFIXES = [' - Cursor'];
export const CODEBUDDY_TITLE_SUFFIXES = [' - CodeBuddy CN', ' - CodeBuddy'];

export interface CdpRelauncher {
  maybeRelaunch: (port: number) => Promise<RelaunchResult>;
  /** Connected: zero the relauncher's "recent mistaken restart" count (see review R3's rate fuse). */
  noteConnected?: () => void;
}

/**
 * Quiet-wake: while the bridge sits in the quiet no-listener poll (IDE not
 * running / no exe / update in progress / burst fuse), a **cheap process
 * probe** — the same predicate the relauncher's `isRunning` uses — watches
 * for the "IDE process just appeared" rising edge and probes CDP immediately.
 *
 * Why not poll CDP faster instead: every reconnect cycle logs one
 * "Reconnecting in …" line, and a fast cadence while the IDE is closed is
 * permanent per-minute log noise (the exact class `noExeLogged` exists to
 * prevent). The 30s CDP poll stays as the backstop (its non-refused branches
 * also run `lsof`); only the wake-up is process-only.
 */
export interface QuietWake {
  /** Must be the same predicate the relauncher uses, or the wake diverges from the self-heal decision. */
  isRunning: () => boolean;
  /** Test hook: tick interval (ms). Default `QUIET_WAKE_POLL_MS`. */
  pollMs?: number;
}

export const QUIET_WAKE_POLL_MS = 2_000;

export interface CDPBridgeOptions {
  titleSuffixes?: string[];
  relauncher?: CdpRelauncher;
  /** macOS app/process names for AXRaise. Default `['Cursor']`. */
  appNames?: string[];
  /** Which IDE this bridge attaches to. Default `'cursor'`. */
  ide?: IdeKind;
  /** Quiet-wake process watcher (rising edge → immediate CDP probe). Absent = today's behavior. */
  quietWake?: QuietWake;
  /** Test hook: skip HTTP `/json` discovery. */
  fetchTargets?: () => Promise<CdpPageTarget[]>;
  /** Test hook: skip HTTP/UA probe. */
  probe?: () => Promise<ProbeResult>;
  /** Test hook: skip the real WebSocket client. */
  createClient?: () => CdpClient;
  /** Re-discover the live debug port (DevToolsActivePort) before each connect. */
  resolveUrl?: () => Promise<{
    cdpUrl: string;
    source: CdpEndpointSource;
    browserUuid?: string;
    hasPortFile?: boolean;
    fileMtime?: number;
  }>;
  /**
   * Quiet strategy is **not caller-configured**: decided by the relauncher
   * (`skipped-not-running` = IDE process is not running = "waiting", not a
   * fault). There used to be a `liveCapable` here, bound to `detectLiveIdeas()`,
   * so machines installed via Setapp / a custom dir missed the inventory → were
   * silenced and no longer self-healed (review must-fix 1).
   */
}

/** Build the osascript used by raiseWindowByTitle. Exported so tests can assert the app name. */
export function raiseWindowAppleScript(title: string, appNames: readonly string[]): string {
  const escaped = title.replace(/"/g, '\\"');
  const blocks = appNames.map((raw) => {
    const app = raw.replace(/"/g, '\\"');
    return `  try
    tell application "${app}" to activate
    tell application "System Events" to tell process "${app}"
      set frontmost to true
      repeat with w in windows
        if name of w contains "${escaped}" then
          try
            set miniaturized of w to false
          end try
          perform action "AXRaise" of w
          return "matched"
        end if
      end repeat
    end tell
  end try`;
  }).join('\n');
  return `on run
${blocks}
  return "no-match"
end run`;
}

/**
 * Windows raise-window command.
 *
 * `WScript.Shell.AppActivate` matches by **window-title prefix** — coarser than
 * macOS `AXRaise`, but the most stable option on Windows without a third-party
 * dependency (it can only raise an interactive-desktop window of the **current
 * session**; Session 0 / a service environment always fails, best-effort).
 *
 * Single quotes in the title must be **doubled** per PowerShell string-literal
 * rules, or the command is a syntax error.
 */
export function raiseWindowPowerShell(title: string): { cmd: string; args: string[] } {
  const safe = title.replace(/'/g, '\'\'');
  return {
    cmd: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(New-Object -ComObject WScript.Shell).AppActivate('${safe}')`,
    ],
  };
}

/**
 * Platform dispatch for "raise the window whose title matches" (pure, for tests).
 * Return `null` = this platform does nothing (or the title is empty). **win32 has no app concept; `appNames` is ignored.**
 */
export function raiseWindowCommand(
  platform: NodeJS.Platform,
  title: string,
  appNames: readonly string[],
): { cmd: string; args: string[] } | null {
  if (!title)
    return null;
  if (platform === 'darwin') {
    return { cmd: 'osascript', args: ['-e', raiseWindowAppleScript(title, appNames)] };
  }
  if (platform === 'win32')
    return raiseWindowPowerShell(title);
  return null;
}

/**
 * "Hit" criterion for a raise-window command (pure, for tests): osascript
 * returns the literal `matched`; `AppActivate` returns `True` / `False`
 * (PowerShell may include `\r\n`).
 */
export function isRaiseMatched(platform: NodeJS.Platform, stdout: string): boolean {
  const out = String(stdout).trim();
  return platform === 'darwin' ? out === 'matched' : /^true$/i.test(out);
}

/** Fallback title parsing for non-connected windows (before Runtime.evaluate is available). */
export function parseCdpTitle(
  raw: string,
  titleSuffixes: readonly string[] = DEFAULT_TITLE_SUFFIXES,
): string {
  let title = raw;
  const suffixes = [...titleSuffixes].sort((a, b) => b.length - a.length);
  for (const suffix of suffixes) {
    if (suffix && title.endsWith(suffix)) {
      title = title.slice(0, -suffix.length);
      break;
    }
  }
  const dashParts = title.split(' - ');
  if (dashParts.length >= 3) {
    title = dashParts[dashParts.length - 2];
  }
  else if (dashParts.length === 2) {
    title = dashParts[dashParts.length - 1];
  }
  return title.trim();
}

function authorityToQualifier(authority: string): string {
  if (!authority)
    return '';
  if (authority.startsWith('wsl+')) {
    return `[WSL: ${authority.slice(4)}]`;
  }
  if (authority.startsWith('ssh-remote+')) {
    const hex = authority.slice('ssh-remote+'.length);
    try {
      const decoded = JSON.parse(Buffer.from(hex, 'hex').toString('utf8')) as { hostName?: string };
      return decoded.hostName ? `[SSH: ${decoded.hostName}]` : `[SSH]`;
    }
    catch {
      return `[SSH: ${hex.substring(0, 16)}]`;
    }
  }
  return `[${authority}]`;
}

export class CDPBridge extends EventEmitter {
  private config: AgentConfig;
  private client: CdpClient | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30000;
  private intentionalDisconnect = false;
  private _activeTargetId = '';
  private _preferredTargetId = '';
  private _windows: CursorWindow[] = [];
  private _activeWorkspaceName: string | null = null;
  /** Local project paths learned from a workbench page, keyed by CDP target id. */
  private readonly workspacePaths = new Map<string, string>();
  private readonly relauncher: CdpRelauncher;
  private readonly titleSuffixes: string[];
  private readonly appNames: string[];
  private readonly ideKind: IdeKind;
  private readonly fetchTargetsOverride?: () => Promise<CdpPageTarget[]>;
  private readonly probeOverride?: () => Promise<ProbeResult>;
  private readonly createClient: () => CdpClient;
  private readonly resolveUrl?: () => Promise<{
    cdpUrl: string;
    source: CdpEndpointSource;
    browserUuid?: string;
    hasPortFile?: boolean;
    fileMtime?: number;
  }>;

  private connectInFlight: Promise<void> | null = null;
  private connectGeneration = 0;
  private currentIssue: CdpIssue | null = null;
  private readonly quietWake?: QuietWake;
  private quietWatchTimer: ReturnType<typeof setInterval> | null = null;
  /** Baseline of the quiet watch (captured on arm): only false→true triggers a probe. */
  private quietSeenRunning = false;
  private endpointSource: CdpEndpointSource | undefined;
  /** Instance uuid from `DevToolsActivePort`: the pre-connect probe must use it for kinship too (or the identity check dies at the attach layer). */
  private endpointUuid: string | undefined;
  /** Last seen port-file mtime (`undefined` = no file was read). */
  private lastFileMtime: number | undefined;
  /** mtime seen at the last relaunch, used to judge "after restart, did this file move". */
  private mtimeAtLastRelaunch: number | undefined;
  /** Whether we have actually relaunched (must not judge "no progress" before the first relaunch). */
  private hasRelaunched = false;
  /**
   * "After a relaunch, the port file we read did not move" → this IDE does not
   * use this file (custom `--user-data-dir`, or we guessed the location wrong).
   * Passing `0` again would make us read a dead file forever and keep killing
   * the IDE — switch to the **configured port** (it does not depend on the file).
   *
   * When we judge: every `no-listener` compares once (not only "between two
   * relaunches"), so the poll right after a relaunch, before the IDE has
   * written the file, **may latch first** (false positive).
   * Harmless: ① actually switching to the configured port still waits for one
   * relaunch that will run (60s cooldown), by which time the file is written;
   * ② once a file port is adopted (`hasPortFile`), `setCdpUrl` immediately
   * clears the latch, and the next time we go back to `0`.
   */
  private fileLocationOff = false;
  /**
   * The **original** configured port. Must be recorded at construction —
   * every `setCdpUrl()` rewrite of `this.config.cdpUrl` with the resolved
   * result means a later `cdpPortFromUrl(this.config.cdpUrl)` is "the last
   * resolved port", not the configured port.
   */
  private readonly configuredPort: number;

  constructor(config: AgentConfig, options: CDPBridgeOptions = {}) {
    super();
    this.config = config;
    this.configuredPort = cdpPortFromUrl(config.cdpUrl);
    this.titleSuffixes = options.titleSuffixes ?? [...DEFAULT_TITLE_SUFFIXES];
    this.appNames = options.appNames && options.appNames.length > 0
      ? [...options.appNames]
      : ['Cursor'];
    this.relauncher = options.relauncher ?? createCursorCdpRelauncher({
      deps: defaultCursorCdpRelaunchDeps(),
    });
    this.ideKind = options.ide ?? 'cursor';
    this.fetchTargetsOverride = options.fetchTargets;
    this.probeOverride = options.probe;
    this.createClient = options.createClient ?? (() => new CdpClient());
    this.resolveUrl = options.resolveUrl;
    this.quietWake = options.quietWake;
  }

  get cdpUrl(): string {
    return this.config.cdpUrl;
  }

  setCdpUrl(
    url: string,
    meta: {
      source?: CdpEndpointSource;
      browserUuid?: string;
      hasPortFile?: boolean;
      fileMtime?: number;
    } = {},
  ): void {
    this.config.cdpUrl = url;
    if (meta.source)
      this.endpointSource = meta.source;
    this.endpointUuid = meta.browserUuid;
    this.lastFileMtime = meta.fileMtime;
    // **Having adopted** a file port = this file's location is correct → clear the "wrong location" latch.
    if (meta.hasPortFile)
      this.fileLocationOff = false;
  }

  get activeTargetId(): string {
    return this._activeTargetId;
  }

  get windows(): CursorWindow[] {
    return this._windows;
  }

  get raiseAppNames(): readonly string[] {
    return this.appNames;
  }

  async connect(targetId?: string): Promise<void> {
    if (this.connectInFlight) {
      await this.connectInFlight.catch(() => {});
      if (!targetId && this.isConnected())
        return;
      if (targetId && this.isConnected() && this._activeTargetId === targetId)
        return;
    }
    else if (!targetId && this.isConnected()) {
      return;
    }

    const run = this.connectOnce(targetId);
    this.connectInFlight = run;
    try {
      await run;
    }
    finally {
      if (this.connectInFlight === run)
        this.connectInFlight = null;
    }
  }

  private async connectOnce(targetId?: string): Promise<void> {
    this.clearReconnectTimer();
    const generation = ++this.connectGeneration;
    try {
      if (this.client) {
        this.intentionalDisconnect = true;
        this.client.disconnect();
        this.client = null;
        this.intentionalDisconnect = false;
      }

      if (this.resolveUrl) {
        const resolved = await this.resolveUrl();
        if (generation !== this.connectGeneration)
          return;
        this.setCdpUrl(resolved.cdpUrl, resolved);
      }

      const probed = await this.runProbe();
      if (generation !== this.connectGeneration)
        return;

      if (probed.kind !== 'ok' || !probed.target?.webSocketDebuggerUrl) {
        if (probed.kind === 'no-listener') {
          clearEndpointCache(this.ideKind);
        }
        let issue = toCdpIssue(probed, 'workbench');
        if (issue.kind === 'no-listener') {
          // Judge "after restart, can we read the port back": compare mtime
          // **only between two relaunches** — 60s cooldown, so we naturally
          // do not misread "IDE started slowly, file not written yet" as
          // "file location is wrong".
          if (
            !this.fileLocationOff
            && this.hasRelaunched
            && this.lastFileMtime === this.mtimeAtLastRelaunch
          ) {
            this.fileLocationOff = true;
            console.log(
              '[cdp-bridge] DevToolsActivePort did not change after the relaunch — this IDE does not '
              + 'use that file (custom --user-data-dir?); relaunching on the configured port instead of 0',
            );
          }
          // Default pass 0 (random port, then read it back from the file, **reserve no port**);
          // only after confirming "this IDE does not use the file we read" do we fall
          // back to the configured port — passing 0 then would forever read a dead
          // file, kill 3 times per 10 minutes, never recover (review Q2(B)).
          const relaunchPort = this.fileLocationOff ? this.configuredPort : 0;
          const result = await this.relauncher.maybeRelaunch(relaunchPort);
          if (generation !== this.connectGeneration || this.isConnected())
            return;
          clearEndpointCache(this.ideKind);
          issue = { ...issue, relaunch: result };
          if (result === 'relaunched') {
            this.hasRelaunched = true;
            this.mtimeAtLastRelaunch = this.lastFileMtime;
          }
          // **The IDE process is not running at all** → this is "waiting", not a
          // fault: quiet slow poll, do not report.
          //
          // The criterion must be "is the process running", **not** "is the app
          // in the inventory": a Setapp / custom-dir machine has an empty
          // inventory, but it is running and should self-heal — using the
          // inventory as the criterion would move R1 from "do not start" to
          // "started but never self-heals" (review must-fix 1).
          // Also covers the other end: when a machine has only one IDE, the
          // other slot's process is not running → do not keep reporting a fake fault.
          if (result === 'skipped-not-running' || result === 'skipped-update-in-progress') {
            this.setIssue(null);
            this.scheduleReconnect('no-listener', { quiet: true });
            return;
          }
          // The IDE is running, but we **cannot find its executable** (win32:
          // candidate table + App Paths both missed).
          // **Report it** (or the user only sees "cannot connect" with no
          // reason), but **do not 500ms fast-poll** — a reinstall / path change
          // is not something that happens in seconds.
          if (result === 'skipped-no-exe') {
            this.setIssue(issue);
            this.scheduleReconnect('no-listener', { quiet: true });
            return;
          }
          // Burst fuse tripped: "leave the IDE alone" is the whole point, and
          // the default branch's 500ms fast poll would storm the log for the
          // rest of the 10-minute window. Keep the issue visible (it is a real
          // fault) — only the cadence goes quiet.
          if (result === 'skipped-throttled') {
            this.setIssue(issue);
            this.scheduleReconnect('no-listener', { quiet: true });
            return;
          }
          // Quit stuck on a save dialog: same storm class, and unlike the fuse
          // there is not even a 10-minute window bounding it — the dialog can
          // sit for hours. The engine's retry gate is subsumed by one quit
          // attempt's own 25–35s duration, so the quiet 30s cadence loses
          // nothing; the wake watcher covers the "user finally dismissed it"
          // transition.
          if (result === 'skipped-quit-pending') {
            this.setIssue(issue);
            this.scheduleReconnect('no-listener', { quiet: true });
            return;
          }
        }
        this.setIssue(issue);
        this.scheduleReconnect(issue.kind);
        return;
      }

      let target = probed.target as CDPTarget;
      if (!this.probeOverride) {
        const targets = await this.fetchTargets(true);
        if (generation !== this.connectGeneration)
          return;
        this._windows = this.targetsToWindows(targets);
        const preferredId = targetId || this._preferredTargetId || undefined;
        const picked = (pickWorkbenchTarget(targets, preferredId) as CDPTarget | undefined)
          ?? targets.find(t => t.type === 'page');
        if (picked?.webSocketDebuggerUrl)
          target = picked;
      }
      else {
        this._windows = this.targetsToWindows([target]);
      }

      this._preferredTargetId = target.id;
      console.log(`[cdp-bridge] Connecting to target: "${target.title}" (${target.url})`);

      const client = this.createClient();
      try {
        await client.connect(target.webSocketDebuggerUrl!);
      }
      catch (err) {
        if (generation !== this.connectGeneration || this.isConnected())
          return;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[cdp-bridge] Connection failed: ${message}`);
        this.setIssue({
          kind: 'attach-failed',
          scope: 'workbench',
          cdpUrl: this.config.cdpUrl,
          port: cdpPortFromUrl(this.config.cdpUrl),
          detail: message,
          at: Date.now(),
        });
        this.scheduleReconnect('attach-failed');
        return;
      }
      if (generation !== this.connectGeneration) {
        client.disconnect();
        return;
      }
      this.client = client;
      this._activeTargetId = target.id;

      const identity = await extractWorkspaceIdentity(client, this.config.windowTitleQualifier);
      if (generation !== this.connectGeneration)
        return;
      this._activeWorkspaceName = identity?.name ?? null;
      this.rememberWorkspacePath(target.id, identity?.localPath ?? null);
      this._windows = this._windows.map((win) => {
        const stamped = this.stampWorkspace(win);
        if (win.id === target.id && this._activeWorkspaceName)
          return { ...stamped, title: this._activeWorkspaceName };
        return stamped;
      });
      if (this._activeWorkspaceName)
        console.log(`[cdp-bridge] Workspace name: "${this._activeWorkspaceName}"`);

      client.on('disconnected', () => {
        if (!this.intentionalDisconnect && this.client === client) {
          console.warn('[cdp-bridge] CDP connection lost unexpectedly');
          this.handleDisconnect();
        }
      });

      this.reconnectDelay = 1000;
      this.clearReconnectTimer();
      this.setIssue(null);
      // Connected: zero the "recent mistaken restart" count. The fuse is for
      // consecutive failures, not punishing a normal Dock cold start (Cursor
      // does not read argv.json, so every start needs one self-heal).
      this.relauncher.noteConnected?.();
      console.log('[cdp-bridge] Connected successfully');
      this.emit('connected');
    }
    catch (err) {
      if (generation !== this.connectGeneration || this.isConnected())
        return;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cdp-bridge] Connection failed: ${message}`);
      this.setIssue({
        kind: 'unknown',
        scope: 'workbench',
        cdpUrl: this.config.cdpUrl,
        port: cdpPortFromUrl(this.config.cdpUrl),
        detail: message,
        at: Date.now(),
      });
      this.scheduleReconnect('unknown');
    }
  }

  private async runProbe(): Promise<ProbeResult> {
    if (this.probeOverride)
      return this.probeOverride();
    return probeCdpEndpoint(this.config.cdpUrl, this.ideKind, {
      lookupOccupant: describePortOccupant,
      // **Carry instance identity**: otherwise "pick port" used the strongest
      // kinship check, then this probe degrades to "look at install path,
      // unrecognized means allow", producing the contradiction "status says
      // blocked, but the agent connected" (review F1).
      expect: { browserUuid: this.endpointUuid },
    });
  }

  private setIssue(issue: CdpIssue | null): void {
    const next = issue && this.endpointSource
      ? { ...issue, endpointSource: this.endpointSource }
      : issue;
    if (sameBridgeIssue(this.currentIssue, next))
      return;
    this.currentIssue = next;
    this.emit('issue', next);
  }

  async switchWindow(targetId: string): Promise<void> {
    if (targetId === this._activeTargetId)
      return;
    this._preferredTargetId = targetId;
    this.connectGeneration++;

    this.intentionalDisconnect = true;
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this._activeTargetId = '';
    this.emit('disconnected');

    this.intentionalDisconnect = false;
    await this.connect(targetId);
  }

  /**
   * Raise the currently active window. Slow AppleScript fallback when a click
   * or send could not find its control — not used on the success path.
   */
  raiseActiveWindow(): Promise<void> {
    const win = this._windows.find(w => w.id === this._activeTargetId);
    if (win)
      return this.raiseWindowByTitle(win.title);
    timingLog('raise', { ok: false, error: 'no-active-window' });
    return Promise.resolve();
  }

  /**
   * Best-effort: bring the window matching `title` to the front.
   * macOS uses AppleScript `AXRaise`; Windows uses `WScript.Shell.AppActivate` (see `raiseWindowCommand`).
   */
  private raiseWindowByTitle(title: string): Promise<void> {
    const spec = raiseWindowCommand(process.platform, title, this.appNames);
    if (!spec)
      return Promise.resolve();
    const started = Date.now();
    return new Promise((resolve) => {
      execFile(spec.cmd, spec.args, { timeout: 4000 }, (err, stdout, stderr) => {
        const ms = Date.now() - started;
        const onMac = process.platform === 'darwin';
        const matched = isRaiseMatched(process.platform, String(stdout));
        const base = { title, apps: this.appNames.join(','), ms };
        if (err) {
          timingLog('raise', { ...base, ok: false, error: err.message });
          console.warn(
            `[cdp-bridge] raiseWindow failed: ${err.message}${
              stderr ? ` (${stderr.trim().slice(0, 120)})` : ''}`,
          );
        }
        else if (matched) {
          timingLog('raise', { ...base, ok: true, matched: true });
          console.log(`[cdp-bridge] Raised window: ${title}`);
        }
        else {
          timingLog('raise', { ...base, ok: true, matched: false });
          // On macOS, `tell application … to activate` in the AppleScript did
          // activate the app (just did not raise the window), so "app activated
          // only" is true; **the Windows branch is a single `AppActivate`, and
          // False means nothing was activated**, so reusing the same sentence
          // is a wrong statement and misleads debugging.
          const platform = onMac ? 'macOS ' : '';
          const suffix = onMac ? ' - app activated only' : ' - nothing was activated';
          console.warn(`[cdp-bridge] No ${platform}window matched "${title}"${suffix}`);
        }
        resolve();
      });
    });
  }

  async refreshWindows(): Promise<CursorWindow[]> {
    try {
      const targets = await this.fetchTargets();
      this._windows = this.targetsToWindows(targets);
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[cdp-bridge] Failed to refresh windows: ${message}`);
    }
    return this._windows;
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.connectGeneration++;
    this.clearReconnectTimer();
    clearEndpointCache(this.ideKind);
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }

  getClient(): CdpClient | null {
    return this.client;
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isConnected();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Any connect attempt (or disconnect) supersedes the quiet watcher; the
    // next quiet schedule re-arms it. One funnel, no second lifecycle.
    this.clearQuietWatch();
  }

  private clearQuietWatch(): void {
    if (this.quietWatchTimer) {
      clearInterval(this.quietWatchTimer);
      this.quietWatchTimer = null;
    }
  }

  /**
   * Rising-edge process watch for the quiet phase. Baseline is captured on
   * arm, so a process already up when we went quiet (no-exe /
   * update-in-progress) has no edge; 消失→再现 (an updater relaunching the
   * new version) still fires. Silent per tick: only the wake probe logs.
   */
  private armQuietWatch(): void {
    const wake = this.quietWake;
    if (!wake || this.quietWatchTimer)
      return;
    this.quietSeenRunning = wake.isRunning();
    this.quietWatchTimer = setInterval(() => {
      if (this.intentionalDisconnect || this.isConnected()) {
        this.clearQuietWatch();
        return;
      }
      const wasRunning = this.quietSeenRunning;
      const running = wake.isRunning();
      this.quietSeenRunning = running;
      if (!wasRunning && running) {
        this.clearQuietWatch();
        void this.connect();
      }
    }, wake.pollMs ?? QUIET_WAKE_POLL_MS);
    this.quietWatchTimer.unref?.();
  }

  private async fetchTargets(verbose = false): Promise<CDPTarget[]> {
    if (this.fetchTargetsOverride) {
      return await this.fetchTargetsOverride() as CDPTarget[];
    }
    const url = `${this.config.cdpUrl}/json`;
    if (verbose)
      console.log(`[cdp-bridge] Discovering targets at ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    }
    finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new Error(`CDP target discovery failed: HTTP ${response.status}`);
    }

    const targets: CDPTarget[] = await response.json() as CDPTarget[];
    if (verbose) {
      const pages = targets.filter(t => t.type === 'page');
      const rest = targets.filter(t => t.type !== 'page');
      const summary = Object.entries(
        rest.reduce<Record<string, number>>((acc, t) => { acc[t.type] = (acc[t.type] ?? 0) + 1; return acc; }, {}),
      ).map(([type, count]) => `${count} ${type}`).join(', ');
      console.log(`[cdp-bridge] Found ${pages.length} page(s)${summary ? ` (+${summary})` : ''}:`);
      for (const t of pages) {
        console.log(`  [page] "${t.title}" — ${t.url}`);
      }
    }
    return targets;
  }

  /** Remember or clear the local folder for a CDP target. The next window list picks it up. */
  rememberWorkspacePath(windowId: string, localPath: string | null): void {
    if (!windowId)
      return;
    if (localPath && isAbsolute(localPath))
      this.workspacePaths.set(windowId, localPath);
    else
      this.workspacePaths.delete(windowId);
  }

  private stampWorkspace(win: CursorWindow): CursorWindow {
    if (win.kind === 'agents') {
      this.workspacePaths.delete(win.id);
      if (win.workspacePath === undefined)
        return win;
      const copy = { ...win };
      delete copy.workspacePath;
      return copy;
    }
    const workspacePath = this.workspacePaths.get(win.id);
    if (!workspacePath) {
      if (win.workspacePath === undefined)
        return win;
      const copy = { ...win };
      delete copy.workspacePath;
      return copy;
    }
    return win.workspacePath === workspacePath ? win : { ...win, workspacePath };
  }

  private targetsToWindows(targets: CDPTarget[]): CursorWindow[] {
    const includeAgents = this.config.agentsWindow !== false;
    const windows = targets
      .filter(t => isProjectWindowPage(t) || (includeAgents && isCursorAgentsWindow(t)))
      .map((t) => {
        // Agents overview window: no project workspace; title is our display name; behavior branches on kind
        if (isCursorAgentsWindow(t)) {
          return {
            id: t.id,
            title: AGENTS_WINDOW_TITLE,
            url: t.url,
            wsUrl: t.webSocketDebuggerUrl,
            kind: 'agents' as const,
          };
        }
        // For the connected window, prefer the workspace name extracted via Runtime.evaluate
        if (t.id === this._activeTargetId && this._activeWorkspaceName) {
          return { id: t.id, title: this._activeWorkspaceName, url: t.url, wsUrl: t.webSocketDebuggerUrl };
        }
        // Fallback: parse the CDP target title (used for non-connected windows
        // until they get polled with their own temporary CDP connection)
        return { id: t.id, title: parseCdpTitle(t.title, this.titleSuffixes), url: t.url, wsUrl: t.webSocketDebuggerUrl };
      });
    const live = new Set(windows.map(win => win.id));
    for (const id of this.workspacePaths.keys()) {
      if (!live.has(id))
        this.workspacePaths.delete(id);
    }
    return windows.map(win => this.stampWorkspace(win));
  }

  private handleDisconnect(): void {
    clearEndpointCache(this.ideKind);
    this.client = null;
    this._activeTargetId = '';
    this.emit('disconnected');
    this.scheduleReconnect();
  }

  private scheduleReconnect(kind?: CdpIssueKind, opts: { quiet?: boolean } = {}): void {
    if (this.intentionalDisconnect)
      return;
    if (this.reconnectTimer)
      return;

    const delay = kind !== undefined
      ? nextReconnectDelay(this.reconnectDelay, {
          kind,
          max: this.maxReconnectDelay,
          quietNoListener: opts.quiet,
        })
      : this.reconnectDelay;
    console.log(`[cdp-bridge] Reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.intentionalDisconnect || this.isConnected())
        return;
      if (kind && kind !== 'no-listener' && kind !== 'no-window') {
        this.reconnectDelay = nextReconnectDelay(this.reconnectDelay, {
          kind,
          max: this.maxReconnectDelay,
        });
      }
      else if (!kind) {
        this.reconnectDelay = nextReconnectDelay(this.reconnectDelay, {
          max: this.maxReconnectDelay,
        });
      }
      await this.connect();
    }, delay);
    if (opts.quiet)
      this.armQuietWatch();
  }
}

function sameBridgeIssue(a: CdpIssue | null, b: CdpIssue | null): boolean {
  if (a === b)
    return true;
  if (!a || !b)
    return false;
  return a.kind === b.kind
    && a.detail === b.detail
    && a.occupant === b.occupant
    && a.notCdpCause === b.notCdpCause
    && a.relaunch === b.relaunch
    && a.endpointSource === b.endpointSource;
}
