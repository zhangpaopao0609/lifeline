import type { CdpEndpointSource, IdeKind } from '../../../protocol/src/index.js';
import type { ProbeResult } from './probe.js';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  codeBuddyActivePortFileCandidates,
  cursorActivePortFileCandidates,
} from '../win-paths.js';

const ADOPT_KINDS = new Set<ProbeResult['kind']>(['ok', 'no-window', 'no-workbench']);

interface CacheEntry {
  cdpUrl: string;
  source: CdpEndpointSource;
  fileMtime: number | undefined;
  browserUuid: string | undefined;
  hasPortFile: boolean;
}

const cache = new Map<IdeKind, CacheEntry>();

export function clearEndpointCache(ide?: IdeKind): void {
  if (ide)
    cache.delete(ide);
  else cache.clear();
}

export function cursorActivePortCandidates(
  home = homedir(),
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'Cursor', 'DevToolsActivePort')];
  }
  if (platform === 'win32')
    return cursorActivePortFileCandidates(env, home);
  return [join(home, '.config', 'Cursor', 'DevToolsActivePort')];
}

export function codeBuddyActivePortCandidates(
  home = homedir(),
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const darwin = [
    join(home, 'Library', 'Application Support', 'CodeBuddy CN', 'DevToolsActivePort'),
    join(home, 'Library', 'Application Support', 'CodeBuddy', 'DevToolsActivePort'),
  ];
  const linux = [
    join(home, '.config', 'CodeBuddy CN', 'DevToolsActivePort'),
    join(home, '.config', 'CodeBuddy', 'DevToolsActivePort'),
  ];
  // win32: put the current platform **first**, still list the other platforms
  // (same "list non-native candidates" style as the darwin / linux branches;
  // note the three branches are not equal length: darwin/linux 4 each, win32 6).
  //
  // ⚠️ **Order** is the only safety; it is not "kinship": `resolveEndpoint`
  // walks candidates and `break`s on the first **readable, port-parseable**
  // file — it is adopted unless judged `no-listener`, including `not-cdp` /
  // `unknown` (that is the review-R3 trade: do not fall back to the configured
  // port). So another platform's candidate is adopted if it is actually read.
  // In practice `<home>\Library\...` / `<home>\.config\...` do not exist on
  // Windows and `readFile` skips them, so putting the current platform first
  // is enough.
  if (platform === 'win32')
    return [...codeBuddyActivePortFileCandidates(env, home), ...linux, ...darwin];
  return platform === 'darwin' ? [...darwin, ...linux] : [...linux, ...darwin];
}

export function parseDevToolsActivePort(text: string): number | undefined {
  const first = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!/^\d+$/.test(first))
    return undefined;
  const n = Number(first);
  if (n < 1 || n > 65535)
    return undefined;
  return n;
}

/**
 * Browser uuid on line 2 of `DevToolsActivePort` (`/devtools/browser/<uuid>`).
 *
 * It is that IDE instance's identity card (regenerated every start). Compare
 * it with `/json/version`'s browser ws path to know "is this port the instance
 * in the file" — independent of product name.
 * If it cannot be parsed, return undefined (**treat as "this layer unavailable",
 * not "mismatch"**).
 */
export function parseDevToolsActivePortUuid(text: string): string | undefined {
  const second = text.split(/\r?\n/)[1]?.trim() ?? '';
  const raw = /^\/devtools\/browser\/([^/]+)$/.exec(second)?.[1];
  // Strict: a non-canonical uuid is always "could not parse" (this layer
  // unavailable); **never** use it for comparison — a loose parse turns
  // "could not read" into "mismatch" and once blocked a healthy Cursor.
  return raw && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
    ? raw
    : undefined;
}

function isLoopbackHost(configuredUrl: string): boolean {
  try {
    // ⚠️ `new URL('http://[::1]:9222').hostname` is **`'[::1]'` (with brackets)**, not `'::1'`.
    // Comparing only `'::1'` classifies a machine configured with `[::1]` as
    // "not loopback" → **silently skip** DevToolsActivePort discovery and
    // connect only to the configured port (review R7, reproduced) → accept both spellings.
    const host = new URL(configuredUrl).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  }
  catch {
    return false;
  }
}

function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  }
  catch {
    return undefined;
  }
}

function defaultMtime(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  }
  catch {
    return undefined;
  }
}

function firstExistingMtime(
  candidates: string[],
  readFile: (p: string) => string | undefined,
  mtime: (p: string) => number | undefined,
): number | undefined {
  for (const path of candidates) {
    if (readFile(path) !== undefined)
      return mtime(path);
  }
  return undefined;
}

