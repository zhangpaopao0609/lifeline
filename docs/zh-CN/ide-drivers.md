# IDE Drivers（agent 侧的可插拔 IDE 适配层）

[English](../ide-drivers.md) | **简体中文**

## 拓扑

```
index.ts（遍历 registeredDrivers() 组装）
  └─ createIdeSlot(kind)            ← 纯骨架：查 DRIVERS[kind]，生命周期唯一
       ├─ driver.bridgeOptions()     CDP 桥差异（titleSuffixes/appNames/relauncher）
       ├─ driver.createExtractor()   DOMExtractor | CodeBuddyExtractor
       ├─ driver.createExecutor()    CommandExecutor | CodeBuddyExecutor
       ├─ driver.attachLive(handle)  连上后怎么接活态（差异最深处）
       └─ WindowMonitor              kind + driver.windowMonitor（声明式差异）
```

**一个 driver = 一种 IDE 的全部接线**：`cdpUrlOf`（config 字段映射）、`portCandidates`（DevToolsActivePort 发现）、`argvPaths`（CLI 写 argv.json）、`hasLiveApp`（探测，**只做安静策略绝不做闸门**）、`openDiskAdapter`（磁盘会话源：cursor SQLite / codebuddy JSON）、`capabilities`（命令能力矩阵，如 `getPlanFull`）。

## 关键设计决策（改的时候别推翻）

1. **活态连接策略整体归 driver，不做钩子回调**：CodeBuddy 是双连接模型——workbench CDP 之外，活态走 coding-copilot webview 的直连 `CdpClient`，带代际（liveGen）与 `nextReconnectDelay` 退避自愈（引擎在 `cdp/relaunch-engine.ts`）。这套状态机留在 slot 里只会重新长出 `kind ===` 分叉，所以整段搬进 `drivers/codebuddy/driver.ts`。Cursor 的 `attachLive` 就三行（直挂 workbench client）。
2. **per-slot 状态用 WeakMap**：driver 是单例，live 状态（gen/重试/客户端）挂 driver 实例会串槽——`codebuddy/driver.ts` 的 `liveStates = new WeakMap<LiveSlotHandle, LiveState>()`。测试建多个同 kind 槽互不干扰。
3. **driver 经 `LiveSlotHandle` 操作面驱动活态**，不碰 slot 私有状态——操作面（cdp / stateManager / extractor / executor / currentCdpUrl / 测试钩子）由 `createIdeSlot` 组装时构建，`CreateIdeSlotOptions` 的测试钩子原样透传。
4. **window-monitor 只外提声明式差异**：wsUrl 过滤（`otherWindowsRequireWsUrl`）进了 driver；`pollWindowParallel` 派发与 `extractFromClient` 防御保留在 monitor 内部（`pollCodeBuddyWindow` 深度绑定 monitor 私有状态，外提接口爆炸；新 IDE 本就需要新的窗口轮询实现）。
5. **connection:status 是 per-ide 的**：agent 按 driver 各报各的（payload 带 `ide`），server `applyConnection` 写对应槽；老 agent（≤0.1.72）不带 `ide` 回落 cursor 槽。旧的 `reportsConnectionStatus` quirk（只报 cursor）已废除。

## 加新 IDE 的清单

1. `packages/protocol/src/wire.ts`：`IDE_KINDS` 加一项（类型/zod/标签/清单全部自动扩散）
2. `packages/agent/src/drivers/<kind>/`：一个目录装下该 IDE 的全部实现——`driver.ts`（探测、端口、argv、磁盘源、capabilities 接线）+ `extractor.ts` / `executor.ts` / `live.ts` / `relaunch.ts` 等（**IDE 本身的差异实现，躲不掉**；结构对照 `cursor/` 与 `codebuddy/`，两边对称）
3. `drivers/index.ts`：注册
4. `window-monitor.ts`：该 IDE 的窗口轮询实现（见决策 4）
5. CLI 的 argv ensure/remove 若该 IDE 需要（函数层表驱动）
6. server 侧零改动（`Partial<Record<IdeKind, …>>` 已扩散）

## 踩坑（判据）

- **runtime 回调签名带 `ide` 参数位**：`ContentLiveRuntime` 的 onSessionFull/Append/Patch/Sync 是 `(sessionId, messages, ide, seq)`——runtime 自己传 `adapter.ide`，别用外层循环变量遮蔽（等价但少了参数位会 TS 报错）。
- **`ContentSource.close()` 是可选方法**：调用要 `adapter.close?.()`。
- **`CursorWindow['kind']` 可选**（`kind?`）：driver 接口的 windowKind 标注用 `WindowKind`，调用方自己 `?? 'project'` 兜底。
- **extractor 回调的 errorMessage 是 `string | null | undefined`**：工厂上下文类型按此标注。
