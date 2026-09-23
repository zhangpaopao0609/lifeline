import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

export const NODE_RUNTIME_VERSION = '22.19.0';
export const NODE_MODULE_ABI = 127;

export interface RuntimeTarget {
  os: string;
  arch: string;
}

export const RUNTIME_TARGETS: readonly RuntimeTarget[] = [
  { os: 'darwin', arch: 'arm64' },
  { os: 'darwin', arch: 'x64' },
  { os: 'linux', arch: 'x64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'win32', arch: 'x64' },
];

/** OS segment of the official Node dist: Windows is **`win`**, not `win32` (wrong name is a 404). */
export function nodeDistOs(os: string): string {
  return os === 'win32' ? 'win' : os;
}

/**
 * Archive extension by platform: official Node Windows ships only `.zip` / `.7z` (**no tar.xz**; measured 404).
 * Our runtime packages use the same rule — both sites must match, so this is the only copy.
 */
function packageExt(os: string): string {
  return os === 'win32' ? 'zip' : 'tar.xz';
}

export function nodeDistFileName(version: string, os: string, arch: string): string {
  return `node-v${version}-${nodeDistOs(os)}-${arch}.${packageExt(os)}`;
}

/** The **one** Node binary we want from the archive: at the root on Windows, under `bin/` on POSIX. */
export function nodeBinMember(version: string, os: string, arch: string): string {
  const root = `node-v${version}-${nodeDistOs(os)}-${arch}`;
  return os === 'win32' ? `${root}/node.exe` : `${root}/bin/node`;
}

export function nodeDistUrl(version: string, os: string, arch: string, base: string): string {
  return `${base.replace(/\/$/, '')}/v${version}/${nodeDistFileName(version, os, arch)}`;
}

/**
 * Unauthenticated asset name; served by the relay under the `/public/` prefix (whitelist in server/public-paths.ts).
 *
 * Windows ships `.zip`: at install time the machine's `tar.exe` (bundled on Win10 1803+) can read zip; older systems fall back to `Expand-Archive`.
 * **The package name must match the spelling in the install script** — a mismatch is a 404 on every platform; tests watch this.
 */
export function runtimePackageName(os: string, arch: string): string {
  return `lifeline-${os}-${arch}.${packageExt(os)}`;
}

/**
 * `PACK_TARGETS` filter (`PACK_TARGETS=win32-x64`).
 *
 * A full pack downloads Node + better-sqlite3 prebuilds for **5 platforms** over the network; local verification cannot realistically run that;
 * empty = all targets (normal behavior on the deploy machine).
 */
export function selectTargets(only: string, all: readonly RuntimeTarget[] = RUNTIME_TARGETS): RuntimeTarget[] {
  const wanted = only.split(',').map(s => s.trim()).filter(Boolean);
  if (wanted.length === 0)
    return [...all];
  const picked = all.filter(t => wanted.includes(`${t.os}-${t.arch}`));
  // **fail-fast**: "silently produce 0 artifacts + exit 0" in the deploy script is much worse than an error —
  // a typo like `PACK_TARGETS=win32_x64` would quietly pack nothing, and we'd only notice missing packages at ship time.
  if (picked.length === 0)
    throw new Error(`PACK_TARGETS matched no target: ${only}`);
  return picked;
}

export function sqlitePrebuildUrl(
  sqliteVersion: string,
  abi: number,
  os: string,
  arch: string,
): string {
  return `https://github.com/WiseLibs/better-sqlite3/releases/download/v${sqliteVersion}/better-sqlite3-v${sqliteVersion}-node-v${abi}-${os}-${arch}.tar.gz`;
}

export function writeSha256File(filePath: string): void {
  const hex = createHash('sha256').update(readFileSync(filePath)).digest('hex');
  writeFileSync(`${filePath}.sha256`, `${hex}  ${basename(filePath)}\n`);
}

export function stageRuntimeTree(
  dest: string,
  parts: {
    nodeBin: string;
    /** Filename of Node as it lands in runtime: POSIX `node`, Windows `node.exe`. Default `node` (existing callers need not change). */
    nodeFileName?: string;
    mjs: string;
    sqliteRoot: string;
    bindingsRoot: string;
    fileUriToPathRoot: string;
  },
): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const nodeName = parts.nodeFileName ?? 'node';
  copyFileSync(parts.nodeBin, join(dest, nodeName));
  chmodSync(join(dest, nodeName), 0o755);
  copyFileSync(parts.mjs, join(dest, 'lifeline.mjs'));
  mkdirSync(join(dest, 'node_modules'), { recursive: true });
  // Always pass dereference: pnpm's node_modules/<pkg> is a **symlink**, and the default copy copies
  // the link itself — into tar/zip that is a dangling link, and runtime will not start on the user's machine
  // (the better-sqlite3 case once wrote the .node back through into node_modules). npm installs real directories,
  // so this only bites under pnpm; it still has to be correct across package managers.
  cpSync(parts.sqliteRoot, join(dest, 'node_modules', 'better-sqlite3'), {
    recursive: true,
    dereference: true,
  });
  cpSync(parts.bindingsRoot, join(dest, 'node_modules', 'bindings'), {
    recursive: true,
    dereference: true,
  });
  cpSync(parts.fileUriToPathRoot, join(dest, 'node_modules', 'file-uri-to-path'), {
    recursive: true,
    dereference: true,
  });
}

