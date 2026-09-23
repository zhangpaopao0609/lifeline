import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
 */
export function codeBuddyArgvCandidates(
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
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
    return [...darwin, ...win, ...linux];
  if (platform === 'win32')
    return [...win, ...linux, ...darwin];
  return [...linux, ...win, ...darwin];
}

export function resolveCodeBuddyArgvPath(
  exists: (p: string) => boolean = existsSync,
  home = homedir(),
): string | null {
  for (const path of codeBuddyArgvCandidates(home)) {
    if (exists(path))
      return path;
    // The candidate list mixes in paths from **other platforms** (uninstall must strip the other copy too), and the "product directory exists" layer
    // only holds for paths of this platform: a relative form from another platform — e.g. a Windows path from `win-paths` whose
    // `dirname` on POSIX — degenerates to `.`, and `.` always exists, so we falsely hit the current directory,
    // and `ensureCodeBuddyCdpArgv` writes CDP config into a file named `C:\...\argv.json`.
    const dir = dirname(path);
    if (dir !== '.' && exists(dir))
      return path;
  }
  return null;
}

export function ensureCodeBuddyCdpArgv(port = 0): EnsureCodeBuddyCdpArgvResult {
  const path = resolveCodeBuddyArgvPath();
  if (!path)
    return 'skipped';
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

export function removeCodeBuddyCdpArgv(home = homedir()): boolean {
  let removed = false;
  for (const path of codeBuddyArgvCandidates(home)) {
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
