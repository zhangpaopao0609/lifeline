import { appendFileSync, createWriteStream, mkdirSync } from 'node:fs';
import { loadConfig } from './config.js';
import { Relay } from './relay.js';
import { readServerVersion } from './server-version.js';

// In a container, cwd (/app) has no temp/ — the logger's open is lazy but appendFileSync is not,
// so a missing directory crashes on the first log line. mkdirSync is idempotent; ensure the dir exists first.
mkdirSync('./temp', { recursive: true });
const logStream = createWriteStream('./temp/server.log', { flags: 'a' });
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
function ts(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}
function writeLog(line: string): void {
  try {
    logStream.write(`${ts()} ${line}\n`);
  }
  catch {
    /* ignore write errors */
  }
}
if (process.env.LOG_FORMAT === 'json') {
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    origLog(JSON.stringify({ ts: Date.now(), level: 'info', msg: line }));
    writeLog(line);
  };
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    origWarn(JSON.stringify({ ts: Date.now(), level: 'warn', msg: line }));
    writeLog(`[WARN] ${line}`);
  };
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    origError(JSON.stringify({ ts: Date.now(), level: 'error', msg: line }));
    writeLog(`[ERROR] ${line}`);
  };
}
else {
  console.log = (...args: unknown[]) => { const line = args.map(String).join(' '); origLog(`${ts()} ${line}`); writeLog(line); };
  console.warn = (...args: unknown[]) => { const line = args.map(String).join(' '); origWarn(`${ts()} [WARN] ${line}`); writeLog(`[WARN] ${line}`); };
  console.error = (...args: unknown[]) => { const line = args.map(String).join(' '); origError(`${ts()} [ERROR] ${line}`); writeLog(`[ERROR] ${line}`); };
}

process.on('uncaughtException', (err) => {
  const msg = `[CRASH] Uncaught exception: ${err.message}\n${err.stack ?? ''}`;
  try {
    appendFileSync('./temp/server.log', `${ts()} ${msg}\n`);
  }
  catch {
    /* ignore */
  }
  origError(msg);
  setTimeout(() => process.exit(1), 100);
});

async function main(): Promise<void> {
  console.log(`=== Lifeline v${readServerVersion()} ===`);
  console.log();

  const config = loadConfig();

  const relay = new Relay(config);
  await relay.start();
  console.log('[main] waiting for agent uplink (run "lifeline start" on the local machine)');
  installShutdown(async () => {
    await relay.stop();
  });
}

const SHUTDOWN_DEADLINE_MS = 5000;

function installShutdown(work: () => Promise<void>): void {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown)
      return;
    shuttingDown = true;
    console.log('\n[main] Shutting down...');
    const force = setTimeout(() => {
      console.warn(`[main] Shutdown exceeded ${SHUTDOWN_DEADLINE_MS}ms; exiting`);
      process.exit(0);
    }, SHUTDOWN_DEADLINE_MS);
    force.unref();
    void work()
      .catch((err) => {
        console.error(`[main] Shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        clearTimeout(force);
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  const msg = `[main] Fatal error: ${err instanceof Error ? err.message : String(err)}\n${err instanceof Error ? err.stack ?? '' : ''}`;
  try {
    appendFileSync('./temp/server.log', `${ts()} [ERROR] ${msg}\n`);
  }
  catch {
    /* ignore */
  }
  console.error(msg);
  setTimeout(() => process.exit(1), 100);
});