export function writeRuntimeTarball(stageDir: string, outFile: string): void {
  // Canonicalize the Node filename (POSIX is `node`) — if someone calls this with a Windows stage, we still don't silently omit the binary
  const nodeName = existsSync(join(stageDir, 'node.exe')) ? 'node.exe' : 'node';
  execFileSync('tar', ['-C', stageDir, '-cJf', outFile, nodeName, 'lifeline.mjs', 'node_modules']);
}

/**
 * Pack as `.zip` (Windows runtime).
 *
 * Use adm-zip, not system `zip`: **the pack machine is Linux** (that's the deploy topology); don't gamble on `zip` being installed.
 * Entry names use forward slashes (zip spec) and **do not include the stage directory itself**, or unzip would add an extra directory layer.
 *
 * zip does not carry the executable bit — Windows does not need it (this does not affect POSIX `.tar.xz`, which stays as-is).
 */
export function writeRuntimeZip(stageDir: string, outFile: string): void {
  const zip = new AdmZip();
  const walk = (abs: string, prefix: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, e.name);
      const entry = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory())
        walk(childAbs, entry);
      else zip.addFile(entry, readFileSync(childAbs));
    }
  };
  walk(stageDir, '');
  zip.writeZip(outFile);
}

/**
 * From inside a package, find its own dependency by Node's resolution rules and return the package directory.
 *
 * **Do not change this to a hard-coded `<repo>/node_modules/<pkg>`**: `bindings` and `file-uri-to-path`
 * are not direct deps of this repo; they sit on better-sqlite3's chain (better-sqlite3 → bindings
 * → file-uri-to-path). pnpm's isolated layout puts them under
 * `node_modules/.pnpm/<pkg>@<ver>/node_modules/`; the repo root **does not** have them.
 *
 * This bug was masked by the host environment for a long time: a real `node_modules/bindings` at the repo root was leftover from the npm era
 * (pnpm does not touch directories it does not own), so local packing kept copying that stale copy and
 * "passed" all the way; only a clean Docker build blew up with `node_modules/bindings missing`.
 * That stale copy also masks a bindings upgrade — it would silently pack the old version.
 */
export function resolveDependencyDir(fromDir: string, spec: string): string {
  try {
    // realpath cannot be skipped: under pnpm, fromDir itself is a symlink (`node_modules/better-sqlite3`
    // → `.pnpm/better-sqlite3@x/node_modules/better-sqlite3`). Node resolves by walking **literal
    // paths** upward — without deref it walks all the way to the repo-root `node_modules`, which may still hold
    // an npm-era stale copy: **it finds something, but the wrong one**, which is stealthier than an error.
    // After deref, the walk hits the real dependency link under `.pnpm/<pkg>@x/node_modules/`.
    const anchor = join(realpathSync(fromDir), 'package.json');
    // Resolve package.json, not the entry file: the entry may sit in a subdirectory (dirname would give `dist` or similar)
    return dirname(createRequire(anchor).resolve(`${spec}/package.json`));
  }
  catch (err) {
    throw new Error(
      `cannot resolve "${spec}" from ${fromDir}: ${err instanceof Error ? err.message : String(err)}; `
      + `run pnpm install (it is a dependency of better-sqlite3, not of the repo root)`,
    );
  }
}

/**
 * Actual version of better-sqlite3 — the source of truth is the **installed package**, not any lock file.
 *
 * Used to read `packages['node_modules/better-sqlite3'].version` from `package-lock.json`:
 * after switching to pnpm that lock does not exist (it became `pnpm-lock.yaml`, keys like
 * `better-sqlite3@12.11.1`), so the function would throw. Reading the package manifest from node_modules is package-manager
 * agnostic, and **naturally aligned** — the directory staged below is this one; the prebuild overlay must be the same version.
 */
export function sqliteVersionFromInstalled(root: string): string {
  const manifest = join(root, 'node_modules', 'better-sqlite3', 'package.json');
  const pkg = JSON.parse(readFileSync(manifest, 'utf-8')) as { version?: string };
  if (!pkg.version)
    throw new Error(`version missing from ${manifest}`);
  return pkg.version;
}

export function download(url: string, dest: string): void {
  const part = `${dest}.part`;
  try {
    execFileSync('curl', ['-fL', '--retry', '3', '-o', part, url], { stdio: 'inherit' });
    renameSync(part, dest);
  }
  catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
}

