/**
 * One idempotent shutdown for SIGINT, SIGTERM, superseded stand-down, and fatal.
 *
 * `drainMs` and `hardDeadlineMs` are controller fills. The design says "short drain"
 * and "hard deadline" without durations. 200ms bounds the cancelled/cancel flush.
 * 8000ms covers JsonlRpc's 5000ms SIGTERM grace plus its exit wait, then forces exit.
 */
export const SHUTDOWN_DRAIN_MS = 200;
export const SHUTDOWN_HARD_DEADLINE_MS = 8_000;

export interface LifecycleDeps {
  /** Claim every pending CLI approval and enqueue `cancelled` without awaiting each one. */
  claimAndEnqueueCancelled: () => readonly Promise<unknown>[];
  /** Enqueue `session/cancel` for every live CLI session. Do not await inside the loop. */
  enqueueCancels: () => readonly Promise<unknown>[];
  /** Close CLI processes. Process-group SIGTERM/SIGKILL stays in `JsonlRpc.close`. */
  closeCli: () => Promise<void>;
  /** Existing IDE slot stop. Behavior stays with the slot. */
  closeIde: () => Promise<void>;
  disconnect: () => void;
  releaseLock: () => void;
  exit: (code: number) => void | Promise<void>;
}

export interface LifecycleOptions {
  drainMs?: number;
  hardDeadlineMs?: number;
  delay?: (ms: number) => Promise<void>;
  schedule?: (ms: number, fn: () => void) => () => void;
}

export interface AgentLifecycle {
  readonly shuttingDown: boolean;
  shutdown: (code: number) => Promise<void>;
}

function delayWithTimeout(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function scheduleTimeout(ms: number, fn: () => void): () => void {
  const timer = setTimeout(fn, ms);
  return () => {
    clearTimeout(timer);
  };
}

export function createLifecycle(deps: LifecycleDeps, options: LifecycleOptions = {}): AgentLifecycle {
  const drainMs = options.drainMs ?? SHUTDOWN_DRAIN_MS;
  const hardDeadlineMs = options.hardDeadlineMs ?? SHUTDOWN_HARD_DEADLINE_MS;
  const delay = options.delay ?? delayWithTimeout;
  const schedule = options.schedule ?? scheduleTimeout;
  let shuttingDown = false;

  async function shutdown(exitCode: number): Promise<void> {
    if (shuttingDown)
      return;
    shuttingDown = true;
    await new Promise<void>((resolve) => {
      let settled = false;
      let cancelDeadline = () => {};
      cancelDeadline = schedule(hardDeadlineMs, () => {
        void end();
      });
      void (async () => {
        try {
          const cancelled = deps.claimAndEnqueueCancelled();
          const cancels = deps.enqueueCancels();
          await Promise.race([
            Promise.allSettled([...cancelled, ...cancels]),
            delay(drainMs),
          ]);
          await Promise.all([
            deps.closeCli(),
            deps.closeIde(),
          ]);
        }
        finally {
          await end();
        }
      })().catch(() => {
        // `end()` already disconnects, releases the lock, and exits.
      });

      async function end(): Promise<void> {
        if (settled)
          return;
        settled = true;
        cancelDeadline();
        try {
          deps.disconnect();
        }
        catch {
          // Disconnect failed; the lock is still released below.
        }
        try {
          deps.releaseLock();
        }
        catch {
          // The lock file may already be gone; still exit.
        }
        try {
          await deps.exit(exitCode);
        }
        finally {
          resolve();
        }
      }
    });
  }

  return {
    get shuttingDown() {
      return shuttingDown;
    },
    shutdown,
  };
}
