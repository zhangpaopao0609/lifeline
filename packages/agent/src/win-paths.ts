/**
 * Sole source of truth for Windows paths. **Do not bring macOS / Linux paths
 * in here** — ternary checks in those files stay as they are; this module
 * only answers "where on Windows".
 *
 * Path construction is all pure (env / home injectable); `findIdeExe` is the
 * only one with IO (fs and registry both injected), because it answers "is
 * this exe actually there", not "where it should be".
 *
 * Windows path pitfalls we have actually hit:
 *  - Cursor's argv.json and DevToolsActivePort both live in **userDataDir**
 *    (`%APPDATA%\Cursor`);
 *  - CodeBuddy's userDataDir is `%APPDATA%\CodeBuddy[ CN]` (measured
 *    `--user-data-dir` is exactly this);
 *  - but CodeBuddy's **content root** is not userDataDir; it is
 *    `%LOCALAPPDATA%\CodeBuddyExtension\Data`.
 *
 * Executable candidates are **deliberately loose** (R1 lesson: inventory miss
 * is asymmetric — for relaunch, miss = never self-heal). `LOCALAPPDATA\Programs`
 * covers per-user installs (both IDEs measured here), `Program Files` covers
 * machine-wide; after the candidate table misses there are two registry
 * fallbacks (`findIdeExe`: `App Paths` → "Installed Programs" table), because
 * **installing on another drive** (`D:\Program Files\cursor`) is in no
 * candidate list, and Cursor's Inno installer does not register App Paths.
 *
 * ⚠️ Join paths **always with `win32.join`**, never the host `path.join`: this
 * module answers "where on Windows", independent of the host platform. Host
 * `join` on macOS / Linux produces mixed separators like `C:\a\Roaming/Cursor`
 * — coincidentally correct on Windows (the two are then equivalent), so only
 * cross-platform unit tests go red, easy to miss. `win32` is the **only** path
 * import here: anyone writing host `join` will fail to compile.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { win32 } from 'node:path';

export interface WinEnv {
  'APPDATA'?: string;
  'LOCALAPPDATA'?: string;
  'ProgramFiles'?: string;
  'ProgramFiles(x86)'?: string;
}

export function appDataDir(env: WinEnv = process.env, home: string = homedir()): string {
  return env.APPDATA || win32.join(home, 'AppData', 'Roaming');
}

export function localAppDataDir(env: WinEnv = process.env, home: string = homedir()): string {
  return env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local');
}

/**
 * `Program Files`. **Must read the env var**: the system drive is not always
 * C:, and localized Windows may rename it. Hardcoded only as last fallback.
 */
export function programFilesDir(env: WinEnv = process.env): string {
  return env.ProgramFiles || 'C:\\Program Files';
}

/** `Program Files (x86)`. **A dedicated function, not a boolean arg**: `true` in `programFilesDir(env, true)` is unreadable at the call site. */
export function programFilesDirX86(env: WinEnv = process.env): string {
  return env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
}

export function cursorUserDataDir(env: WinEnv = process.env, home: string = homedir()): string {
  return win32.join(appDataDir(env, home), 'Cursor');
}

/**
 * Cursor's session database. This module is the "sole Windows path source":
 * `DEFAULT_CURSOR_VSCDB` in `content-runtime.ts` and the Windows entry of
 * `cursorVscdbCandidates()` in `tab-identity.ts` both take it from here;
 * do not assemble another copy.
 */
export function cursorVscdbPath(env: WinEnv = process.env, home: string = homedir()): string {
  return win32.join(cursorUserDataDir(env, home), 'User', 'globalStorage', 'state.vscdb');
}

export function cursorArgvPath(env: WinEnv = process.env, home: string = homedir()): string {
  return win32.join(cursorUserDataDir(env, home), 'argv.json');
}

/**
 * Candidate **file paths** for `DevToolsActivePort` (**not the port**).
 *
 * The `File` in the name is deliberate: `cdp-endpoint.ts` has another
 * `cursorActivePortCandidates(home, platform)` with the same meaning but
 * different parameters; the same name would force import aliases at call
 * sites and is easy to misread. Returning an array (even with one entry)
 * matches CodeBuddy's multi-candidate shape so callers uniformly `.some()` /
 * `.find()`.
 */
export function cursorActivePortFileCandidates(env: WinEnv = process.env, home: string = homedir()): string[] {
  return [win32.join(cursorUserDataDir(env, home), 'DevToolsActivePort')];
}

