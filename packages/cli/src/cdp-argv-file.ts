import type { CdpPortValueForm } from './cdp-argv.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { vscodeCodeBuddyPluginInstalled } from '../../agent/src/codebuddy-vscode.js';
import {
  codeBuddyArgvCandidates as winCodeBuddyArgvCandidates,
  cursorArgvPath as winCursorArgvPath,
} from '../../agent/src/win-paths.js';
import {
  removeManagedRemoteDebuggingPort,
  setManagedRemoteDebuggingPort,
} from './cdp-argv.js';

/**
 * macOS uses `~/.cursor`, Linux uses the XDG userDataDir, **Windows uses Electron's userDataDir**
 * (`%APPDATA%\Cursor` — measured: argv.json and DevToolsActivePort both land there).
 *
 * `platform` / `env` are injectable: otherwise the win32 branch can only run on Windows, and macOS CI cannot cover it.
 * Existing call sites are all no-arg `cursorArgvPath()`; the defaults keep behavior unchanged.
 */
export function cursorArgvPath(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'darwin')
    return join(home, '.cursor', 'argv.json');
  if (platform === 'win32')
    return winCursorArgvPath(env, home);
  return join(home, '.config', 'Cursor', 'argv.json');
}

export type EnsureCdpArgvResult = 'added' | 'already' | 'created';

export function ensureCursorCdpArgv(port = 0): EnsureCdpArgvResult {
  const path = cursorArgvPath();
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    const { text } = setManagedRemoteDebuggingPort('{\n}\n', port);
    writeFileSync(path, text, 'utf-8');
    return 'created';
  }
  const raw = readFileSync(path, 'utf-8');
  const { text, changed } = setManagedRemoteDebuggingPort(raw, port);
  if (!changed)
    return 'already';
  writeFileSync(path, text, 'utf-8');
  return 'added';
}

export function removeCursorCdpArgv(): boolean {
  const path = cursorArgvPath();
  if (!existsSync(path))
    return false;
  const raw = readFileSync(path, 'utf-8');
  const { text, changed } = removeManagedRemoteDebuggingPort(raw);
  if (!changed)
    return false;
  writeFileSync(path, text, 'utf-8');
  return true;
}

export type EnsureCodeBuddyCdpArgvResult = EnsureCdpArgvResult | 'skipped';

/**
 * First installed product wins: Chinese build, then international.
 * Both layouts are listed so uninstall still strips what we wrote on either
 * platform; the current platform's layout comes first.
 *
 * `includeVscode` (default `true` for uninstall safety): append the argv.json
 * of the VSCode **CodeBuddy plugin host**. `ensureCodeBuddyCdpArgv` passes the
 * plugin gate result so we only ever *write* it on plugin machines;
 * `removeCodeBuddyCdpArgv` keeps the default so cleanup never leaves a managed
 * port behind on a machine whose plugin was removed later.
 */
export function codeBuddyArgvCandidates(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  opts: { includeVscode?: boolean } = {},
): string[] {
  const darwin = [
    join(home, 'Library', 'Application Support', 'CodeBuddy CN', 'argv.json'),
    join(home, 'Library', 'Application Support', 'CodeBuddy', 'argv.json'),
  ];
  const linux = [
    join(home, '.config', 'CodeBuddy CN', 'argv.json'),
    join(home, '.config', 'CodeBuddy', 'argv.json'),
  ];
  // Current platform first; other platforms are **still listed**: uninstall must be able to strip the copy we wrote on the other layout too.
  const win = winCodeBuddyArgvCandidates(env, home);
  if (platform === 'darwin')
    return withVscodeArgv([...darwin, ...win, ...linux], home, opts);
  if (platform === 'win32')
    return withVscodeArgv([...win, ...linux, ...darwin], home, opts);
  return withVscodeArgv([...linux, ...win, ...darwin], home, opts);
}

/**
 * ⚠️ VSCode reads argv.json from `~/.vscode/argv.json` on **all** platforms
 * (measured on macOS 2026-11-03; VSCode's own source joins `<home>/.vscode`) —
 * NOT userDataDir like Cursor / CodeBuddy. Inserted right after the current
 * platform's CodeBuddy entries (the first 2 in every branch above) so a
 * dual-install machine still writes CodeBuddy first.
 */
function withVscodeArgv(
  candidates: string[],
  home: string,
  opts: { includeVscode?: boolean },
): string[] {
  // Default **false**: every production caller passes the gate explicitly
  // (ensure/resolve = plugin gate, remove = true); a default-true here would
  // make this pure list machine-dependent and write ports into plain-VSCode
  // installs.
  if (opts.includeVscode !== true)
    return candidates;
  return [...candidates.slice(0, 2), join(home, '.vscode', 'argv.json'), ...candidates.slice(2)];
}

/**
 * Is this argv.json the **VSCode host's** (`~/.vscode/argv.json`, all platforms)?
 *
 * The distinction decides user-facing copy, not behavior: VSCode reads
 * `remote-debugging-port` from argv.json (its `out/main.js` applies it through
 * `app.commandLine.appendSwitch`), while Cursor and the CodeBuddy IDE ignore it
 * (measured). Saying "a manual reopen is pointless" to a VSCode user is backwards.
 */
export function isVscodeArgvPath(path: string): boolean {
  return /[\\/]\.vscode[\\/]argv\.json$/.test(path);
}

