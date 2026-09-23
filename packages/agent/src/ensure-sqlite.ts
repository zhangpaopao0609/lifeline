/**
 * Rebuild ~/.lifeline/better-sqlite3 with the Node that will load it.
 *
 * `npm` is `#!/usr/bin/env node`, so PATH's node (often 20) compiles the
 * addon even when the daemon plist bakes a different execPath (often 24).
 * Always invoke npm-cli.js via that execPath and put its bin dir first on PATH.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

export function isSqliteAbiMismatch(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /NODE_MODULE_VERSION/.test(msg) && /compiled against/i.test(msg);
}

/**
 * Find an npm entry that can be executed together with `node`.
 *
 * This looks for **Node's bundled npm** (the copy in the official distro),
 * which is a different matter from this repo using pnpm for dependencies:
 * `rebuild` uses node-gyp to rebuild a native addon in place, and npm is
 * handy for that; hunting pnpm's install location for this one job is not
 * worth it. Bundled runtime has no npm → return null, and that development
 * path naturally fails (see the resolveNpmCli call site below).
 *
 * Candidates **must be a JS file** (the only exception is the darwin entry):
 *  - Windows Node distros ship `npm` / `npm.cmd` / `npm.ps1`; the **extensionless
 *    `npm` is a shell script for Git Bash** (it exists, but handing it to node
 *    always fails);
 *  - `npm.cmd` / `npm.ps1` need a shell and cannot be spawned directly.
 *  So win32 **does not list** bare `npm`; only `node_modules\npm\bin\npm-cli.js`
 *  (Windows layout has no middle `lib`).
 *  macOS `<nodeDir>/npm` is a **symlink** to npm-cli.js, so `node <symlink>` is
 *  legal — keep it as the last candidate.
 */
export function resolveNpmCli(
  nodeBin: string,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const dir = dirname(nodeBin);
  const candidates = [
    // Windows layout: <nodeDir>\node_modules\npm\bin\npm-cli.js
    join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // macOS / Linux official layout: <nodeDir>/../lib/node_modules/npm/bin/npm-cli.js
    join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // macOS symlink. **Must be excluded on Windows** (that one is a shell script).
    ...(platform === 'win32' ? [] : [join(dir, 'npm')]),
  ];
  return candidates.find(exists) ?? null;
}

export interface SqliteRebuildDeps {
  existsSync: (path: string) => boolean;
  execFileSync: (
    file: string,
    args: readonly string[],
    options?: { env?: NodeJS.ProcessEnv; stdio?: 'pipe' | 'ignore' | 'inherit' },
  ) => Buffer | string;
  log: (msg: string) => void;
}

const defaultDeps: SqliteRebuildDeps = {
  existsSync,
  execFileSync: execFileSync as SqliteRebuildDeps['execFileSync'],
  log: msg => console.warn(msg),
};

export function rebuildBetterSqlite3(
  nodeBin: string,
  prefix: string,
  deps: Partial<SqliteRebuildDeps> = {},
): void {
  const { existsSync: exists, execFileSync: exec, log } = { ...defaultDeps, ...deps };
  const npmCli = resolveNpmCli(nodeBin, exists);
  if (!npmCli) {
    throw new Error(`Cannot find npm next to ${nodeBin}`);
  }
  log(`[sqlite] Rebuilding better-sqlite3 for ${nodeBin} in ${prefix}`);
  exec(nodeBin, [npmCli, '--prefix', prefix, 'rebuild', 'better-sqlite3'], {
    env: { ...process.env, PATH: `${dirname(nodeBin)}${delimiter}${process.env.PATH ?? ''}` },
    stdio: 'pipe',
  });
}