/**
 * CodeBuddy has two product names (CN / international); **use whichever
 * userDataDir is installed**.
 *
 * CN first: machines in CN measured the CN build
 * (`--user-data-dir=%APPDATA%\CodeBuddy CN`), same order as macOS
 * `CODEBUDDY_APP_CANDIDATES`.
 * **Keep both names**: uninstall must clean the other copy too, and a
 * rename / edition switch will not miss.
 */
export const CODEBUDDY_PRODUCT_NAMES = ['CodeBuddy CN', 'CodeBuddy'] as const;

export function codeBuddyUserDataDirs(env: WinEnv = process.env, home: string = homedir()): string[] {
  return CODEBUDDY_PRODUCT_NAMES.map(n => win32.join(appDataDir(env, home), n));
}

export function codeBuddyArgvCandidates(env: WinEnv = process.env, home: string = homedir()): string[] {
  return codeBuddyUserDataDirs(env, home).map(d => win32.join(d, 'argv.json'));
}

/** Same as `cursorActivePortFileCandidates`: return **file-path** candidates, order = userDataDir order. */
export function codeBuddyActivePortFileCandidates(env: WinEnv = process.env, home: string = homedir()): string[] {
  return codeBuddyUserDataDirs(env, home).map(d => win32.join(d, 'DevToolsActivePort'));
}

/** Content root: measured as `Data\<uid>\CodeBuddyIDE\<workspaceId>\history\<bucket>\`. */
export function codeBuddyDataRoot(env: WinEnv = process.env, home: string = homedir()): string {
  return win32.join(localAppDataDir(env, home), 'CodeBuddyExtension', 'Data');
}

/**
 * Per-user install (measured) first, then machine-wide.
 *
 * The first two differ only in case: NTFS is case-insensitive so they are
 * equivalent on a real machine, but **different installers really use
 * different directory-name casing** (this machine measured lowercase
 * `cursor`), while the injected `exists` in unit tests is case-sensitive —
 * listing both is the cheapest fix.
 */
export function cursorExeCandidates(env: WinEnv = process.env, home: string = homedir()): string[] {
  return [
    win32.join(localAppDataDir(env, home), 'Programs', 'cursor', 'Cursor.exe'),
    win32.join(localAppDataDir(env, home), 'Programs', 'Cursor', 'Cursor.exe'),
    win32.join(programFilesDir(env), 'Cursor', 'Cursor.exe'),
    win32.join(programFilesDirX86(env), 'Cursor', 'Cursor.exe'),
  ];
}

/** Candidates are deliberately loose: the cost of an inventory miss is "never self-heal" (see the R1 note in `live-ides.ts`). */
export function codeBuddyExeCandidates(env: WinEnv = process.env, home: string = homedir()): string[] {
  const out: string[] = [];
  for (const n of CODEBUDDY_PRODUCT_NAMES) {
    out.push(win32.join(localAppDataDir(env, home), 'Programs', n, `${n}.exe`));
  }
  for (const n of CODEBUDDY_PRODUCT_NAMES) {
    out.push(win32.join(programFilesDir(env), n, `${n}.exe`));
  }
  for (const n of CODEBUDDY_PRODUCT_NAMES) {
    out.push(win32.join(programFilesDirX86(env), n, `${n}.exe`));
  }
  return out;
}

/** Image name in `tasklist /FI "IMAGENAME eq <name>"`. */
export const CURSOR_IMAGE_NAME = 'Cursor.exe';
export const CODEBUDDY_IMAGE_NAMES = ['CodeBuddy CN.exe', 'CodeBuddy.exe'];

/** Executable names that may be registered under `App Paths`. */
export const CURSOR_APP_PATHS_EXES = ['Cursor.exe'];
export const CODEBUDDY_APP_PATHS_EXES = ['CodeBuddy CN.exe', 'CodeBuddy.exe'];

/**
 * Take the **default value** from `reg query <key> /ve` output (used by `App Paths`).
 *
 * Real output looks like:
 * ```
 * HKEY_CLASSES_ROOT\.txt
 *     (Default)    REG_SZ    txtfilelegacy
 * ```
 *
 * ⚠️ **Match by value type, never by the label text**. Measured (Chinese Windows):
 * ```
 * windowsHide=false  ->  "    (Default)    REG_SZ    txtfilelegacy"
 * windowsHide=true   ->  "    (Ĭ��)    REG_SZ    txtfilelegacy"
 * ```
 * Under `windowsHide: true` (what production uses) reg.exe uses the **OEM/ANSI
 * code page**, and the default-value label is **localized** to `(默认)` (decoded
 * as UTF-8 it is garbage). Hard-coding `(Default)` would silently break the
 * whole App Paths fallback on Chinese machines — exactly the machines it is
 * meant to save.
 *
 * ⚠️ Same reason: **the value itself** is garbled on non-English paths
 * (`existsSync` fails → try the next). That is an inherent cost of reading
 * ANSI; known and acceptable (common install paths are ASCII; `%LOCALAPPDATA%`
 * for a Chinese username is covered by the candidate table, not the registry).
 *
 * `%VAR%` inside `REG_EXPAND_SZ` **must be expanded by us**: without that,
 * `existsSync('%ProgramFiles%\…')` is always false and those registrations
 * are silently skipped too.
 */