/** Extract **that one** executable from the official Node archive (exported so unit tests can feed a synthetic zip). */
export function extractNodeBinary(
  archive: string,
  destDir: string,
  version: string,
  os: string,
  arch: string,
): string {
  mkdirSync(destDir, { recursive: true });
  const member = nodeBinMember(version, os, arch);
  if (os === 'win32') {
    // Windows is zip-only: use adm-zip to **extract that one member** (don't unpack the whole archive; saves time and disk)
    new AdmZip(archive).extractEntryTo(member, destDir, true, true);
  }
  else {
    execFileSync('tar', ['-xJf', archive, '-C', destDir, member]);
  }
  const inner = join(destDir, member);
  if (!existsSync(inner))
    throw new Error(`node binary missing in ${archive}`);
  return inner;
}

function overlaySqlitePrebuild(sqliteRoot: string, archive: string): void {
  const tmp = join(sqliteRoot, '.prebuild-tmp');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', tmp]);
  const addon = join(tmp, 'build', 'Release', 'better_sqlite3.node');
  if (!existsSync(addon)) {
    throw new Error(`better-sqlite3 prebuild missing .node in ${archive}`);
  }
  mkdirSync(join(sqliteRoot, 'build', 'Release'), { recursive: true });
  copyFileSync(addon, join(sqliteRoot, 'build', 'Release', 'better_sqlite3.node'));
  rmSync(tmp, { recursive: true, force: true });
}

export async function packAll(root = process.cwd()): Promise<void> {
  // Unauthenticated assets land in a public/ subdirectory of their own: the relay is mounted on /public as a whole, so the whitelist needs only one prefix.
  const dist = join(root, 'dist', 'client', 'public');
  const mjs = join(root, 'dist', 'cli', 'lifeline.mjs');
  if (!existsSync(mjs)) {
    throw new Error('dist/cli/lifeline.mjs missing; run pnpm build:cli first');
  }
  mkdirSync(dist, { recursive: true });
  const cache = join(root, 'temp', 'node-dist-cache');
  mkdirSync(cache, { recursive: true });
  const nodeBase = process.env.NODE_DIST_BASE ?? 'https://nodejs.org/dist';
  const sqliteVer = sqliteVersionFromInstalled(root);
  // better-sqlite3 is a direct dep of this repo, so it must exist under the root node_modules.
  const sqliteSrc = join(root, 'node_modules', 'better-sqlite3');
  if (!existsSync(sqliteSrc))
    throw new Error('node_modules/better-sqlite3 missing; run pnpm install');
  // The other two sit on its dependency chain (better-sqlite3 → bindings → file-uri-to-path);
  // find them from their host packages by resolution rules — see the comment on resolveDependencyDir; don't change this back to a hard-coded path.
  const bindingsSrc = resolveDependencyDir(sqliteSrc, 'bindings');
  const fileUriToPathSrc = resolveDependencyDir(bindingsSrc, 'file-uri-to-path');

  for (const { os, arch } of selectTargets(process.env.PACK_TARGETS ?? '')) {
    const nodeName = nodeDistFileName(NODE_RUNTIME_VERSION, os, arch);
    const nodeArchive = join(cache, nodeName);
    if (!existsSync(nodeArchive)) {
      download(nodeDistUrl(NODE_RUNTIME_VERSION, os, arch, nodeBase), nodeArchive);
    }
    const extractDir = join(cache, `extract-${os}-${arch}`);
    const nodeBin = extractNodeBinary(nodeArchive, extractDir, NODE_RUNTIME_VERSION, os, arch);

    const preName = `better-sqlite3-v${sqliteVer}-node-v${NODE_MODULE_ABI}-${os}-${arch}.tar.gz`;
    const preArchive = join(cache, preName);
    if (!existsSync(preArchive)) {
      download(sqlitePrebuildUrl(sqliteVer, NODE_MODULE_ABI, os, arch), preArchive);
    }
    const sqliteStage = join(cache, `sqlite-${os}-${arch}`);
    rmSync(sqliteStage, { recursive: true, force: true });
    // dereference cannot be skipped: pnpm's node_modules/better-sqlite3 is a symlink;
    // without deref, stage becomes a link pointing at node_modules, and the overlay below would
    // write another platform's .node through into node_modules (on darwin it gets written as a linux ELF,
    // then every sqlite test fails dlopen). npm installs a real directory, so this only bites under pnpm.
    cpSync(sqliteSrc, sqliteStage, { recursive: true, dereference: true });
    overlaySqlitePrebuild(sqliteStage, preArchive);

    const stage = join(cache, `stage-${os}-${arch}`);
    stageRuntimeTree(stage, {
      nodeBin,
      nodeFileName: os === 'win32' ? 'node.exe' : 'node',
      mjs,
      sqliteRoot: sqliteStage,
      bindingsRoot: bindingsSrc,
      fileUriToPathRoot: fileUriToPathSrc,
    });
    const out = join(dist, runtimePackageName(os, arch));
    if (os === 'win32')
      writeRuntimeZip(stage, out);
    else writeRuntimeTarball(stage, out);
    writeSha256File(out);
    console.log(`[pack-runtime] ${out}`);
  }
}

const isMain
  = typeof process.argv[1] === 'string'
    && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  packAll().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
