import type { SessionWatermark } from './content-watermark.js';
import type { IdeSlot } from './ide-slot.js';
import type { ContentSource } from './sources/content-source.js';
import type { IdeKind } from './sources/types.js';
import type { ChatElement, CursorState } from './types.js';
import { hostname } from 'node:os';
import { includeProcessEnabled, loadCliConfig } from '../../cli/src/config.js';
import { IDE_LABELS } from '../../protocol/src/index.js';
import { attachIdeCommandHandlers } from './command-router.js';
import { loadConfig, loadSelectors } from './config.js';
import { applyContentSource, ContentLiveRuntime } from './content-runtime.js';
import {
  loadWatermarks,
  mergeIde,
  pickIde,
  saveWatermarks,

} from './content-watermark.js';
import { registeredDrivers } from './drivers/index.js';
import { createIdeSlot } from './ide-slot.js';
import { canControlIde, detectLiveIdes } from './live-ides.js';
import { SessionIndexReporter } from './session-index-reporter.js';
import { resolveSessionId } from './session-lookup.js';
import { parseIde } from './types.js';
import { Uplink } from './uplink.js';

/**
 * Local agent: thin client that dials out to the server and drives the IDE over
 * loopback CDP (this machine never needs an inbound port).
 *
 * Assemble every IDE slot from the driver registry (P3): disk source,
 * projection runtime, live slot, and command targets are all built by
 * iterating — adding an IDE does not change this file; see drivers/index.ts.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.remoteUrl) {
    console.error('[agent] REMOTE_URL is required (address of the remote server)');
    process.exit(1);
  }
  if (!config.agentToken) {
    console.error('[agent] AGENT_TOKEN is required (must match the remote server)');
    process.exit(1);
  }
  const selectors = loadSelectors(config);

  const drivers = registeredDrivers();
  for (const { kind, driver } of drivers) {
    // IDE_LABELS keeps the uppercase display name used in the old startup log (kind printed raw would be lowercase)
    console.log(`[agent] ${IDE_LABELS[kind]} CDP: ${driver.cdpUrlOf(config)}`);
  }
  console.log(`[agent] Remote: ${config.remoteUrl}`);
  console.log(`[agent] Poll interval: ${config.pollIntervalMs}ms`);
  console.log();

  // The CLI path always supplies AGENT_ID (machine identity in `~/.lifeline/config.json`,
  // see cli/config.ts); only running the bundle directly (`pnpm run agent`) falls
  // back to hostname — that is a local debug path, not used for multi-user ownership.
  // `||` not `??`: empty string must mean "absent", or we would register with an
  // empty id (the server falls back to socket id, a new row on every reconnect).
  const agentId = process.env.AGENT_ID || `agent-${hostname()}`;
  const liveIdes = detectLiveIdes();
  // Whether we can "control an IDE" is decided by the **platform** (Linux is
  // content-source only), not "whether a GUI app is installed".
  const control = canControlIde();
  console.log(
    `[agent] canControlIde=${control}  liveIdes: ${liveIdes.length ? liveIdes.join(',') : '(none)'}`,
  );
  const uplink = new Uplink(config.remoteUrl, config.agentToken, agentId, liveIdes, !control);
  // Handshake must finish before better-sqlite3's sync open/rebuild, or the
  // websocket connect timer expires and the machine stays offline.
  await new Promise<void>((resolve) => {
    if (uplink.connected) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 8_000);
    uplink.once('connected', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const includeProcess = includeProcessEnabled(loadCliConfig());
  console.log(`[content-live] includeProcess=${includeProcess}`);

  // Watermark: one file, per-ide prefixes (do not stash in a closure; they
  // overwrite each other). First request after restart: matching → sync,
  // disk changed → patch; no more full re-projection.
  let watermarks = loadWatermarks();
  const saveIdeWatermark = (ide: IdeKind) => (snapshot: Record<string, SessionWatermark>) => {
    watermarks = mergeIde(watermarks, ide, snapshot);
    saveWatermarks(watermarks);
  };

  // Disk session source → projection runtime (the callback's ide is carried by
  // the runtime itself; remaining constructor args are isomorphic)
  const diskAdapters: Partial<Record<IdeKind, ContentSource>> = {};
  const runtimes: Partial<Record<IdeKind, ContentLiveRuntime>> = {};
  for (const { kind, driver } of drivers) {
    const adapter = driver.openDiskAdapter({ includeProcess });
    diskAdapters[kind] = adapter ?? undefined;
    runtimes[kind] = adapter
      ? new ContentLiveRuntime(
          adapter,
          {
            onIndex() {},
            onSessionFull(sessionId: string, messages: ChatElement[], ide: IdeKind, seq: number) {
              uplink.send('session:full', { sessionId, messages, ide, seq });
            },
            onSessionAppend(sessionId: string, messages: ChatElement[], ide: IdeKind, seq: number) {
              uplink.send('session:append', { sessionId, messages, ide, seq });
            },
            onSessionPatch(sessionId: string, messages: ChatElement[], ide: IdeKind, seq: number) {
              uplink.send('session:patch', { sessionId, messages, ide, seq });
            },
            onSessionSync(sessionId: string, ide: IdeKind, seq: number) {
              uplink.send('session:sync', { sessionId, ide, seq });
            },
          },
          { watermark: pickIde(watermarks, kind), onWatermark: saveIdeWatermark(kind) },
        )
      : undefined;
  }

  // Census: report session id/title/time only; the server uses this to know which machine holds the content.
  const indexSources = drivers
    .map(({ kind }) => diskAdapters[kind])
    .filter((source): source is ContentSource => source !== undefined);
  const indexReporter = new SessionIndexReporter({
    sources: indexSources,
    send: payload => uplink.send('sessions:index', payload),
    log: msg => console.log(msg),
  });
  console.log(`[session-index] reporting ${indexSources.length} source(s)`);

  // Live slots (CDP + extract + execute + window monitor); connection:status is
  // reported per IDE (P4 per-ide: server writes the matching slot; packets from
  // old agents without ide fall back to cursor on the server).
  const slots: Partial<Record<IdeKind, IdeSlot>> = {};
  for (const { kind, driver } of drivers) {
    slots[kind] = createIdeSlot({
      kind,
      cdpUrl: driver.cdpUrlOf(config),
      selectors,
      config,
      runtime: runtimes[kind] ?? null,
      onPatch: (patch) => {
        uplink.send('state:patch', { ide: kind, patch });
      },
      onConnection: (connected: boolean) => {
        uplink.send('connection:status', { ide: kind, connected });
      },
    });
  }

  for (const { kind } of drivers) {
    applyContentSource(diskAdapters[kind] ?? null, source =>
      slots[kind]!.stateManager.setContentSource(source));
  }

  attachIdeCommandHandlers(
    (event, handler) => uplink.on(event, handler),
    Object.fromEntries(
      drivers.map(({ kind }) => {
        const slot = slots[kind]!;
        return [
          kind,
          {
            commandExecutor: slot.executor,
            cdpBridge: slot.cdp,
            pauseLive: () => slot.pauseLive(),
            resumeLive: () => slot.resumeLive(),
            waitUntilReady: () => slot.waitUntilReady(),
            refreshState: () => slot.refreshState(),
            emitResult: (result: unknown) => uplink.send('command:result', result),
          },
        ];
      }),
    ),
  );

  const sendFullState = (): void => {
    const ides: Partial<Record<IdeKind, CursorState>> = {};
    for (const { kind } of drivers) {
      ides[kind] = slots[kind]!.stateManager.getCurrentState();
    }
    uplink.send('state:full', { ides });
    for (const { kind } of drivers) {
      const active = runtimes[kind]?.getActiveSession();
      if (active)
        runtimes[kind]?.requestSession(active);
    }
  };
  uplink.on('connected', sendFullState);
  uplink.on('sync', () => {
    // The server may have a fresh ledger (this machine just connected, or was
    // just deleted on the web): re-report the full census too, or an unchanged
    // fingerprint skips every round and the server stays empty.
    indexReporter.reset();
    sendFullState();
  });

  /**
   * The token is bound to agentId. If rejected (someone else holds this id, or
   * the token does not match), reconnecting with a new id does not help; re-run
   * `lifeline setup` on this machine for a new credential.
   */
  uplink.on('rejected', () => {
    console.error(
      '[agent] Server refused this machine (token/id mismatch or another account owns the id). Re-run `lifeline setup` on this machine.',
    );
  });

  uplink.on(
    'session:get',
    (payload: { sessionId?: string; tabTitle?: string; ide?: IdeKind; sinceSeq?: number }) => {
      const ide = parseIde(payload?.ide);
      const source = diskAdapters[ide];
      const target = runtimes[ide];
      const sessionId
        = payload?.sessionId || resolveSessionId(source?.listSessions() ?? [], payload ?? {});
      if (!sessionId)
        return;
      // Follow this session so later disk-change deltas are pushed.
      // In the cross-machine case (server names the content machine) this step
      // makes the web "live", not a snapshot. On the same machine, DOM later
      // overwrites it with the active session it sees.
      target?.setActiveSession(sessionId);
      // sinceSeq is passed through: match → sync, mismatch → patch; do not
      // re-project the whole session. Local machine has no such session →
      // answer "missing" explicitly so the web does not retry forever
      // (2026-09-20 empty-session storm).
      if (target?.requestSession(sessionId, payload?.sinceSeq) === false) {
        uplink.send('session:missing', { sessionId, ide });
      }
    },
  );

  for (const { kind } of drivers) {
    runtimes[kind]?.start();
  }
  indexReporter.start();
  // Platforms that can control an IDE: start every slot — **probe even if the
  // app is not detected**, because "not in the inventory" is only a quiet
  // strategy, not a gate (review R1).
  // Platforms that cannot control (Linux): content source only, **do not start
  // CDP** — no port probe, no fault reports; the server files the machine under
  // "content sources" via `contentSource`.
  if (control) {
    await Promise.all(drivers.map(({ kind }) => slots[kind]!.start()));
  }
  else {
    console.log('[agent] Linux：只做数据源，不连 CDP（只读会话数据）');
  }
  console.log('[agent] Running. Ctrl+C to stop.');

  const shutdown = async () => {
    console.log('\n[agent] Shutting down...');
    indexReporter.stop();
    for (const { kind } of drivers) {
      runtimes[kind]?.stop();
      diskAdapters[kind]?.close?.();
    }
    await Promise.all(drivers.map(({ kind }) => slots[kind]!.stop()));
    uplink.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (reason) => {
    console.error(`[agent] Unhandled rejection: ${String(reason)}`);
  });
}

main().catch((err) => {
  const msg = `[agent] Fatal error: ${err instanceof Error ? err.message : String(err)}\n${err instanceof Error ? err.stack ?? '' : ''}`;
  console.error(msg);
  setTimeout(() => process.exit(1), 100);
});