export function parseRegQueryDefaultValue(
  stdout: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    // Column 1 is the label ((Default) / `(默认)` / other languages); **do not match it**; only type and value.
    const m = /^\s+\S+\s+REG_(EXPAND_)?SZ\s+(.+?)\s*$/i.exec(line);
    if (!m)
      continue;
    const raw = m[2].replace(/^"|"$/g, '').trim();
    if (!raw)
      return undefined;
    // reg prints this localized line when "the key exists but the default is unset" (English form is this); not a path.
    if (/^\(value not set\)$/i.test(raw))
      return undefined;
    return m[1] ? expandEnvVars(raw, env) : raw;
  }
  return undefined;
}

/**
 * Expand `%NAME%`. Windows env names are case-insensitive: the registry often
 * writes lowercase `%programfiles%`, while `process.env` / an injected plain
 * object may only have `ProgramFiles`, so try all three spellings.
 */
function expandEnvVars(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace(/%([^%]+)%/g, (whole, name: string) => {
    if (env[name] !== undefined)
      return env[name]!;
    const upper = name.toUpperCase();
    if (env[upper] !== undefined)
      return env[upper]!;
    const key = Object.keys(env).find(k => k.toUpperCase() === upper);
    return key !== undefined ? (env[key] ?? whole) : whole;
  });
}

/**
 * `App Paths` keys, **HKCU first**.
 *
 * Per-user installers (`%LOCALAPPDATA%\Programs` — both IDEs measured this way
 * on this machine) often register App Paths in HKCU; **HKLM-only would miss
 * exactly the machines that need the fallback**.
 */
export function appPathsKeys(exeName: string): string[] {
  return [
    `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
    `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
  ];
}

/**
 * Parent keys of the "Installed Programs" table, **HKCU first**.
 *
 * This is the only remaining self-heal after the candidate table and
 * `App Paths` both miss: Inno / NSIS / Squirrel all write `InstallLocation` /
 * `DisplayIcon` here, and they **need not register App Paths** — Cursor's Inno
 * installer measured as unregistered (neither HKCU nor HKLM), so "installed to
 * a non-standard dir" (e.g. `D:\Program Files\cursor`) used to land in
 * `skipped-no-exe`: no error, no restart.
 *
 * `HKLM\...\WOW6432Node\...` is the 32-bit installer view: Node x64 reading
 * `HKLM\SOFTWARE` is not redirected, so list it explicitly.
 */
export function uninstallParentKeys(): string[] {
  return [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
}

/** A `reg query` value line: `    <name>    REG_SZ    <value>`. The name may contain spaces (`Inno Setup: App Path`). */
const REG_VALUE_LINE = /^\s+(.+?)\s+REG_(EXPAND_)?SZ\s+(.*?)\s*$/i;

/** Value names whose meaning is an **install directory** (not an exe path). */
const INSTALL_LOCATION_VALUE = 'installlocation';

/**
 * Clean a value: `DisplayIcon` often carries an icon index (`,0` / `,-100`) and wrapping quotes.
 * Order is "strip index first, then quotes" — the index sits outside the quotes (`"…\Cursor.exe",0`).
 */
function cleanRegPath(raw: string): string {
  return raw
    .replace(/,\s*-?\d+\s*$/, '')
    .replace(/^"|"$/g, '')
    .trim();
}

/**
 * Derive candidate exe paths from `reg query <Uninstall parent> /s /f <needle> /d` output.
 *
 * Measured: this command **prints only matching value lines** (non-matching
 * values under the same key are omitted), like:
 * ```
 * HKEY_CURRENT_USER\SOFTWARE\...\Uninstall\{DADADADA-…}}_is1
 *     InstallLocation    REG_SZ    C:\Users\me\AppData\Local\Programs\cursor\
 *     DisplayIcon    REG_SZ    C:\Users\me\AppData\Local\Programs\cursor\Cursor.exe
 *
 * End of search: 12 match(es) found.
 * ```
 * So we **do not track key names**: each value is self-contained (key-name
 * lines have no leading whitespace, so the regex naturally skips them).
 *
 * Accept rules (only "the value itself is an exe path" or known directory value names):
 *  - `InstallLocation` → join `<exe name>` (installer-written dir, usually trailing `\`);
 *  - value basename **equals** the target exe name → use it (`DisplayIcon` takes this path);
 *  - name contains `uninstall` and the value is an exe (`unins000.exe`) → take its
 *    directory then join (the uninstaller lives in the install dir).
 *
 * Drop everything else: `DisplayName` / `URLInfoAbout` / a `DisplayIcon` pointing
 * at `.ico` are not an exe. A real machine had a Chrome web-app registration
 * `DisplayName=Cursor` whose `DisplayIcon` pointed at `.ico`; treating that as
 * an exe would make self-heal spawn an icon file.
 */
export function uninstallExeCandidatesFromRegQuery(
  stdout: string,
  exeName: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const want = exeName.toLowerCase();
  const out: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = REG_VALUE_LINE.exec(line);
    if (!m)
      continue;
    const valueName = (m[1] ?? '').toLowerCase();
    const raw = m[2] ? expandEnvVars(m[3] ?? '', env) : (m[3] ?? '');
    const value = cleanRegPath(raw);
    if (!value)
      continue;
    if (valueName === INSTALL_LOCATION_VALUE) {
      out.push(win32.join(value, exeName));
      continue;
    }
    if (win32.basename(value).toLowerCase() === want) {
      out.push(value);
      continue;
    }
    if (valueName.includes('uninstall') && value.toLowerCase().endsWith('.exe')) {
      out.push(win32.join(win32.dirname(value), exeName));
    }
  }
  return [...new Set(out)];
}

