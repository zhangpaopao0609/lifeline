import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { probeUnixWebSocket } from './ws-unix.js';

/**
 * One long-lived `codex app-server --listen unix://…` per user, shared by the web (the ACP bridge) and
 * the terminal (`lifeline codex`, i.e. `codex --remote`). Both clients subscribe to the same threads, so
 * replies, tool calls and approvals of a terminal turn reach the phone live, and either side can approve.
 *
 * Whoever needs it first starts it, detached, so it outlives the agent and the terminal: restarting or
 * updating the agent does not kill running Codex turns. Under a systemd service the agent's cgroup would
 * still take it down, so there it is started as its own transient unit (`systemd-run --user`).
 *
 * `LIFELINE_CODEX_SHARED=0` turns sharing off (private app-server per session, as before).
 */
export const CODEX_SHARED_ENV = 'LIFELINE_CODEX_SHARED';
/** Socket override (tests, or a server the user runs themselves). */
export const CODEX_SOCKET_ENV = 'LIFELINE_CODEX_SOCKET';
export const CODEX_SHARED_UNIT = 'lifeline-codex-app-server';

/** sockaddr_un is 104 (macOS) / 108 (Linux) bytes. */
const SOCKET_PATH_MAX = 100;
const START_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

/** Lifeline secrets and supervisor variables that must not leak into the long-lived server. */
const DROP_ENV = ['AGENT_TOKEN', 'REMOTE_URL', 'CODEBUDDY_API_KEY', 'CODEBUDDY_INTERNET_ENVIRONMENT', 'LIFELINE_SUPERVISED', 'INVOCATION_ID', 'JOURNAL_STREAM', 'MANAGERPID', 'NOTIFY_SOCKET'];

export function codexStateDir(home: string = homedir()): string {
  return join(home, '.lifeline', 'codex');
}

/** Socket of the shared server, or undefined when sharing is off or the path cannot be a unix socket. */
export function codexSharedSocket(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | undefined {
  if (env[CODEX_SHARED_ENV] === '0')
    return undefined;
  const override = env[CODEX_SOCKET_ENV];
  const path = override && isAbsolute(override) ? override : join(codexStateDir(home), 'app-server.sock');
  return Buffer.byteLength(path) <= SOCKET_PATH_MAX ? path : undefined;
}

export function sharedServerEnv(env: NodeJS.ProcessEnv, codex: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of DROP_ENV)
    delete out[key];
  for (const key of Object.keys(out)) {
    if (key.startsWith('LIFELINE_'))
      delete out[key];
  }
  // npm's `codex` is `#!/usr/bin/env node`; keep its own directory (where that node usually lives) on PATH.
  const bin = isAbsolute(codex) ? dirname(codex) : '';
  const parts = String(out.PATH ?? '').split(':').filter(Boolean);
  if (bin && !parts.includes(bin))
    out.PATH = [bin, ...parts].join(':');
  return out;
}

function hasCommand(name: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer(sock: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(sock) && await probeUnixWebSocket(sock, 1000))
      return true;
    await sleep(150);
  }
  return false;
}

function spawnServer(codex: string, sock: string, env: NodeJS.ProcessEnv, home: string, log: (msg: string) => void): void {
  const args = ['app-server', '--listen', `unix://${sock}`];
  const serverEnv = sharedServerEnv(env, codex);
  if (env.INVOCATION_ID && hasCommand('systemd-run')) {
    const setenv = Object.entries(serverEnv)
      .filter(([key, value]) => typeof value === 'string' && /^[A-Z_]\w*$/i.test(key) && !value.includes('\n'))
      .map(([key, value]) => `--setenv=${key}=${value}`);
    const res = spawnSync('systemd-run', ['--user', '--quiet', '--collect', `--unit=${CODEX_SHARED_UNIT}`, `--property=WorkingDirectory=${home}`, ...setenv, codex, ...args], { stdio: 'ignore', timeout: 10_000 });
    if (res.status === 0)
      return;
    log(`systemd-run failed (exit ${res.status ?? 'null'}); starting the shared Codex server detached instead`);
  }
  const logFile = join(dirname(sock), 'app-server.log');
  const fd = openSync(logFile, 'a');
  try {
    const child = spawn(codex, args, { cwd: home, env: serverEnv, detached: true, stdio: ['ignore', fd, fd] });
    child.on('error', err => log(`cannot start the shared Codex server: ${err.message}`));
    child.unref();
  }
  finally {
    closeSync(fd);
  }
}

export interface EnsureSharedOptions {
  codex: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * The shared server's socket once it answers, starting the server if nobody runs it. Undefined when
 * sharing is off or it does not come up (an old Codex without `--listen`, say): callers fall back to a
 * private app-server.
 */
export async function ensureCodexSharedServer(options: EnsureSharedOptions): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const log = options.log ?? (() => {});
  const sock = codexSharedSocket(env, home);
  if (!sock)
    return undefined;
  if (existsSync(sock) && await probeUnixWebSocket(sock))
    return sock;
  mkdirSync(dirname(sock), { recursive: true, mode: 0o700 });
  const lock = `${sock}.lock`;
  let locked = false;
  try {
    mkdirSync(lock);
    locked = true;
  }
  catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
        locked = true;
      }
    }
    catch {}
  }
  if (!locked)
    return await waitForServer(sock, options.timeoutMs ?? START_TIMEOUT_MS) ? sock : undefined;
  try {
    if (existsSync(sock)) {
      if (await probeUnixWebSocket(sock))
        return sock;
      rmSync(sock, { force: true });
    }
    spawnServer(options.codex, sock, env, home, log);
    if (await waitForServer(sock, options.timeoutMs ?? START_TIMEOUT_MS))
      return sock;
    log(`the shared Codex server did not come up on ${sock} (see ${join(dirname(sock), 'app-server.log')})`);
    return undefined;
  }
  finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// ---------- Lifeline session id -> Codex thread id ----------

/**
 * A Lifeline Codex session is created before its thread (the thread starts on the first prompt) and can
 * be re-pointed at another thread with `/attach`, so its id is an alias. The bridge records the thread
 * here; `session/load` and `lifeline codex resume <id>` read it.
 */
export interface CodexSessionRecord {
  threadId: string;
  cwd?: string;
  updatedAt: number;
}

const RECORD_TTL_MS = 180 * 24 * 3600 * 1000;

export function codexSessionsPath(home: string = homedir()): string {
  return join(codexStateDir(home), 'sessions.json');
}

export function readCodexSessions(path: string = codexSessionsPath()): Record<string, CodexSessionRecord> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw))
      return {};
    const out: Record<string, CodexSessionRecord> = {};
    for (const [id, rec] of Object.entries(raw as Record<string, unknown>)) {
      if (rec && typeof rec === 'object' && typeof (rec as CodexSessionRecord).threadId === 'string')
        out[id] = rec as CodexSessionRecord;
    }
    return out;
  }
  catch {
    return {};
  }
}

export function writeCodexSession(id: string, rec: Omit<CodexSessionRecord, 'updatedAt'>, path: string = codexSessionsPath(), now: number = Date.now()): void {
  const all = readCodexSessions(path);
  all[id] = { ...rec, updatedAt: now };
  for (const [key, value] of Object.entries(all)) {
    if (now - (value.updatedAt ?? 0) > RECORD_TTL_MS)
      delete all[key];
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Thread for a Lifeline session id; an id with no record is taken as a thread id. */
export function resolveCodexThread(id: string, path: string = codexSessionsPath()): string {
  return readCodexSessions(path)[id]?.threadId ?? id;
}
