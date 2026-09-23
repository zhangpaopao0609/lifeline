import type { CliConfig } from './config.js';
import { execSync, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadCliConfig } from './config.js';

export function log(msg: string): void {
  console.log(msg);
}

export function requireConfig(): CliConfig {
  const config = loadCliConfig();
  if (!config) {
    console.error('No configuration found. Run: lifeline setup');
    process.exit(1);
  }
  return config;
}

interface Asker {
  ask: (question: string) => Promise<string>;
  close: () => void;
}

/**
 * Prompt helper. Interactive TTY uses readline; piped stdin (e.g.
 * "printf ... | lifeline setup") is buffered into a line queue instead,
 * because readline drops pending question callbacks when stdin hits EOF.
 */
export function createAsker(): Asker {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return {
      ask: question =>
        new Promise((resolve) => {
          rl.question(question, answer => resolve((answer ?? '').trim()));
        }),
      close: () => rl.close(),
    };
  }

  const lines: string[] = [];
  const pending: Array<(value: string) => void> = [];
  let ended = false;
  let buffer = '';

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      lines.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
    flush();
  });
  process.stdin.on('end', () => {
    if (buffer)
      lines.push(buffer);
    ended = true;
    flush();
  });

  function flush(): void {
    while (pending.length > 0 && lines.length > 0) {
      pending.shift()!(lines.shift()!);
    }
    while (ended && pending.length > 0) {
      pending.shift()!('');
    }
  }

  return {
    ask: (question) => {
      process.stdout.write(question);
      if (lines.length > 0)
        return Promise.resolve(lines.shift()!.trim());
      if (ended)
        return Promise.resolve('');
      return new Promise(resolve => pending.push(resolve));
    },
    close: () => {
      /* piped stdin closes on its own */
    },
  };
}

/**
 * Best-effort open in the default browser. Headless boxes have no opener at
 * all (`xdg-open` ENOENT), and an unhandled 'error' event would kill the
 * caller mid-setup, so failures are swallowed and callers print the URL.
 */
export function openBrowser(url: string): void {
  const [cmd, args]
    = process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      /* no opener installed — the URL was already printed */
    });
    child.unref();
  }
  catch {
    /* spawn threw synchronously — same story */
  }
}

export function resolveCliEntry(): string | undefined {
  try {
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : undefined;
    return entry && existsSync(entry) ? entry : undefined;
  }
  catch {
    return undefined;
  }
}

/**
 * The setup screen reports what it did in two columns instead of narrating
 * every internal path. `detail()` carries the follow-up lines so long values
 * (links, commands) stay aligned under the value column.
 */
const REPORT_COL = 12;
export function row(label: string, value: string): void {
  log(`  ${label}${' '.repeat(Math.max(1, REPORT_COL - label.length))}${value}`);
}
export function detail(line: string): void {
  log(`${' '.repeat(2 + REPORT_COL)}${line}`);
}

/** `~/.lifeline/config.json` reads better than the absolute path. */
export function shortPath(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * Renders a URL as a terminal link: OSC 8 hyperlink (clickable in Terminal.app,
 * iTerm2, Warp, VS Code, …) plus underline/cyan so it reads as an address even
 * where the escape is not clickable. Plain text when stdout is not a terminal —
 * piped output, logs and CI must not collect escape codes.
 */
export function hyperlink(url: string): string {
  const term = process.env.TERM ?? '';
  if (!process.stdout.isTTY || term === 'dumb')
    return url;
  const text = process.env.NO_COLOR ? url : `\x1B[4;36m${url}\x1B[0m`;
  return `\x1B]8;;${url}\x1B\\${text}\x1B]8;;\x1B\\`;
}

/** Runs a command with stderr captured: raw launchd/systemctl dumps are noise on a setup screen. */
export function tryRun(cmd: string): string | undefined {
  try {
    execSync(cmd, { stdio: 'pipe' });
    return undefined;
  }
  catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    const text = (stderr ? stderr.toString() : '') || (err instanceof Error ? err.message : String(err));
    return firstLine(text) || 'unknown error';
  }
}

export function firstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).filter(Boolean)[0] ?? '';
}

export interface DaemonOutcome {
  /**
   * false = the agent ended up not running and the user has to act (setup then
   * exits non-zero). The "no CLI entry to install" case stays true: there is
   * nothing to install from a source checkout, the note says what to run.
   */
  ok: boolean;
  summary: string;
  notes: string[];
}

/**
 * Options for `cmdDaemon*`.
 *
 * Deliberately a named interface instead of `opts: { quiet?: boolean }`: `tests/cli-commands.test.ts`'s
 * `functionBody()` slices function bodies **by brace matching**, so a `{}` in the signature would make it cut only the first line
 * (T11 already hit this on `installerInvocation`).
 */
export interface DaemonOpts {
  quiet?: boolean;
}
