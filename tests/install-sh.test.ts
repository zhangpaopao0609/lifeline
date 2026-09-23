import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * These cases run **POSIX `install.sh`** (stub `uname` to simulate darwin/linux), so they need a
 * POSIX shell and POSIX tools. Windows has no `sh`/`shasum`, but **Git for Windows** ships a
 * full set (`sh.exe` / `tar.exe` (GNU, supports `-J`) / `sha256sum.exe` / `uname.exe` / `openssl.exe`).
 *
 * ⚠️ The key is that Git Bash **`/usr/bin` is `<Git>\usr\bin`** — so a child PATH of
 * `/usr/bin:/bin` still resolves `sha256sum` / `tar`; **the only change is converting the stub
 * dir to POSIX form** (`C:\a\b` → `/c/a/b`), otherwise the colon in a Windows path is a PATH
 * separator and stub `uname` is never found (before 2026-09-20 these cases were all red here;
 * the root cause was this + no `sh`).
 */
const GIT_USR_BIN = 'C:\\Program Files\\Git\\usr\\bin';
/** `xz.exe` lives here (not in `usr\bin`) — GNU tar's `-J` needs it; see `posixEnv()` below. */
const GIT_MINGW_BIN = 'C:\\Program Files\\Git\\mingw64\\bin';

/**
 * Env for POSIX tools **Node spawn()s directly**: append Git's `mingw64\bin` to PATH.
 *
 * Why: fixture `tar -cJf` is spawned by Node (not via a shell); PATH is Node's PATH —
 * no `xz.exe` there, so GNU tar `-J` reports `xz: command not found`. msys2 programs
 * convert a Windows-form PATH themselves, so append with the Windows delimiter.
 */
function posixEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${process.env.PATH ?? ''}${delimiter}${GIT_MINGW_BIN}` };
}

/** Prefer Git's copy of this tool; otherwise use whatever is on PATH (macOS/Linux take this path). */
function preferGit(binary: string, fallback: string): string {
  const inGit = join(GIT_USR_BIN, binary);
  return existsSync(inGit) ? inGit : fallback;
}

const POSIX_SH = preferGit('sh.exe', 'sh');
/** system32 `tar.exe` **does not support `-J`** (xz), so prefer Git's GNU tar. */
const POSIX_TAR = preferGit('tar.exe', 'tar');
const POSIX_SHA256 = preferGit('sha256sum.exe', 'shasum');
/**
 * ⚠️ macOS `shasum` **defaults to SHA-1** (do not be fooled by the name): must pass `-a 256`.
 * Without it the fixture sidecar is 40 hex chars, `install.sh` rejects it as "not a sha256
 * manifest" — the failure appears in install.sh but the cause is the fixture, hard to see
 * (2026-09-20 all-red on macOS was this).
 */
const POSIX_SHA256_ARGS = POSIX_SHA256.endsWith('sha256sum.exe') ? [] : ['-a', '256'];

/**
 * `C:\Users\x\tmp` → `/c/Users/x/tmp`.
 * Only Windows paths need converting (returned as-is on POSIX); otherwise `:` is treated as a PATH separator by the shell.
 */
function toPosixPath(p: string): string {
  const m = /^([A-Z]):\\(.*)$/i.exec(p);
  return m ? `/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}` : p;
}

/**
 * `C:\Users\x` → `/C:/Users/x` (**file URL path part**; do not use the `/c/` form above).
 *
 * Both look POSIX, but they are for different uses: `/c/...` is a **filesystem path** for
 * shell / msys2 programs; a `file://` URL must use standard Windows form `file:///C:/...` —
 * feeding `/c/...` makes curl try to open `/c/Users/...` and report `curl: (37) Could not
 * open file` (hit on a real machine). On POSIX the input is already `/Users/x`, returned as-is.
 */
/**
 * Path form the script **writes into the shim**: we give it POSIX-form `LIFELINE_HOME`, so on
 * Windows it writes `/c/...` (not `C:\...`). Both are absolute — assertions must pick the same
 * form per platform, or Windows false-fails comparing `C:\...` to `/c/...`.
 */
