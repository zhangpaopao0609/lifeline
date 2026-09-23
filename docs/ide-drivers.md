# IDE Drivers (pluggable IDE adapters on the agent)

**English** | [简体中文](./zh-CN/ide-drivers.md)

## Topology

```
index.ts (walks registeredDrivers() and wires them)
  └─ createIdeSlot(kind)            ← skeleton only: lookup DRIVERS[kind], one lifecycle
       ├─ driver.bridgeOptions()     CDP bridge diffs (titleSuffixes/appNames/relauncher)
       ├─ driver.createExtractor()   DOMExtractor | CodeBuddyExtractor
       ├─ driver.createExecutor()    CommandExecutor | CodeBuddyExecutor
       ├─ driver.attachLive(handle)  how live state attaches after connect (the deepest split)
       └─ WindowMonitor              kind + driver.windowMonitor (declarative diffs)
```

**One driver = all wiring for one IDE**: `cdpUrlOf` (config field map), `portCandidates` (DevToolsActivePort discovery), `argvPaths` (CLI writes argv.json), `hasLiveApp` (probe — **quiet policy only, never a gate**), `openDiskAdapter` (on-disk session source: cursor SQLite / codebuddy JSON), `capabilities` (command matrix, e.g. `getPlanFull`).

## Design decisions (do not overturn these)

1. **Live-attach policy lives entirely on the driver, not as hook callbacks.** CodeBuddy is dual-connection: besides workbench CDP, live state uses a direct `CdpClient` to the coding-copilot webview, with generation (`liveGen`) and `nextReconnectDelay` backoff (engine in `cdp/relaunch-engine.ts`). Leave that state machine in the slot and `kind ===` forks grow back, so the whole block moved into `drivers/codebuddy/driver.ts`. Cursor `attachLive` is three lines (hang the workbench client).
2. **Per-slot state is a WeakMap.** The driver is a singleton; live state (gen / retry / client) on the driver instance would leak across slots — `codebuddy/driver.ts` keeps `liveStates = new WeakMap<LiveSlotHandle, LiveState>()`. Tests can build several same-kind slots without crosstalk.
3. **The driver drives live state through the `LiveSlotHandle` surface**, not slot-private fields. The surface (cdp / stateManager / extractor / executor / currentCdpUrl / test hooks) is built when `createIdeSlot` assembles; `CreateIdeSlotOptions` test hooks pass through as-is.
4. **window-monitor only lifts declarative diffs.** wsUrl filtering (`otherWindowsRequireWsUrl`) is on the driver; `pollWindowParallel` dispatch and `extractFromClient` guards stay inside the monitor (`pollCodeBuddyWindow` is bound to monitor-private state; lifting it explodes the interface; a new IDE needs a new window poll anyway).
5. **`connection:status` is per-IDE.** The agent reports per driver (payload includes `ide`); server `applyConnection` writes the matching slot. Old agents (≤0.1.72) without `ide` fall back to the cursor slot. The old `reportsConnectionStatus` quirk (cursor only) is gone.

## Checklist for a new IDE

1. `packages/protocol/src/wire.ts`: add one `IDE_KINDS` entry (types / zod / labels / lists all fan out)
2. `packages/agent/src/drivers/<kind>/`: one directory for that IDE — `driver.ts` (probe, ports, argv, disk source, capabilities) + `extractor.ts` / `executor.ts` / `live.ts` / `relaunch.ts` as needed (**the IDE's own diffs cannot be avoided**; mirror `cursor/` and `codebuddy/`)
3. `drivers/index.ts`: register
4. `window-monitor.ts`: window poll for that IDE (see decision 4)
5. CLI argv ensure/remove if that IDE needs it (table-driven at the function layer)
6. Zero server changes (`Partial<Record<IdeKind, …>>` already fans out)

## Pitfalls (criteria)

- **Runtime callback signatures include an `ide` parameter.** `ContentLiveRuntime` onSessionFull/Append/Patch/Sync is `(sessionId, messages, ide, seq)` — the runtime passes `adapter.ide`. Do not shadow it with an outer loop variable (equivalent, but missing the parameter fails TS).
- **`ContentSource.close()` is optional:** call `adapter.close?.()`.
- **`CursorWindow['kind']` is optional** (`kind?`): the driver interface types windowKind as `WindowKind`; callers `?? 'project'`.
- **Extractor callback `errorMessage` is `string | null | undefined`:** factory context types must match.
