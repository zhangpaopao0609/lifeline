/**
 * Copy static scripts from `packages/web/public/` into `dist/client/public/`, and wipe the previous
 * `assets/` and `index.html` (vite regenerates them).
 *
 * Why not a one-liner shell: the old `mkdir -p … && cp a b c dest/ && rm -rf …` is **POSIX syntax**,
 * and on Windows `pnpm run build:web` fails with `The syntax of the command is incorrect.` —
 * i.e. a Windows dev machine **cannot build the web package at all**. node:fs is isomorphic across three platforms and reports a missing file clearly.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'packages', 'web', 'public');
const OUT_DIR = join(ROOT, 'dist', 'client', 'public');

/** Unauthenticated assets (whitelist in `server/public-paths.ts`). Change this list when adding/removing scripts. */
const FILES = ['install.sh', 'uninstall.sh', 'install.ps1', 'uninstall.ps1'];

mkdirSync(OUT_DIR, { recursive: true });
for (const file of FILES) {
  const src = join(PUBLIC_DIR, file);
  if (!existsSync(src))
    throw new Error(`[copy-web-public] missing ${src}`);
  cpSync(src, join(OUT_DIR, file));
}

for (const stale of [join(ROOT, 'dist', 'client', 'assets'), join(ROOT, 'dist', 'client', 'index.html')]) {
  rmSync(stale, { recursive: true, force: true });
}

console.log(`[copy-web-public] ${FILES.length} files -> dist/client/public`);