/**
 * **Every** argv.json this machine should manage — one per installed host, not
 * just the first.
 *
 * "First installed product wins" is right for the Chinese vs international
 * CodeBuddy builds (mutually exclusive installs), but **wrong for the VSCode
 * plugin host**: it is a second, simultaneously usable host, not another version.
 * Writing only the standalone IDE's file left `~/.vscode/argv.json` without a
 * port on every dual-install machine, so a VSCode the user started themselves
 * always came up without a debug port and got quit + reopened by the relauncher
 * (see `docs/ide-drivers.md`, the plugin gate).
 *
 * The existence criterion is the same one the single-path resolver used (the
 * file, or its product directory, exists), so "what we write" and "what we clean
 * up" see the same set.
 */
export function resolveCodeBuddyArgvPaths(
  exists: (p: string) => boolean = existsSync,
  home = homedir(),
  opts: { includeVscode?: boolean } = {},
): string[] {
  // Default = the plugin gate (`~/.vscode` exists on every machine where VSCode
  // ever ran, plugin or not — an ungated resolve would mark those machines as
  // "CodeBuddy installed" and write the port). Removal passes `true` explicitly
  // so cleanup never misses.
  const includeVscode = opts.includeVscode ?? vscodeCodeBuddyPluginInstalled({ home });
  const out: string[] = [];
  for (const path of codeBuddyArgvCandidates(home, process.platform, process.env, { includeVscode })) {
    // The candidate list mixes in paths from **other platforms** (uninstall must strip the other copy too), and the "product directory exists" layer
    // only holds for paths of this platform: a relative form from another platform — e.g. a Windows path from `win-paths` whose
    // `dirname` on POSIX — degenerates to `.`, and `.` always exists, so we falsely hit the current directory,
    // and `ensureCodeBuddyCdpArgv` writes CDP config into a file named `C:\...\argv.json`.
    const dir = dirname(path);
    const installed = exists(path) || (dir !== '.' && exists(dir));
    // `~/.vscode/argv.json` may not exist yet (VSCode creates it only when the
    // user configures runtime args) — its directory carrying settings.json is
    // enough, and `ensure` creates the file.
    if (installed && !out.includes(path))
      out.push(path);
  }
  return out;
}

/** Primary argv.json (first installed host). Kept for callers that only need one. */
export function resolveCodeBuddyArgvPath(
  exists: (p: string) => boolean = existsSync,
  home = homedir(),
  opts: { includeVscode?: boolean } = {},
): string | null {
  return resolveCodeBuddyArgvPaths(exists, home, opts)[0] ?? null;
}

export interface EnsureCodeBuddyCdpArgvOutcome {
  /** Strongest action taken: `created` > `added` > `already`; `skipped` = no host installed. */
  state: EnsureCodeBuddyCdpArgvResult;
  /** Every argv.json managed right now (one per installed host). */
  paths: string[];
  /** The subset actually written this run. */
  written: string[];
}

/**
 * Write the port into **every** installed host's argv.json.
 *
 * Writing more than one file is the point: a dual-install machine must not leave
 * the VSCode side without a port, or every self-started VSCode triggers the
 * quit-and-reopen self-heal. `setManagedRemoteDebuggingPort` inserts a marked
 * key without re-serializing JSON and leaves an unmarked user-owned
 * `remote-debugging-port` alone, so touching VSCode's own file is safe.
 *
 * The **value form differs per host**: VSCode's argv.json schema types this key as a
 * string (a number is dropped silently — measured 2026-11-09 on VS Code 1.144), while
 * Cursor / the CodeBuddy IDE keep the numeric form this CLI has always written. A
 * rewrite also repairs the form, so machines that already hold the broken numeric
 * value in `~/.vscode/argv.json` are fixed by the next `lifeline start`.
 */
export function ensureCodeBuddyCdpArgv(
  port = 0,
  opts: { includeVscode?: boolean; home?: string } = {},
): EnsureCodeBuddyCdpArgvOutcome {
  const paths = resolveCodeBuddyArgvPaths(existsSync, opts.home ?? homedir(), { includeVscode: opts.includeVscode });
  if (paths.length === 0)
    return { state: 'skipped', paths, written: [] };

  let state: EnsureCodeBuddyCdpArgvResult = 'already';
  const written: string[] = [];
  for (const path of paths) {
    // VSCode validates argv.json against its own schema: the port must be a **string**
    // there, or the key is dropped silently and the editor starts without a port.
    const form: CdpPortValueForm = isVscodeArgvPath(path) ? 'string' : 'number';
    if (!existsSync(path)) {
      const { text } = setManagedRemoteDebuggingPort('{\n}\n', port, form);
      writeFileSync(path, text, 'utf-8');
      written.push(path);
      state = 'created';
      continue;
    }
    const raw = readFileSync(path, 'utf-8');
    const { text, changed } = setManagedRemoteDebuggingPort(raw, port, form);
    if (!changed)
      continue;
    writeFileSync(path, text, 'utf-8');
    written.push(path);
    if (state !== 'created')
      state = 'added';
  }
  return { state, paths, written };
}

export function removeCodeBuddyCdpArgv(home = homedir()): boolean {
  let removed = false;
  // includeVscode: true — cleanup must cover every layout we may have written,
  // including a machine whose plugin (and with it the gate) was removed later.
  for (const path of codeBuddyArgvCandidates(home, process.platform, process.env, { includeVscode: true })) {
    if (!existsSync(path))
      continue;
    const raw = readFileSync(path, 'utf-8');
    // A previous version wrote AgentRemote CDP into the file; not recognizing it means we can never strip it, and the CDP port stays after uninstall.
    if (!raw.includes('Lifeline CDP') && !raw.includes('AgentRemote CDP'))
      continue;
    const { text, changed } = removeManagedRemoteDebuggingPort(raw);
    if (!changed)
      continue;
    writeFileSync(path, text, 'utf-8');
    removed = true;
  }
  return removed;
}
