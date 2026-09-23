import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Bundles the Lifeline CLI (agent included) into a single self-contained
 * Node script at dist/cli/lifeline.mjs. Install globally with:
 *
 *   pnpm run build:cli && pnpm add -g .
 *
 * One `lifeline` command, config in ~/.lifeline/.
 *
 * Also publishes dist/client/public/cli-latest.txt — the release manifest
 * installed CLIs fetch to spot a new version (`lifeline status` / `update`).
 */
import * as esbuild from 'esbuild';

const outfile = 'dist/cli/lifeline.mjs';
/** Served under /public next to the runtime tarballs; see server/public-paths.ts. */
const latestFile = 'dist/client/public/cli-latest.txt';

/** The one source of the CLI version: package.json (bump it there). */
export function cliVersion(root = process.cwd()): string {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8')) as {
    version?: string;
  };
  if (!pkg.version)
    throw new Error('version missing from package.json');
  return pkg.version;
}

export function writeLatestVersionFile(version: string, path = latestFile): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${version}\n`, 'utf-8');
}

export async function buildCli(): Promise<void> {
  const version = cliVersion();

  await esbuild.build({
    entryPoints: ['packages/cli/src/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    // Match pack-runtime's NODE_RUNTIME_VERSION (22.19.0) and the repo .node-version:
    // better-sqlite3 is a native module; only Node 22 has an arm64 prebuild (20 does not).
    target: 'node22',
    outfile,
    // Baked in so the bundle needs no package.json at runtime (the runtime tar
    // ships node + lifeline.mjs + node_modules only). Single source of the
    // version stays package.json — never hand-write the number into src/cli.
    // LIFELINE_DEFAULT_SERVER_URL: bake the default origin in too (export it at build time to bake it;
    // unset → empty string → CLI falls through to "run setup first" instead of guessing an origin).
    define: {
      __CLI_VERSION__: JSON.stringify(version),
      __CLI_DEFAULT_SERVER_URL__: JSON.stringify(process.env.LIFELINE_DEFAULT_SERVER_URL ?? ''),
    },
    // The createRequire shim gives bundled CJS code (dotenv etc.) a working
    // `require` inside the ESM output - without it they throw
    // "Dynamic require of fs is not supported" at runtime.
    banner: {
      js: '#!/usr/bin/env node\nimport { createRequire } from "module";\nconst require = createRequire(import.meta.url);',
    },
    // Optional native accelerators for ws; the pure-JS fallbacks are used when absent.
    // better-sqlite3 is a native addon — must stay external so the CLI loads it from node_modules.
    external: ['bufferutil', 'utf-8-validate', 'better-sqlite3'],
    logLevel: 'info',
  });

  mkdirSync('dist/cli', { recursive: true });
  chmodSync(outfile, 0o755);
  writeLatestVersionFile(version);
  console.log(`[build:cli] ${outfile} (executable, v${version})`);
  console.log(`[build:cli] ${latestFile}`);
}

const isMain
  = typeof process.argv[1] === 'string' && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  buildCli().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