function shimPathForm(p: string): string {
  return process.platform === 'win32' ? toPosixPath(p) : p;
}

function toFileUrlPath(p: string): string {
  const m = /^([A-Z]):\\(.*)$/i.exec(p);
  return m ? `/${m[1]!.toUpperCase()}:/${m[2]!.replace(/\\/g, '/')}` : p;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'packages/web/public/install.sh');

/** Unauthenticated assets live under the `public/` subdirectory: install.sh builds `$BASE/public/...`. */
function makePackage(dir: string, target: string): void {
  const stage = join(dir, 'stage');
  const publicDir = join(dir, 'public');
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(join(stage, 'node_modules', 'better-sqlite3'), { recursive: true });
  writeFileSync(join(stage, 'node'), '#!/bin/sh\necho runtime-node\n');
  chmodSync(join(stage, 'node'), 0o755);
  writeFileSync(join(stage, 'lifeline.mjs'), 'console.log("cli")\n');
  writeFileSync(join(stage, 'node_modules', 'better-sqlite3', 'package.json'), '{"name":"better-sqlite3"}\n');
  const name = `lifeline-${target}.tar.xz`;
  const tar = join(publicDir, name);
  // ⚠️ Args must be **POSIX form**: tar/sha256sum under `<Git>\usr\bin` are the MSYS2 build,
  // they parse paths as POSIX, and `C:\...` is treated as "remote host C:"
  // (on-machine error was `tar (child): Cannot connect to C: resolve failed`).
  execFileSync(POSIX_TAR, ['-C', toPosixPath(stage), '-cJf', toPosixPath(tar), 'node', 'lifeline.mjs', 'node_modules'], {
    env: posixEnv(),
  });
  // Both tools print `<hex>  <path>`, compatible with split(/\s+/)[0] below
  // (sha256sum is 256 by default; shasum gets `-a 256` via POSIX_SHA256_ARGS).
  const sum = execFileSync(POSIX_SHA256, [...POSIX_SHA256_ARGS, toPosixPath(tar)], {
    encoding: 'utf-8',
    env: posixEnv(),
  });
  const hex = sum.trim().split(/\s+/)[0] ?? '';
  // The fixture also holds this: the sidecar must be 64-char sha256, or install.sh refuses
  // to install and that error looks nothing like a fixture bug (see POSIX_SHA256_ARGS).
  assert.match(hex, /^[0-9a-f]{64}$/);
  writeFileSync(join(publicDir, `${name}.sha256`), `${hex}  ${name}\n`);
}

function stubUname(dir: string, sys: string, machine: string): void {
  writeFileSync(
    join(dir, 'uname'),
    `#!/bin/sh\n[ "$1" = -s ] && { printf '%s\\n' '${sys}'; exit 0; }\n[ "$1" = -m ] && { printf '%s\\n' '${machine}'; exit 0; }\nprintf '%s\\n' '${sys}'\n`,
  );
  chmodSync(join(dir, 'uname'), 0o755);
}

function runInstall(opts: {
  home: string;
  binDir: string;
  libDir: string;
  baseDir: string;
  stubDir: string;
  extraPath?: string;
}): ReturnType<typeof spawnSync> {
  return spawnSync(POSIX_SH, [SCRIPT], {
    env: {
      ...process.env,
      // These paths **all** need POSIX form: the script runs in a POSIX shell, and the colon in
      // `C:\a\b` is a PATH separator (stub `uname` is lost). `/c/x` and `C:\x` are the same place
      // in Git Bash, so later reads of the product via a Windows path still work.
      HOME: toPosixPath(opts.home),
      // ⚠️ `/mingw64/bin` **cannot be omitted**: `install.sh` uses `tar -xJf` (xz), and GNU tar
      // `-J` **externally execs `xz`** — `xz.exe` is in `<Git>\mingw64\bin`, not `usr\bin`.
      // Drop it when overlaying PATH and you get `xz: command not found` (that is where the machine failed).
      PATH: `${toPosixPath(opts.stubDir)}:${opts.extraPath ?? ''}:/usr/bin:/bin:/mingw64/bin`,
      LIFELINE_BIN_DIR: toPosixPath(opts.binDir),
      LIFELINE_HOME: toPosixPath(opts.libDir),
      LIFELINE_SERVER: `file://${toFileUrlPath(opts.baseDir)}`,
    },
    encoding: 'utf-8',
  });
}

