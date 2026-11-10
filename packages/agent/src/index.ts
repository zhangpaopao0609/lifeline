import type { SessionWatermark } from './content-watermark.js';
import type { IdeSlot } from './ide-slot.js';
import type { AgentLifecycle } from './lifecycle.js';
import type { ContentSource } from './sources/content-source.js';
import type { IdeKind } from './sources/types.js';
import type { ChatElement, CursorState } from './types.js';
import { randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { BUILD_VERSION } from '../../cli/src/build-version.js';
import { includeProcessEnabled, loadCliConfig } from '../../cli/src/config.js';
import { IDE_KINDS, IDE_LABELS, SYNC_REASON_PATCH_GAP } from '../../protocol/src/index.js';
import { staticCliAcp } from './cli-capability.js';
import { attachIdeCommandHandlers } from './command-router.js';
import { loadConfig, loadSelectors } from './config.js';
import { applyContentSource, codeBuddyHostShardExists, ContentLiveRuntime } from './content-runtime.js';
import {
  loadWatermarks,
  mergeIde,
  pickIde,
  saveWatermarks,

} from './content-watermark.js';
import { cliCatalogPath } from './drivers/acp/catalog-disk.js';
import { attachCliUplinkSync, attachLiveCliListeners, createLiveCliEntry, warmCursorModels } from './drivers/acp/live-entry.js';
import { acpSpawnAllowed } from './drivers/acp/readiness.js';
import { cliSessionLedgerPath } from './drivers/acp/session-ledger.js';
import { contentDrivers, registeredDrivers } from './drivers/index.js';
import { createIdeSlot } from './ide-slot.js';
import { createLifecycle } from './lifecycle.js';
import { canControlIde, detectLiveIdes } from './live-ides.js';
import { PatchSequencer } from './patch-sequencer.js';
import { SessionIndexReporter } from './session-index-reporter.js';
import { resolveSessionId } from './session-lookup.js';
import {
  acquireAgentLock,
  agentLockPath,
  formatLockRefusal,
  releaseAgentLock,
} from './single-instance.js';
import { readSuperseded } from './superseded-outcome.js';
import { isIdeKind, parseIde } from './types.js';
import { Uplink } from './uplink.js';

/**
 * `process.exit` can drop buffered writes when stderr is a pipe, and a lost line from a failed
 * start is exactly the silent failure this change exists to remove: give libuv the budget this
 * file's fatal handler has always used. Declared before `main()` so that function's own doc block
 * stays attached to it.
 */
/** Set once `main` has built the lifecycle, so a fatal throw can still shut down. */
let shutdownLifecycle: AgentLifecycle | undefined;

async function exitAfterFlush(code: number): Promise<never> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 100);
  });
  return process.exit(code);
}

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
    await exitAfterFlush(1);
  }
  if (!config.agentToken) {
    console.error('[agent] AGENT_TOKEN is required (must match the remote server)');
    await exitAfterFlush(1);
  }
  // The CLI path always supplies AGENT_ID (machine identity in `~/.lifeline/config.json`,
  // see cli/config.ts); only running the bundle directly (`pnpm run agent`) falls
  // back to hostname — that is a local debug path, not used for multi-user ownership.
  // `||` not `??`: empty string must mean "absent", or we would register with an
  // empty id (the server falls back to socket id, a new row on every reconnect).
  const agentId = process.env.AGENT_ID || `agent-${hostname()}`;

  // One agent per machine, decided **before** anything observable: no driver banner, no CDP probe,
  // no uplink. A second process must fail as one legible line instead of registering and letting
  // the server silently resolve the duplicate (工蜂 Issue #2). The block carries our own identity.
  const lock = acquireAgentLock({ agentId, version: BUILD_VERSION, remoteUrl: config.remoteUrl });
  if (!lock.ok) {
    // The result already carries whether the holder is the service (`lifeline stop`) or something
    // else, decided by the probe the lock made: this path must never re-probe, and must not name a
    // way to kill a pid it could not identify.
    for (const line of formatLockRefusal({
      result: lock,
      identity: { pid: process.pid, agentId, version: BUILD_VERSION, remoteUrl: config.remoteUrl },
      lockPath: agentLockPath(),
    })) {
      console.error(line);
    }
    // Non-zero on purpose: launchd (`KeepAlive { SuccessfulExit: false }`) and systemd
    // (`Restart=on-failure`) only relaunch a failed process, and a lock that has gone stale by
    // then is taken over by the normal rule on the next attempt.
    await exitAfterFlush(1);
  }
  console.log(`[agent] pid=${process.pid} agentId=${agentId} v${BUILD_VERSION} remote=${config.remoteUrl}`);
  console.log(`[agent] lock ${agentLockPath()} (held by pid ${process.pid})`);

  const selectors = loadSelectors(config);

  const drivers = registeredDrivers();
  for (const { kind, driver } of drivers) {
    // IDE_LABELS keeps the uppercase display name used in the old startup log (kind printed raw would be lowercase)
    console.log(`[agent] ${IDE_LABELS[kind]} CDP: ${driver.cdpUrlOf(config)}`);
  }
  console.log(`[agent] Remote: ${config.remoteUrl}`);
  console.log(`[agent] Poll interval: ${config.pollIntervalMs}ms`);
  console.log();

  const liveIdes = detectLiveIdes();
  // Whether we can "control an IDE" is decided by the **platform** (Linux is
  // content-source only), not "whether a GUI app is installed".
  const control = canControlIde();
  console.log(
    `[agent] canControlIde=${control}  liveIdes: ${liveIdes.length ? liveIdes.join(',') : '(none)'}`,
  );
  const instanceId = randomUUID();
  /**
   * Routing capability for the server (`agent:register.slots`).
   *
   * Not `registeredDrivers()`: that is "compiled into this binary", so it would
   * claim a `vscode` slot on a machine with no plugin and no history — the server
   * would then accept commands/`session:get` for it, and the agent would have no
   * runtime to answer with. Two real sources:
   *  - the slot was created by this process (plugin installed and we can control);
   *  - the slot has a **content shard** on disk (history from a profile/remote that
   *    this process does not control, or a restored data dir) — read-only, but
   *    `session:get` must be answerable.
   *
   * Cheap + sqlite-free on purpose: this runs before the handshake.
   */
  const routableSlots = (): IdeKind[] => {
    const out = new Set<IdeKind>(drivers.map(({ kind }) => kind));
    if (codeBuddyHostShardExists('vscode'))
      out.add('vscode');
    if (codeBuddyHostShardExists('codebuddy'))
      out.add('codebuddy');
    return IDE_KINDS.filter(kind => out.has(kind));
  };
  const declaredSlots = routableSlots();
  console.log(`[agent] routable slots: ${declaredSlots.join(',') || '(none)'}`);
  const uplink = new Uplink(config.remoteUrl, config.agentToken, agentId, liveIdes, !control, {
    instanceId,
    cliAcp: staticCliAcp(),
    slots: declaredSlots,
  });
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

  // Filled in once slots exist. A stand-down during the sqlite open has nothing to stop yet.
  let stopIde = async (): Promise<void> => {};
  const cliFile = loadCliConfig();
  const liveCli = createLiveCliEntry({
    epoch: instanceId,
    emit: (event, payload) => uplink.send(event, payload),
    apiKey: cliFile?.codebuddyApiKey,
    environment: cliFile?.codebuddyInternetEnvironment,
    ledgerPath: cliSessionLedgerPath(),
    catalogPath: cliCatalogPath(),
  });
  const cliSessions = liveCli.manager;
  void cliSessions.restore();
  warmCursorModels(process.env, cliCatalogPath());
  // CodeBuddy has no `--list-models`. Read its catalog once at startup so the
  // new-session dialog is not the process that waits on `session/new`.
  if (acpSpawnAllowed(process.platform, process.env))
    void cliSessions.readCatalog({ source: 'codebuddy-cli', cwd: homedir() });
  void liveCli.probe('cursor-cli');
  void liveCli.probe('codebuddy-cli');
  void liveCli.probe('codex-cli');
  attachLiveCliListeners((event, handler) => {
    uplink.on(event, handler);
  }, liveCli);
  attachCliUplinkSync((event, handler) => {
    uplink.on(event, handler);
  }, cliSessions, uplink.connected);
  const lifecycle = createLifecycle({
    claimAndEnqueueCancelled: () => cliSessions.claimAndEnqueueCancelled(),
    enqueueCancels: () => cliSessions.enqueueCancels(),
    closeCli: () => cliSessions.closeAll(),
    closeIde: () => stopIde(),
    disconnect: () => uplink.disconnect(),
    releaseLock: () => releaseAgentLock(),
    exit: code => exitAfterFlush(code),
  });
  shutdownLifecycle = lifecycle;

  /**
   * The server gave this machine's slot to another process. Subscribed **here**, right after the
   * handshake — not next to `rejected` further down: everything between this line and the driver
   * setup takes seconds (the sync sqlite open/rebuild), the socket listener is already live during
   * that window, and an event that arrives before a listener exists is dropped. Missing it is not
   * self-healing: we would keep running (and holding the lock) while the server discards everything
   * we report, and no watchdog rebuild corrects it because our socket never dropped.
   *
   * Whether we stand down is not a judgement call here: `readSuperseded` stands us down only for a
   * superseder that names itself, because that is the one case where staying alive would only flap the
   * slot. A superseder that cannot name itself took a slot the server already considered gone — we are
   * the newer code, we hold the lock, and our next registration (the watchdog's reconnect) takes the
   * slot back by the identity rule.
   *
   * Neither branch reconnects, re-registers or re-syncs on its own: standing down means exit, and
   * keeping the lock means doing nothing at all about the slot.
   */
  uplink.on('superseded', (payload: unknown) => {
    const { standDown, lines } = readSuperseded(payload);
    // A stand-down is an exit reason, so it goes to stderr like the refusal; keeping the lock is a
    // warning, and it has to be visible: "the console shows the other version" is the symptom the
    // reader will be staring at.
    const print = standDown ? console.error : console.warn;
    for (const line of lines)
      print(line);
    if (!standDown)
      return;
    // Shared shutdown disconnects only after CLI and IDE close, then releases the lock, then exits.
    // Doing those three here would drop the socket before the cancelled/cancel flush.
    void lifecycle.shutdown(1);
  });

  const includeProcess = includeProcessEnabled(cliFile);
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
  // Content side: `hasContent` keeps a slot with a disk shard readable even when its
  // host is not controllable here (see `contentDrivers`). Control side (`drivers`)
  // still decides the CDP slots below.
  const contentSources = contentDrivers();
  for (const { kind, driver } of contentSources) {
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
  const indexSources = contentSources
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
  // Every state:patch is numbered so the server can notice a lost one and ask for a full state.
  const patchSeq = new PatchSequencer();
  for (const { kind, driver } of drivers) {
    slots[kind] = createIdeSlot({
      kind,
      cdpUrl: driver.cdpUrlOf(config),
      selectors,
      config,
      runtime: runtimes[kind] ?? null,
      onPatch: (patch) => {
        uplink.send('state:patch', patchSeq.stamp(kind, patch));
      },
      onConnection: (connected: boolean) => {
        uplink.send('connection:status', { ide: kind, connected });
      },
    });
  }

  for (const { kind } of contentSources) {
    const slot = slots[kind];
    // A content-only slot (shard on disk, host not created here) has no state to mark.
    if (!slot)
      continue;
    applyContentSource(diskAdapters[kind] ?? null, source => slot.stateManager.setContentSource(source));
  }

  stopIde = async () => {
    indexReporter.stop();
    for (const { kind } of contentSources) {
      runtimes[kind]?.stop();
      diskAdapters[kind]?.close?.();
    }
    await Promise.all(drivers.map(({ kind }) => slots[kind]!.stop()));
  };

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
            uploadDir: config.uploadDir,
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
    uplink.send('state:full', { ides, patchSeq: patchSeq.baseline() });
    for (const { kind } of drivers) {
      const active = runtimes[kind]?.getActiveSession();
      if (active)
        runtimes[kind]?.requestSession(active);
    }
  };
  uplink.on('connected', sendFullState);
  uplink.on('sync', (payload?: { reason?: string }) => {
    // The server may have a fresh ledger (this machine just connected, or was
    // just deleted on the web): re-report the full census too, or an unchanged
    // fingerprint skips every round and the server stays empty.
    // Exception: a patch-gap sync only says the live state drifted; the census is
    // untouched, and re-sending hundreds of session rows for it would be waste.
    if (payload?.reason !== SYNC_REASON_PATCH_GAP)
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
      // Present-but-unknown (a server newer than this build): never fold into cursor —
      // answering would project Cursor's body for another slot's session, and the
      // `session:missing` reply would be recorded under cursor. The server gates
      // routing on `slots`; this is defense in depth.
      if (payload?.ide !== undefined && !isIdeKind(payload.ide)) {
        console.warn(`[agent] session:get for unknown ide "${String(payload.ide)}" ignored`);
        return;
      }
      const ide = parseIde(payload?.ide);
      const source = diskAdapters[ide];
      const target = runtimes[ide];
      const sessionId
        = payload?.sessionId || resolveSessionId(source?.listSessions() ?? [], payload ?? {});
      if (!sessionId) {
        // A tabTitle-only request that matches nothing has no id to answer with; the page
        // waits on a skeleton, so make the drop visible in the log.
        if (typeof payload?.tabTitle === 'string' && payload.tabTitle.length > 0)
          console.warn(`[agent] session:get tabTitle="${payload.tabTitle}" ide=${ide}: no session on disk`);
        return;
      }
      // No runtime for this slot (its disk adapter never opened): answer explicitly.
      // Silence here is the worst outcome — the web has no timeout and sits on a
      // skeleton forever, which is exactly what "slots over-reported" would cause.
      if (!target) {
        uplink.send('session:missing', { sessionId, ide });
        return;
      }
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

  // Content runtimes belong to `contentSources`, which can exceed the control set: a
  // slot with a disk shard but no host (plugin removed / restored data) gets an adapter,
  // a census source and `slots` membership — without `start()` it would answer one
  // `session:get` and then never push append/patch, freezing the page's body.
  for (const { kind } of contentSources) {
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

  process.on('SIGINT', () => {
    if (lifecycle.shuttingDown)
      return;
    console.log('\n[agent] Shutting down...');
    void lifecycle.shutdown(0);
  });
  process.on('SIGTERM', () => {
    if (lifecycle.shuttingDown)
      return;
    console.log('\n[agent] Shutting down...');
    void lifecycle.shutdown(0);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`[agent] Unhandled rejection: ${String(reason)}`);
  });
}

main().catch((err) => {
  const msg = `[agent] Fatal error: ${err instanceof Error ? err.message : String(err)}\n${err instanceof Error ? err.stack ?? '' : ''}`;
  console.error(msg);
  const lifecycle = shutdownLifecycle;
  if (lifecycle)
    void lifecycle.shutdown(1);
  else
    void exitAfterFlush(1);
});