export interface ExeLookupDeps {
  exists?: (p: string) => boolean;
  /** Registry-read injection point (default impl is `reg query`). Unit tests do not actually run it. */
  queryRegistry?: (key: string) => string | undefined;
  /**
   * Injection point for "Installed Programs" table search: output of
   * `reg query <parent> /s /f <needle> /d`.
   * Not the same command as `queryRegistry` (`/ve` default value only), so a
   * dedicated hook rather than reuse.
   */
  queryUninstall?: (parent: string, needle: string) => string | undefined;
  /** Used when expanding `%VAR%` inside `REG_EXPAND_SZ`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Find an IDE executable: candidate table → `App Paths` → "Installed Programs" table (`Uninstall`).
 *
 * Why the extra two steps: **the cost of an "inventory miss" is asymmetric**
 * (review R1) — a machine installed to a non-standard dir has no self-heal
 * after the candidate table misses, and both of these are **real paths the
 * installer itself registered**.
 *
 * ⚠️ `App Paths` alone is not enough (2026-09-21 live root cause): Cursor is
 * an Inno installer and **does not register App Paths** (HKCU / HKLM both
 * measured `unable to find`), so installing at `D:\Program Files\cursor`
 * broke all three fallbacks, `canRelaunch()` stayed false → `skipped-no-exe`:
 * no error, no restart, the user only sees "cannot connect".
 * On that same machine the `Uninstall` table's `InstallLocation` /
 * `DisplayIcon` were always correct — see `uninstallParentKeys`.
 *
 * If not found, return `undefined` and let the caller **report it** (do not
 * silently return, or the user only sees "cannot connect").
 */
export function findIdeExe(
  candidates: string[],
  appPathExes: string[],
  deps: ExeLookupDeps = {},
): string | undefined {
  const exists = deps.exists ?? existsSync;
  const direct = candidates.find(exists);
  if (direct)
    return direct;
  const env = deps.env ?? process.env;

  const query = deps.queryRegistry;
  if (query) {
    for (const exe of appPathExes) {
      for (const key of appPathsKeys(exe)) {
        const raw = query(key);
        const p = raw ? parseRegQueryDefaultValue(raw, env) : undefined;
        if (p && exists(p))
          return p;
      }
    }
  }

  const queryUninstall = deps.queryUninstall;
  if (queryUninstall) {
    for (const exe of appPathExes) {
      // needle = product name without `.exe`: directory-type registrations
      // (`InstallLocation` / `DisplayName`) store the product name; a needle
      // with `.exe` will not match them. reg data search is case-insensitive
      // (measured: `Cursor` hits `…\Programs\cursor\`).
      const needle = exe.replace(/\.exe$/i, '');
      for (const parent of uninstallParentKeys()) {
        const out = queryUninstall(parent, needle);
        if (!out)
          continue;
        const found = uninstallExeCandidatesFromRegQuery(out, exe, env).find(exists);
        if (found)
          return found;
      }
    }
  }
  return undefined;
}