describe('install.sh', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'install-sh-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('installs darwin-arm64 runtime and writes an absolute-path shim', () => {
    const home = join(tmp, 'home');
    const binDir = join(tmp, 'bin');
    const libDir = join(home, '.lifeline');
    const baseDir = join(tmp, 'base');
    const stubDir = join(tmp, 'stub');
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(stubDir, { recursive: true });
    makePackage(baseDir, 'darwin-arm64');
    stubUname(stubDir, 'Darwin', 'arm64');
    const result = runInstall({ home, binDir, libDir, baseDir, stubDir });
    assert.equal(result.status, 0, result.stderr);
    const node = join(libDir, 'runtime', 'node');
    const mjs = join(libDir, 'runtime', 'lifeline.mjs');
    const shim = readFileSync(join(binDir, 'lifeline'), 'utf-8');
    assert.equal(existsSync(node), true);
    assert.equal(existsSync(mjs), true);
    assert.match(shim, /^#!\/bin\/sh\n/);
    assert.match(shim, new RegExp(`exec "${shimPathForm(node)}" "${shimPathForm(mjs)}" "\\$@"`));
    assert.match(result.stdout, /lifeline setup --server-url/);
  });

  it('installs linux-x64 runtime and writes an absolute-path shim', () => {
    const home = join(tmp, 'home');
    const binDir = join(tmp, 'bin');
    const libDir = join(home, '.lifeline');
    const baseDir = join(tmp, 'base');
    const stubDir = join(tmp, 'stub');
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(stubDir, { recursive: true });
    makePackage(baseDir, 'linux-x64');
    stubUname(stubDir, 'Linux', 'x86_64');
    const result = runInstall({ home, binDir, libDir, baseDir, stubDir });
    assert.equal(result.status, 0, result.stderr);
    const node = join(libDir, 'runtime', 'node');
    const mjs = join(libDir, 'runtime', 'lifeline.mjs');
    const shim = readFileSync(join(binDir, 'lifeline'), 'utf-8');
    assert.equal(existsSync(node), true);
    assert.equal(existsSync(mjs), true);
    assert.match(shim, new RegExp(`exec "${shimPathForm(node)}" "${shimPathForm(mjs)}" "\\$@"`));
    assert.match(result.stdout, /lifeline setup --server-url/);
  });

  it('maps Linux aarch64 to linux-arm64', () => {
    const home = join(tmp, 'home');
    const binDir = join(tmp, 'bin');
    const libDir = join(home, '.lifeline');
    const baseDir = join(tmp, 'base');
    const stubDir = join(tmp, 'stub');
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(stubDir, { recursive: true });
    makePackage(baseDir, 'linux-arm64');
    stubUname(stubDir, 'Linux', 'aarch64');
    const result = runInstall({ home, binDir, libDir, baseDir, stubDir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(libDir, 'runtime', 'lifeline.mjs')), true);
  });

  it('points at a daemon restart when it is an update, not a fresh install', () => {
    const home = join(tmp, 'home');
    const binDir = join(tmp, 'bin');
    const libDir = join(home, '.lifeline');
    const baseDir = join(tmp, 'base');
    const stubDir = join(tmp, 'stub');
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(stubDir, { recursive: true });
    makePackage(baseDir, 'darwin-arm64');
    mkdirSync(join(libDir, 'runtime'), { recursive: true });
    writeFileSync(join(libDir, 'runtime', 'lifeline.mjs'), 'console.log("old")\n');
    stubUname(stubDir, 'Darwin', 'arm64');
    const result = runInstall({ home, binDir, libDir, baseDir, stubDir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updated: .*runtime\/lifeline\.mjs/);
    assert.match(result.stdout, /lifeline daemon install/);
    // An upgrade must not prompt to log in again
    assert.doesNotMatch(result.stdout, /Next, sign in/);
    assert.equal(
      readFileSync(join(libDir, 'runtime', 'lifeline.mjs'), 'utf-8'),
      'console.log("cli")\n',
    );
  });

  it('rejects unsupported uname without touching runtime', () => {
    const home = join(tmp, 'home');
    const binDir = join(tmp, 'bin');
    const libDir = join(home, '.lifeline');
    const baseDir = join(tmp, 'base');
    const stubDir = join(tmp, 'stub');
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(stubDir, { recursive: true });
    mkdirSync(join(libDir, 'runtime'), { recursive: true });
    writeFileSync(join(libDir, 'runtime', 'keep'), 'yes');
    stubUname(stubDir, 'Linux', 'ppc64');
    const result = runInstall({ home, binDir, libDir, baseDir, stubDir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /不受支持/);
    assert.match(result.stderr, /Linux ppc64/);
    assert.equal(readFileSync(join(libDir, 'runtime', 'keep'), 'utf-8'), 'yes');
  });

  it('leaves existing runtime in place when sha256 does not match', () => {
    const home = join(tmp, 'home');
    const binDir = join(tmp, 'bin');
    const libDir = join(home, '.lifeline');
    const baseDir = join(tmp, 'base');
    const stubDir = join(tmp, 'stub');
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(stubDir, { recursive: true });
    makePackage(baseDir, 'darwin-arm64');
    writeFileSync(
      join(baseDir, 'public', 'lifeline-darwin-arm64.tar.xz.sha256'),
      `${'0'.repeat(64)}  lifeline-darwin-arm64.tar.xz\n`,
    );
    mkdirSync(join(libDir, 'runtime'), { recursive: true });
    writeFileSync(join(libDir, 'runtime', 'keep'), 'yes');
    stubUname(stubDir, 'Darwin', 'arm64');
    const result = runInstall({ home, binDir, libDir, baseDir, stubDir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sha256 不匹配/);
    assert.equal(readFileSync(join(libDir, 'runtime', 'keep'), 'utf-8'), 'yes');
  });

  it('rejects an HTML login page saved as the sha256 sidecar', () => {
    const home = join(tmp, 'home');
    const binDir = join(tmp, 'bin');
    const libDir = join(home, '.lifeline');
    const baseDir = join(tmp, 'base');
    const stubDir = join(tmp, 'stub');
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(stubDir, { recursive: true });
    makePackage(baseDir, 'darwin-arm64');
    writeFileSync(
      join(baseDir, 'public', 'lifeline-darwin-arm64.tar.xz.sha256'),
      '<!DOCTYPE html><html><body>signin</body></html>\n',
    );
    mkdirSync(join(libDir, 'runtime'), { recursive: true });
    writeFileSync(join(libDir, 'runtime', 'keep'), 'yes');
    stubUname(stubDir, 'Darwin', 'arm64');
    const result = runInstall({ home, binDir, libDir, baseDir, stubDir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /登录页拦截/);
    assert.equal(readFileSync(join(libDir, 'runtime', 'keep'), 'utf-8'), 'yes');
  });

  it('does not require PATH node or npm-install better-sqlite3', () => {
    const text = readFileSync(SCRIPT, 'utf-8');
    assert.doesNotMatch(text, /Node\.js 20\+/);
    assert.doesNotMatch(text, /npm install/);
    assert.match(text, /PACKAGE="lifeline-\$\{target\}\.tar\.xz"/);
    // Download URLs must fall under the unauthenticated /public prefix.
    assert.match(text, /\$BASE\/public\/\$PACKAGE/);
    // Linux only has sha256sum, macOS only has shasum; try both.
    assert.match(text, /sha256sum/);
    assert.match(text, /shasum -a 256 -c/);
  });
});
