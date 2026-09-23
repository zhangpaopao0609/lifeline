/**
 * Tools and paths needed to run **POSIX installer tests** (`install.sh` / `uninstall.sh`) on Windows.
 *
 * Background (2026-09-20 on-machine investigation): these suites used to fail **entirely** on this
 * box and looked like "platform N/A", but the chain actually works — **Git for Windows ships a
 * full POSIX userland**, it just is not on PATH:
 *
 * | Need | Where |
 * |---|---|
 * | `sh` / `uname` / `sha256sum` / (MSYS2) `tar` | `<Git>\usr\bin` |
 * | `xz.exe` (GNU tar **externally execs** it for `-J`) | `<Git>\mingw64\bin` |
 *
 * Three pitfalls (each hit on a real machine):
 * 1. **`/mingw64/bin` must stay on PATH**: GNU tar's `-J` is `exec xz`, and `xz.exe` lives in
 *    `mingw64\bin`, not `usr\bin` — drop it when overlaying PATH and you get `xz: command not found`.
 * 2. **Paths fed to MSYS2 programs must be POSIX form**: tar/sha256sum under `usr\bin` parse POSIX,
 *    so `C:\...` is treated as "remote host `C:`" (`tar: Cannot connect to C: resolve failed`).
 * 3. **Windows paths cannot go straight into PATH**: the `:` in `C:\a\b` is a shell separator → `toPosixPath`.
 *
 * Also, **two POSIX-looking forms must not be mixed**: filesystem paths use `/c/...` (`toPosixPath`),
 * while the path part of a `file://` URL must be standard Windows form `/C:/...` (`toFileUrlPath`) —
 * mixing them makes curl report `(37) Could not open file`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const GIT_USR_BIN = 'C:\\Program Files\\Git\\usr\\bin';
/** `xz.exe` lives here (not in `usr\bin`). */
const GIT_MINGW_BIN = 'C:\\Program Files\\Git\\mingw64\\bin';

/** Prefer Git's copy of this tool; otherwise use whatever is on PATH (macOS/Linux take this path). */
function preferGit(binary: string, fallback: string): string {
  const inGit = join(GIT_USR_BIN, binary);
  return existsSync(inGit) ? inGit : fallback;
}

export const POSIX_SH = preferGit('sh.exe', 'sh');
/** system32 `tar.exe` does not support `-J` (xz), so prefer Git's GNU tar. */
export const POSIX_TAR = preferGit('tar.exe', 'tar');
export const POSIX_SHA256 = preferGit('sha256sum.exe', 'shasum');

/** Whether this machine has a usable POSIX userland (skip these tests if not). */
export function hasPosixUserland(): boolean {
  return spawnSync(POSIX_SH, ['-c', 'tar --version >/dev/null 2>&1 && sha256sum --version >/dev/null 2>&1'], {
    env: posixEnv(),
    stdio: 'ignore',
  }).status === 0;
}

/** `C:\Users\x\tmp` → `/c/Users/x/tmp` (returned as-is on POSIX). Use as a path for shell / MSYS2 programs. */
export function toPosixPath(p: string): string {
  const m = /^([A-Z]):\\(.*)$/i.exec(p);
  return m ? `/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}` : p;
}

/** `C:\Users\x` → `/C:/Users/x` (path part of a `file://` URL; **do not** use the `toPosixPath` form). */
export function toFileUrlPath(p: string): string {
  const m = /^([A-Z]):\\(.*)$/i.exec(p);
  return m ? `/${m[1]!.toUpperCase()}:/${m[2]!.replace(/\\/g, '/')}` : p;
}

/**
 * Env for POSIX tools **Node spawn()s directly**: append Git's `mingw64\bin` to PATH.
 * (MSYS2 programs convert a Windows-form PATH themselves, so append with the Windows delimiter.)
 */
export function posixEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${process.env.PATH ?? ''}${delimiter}${GIT_MINGW_BIN}` };
}

/**
 * Path form the script **writes into the shim**: we give it POSIX-form `LIFELINE_HOME`, so on Windows
 * it writes `/c/...` rather than `C:\...`. Both are absolute — assertions must pick the same form per
 * platform, or they false-fail.
 */
export function shimPathForm(p: string): string {
  return process.platform === 'win32' ? toPosixPath(p) : p;
}

/**
 * Args for checking a sidecar file: `shasum -a 256 -c <file>` vs `sha256sum -c <file>` have
 * **different flags**; this unifies them (macOS only has shasum; on Windows we give Git's sha256sum).
 */
export function sha256CheckArgs(file: string): string[] {
  return /sha256sum/i.test(POSIX_SHA256) ? ['-c', file] : ['-a', '256', '-c', file];
}
