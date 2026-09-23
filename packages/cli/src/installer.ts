import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { rebuildBetterSqlite3, resolveNpmCli } from '../../agent/src/ensure-sqlite.js';
import { CONFIG_DIR } from './config.js';
import { PUBLIC_PREFIX } from './version.js';

/** `<home>/runtime` for install.sh installs; LIFELINE_HOME wins so custom homes keep working. */
export function runtimeHome(): string {
  return process.env.LIFELINE_HOME || CONFIG_DIR;
}

/** Name of the Node binary inside runtime: `node` on POSIX, `node.exe` on Windows. */
export function runtimeNodeName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'node.exe' : 'node';
}

/** Installer script name. Assets live under `/public/` (the unauthenticated whitelist is a prefix, so adding a platform doesn't require a server change). */
export function installerScriptName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'install.ps1' : 'install.sh';
}

/**
 * How the installer script is run: **both paths "feed the script to the interpreter's stdin"**.
 *
 * That's why the CLI has only this one platform branch — script contents never go on the command line (quotes, length, `%` expansion all become non-issues).
 * POSIX uses `sh -s`; Windows uses `powershell -Command -` (verified: it can read a multiline script from stdin,
 * whereas `-EncodedCommand` / `-File` would need extra plumbing).
 */
/**
 * Env handed to the installer script, with a platform-specific extra.
 *
 * On Windows we **must** prepend PowerShell 5.1's own module directory onto `PSModulePath`: in practice, node-spawned
 * `powershell.exe` inherits a `PSModulePath` that puts **PowerShell 7** module dirs ahead of 5.1,
 * so 5.1 loads the PS7 copies and even `Get-FileHash` fails to resolve — the installer then dies at the sha256 step
 * (`irm | iex` is unaffected because that's an interactive session's env).
 * **Prepend**, don't replace: the user's own module paths must stay.
 */
export function installerEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== 'win32')
    return env;
  const psModules = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'Modules',
  );
  return { ...env, PSModulePath: `${psModules};${env.PSModulePath ?? ''}` };
}

export interface InstallerInvocation {
  cmd: string;
  args: string[];
}

export function installerInvocation(platform: NodeJS.Platform = process.platform): InstallerInvocation {
  return platform === 'win32'
    ? { cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'] }
    : { cmd: 'sh', args: ['-s'] };
}

/**
 * Reuse the install script for the download/verify/swap instead of reimplementing it:
 * platform mapping, sha256 check and the runtime.next atomic swap live there and
 * must stay in one place. Env vars are passed through, so a custom
 * LIFELINE_BIN_DIR still lands in the same place.
 */
export async function runInstaller(base: string, env: NodeJS.ProcessEnv): Promise<void> {
  const scriptName = installerScriptName();
  const url = `${base}${PUBLIC_PREFIX}/${scriptName}`;
  let script: string;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok)
      throw new Error(`HTTP ${res.status}`);
    script = await res.text();
  }
  catch (err) {
    console.error(`Failed to download ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return process.exit(1);
  }

  const invocation = installerInvocation();
  const result = spawnSync(invocation.cmd, invocation.args, {
    input: script,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: installerEnv(env),
  });
  if (result.status !== 0) {
    console.error('Installer failed; the existing runtime was left in place.');
    process.exit(1);
  }
}

/** Runs the freshly installed bundle once — the only proof that the swap worked. */
export function installedVersion(nodeBin: string, mjs: string): string | null {
  try {
    // execFileSync rather than a command string: Windows gets one less layer of
    // shell quoting (and the path may contain spaces either way).
    const out = execFileSync(nodeBin, [mjs, '--version'], { encoding: 'utf-8' }).trim();
    return out || null;
  }
  catch {
    return null;
  }
}

/**
 * The bundled runtime ships better-sqlite3 prebuilt for its own Node, and has
 * no npm to rebuild with — silently nothing to do. Only a real rebuild failure
 * (system Node whose ABI moved) is worth a line.
 */
export function rebuildSqliteFor(nodeBin: string): string | undefined {
  if (!resolveNpmCli(nodeBin))
    return undefined;
  try {
    // The progress line would cut the setup report in half; the outcome is
    // reported as a note instead.
    rebuildBetterSqlite3(nodeBin, CONFIG_DIR, { log: () => {} });
    return undefined;
  }
  catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