export async function resolveEndpoint(opts: {
  ide: IdeKind;
  configuredUrl: string;
  probe: typeof import('./probe.js').probeCdpEndpoint;
  readFile?: (p: string) => string | undefined;
  candidates: string[];
  mtime?: (p: string) => number | undefined;
}): Promise<{
  cdpUrl: string;
  source: CdpEndpointSource;
  browserUuid?: string;
  /**
   * This call **actually adopted** the port in the file (not merely "read a file").
   *
   * The caller (`CDPBridge`) uses this to clear "this IDE does not use the file
   * we read": adopting a file port = the file location is fine.
   *
   * **It does not directly decide which port to pass on relaunch**: default is
   * `0`; only "after relaunch this file's mtime did not move" switches to the
   * configured port — see `fileLocationOff` in `cdp-bridge.ts` and review Q2(B).
   */
  hasPortFile: boolean;
  /**
   * mtime of the port file we read (`undefined` if we did not read one).
   *
   * The caller uses it to judge "after restarting the IDE, did this file move"
   * — if not, this IDE does not use this file (custom `--user-data-dir`), and
   * only then should we switch to the configured port. **mtime alone needs no extra request**.
   */
  fileMtime?: number;
}> {
  const readFile = opts.readFile ?? defaultReadFile;
  const mtime = opts.mtime ?? defaultMtime;

  if (!isLoopbackHost(opts.configuredUrl)) {
    // Tunnel / remote forward: a local file is meaningless, and no candidate was read.
    return { cdpUrl: opts.configuredUrl, source: 'config', hasPortFile: false };
  }

  const fileMtime = firstExistingMtime(opts.candidates, readFile, mtime);
  const cached = cache.get(opts.ide);
  if (cached && cached.fileMtime === fileMtime) {
    // Cached health checks must carry identity too, or classification briefly disagrees with the agent/CLI's final decision.
    const health = await opts.probe(cached.cdpUrl, opts.ide, {
      expect: { browserUuid: cached.browserUuid },
    });
    if (health.kind !== 'no-listener') {
      return {
        cdpUrl: cached.cdpUrl,
        source: cached.source,
        browserUuid: cached.browserUuid,
        hasPortFile: cached.hasPortFile,
        fileMtime: cached.fileMtime,
      };
    }
    cache.delete(opts.ide);
  }

  let adopted: { cdpUrl: string; source: CdpEndpointSource } | undefined;
  let lastProbe: ProbeResult | undefined;
  /** Identity card of the instance in the file. **Only sent out when a file port was actually adopted**; the fallback path has none. */
  let fileUuid: string | undefined;

  for (const path of opts.candidates) {
    const text = readFile(path);
    if (text === undefined)
      continue;
    const port = parseDevToolsActivePort(text);
    if (port === undefined)
      continue;
    fileUuid = parseDevToolsActivePortUuid(text);
    const cdpUrl = `http://127.0.0.1:${port}`;
    // Pass instance identity down: a match is that IDE (a rename still counts); a mismatch means another process took the port.
    lastProbe = await opts.probe(cdpUrl, opts.ide, { expect: { browserUuid: fileUuid } });
    if (ADOPT_KINDS.has(lastProbe.kind)) {
      // Shape confirmed as ours.
      adopted = { cdpUrl, source: 'active-port-file' };
    }
    else if (lastProbe.kind === 'not-cdp' || lastProbe.kind === 'unknown') {
      // "Someone answered but we do not recognize it": **return that as-is, never fall back to the configured port**.
      //
      // Falling back to 9222 (empty once the port became random) would make us
      // conclude "this IDE has no debug port" and trigger a destructive
      // relaunch — while something is sitting on that port and the IDE is healthy.
      // Handing the "not recognized" reason up is much safer than "guess an empty
      // port, then kill the IDE".
      // (Review R3: this fallback once killed the user's IDE every ~60s.)
      adopted = { cdpUrl, source: 'active-port-file' };
    }
    // Only no-listener (nobody answered) may continue → fall back to the configured port.
    break;
  }

  if (!adopted) {
    lastProbe = await opts.probe(opts.configuredUrl, opts.ide);
    adopted = { cdpUrl: opts.configuredUrl, source: 'config-fallback' };
  }

  // **Only actually adopting the port in the file** counts as "can read the
  // port file"; uuid likewise.
  //
  // Returning true when "the file was read but nobody is listening on that
  // port (eventual fallback to the configured port)" would make us think
  // "after restart we can read it back", so we pass 0 again → the new port
  // is written into a directory we may not be able to read → back into the
  // kill loop. Sending the dead file's old uuid is worse: we would compare
  // it against the **new instance** on the configured port and block ourselves.
  const fromFile = adopted.source === 'active-port-file';
  const browserUuid = fromFile ? fileUuid : undefined;

  if (lastProbe?.kind === 'no-listener') {
    cache.delete(opts.ide);
  }
  else {
    cache.set(opts.ide, { ...adopted, fileMtime, browserUuid, hasPortFile: fromFile });
  }

  return { ...adopted, browserUuid, hasPortFile: fromFile, fileMtime };
}
