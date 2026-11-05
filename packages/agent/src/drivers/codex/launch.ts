import { accessSync, constants, statSync } from 'node:fs';
// Aliased: the CLI bundle banner already declares a top-level `createRequire` (see load-sqlite.ts).
import { createRequire as nodeCreateRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Hidden `lifeline` subcommand that runs the Codex ACP bridge on stdio.
 * Must not be `run` / `start`: those tokens mark a command line as a running agent
 * (`commandLineIsRunningAgent`), and the bridge is a child of the agent, not another agent.
 */
export const CODEX_BRIDGE_SUBCOMMAND = 'codex-acp-bridge';

/** Env var naming the Codex CLI binary for the bridge (absolute path, set from `codexCliPath`). */
export const CODEX_CLI_ENV = 'LIFELINE_CODEX_CLI';

export interface CodexBridgeLaunch {
  command: string;
  args: string[];
}

/** Loader flags a dev run (tsx) needs in the bridge child as well. */
const LOADER_FLAGS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader']);

/**
 * The bridge runs in the session directory, where a bare loader name (`--import tsx`) does not
 * resolve; pin it to the file this process resolved it to.
 */
function pinSpecifier(flag: string, value: string): string {
  if (/^(?:\.{0,2}\/|file:|data:|node:)/.test(value))
    return value;
  try {
    return flag === '--import' || flag.endsWith('loader')
      ? import.meta.resolve(value)
      : nodeCreateRequire(import.meta.url).resolve(value);
  }
  catch {
    return value;
  }
}

function loaderExecArgv(execArgv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i]!;
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (!LOADER_FLAGS.has(flag))
      continue;
    if (eq > 0) {
      out.push(`${flag}=${pinSpecifier(flag, arg.slice(eq + 1))}`);
    }
    else if (i + 1 < execArgv.length) {
      out.push(flag, pinSpecifier(flag, execArgv[++i]!));
    }
  }
  return out;
}

/**
 * How to start the bridge: the running Node with this program's own entry.
 * In the bundled runtime every module shares `import.meta.url` (= `lifeline.mjs`), so the bridge is
 * `node lifeline.mjs codex-acp-bridge`. From source (tsx) it is this directory's `main.ts` with the
 * same loader flags. Either way nothing outside the runtime tarball is needed.
 */
export function codexBridgeLaunch(
  moduleUrl: string = import.meta.url,
  execPath: string = process.execPath,
  execArgv: readonly string[] = process.execArgv,
): CodexBridgeLaunch {
  const here = fileURLToPath(moduleUrl);
  if (/\.[cm]?ts$/.test(here))
    return { command: execPath, args: [...loaderExecArgv(execArgv), join(dirname(here), 'main.ts')] };
  return { command: execPath, args: [here, CODEX_BRIDGE_SUBCOMMAND] };
}

/** The bridge spawns this file itself, so "binary missing" has to be decided before the bridge starts. */
export function isExecutableFile(path: string | undefined): path is string {
  if (typeof path !== 'string' || !isAbsolute(path))
    return false;
  try {
    if (!statSync(path).isFile())
      return false;
    accessSync(path, constants.X_OK);
    return true;
  }
  catch {
    return false;
  }
}
