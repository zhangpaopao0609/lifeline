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
- **Cursor Agents Window 把消息头搬进了 `composerConvHeaders` 分块**（实测 2026-10-31，Windows Cursor，`state.vscdb` 三张表：`ItemTable` / `composerHeaders` / `cursorDiskKV`）：新形态会话的 `composerData.fullConversationHeadersOnly` 是**空数组**、`conversationMap` 是空对象，头改存 `cursorDiskKV` 的 `composerConvHeaders:<composerId>:<6 位补零 chunk>`（`chunkSize` 256 条一块），由 `composerData.headerLog {chunkSize, chunkCount, count, generation}` 指路；正文仍是老 key `bubbleId:<sid>:<bid>`，分块头里的 `bubbleId` 直接带 `/s:N` 后缀，正好等于正文 key 的后半段。老会话的内联数组还在，且**两者 `_v` 都是 18**——不能按版本号分支，只能看 `headerLog`。只读内联数组 → 列表有条目、点开「会话为空」。`cursor-adapter.ts` 的 `readHeaders()` 是唯一入口（按 `chunkCount` 截掉 trim 遗留的陈旧尾块；chunk 还没落地时回退内联数组）。
- **composer 附件走 `command:send_message`，不走上传接口。** 字节以 base64 放在命令载荷里，agent 写到 `~/.lifeline/uploads` 后二选一：原生粘贴给 IDE，或把本地路径打进 prompt。`commandPayloadSchema` 是普通 `z.object`，旧版 server 或 agent 会把 `attachments` **静默剥掉**而文字照发——消息到了、文件没了。三端必须一起升。
- **粘贴打的是「前台」那个 composer，所以 `landOnOpenChat` 必须跑在 `materializeAttachments` 之前**（`command-router.ts`）：反过来的话文件粘进上一个会话、文字发进这一个。原生粘贴的成功判据是 composer 里**附件节点数真的增加**，绝不看 `preventDefault`——编辑器会吞掉一个它保不住的粘贴。只吃进一部分（4 个里 2 个）按失败处理，改走路径文本：模型看不见的 chip 比一条能读的路径更糟。别把判据放宽成「IDE 没报错」。
- **`preserveComposer` 的含义是编辑器里已经躺着原生附件。** 不要再来一遍「全选 + 重打」：`codebuddy/executor.ts` 在纯附件发送时跳过 insert，`cursor/executor.ts` 保留 chip 节点。重打会删掉附件，消息带着文字发出去、文件没了。
- **Cursor 侧边栏「运行中」图标是 glass 点阵 loader**（CDP 实测 2026-10-10，Cursor 3.24.9）：运行中的会话行，前导图标是 `.agent-sidebar-cell-icon .ui-dot-grid-loader[data-shape="sine_3x3"]`（与 Agents 窗口的行同一个组件）；**旧 `.spinning-loader` / `.cursor-icon-modifier-spin` 在项目窗口里已不再出现**。`cursor/extractor.ts` 的 `cellIsRunning` 漏掉它就报 `active`，而 web 侧「行状态优先于窗口级 live」（`hasRowStatus`）→ 顶部写"空闲"、composer 不锁（用户反馈：会话明明在跑）。判定必须限定在 `.agent-sidebar-cell-icon` 槽位内：已完成行那里是 `.ui-agent-status-dot[data-variant=done-seen]`，不要把它当 running。
