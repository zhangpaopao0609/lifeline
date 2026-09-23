import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';
import {
  download,
  extractNodeBinary,
  NODE_MODULE_ABI,
  NODE_RUNTIME_VERSION,
  nodeBinMember,
  nodeDistFileName,
  nodeDistOs,
  nodeDistUrl,
  resolveDependencyDir,
  RUNTIME_TARGETS,
  runtimePackageName,
  selectTargets,
  sqlitePrebuildUrl,
  sqliteVersionFromInstalled,
  stageRuntimeTree,
  writeRuntimeTarball,
  writeRuntimeZip,
  writeSha256File,
} from '../scripts/pack-runtime.ts';
// Windows has no shasum/tar; use Git's copies (see tests/posix-tools.ts)
import { POSIX_SHA256, posixEnv, sha256CheckArgs, toPosixPath } from './posix-tools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('pack-runtime helpers', () => {
  it('names official node dist and github sqlite prebuild', () => {
    assert.equal(NODE_RUNTIME_VERSION, '22.19.0');
    assert.equal(nodeDistFileName('22.19.0', 'darwin', 'arm64'), 'node-v22.19.0-darwin-arm64.tar.xz');
    assert.equal(nodeDistFileName('22.19.0', 'darwin', 'x64'), 'node-v22.19.0-darwin-x64.tar.xz');
    assert.equal(
      nodeDistUrl('22.19.0', 'darwin', 'arm64', 'https://nodejs.org/dist'),
      'https://nodejs.org/dist/v22.19.0/node-v22.19.0-darwin-arm64.tar.xz',
    );
    assert.equal(runtimePackageName('darwin', 'arm64'), 'lifeline-darwin-arm64.tar.xz');
    assert.equal(
      sqlitePrebuildUrl('12.11.1', 127, 'darwin', 'arm64'),
      'https://github.com/WiseLibs/better-sqlite3/releases/download/v12.11.1/better-sqlite3-v12.11.1-node-v127-darwin-arm64.tar.gz',
    );
  });

  it('stages tree, tars xz, and writes shasum -c compatible sidecar', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pack-runtime-'));
    try {
      const parts = join(tmp, 'parts');
      mkdirSync(parts, { recursive: true });
      writeFileSync(join(parts, 'node'), 'NODEBIN');
      chmodSync(join(parts, 'node'), 0o755);
      writeFileSync(join(parts, 'cli.mjs'), 'MJS');
      mkdirSync(join(parts, 'sqlite', 'lib'), { recursive: true });
      writeFileSync(join(parts, 'sqlite', 'package.json'), '{"name":"better-sqlite3"}\n');
      writeFileSync(join(parts, 'sqlite', 'lib', 'index.js'), 'module.exports = 1\n');
      mkdirSync(join(parts, 'bindings'), { recursive: true });
      writeFileSync(join(parts, 'bindings', 'package.json'), '{"name":"bindings"}\n');
      mkdirSync(join(parts, 'file-uri-to-path'), { recursive: true });
      writeFileSync(join(parts, 'file-uri-to-path', 'package.json'), '{"name":"file-uri-to-path"}\n');
      const stage = join(tmp, 'stage');
      stageRuntimeTree(stage, {
        nodeBin: join(parts, 'node'),
        mjs: join(parts, 'cli.mjs'),
        sqliteRoot: join(parts, 'sqlite'),
        bindingsRoot: join(parts, 'bindings'),
        fileUriToPathRoot: join(parts, 'file-uri-to-path'),
      });
      assert.equal(readFileSync(join(stage, 'node'), 'utf-8'), 'NODEBIN');
      assert.equal(readFileSync(join(stage, 'lifeline.mjs'), 'utf-8'), 'MJS');
      assert.equal(
        readFileSync(join(stage, 'node_modules', 'better-sqlite3', 'package.json'), 'utf-8'),
        '{"name":"better-sqlite3"}\n',
      );
      assert.equal(
        readFileSync(join(stage, 'node_modules', 'bindings', 'package.json'), 'utf-8'),
        '{"name":"bindings"}\n',
      );
      assert.equal(
        readFileSync(join(stage, 'node_modules', 'file-uri-to-path', 'package.json'), 'utf-8'),
        '{"name":"file-uri-to-path"}\n',
      );
      assert.equal(existsSync(join(stage, 'node_modules', 'prebuild-install')), false);
      const out = join(tmp, 'lifeline-darwin-arm64.tar.xz');
      writeRuntimeTarball(stage, out);
      writeSha256File(out);
      const listing = execFileSync('tar', ['-tJf', out], { encoding: 'utf-8' });
      assert.match(listing, /^node$/m);
      assert.match(listing, /^lifeline\.mjs$/m);
      assert.match(listing, /node_modules\/bindings/);
      assert.match(listing, /node_modules\/file-uri-to-path/);
      assert.doesNotMatch(listing, /prebuild-install/);
      assert.doesNotMatch(listing, /lifeline-darwin-arm64\//);
      const sha = readFileSync(`${out}.sha256`, 'utf-8');
      assert.match(sha, /^[a-f0-9]{64} {2}lifeline-darwin-arm64\.tar\.xz\n$/);
      // Windows has no `shasum`; use Git's `sha256sum` (different flags, see sha256CheckArgs);
      // convert paths to POSIX form and put `mingw64\bin` on PATH (see tests/posix-tools.ts).
      execFileSync(POSIX_SHA256, sha256CheckArgs(toPosixPath(`${out}.sha256`)), { cwd: tmp, env: posixEnv() });
    }
    finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('packAll copies hoisted sqlite deps from node_modules and fails if missing', () => {
    const src = readFileSync(join(ROOT, 'scripts/pack-runtime.ts'), 'utf-8');
    // Output must land in the unauthenticated dir: relay mounts /public onto dist/client/public.
    assert.match(src, /join\(root, 'dist', 'client', 'public'\)/);
    // bindings / file-uri-to-path are **not** direct deps of this repo; they sit on the
    // better-sqlite3 chain: resolve them from the host package, do not hard-join
    // `<root>/node_modules/<pkg>` (under pnpm isolation the root does not have them;
    // if the root still has an npm-era leftover, a hard join "passes" while copying the
    // old version — this only blew up in a clean Docker build on 2026-09-21).
    assert.match(src, /resolveDependencyDir\(sqliteSrc, 'bindings'\)/);
    assert.match(src, /resolveDependencyDir\(bindingsSrc, 'file-uri-to-path'\)/);
    assert.doesNotMatch(src, /join\(root, 'node_modules', 'bindings'\)/);
    assert.doesNotMatch(src, /join\(root, 'node_modules', 'file-uri-to-path'\)/);
    assert.doesNotMatch(src, /prebuild-install/);
  });

  // This case was added later: the source-string assertions above were all green and never
  // noticed the implementation was wrong. Build a real "pnpm isolated layout" on disk
  // (deliberately no bindings at root) and check the resolve result.
  it('resolveDependencyDir follows the nested pnpm layout, not root hoisting', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pack-resolve-'));
    try {
      const nm = join(tmp, 'node_modules');
      const store = join(nm, '.pnpm');
      /** Real body lives at .pnpm/<pkg>@<ver>/node_modules/<pkg> */
      const realPkg = (pkg: string, ver: string): { dir: string; host: string } => {
        const dir = join(store, `${pkg}@${ver}`, 'node_modules', pkg);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), `{"name":"${pkg}","version":"${ver}"}\n`);
        return { dir, host: join(store, `${pkg}@${ver}`, 'node_modules') };
      };
      /** pnpm puts a directory link for the dep in the host node_modules — without it this is not a pnpm layout */
      const link = (target: string, at: string): boolean => {
        try {
          symlinkSync(target, at, 'dir');
          return true;
        }
        catch {
          return false;
        }
      };

      const sqlite = realPkg('better-sqlite3', '12.11.1');
      const bindings = realPkg('bindings', '1.5.0');
      const futp = realPkg('file-uri-to-path', '1.0.0');
      const linked
        = link(bindings.dir, join(sqlite.host, 'bindings'))
          && link(futp.dir, join(bindings.host, 'file-uri-to-path'))
        // Root node_modules only has direct deps (pointing at .pnpm) — exactly the Docker condition
          && link(sqlite.dir, join(nm, 'better-sqlite3'));
      if (!linked) {
        // Directory links on Windows need Developer Mode / admin; skip if we cannot create them.
        // (The same function is still tested against the real node_modules, so coverage is not all lost.)
        assert.equal(process.platform, 'win32', `symlink failed on ${process.platform}`);
        return;
      }

      // Start from the **root link** (that is how callers pass it) and walk to the real body in .pnpm.
      // Expected values need realpath: macOS tmpdir is `/var/...`, realpath yields
      // `/private/var/...` (two names for the same directory).
      assert.equal(resolveDependencyDir(join(nm, 'better-sqlite3'), 'bindings'), realpathSync(bindings.dir));
      assert.equal(resolveDependencyDir(bindings.dir, 'file-uri-to-path'), realpathSync(futp.dir));
      // Key condition: root has **no** bindings (a leftover local npm copy used to hide this)
      assert.equal(existsSync(join(nm, 'bindings')), false);

      // On miss, say "this is a better-sqlite3 dep + run pnpm install"; do not leak only Node's raw error
      assert.throws(
        () => resolveDependencyDir(join(nm, 'better-sqlite3'), 'not-installed'),
        /cannot resolve "not-installed".*better-sqlite3.*pnpm install/s,
      );
    }
    finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Re-check against this repo's real node_modules (that is the path Docker runs)
  it('resolves the real installed better-sqlite3 dependency chain', () => {
    const sqlite = join(ROOT, 'node_modules', 'better-sqlite3');
    const bindings = resolveDependencyDir(sqlite, 'bindings');
    assert.equal(
      (JSON.parse(readFileSync(join(bindings, 'package.json'), 'utf-8')) as { name: string }).name,
      'bindings',
    );
    const futp = resolveDependencyDir(bindings, 'file-uri-to-path');
    assert.equal(
      (JSON.parse(readFileSync(join(futp, 'package.json'), 'utf-8')) as { name: string }).name,
      'file-uri-to-path',
    );
    // Key: it must come from the pnpm store, **not** an npm-era leftover in root node_modules.
    // This assertion failed before realpath was added — what it "found" then was that old
    // copy, which made local packing look fine (only a clean container exposed it).
    assert.notEqual(bindings, join(ROOT, 'node_modules', 'bindings'));
    assert.notEqual(futp, join(ROOT, 'node_modules', 'file-uri-to-path'));
  });

  // After switching to pnpm, node_modules/<pkg> is a symlink; what is copied into stage must be a
  // **real directory**, or the tarball is a pile of dangling links and runtime will not start on the user machine.
  it('copies symlinked pnpm packages as real files, not as links', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pack-symlink-'));
    try {
      const parts = join(tmp, 'parts');
      const store = join(tmp, 'store');
      mkdirSync(parts, { recursive: true });
      // Fake a .pnpm store: the real body is here; the top-level name is only a link to it
      for (const pkg of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
        mkdirSync(join(store, pkg, 'build', 'Release'), { recursive: true });
        writeFileSync(join(store, pkg, 'package.json'), `{"name":"${pkg}"}\n`);
      }
      writeFileSync(join(store, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'), 'ADDON');

      const linked: string[] = [];
      for (const pkg of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
        const link = join(parts, pkg);
        try {
          symlinkSync(join(store, pkg), link, 'dir');
        }
        catch {
          // Directory links on Windows need Developer Mode / admin; skip if we cannot create them —
          // the migration criterion is already held by the "all three cpSync use dereference" source assertion.
          assert.equal(process.platform, 'win32', `symlink failed on ${process.platform}`);
          return;
        }
        linked.push(link);
      }
      assert.equal(linked.length, 3);

      writeFileSync(join(parts, 'node'), 'NODEBIN');
      chmodSync(join(parts, 'node'), 0o755);
      writeFileSync(join(parts, 'cli.mjs'), 'MJS');

      const stage = join(tmp, 'stage');
      stageRuntimeTree(stage, {
        nodeBin: join(parts, 'node'),
        mjs: join(parts, 'cli.mjs'),
        sqliteRoot: join(parts, 'better-sqlite3'),
        bindingsRoot: join(parts, 'bindings'),
        fileUriToPathRoot: join(parts, 'file-uri-to-path'),
      });

      for (const pkg of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
        const staged = join(stage, 'node_modules', pkg);
        assert.equal(existsSync(join(staged, 'package.json')), true, `${pkg} 要真的落进 stage`);
        assert.equal(lstatSync(staged).isSymbolicLink(), false, `${pkg} 在 stage 里不能还是链接`);
      }
      // Nested files under the link must be present too (this also fails if the link was copied as a link)
      assert.equal(
        existsSync(join(stage, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')),
        true,
      );
    }
    finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Version source of truth moved from package-lock.json (npm-only, absent under pnpm) to the installed package itself
  it('sqliteVersionFromInstalled matches the actual installed better-sqlite3', () => {
    const installed = JSON.parse(
      readFileSync(join(ROOT, 'node_modules', 'better-sqlite3', 'package.json'), 'utf-8'),
    ) as { version: string };
    assert.equal(sqliteVersionFromInstalled(ROOT), installed.version);
    // The prebuild URL is built from **this version + ABI**: drift fetches a GitHub release that does not exist (404)
    assert.match(
      sqlitePrebuildUrl(installed.version, NODE_MODULE_ABI, 'darwin', 'arm64'),
      new RegExp(`/v${installed.version.replace(/\./g, '\\.')}/better-sqlite3-v${installed.version.replace(/\./g, '\\.')}-node-v${NODE_MODULE_ABI}-`),
    );
  });

  it('sqliteVersionFromInstalled reads the installed package, not a lockfile', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pack-sqlitever-'));
    try {
      const pkgDir = join(tmp, 'node_modules', 'better-sqlite3');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), '{"name":"better-sqlite3","version":"12.34.56"}\n');
      assert.equal(sqliteVersionFromInstalled(tmp), '12.34.56');

      // Not installed at all → the error must name which manifest, not a generic "missing"
      rmSync(pkgDir, { recursive: true, force: true });
      assert.throws(() => sqliteVersionFromInstalled(tmp), /better-sqlite3\/package\.json/);

      // Manifest exists but no version → must not return undefined and build a prebuild URL that does not exist
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), '{"name":"better-sqlite3"}\n');
      assert.throws(() => sqliteVersionFromInstalled(tmp), /version missing/);
    }
    finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('download commits via .part and does not leave dest after a failed curl', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pack-download-'));
    try {
      const src = join(tmp, 'payload.txt');
      writeFileSync(src, 'hello-runtime\n');
      const dest = join(tmp, 'out.bin');
      download(pathToFileURL(src).href, dest);
      assert.equal(readFileSync(dest, 'utf-8'), 'hello-runtime\n');
      assert.equal(existsSync(`${dest}.part`), false);

      const missingDest = join(tmp, 'missing.bin');
      assert.throws(() => download(pathToFileURL(join(tmp, 'nope.txt')).href, missingDest));
      assert.equal(existsSync(missingDest), false);
      assert.equal(existsSync(`${missingDest}.part`), false);

      const keep = join(tmp, 'keep.bin');
      writeFileSync(keep, 'original\n');
      assert.throws(() => download(pathToFileURL(join(tmp, 'nope.txt')).href, keep));
      assert.equal(readFileSync(keep, 'utf-8'), 'original\n');
      assert.equal(existsSync(`${keep}.part`), false);
    }
    finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// Official Windows Node artifacts are only .zip / .7z (**no tar.xz**), so the packer must read zip;
// our runtime also ships .zip, unpacked with the machine's tar.exe (Win10 1803+) / Expand-Archive fallback.
describe('win32 packaging', () => {
  it('maps win32 to the `win` dist os and a .zip node archive', () => {
    assert.equal(nodeDistOs('win32'), 'win');
    assert.equal(nodeDistOs('darwin'), 'darwin');
    assert.equal(nodeDistOs('linux'), 'linux');
    assert.equal(nodeDistFileName('22.19.0', 'win32', 'x64'), 'node-v22.19.0-win-x64.zip');
    assert.equal(
      nodeDistUrl('22.19.0', 'win32', 'x64', 'https://nodejs.org/dist'),
      'https://nodejs.org/dist/v22.19.0/node-v22.19.0-win-x64.zip',
    );
  });

  it('takes node.exe from the archive root (POSIX keeps bin/node)', () => {
    assert.equal(nodeBinMember('22.19.0', 'win32', 'x64'), 'node-v22.19.0-win-x64/node.exe');
    assert.equal(nodeBinMember('22.19.0', 'darwin', 'arm64'), 'node-v22.19.0-darwin-arm64/bin/node');
    assert.equal(nodeBinMember('22.19.0', 'linux', 'x64'), 'node-v22.19.0-linux-x64/bin/node');
  });

  it('names the Windows runtime package .zip and keeps the others .tar.xz', () => {
    assert.equal(runtimePackageName('win32', 'x64'), 'lifeline-win32-x64.zip');
    assert.equal(runtimePackageName('darwin', 'arm64'), 'lifeline-darwin-arm64.tar.xz');
    assert.equal(runtimePackageName('linux', 'arm64'), 'lifeline-linux-arm64.tar.xz');
  });

  it('includes win32-x64 in the target list', () => {
    assert.ok(RUNTIME_TARGETS.some(t => t.os === 'win32' && t.arch === 'x64'));
    assert.equal(RUNTIME_TARGETS.length, 5);
  });

  // PACK_TARGETS only runs named targets: a full pack downloads 5 platforms of Node + sqlite prebuilds; local verify cannot run that
  it('PACK_TARGETS narrows the target list, blank keeps all, unknown yields none', () => {
    const ids = (s: string) => selectTargets(s).map(t => `${t.os}-${t.arch}`);
    assert.deepEqual(ids('win32-x64'), ['win32-x64']);
    assert.deepEqual(ids('darwin-arm64, linux-x64'), ['darwin-arm64', 'linux-x64']);
    assert.equal(ids('').length, RUNTIME_TARGETS.length);
    assert.equal(ids('   ').length, RUNTIME_TARGETS.length);
    // A misspelling must throw, not silently produce 0 (in deploy that is "we shipped fewer packages")
    assert.throws(() => ids('nope'), /matched no target/);
    assert.throws(() => ids('win32_x64'), /matched no target/);
  });

  // win32 is the only new "read an external zip" logic: extract only node.exe, land no other members
  it('extracts only node.exe from the node archive (and throws when it is absent)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pack-extract-'));
    try {
      const zip = new AdmZip();
      zip.addFile('node-v22.19.0-win-x64/node.exe', Buffer.from('NODEBIN'));
      zip.addFile('node-v22.19.0-win-x64/npm', Buffer.from('NPM'));
      zip.addFile('node-v22.19.0-win-x64/node_modules/npm/package.json', Buffer.from('{}'));
      const archive = join(tmp, 'node.zip');
      zip.writeZip(archive);

      const out = join(tmp, 'out');
      const bin = extractNodeBinary(archive, out, '22.19.0', 'win32', 'x64');
      assert.equal(bin, join(out, 'node-v22.19.0-win-x64', 'node.exe'));
      assert.equal(readFileSync(bin, 'utf-8'), 'NODEBIN');
      assert.equal(existsSync(join(out, 'node-v22.19.0-win-x64', 'npm')), false, '其余成员不该被解出来');
      assert.equal(existsSync(join(out, 'node-v22.19.0-win-x64', 'node_modules')), false);

      const bad = new AdmZip();
      bad.addFile('node-v22.19.0-win-x64/README.md', Buffer.from('x'));
      const badArchive = join(tmp, 'bad.zip');
      bad.writeZip(badArchive);
      assert.throws(() => extractNodeBinary(badArchive, join(tmp, 'out2'), '22.19.0', 'win32', 'x64'));
    }
    finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // This case needs no system tools besides shasum/tar; it runs on Windows / macOS / Linux
  it('writes a zip runtime with node.exe at the root and adm-zip can read it back', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pack-zip-'));
    try {
      const parts = join(tmp, 'parts');
      mkdirSync(parts, { recursive: true });
      writeFileSync(join(parts, 'node.exe'), 'NODEBIN');
      writeFileSync(join(parts, 'cli.mjs'), 'MJS');
      mkdirSync(join(parts, 'sqlite', 'build', 'Release'), { recursive: true });
      writeFileSync(join(parts, 'sqlite', 'package.json'), '{"name":"better-sqlite3"}\n');
      writeFileSync(join(parts, 'sqlite', 'build', 'Release', 'better_sqlite3.node'), 'ADDON');
      mkdirSync(join(parts, 'bindings'), { recursive: true });
      writeFileSync(join(parts, 'bindings', 'package.json'), '{"name":"bindings"}\n');
      mkdirSync(join(parts, 'file-uri-to-path'), { recursive: true });
      writeFileSync(join(parts, 'file-uri-to-path', 'package.json'), '{"name":"file-uri-to-path"}\n');

      const stage = join(tmp, 'stage');
      stageRuntimeTree(stage, {
        nodeBin: join(parts, 'node.exe'),
        nodeFileName: 'node.exe',
        mjs: join(parts, 'cli.mjs'),
        sqliteRoot: join(parts, 'sqlite'),
        bindingsRoot: join(parts, 'bindings'),
        fileUriToPathRoot: join(parts, 'file-uri-to-path'),
      });
      assert.equal(existsSync(join(stage, 'node.exe')), true, 'Windows runtime 里是 node.exe');
      assert.equal(existsSync(join(stage, 'node')), false);

      const out = join(tmp, 'lifeline-win32-x64.zip');
      writeRuntimeZip(stage, out);
      writeSha256File(out);

      const zip = new AdmZip(out);
      const names = zip.getEntries().map(e => e.entryName.replace(/\\/g, '/'));
      assert.ok(names.includes('node.exe'), names.join(', '));
      assert.ok(names.includes('lifeline.mjs'));
      assert.ok(names.includes('node_modules/better-sqlite3/build/Release/better_sqlite3.node'));
      assert.ok(names.includes('node_modules/bindings/package.json'));
      assert.ok(names.includes('node_modules/file-uri-to-path/package.json'));
      // Entry names must not include the stage directory itself, or unpacking adds an extra layer
      assert.equal(names.some(n => n.startsWith('stage/')), false);
      assert.equal(zip.readAsText('node.exe'), 'NODEBIN');

      const sha = readFileSync(`${out}.sha256`, 'utf-8');
      assert.match(sha, /^[a-f0-9]{64} {2}lifeline-win32-x64\.zip\n$/);
    }
    finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// The self-host image is the only shipping path: runtime packing's build entry is the Dockerfile;
// docs must still watch AGENTS.md so build:runtime and "does not require a local Node install"
// are not dropped.
describe('runtime packing is wired into the docs and the self-host image', () => {
  it('AGENTS.md documents build:runtime and the Dockerfile packs linux-x64', () => {
    const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf-8');
    assert.match(agents, /build:runtime/);
    assert.match(agents, /No requirement that Node is preinstalled/);
    const docker = readFileSync(join(ROOT, 'Dockerfile'), 'utf-8');
    assert.match(docker, /PACK_TARGETS=linux-x64 pnpm run build:runtime/);
  });
});
