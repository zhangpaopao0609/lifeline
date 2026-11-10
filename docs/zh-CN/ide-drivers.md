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

- **Cursor 子代理也是已保存的 composer 会话。** `task_v2.result.agentId` 就是子会话的 composer id；结果尚未落盘时，用父会话的 `subagentComposerIds` 对照子会话的 `subagentInfo.parentComposerId` 和 `toolCallId` / `toolCallIdHistory` 关联。即使任务 bubble 没变，关联变化也必须使投影指纹失效。阅读子会话时应与当前/父会话并行跟随，不能抢走其跟随目标；只读数据源机器也一样。
- **runtime 回调签名带 `ide` 参数位**：`ContentLiveRuntime` 的 onSessionFull/Append/Patch/Sync 是 `(sessionId, messages, ide, seq)`——runtime 自己传 `adapter.ide`，别用外层循环变量遮蔽（等价但少了参数位会 TS 报错）。
- **`ContentSource.close()` 是可选方法**：调用要 `adapter.close?.()`。
- **`CursorWindow['kind']` 可选**（`kind?`）：driver 接口的 windowKind 标注用 `WindowKind`，调用方自己 `?? 'project'` 兜底。
- **extractor 回调的 errorMessage 是 `string | null | undefined`**：工厂上下文类型按此标注。
- **Cursor Agents Window 把消息头搬进了 `composerConvHeaders` 分块**（实测 2026-10-31，Windows Cursor，`state.vscdb` 三张表：`ItemTable` / `composerHeaders` / `cursorDiskKV`）：新形态会话的 `composerData.fullConversationHeadersOnly` 是**空数组**、`conversationMap` 是空对象，头改存 `cursorDiskKV` 的 `composerConvHeaders:<composerId>:<6 位补零 chunk>`（`chunkSize` 256 条一块），由 `composerData.headerLog {chunkSize, chunkCount, count, generation}` 指路；正文仍是老 key `bubbleId:<sid>:<bid>`，分块头里的 `bubbleId` 直接带 `/s:N` 后缀，正好等于正文 key 的后半段。老会话的内联数组还在，且**两者 `_v` 都是 18**——不能按版本号分支，只能看 `headerLog`。只读内联数组 → 列表有条目、点开「会话为空」。`cursor-adapter.ts` 的 `readHeaders()` 是唯一入口（按 `chunkCount` 截掉 trim 遗留的陈旧尾块；chunk 还没落地时回退内联数组）。
- **composer 附件走 `command:send_message`，不走上传接口。** 字节以 base64 放在命令载荷里，agent 写到 `~/.lifeline/uploads` 后二选一：原生粘贴给 IDE，或把本地路径打进 prompt。`commandPayloadSchema` 是普通 `z.object`，旧版 server 或 agent 会把 `attachments` **静默剥掉**而文字照发——消息到了、文件没了。三端必须一起升。
- **粘贴打的是「前台」那个 composer，所以 `landOnOpenChat` 必须跑在 `materializeAttachments` 之前**（`command-router.ts`）：反过来的话文件粘进上一个会话、文字发进这一个。原生粘贴的成功判据是 composer 里**附件节点数真的增加**，绝不看 `preventDefault`——编辑器会吞掉一个它保不住的粘贴。只吃进一部分（4 个里 2 个）按失败处理，改走路径文本：模型看不见的 chip 比一条能读的路径更糟。别把判据放宽成「IDE 没报错」。
- **`preserveComposer` 的含义是编辑器里已经躺着原生附件。** 不要再来一遍「全选 + 重打」：`codebuddy/executor.ts` 在纯附件发送时跳过 insert，`cursor/executor.ts` 保留 chip 节点。重打会删掉附件，消息带着文字发出去、文件没了。
- **Cursor 侧边栏「运行中」图标是 glass 点阵 loader**（CDP 实测 2026-10-10，Cursor 3.24.9）：运行中的会话行，前导图标是 `.agent-sidebar-cell-icon .ui-dot-grid-loader[data-shape="sine_3x3"]`（与 Agents 窗口的行同一个组件）；**旧 `.spinning-loader` / `.cursor-icon-modifier-spin` 在项目窗口里已不再出现**。`cursor/extractor.ts` 的 `cellIsRunning` 漏掉它就报 `active`，而 web 侧「行状态优先于窗口级 live」（`hasRowStatus`）→ 顶部写"空闲"、composer 不锁（用户反馈：会话明明在跑）。判定必须限定在 `.agent-sidebar-cell-icon` 槽位内：已完成行那里是 `.ui-agent-status-dot[data-variant=done-seen]`，不要把它当 running。
- **CodeBuddy 还能以 VSCode 插件形态运行，所有 VSCode 相关行为都必须过插件门控**（实测 2026-11-03，VSCode + `tencent-cloud.coding-copilot`）：coding-copilot 面板本质是扩展 webview，所以同一个 `codebuddy` IDE 种类即可覆盖两种宿主 —— webview DOM 相同（extractor/executor 零改动）、历史根目录同为 `CodeBuddyExtension/Data`（插件写在 `<uid>/VSCode/`，IDE 写在 `<uid>/CodeBuddyIDE/`，adapter 两者都扫）。**2026-11-04 已对真实 VSCode 1.144.1 端到端实测**（临时 `--user-data-dir` 实例）：插件 webview 的 CDP target URL 形如 `vscode-webview://<hash>/index.html?...&extensionId=Tencent-Cloud.coding-copilot&...` —— 原版 VSCode 把扩展身份编码在 query 参数里（CodeBuddy IDE fork 则直接用 origin 命名），**两种形态都含小写 `coding-copilot` 子串**，`pickCodingCopilotTarget` 的过滤器无需改动；在该 webview 上真实跑 `dumpCodeBuddyLive` 能取到 Craft/Auto 模式-模型字段（DOM 一致）。另实测：**已有实例在跑时 `open -a "Visual Studio Code" --args --remote-debugging-port=N` 不生效**（单例转发丢参——新进程打了 `DevTools listening` 就退出），这正是 relauncher 必须 quit-first 的原因。差异只在启动/路径，门控是 `vscodeCodeBuddyPluginInstalled()`（`~/.vscode/extensions/tencent-cloud.coding-copilot*`）：**不加门控的话，每台装了裸 VSCode 的机器都会被写 argv 端口、被自愈重启**（VSCode 几乎人手一份，CodeBuddy IDE 不是）。规则：① VSCode 只有通过门控才加入 `isRunning`/quit/open 这个「家族」；② quit 必须记住退的是哪个产品、open 重开**同一个**（退了插件版 VSCode 却拉起 CodeBuddy 比不自愈更糟），并且**只能有单目标**：两个平台都是「有 CodeBuddy 镜像就只退它，否则只退 Code.exe」（Windows 侧是 `pickCodeBuddyQuitImagesWin`）。⚠️「杀哪些」和「等谁退出」必须是同一个集合——`quitProcessWin` 缺省就从被杀列表推导轮询，别另传一个家族谓词：传了之后 `taskkill` 只打到 CodeBuddy、轮询却把还在跑的 `Code.exe` 算进来，quit 永远等不到退出 → `skipped-quit-pending` → Windows 上插件机器永远不自愈；③ 端口/argv 候选列表保持**纯函数**——driver 显式传门控、函数默认「不含 VSCode」，测试才不依赖所在机器（默认走真实 IO 的门控曾让 `codeBuddyArgvCandidates` 在开发机返回 7 条、CI 上 6 条）；④ VSCode 的 argv.json 在**所有**平台都读 `~/.vscode/argv.json`——不像 Cursor/CodeBuddy 在 userDataDir；`removeCodeBuddyCdpArgv` 永远包含它（机器可能在卸载前就删了插件）；⚠️ **写入必须「每个装了的宿主各写一份」，不能「第一个装的产品赢」**（`resolveCodeBuddyArgvPaths`）：那条规则只对 CN/国际版互斥安装成立，VSCode 是**可以同时使用的第二个宿主**——只写独立 IDE 那份时，用户自己打开的 VSCode 永远没调试端口，于是每次都被自愈退出重开。**Linux** 上这份文件照样会写，尽管 agent 在那里从不控制 IDE（只是内容源）——Cursor / CodeBuddy IDE 一直是这个行为，现在扩展到 VSCode 那份；保持不加以让卸载逻辑对称，而且打开 `LIFELINE_LINUX_CDP=1` 后它是真的有用；⑤ probe（`probe.ts`）对 `codebuddy` 把 VSCode 的 workbench/UA 视为「不认识，放行」（自家人），仅对 `cursor` 视为 foreign；⑥ VSCode 窗口标题分隔符在 macOS 是 em dash（` — Visual Studio Code`）——`CODEBUDDY_TITLE_SUFFIXES` 两种横线都收；⑦ **`host` 是展示信息，来自连接的端点、不来自安装清单**：`hostOf`（probe）先看 workbench 的安装路径，其次看 UA（` Code/<n>`）；缺省 = 未知 → 控制台只显示产品名。**绝不能默认成 `ide`**：只有插件的机器会被提示去开一个它没装的程序。插件宿主的自愈/状态文案要说 **VS Code**（`ideSubject`），因为被退掉又重开的就是它。⑧ 端口发现要**走过没人应答的文件，绝不走过有人应答的**：宿主崩溃（而不是干净退出）会把 `DevToolsActivePort` 留在原地，而两个宿主各有一份——停在第一个能读的候选上，双装机器就永远读不到活着的那份，VSCode 每次冷启动都被退出重开。**只有 `no-listener` 才允许继续**（有人应答就采纳，这是 review R3 的教训）；返回给 bridge 的 `fileMtime` **和端点缓存的键**都必须跟着**实际采纳**的那份走：`cdp-bridge` 用它判断「重启后这张文件有没有变」，而第一个候选可能是另一个宿主的残留。⑨ **macOS 上判断「app 在不在跑」绝不能只信 `pgrep`**：2026-11-05 实测，CodeBuddy CN 的主进程对 `pgrep` 完全不可见（`-f "<App>.app/Contents/MacOS/"`、`-f CodeBuddy`、甚至 `-x Electron` 都不命中），而 `ps -axo pid=,command=` 能列出来——同一用户同一会话，Dock 启动和 `open --args` 启动都一样；同机 WorkBuddy 的 `Electron` 进程却能看见。后果：`isCodeBuddyRunning` 对运行中的 IDE 返回 false，家族判定被 VSCode 满足，自愈于是**退掉了 VSCode**，而不是那个没有端口的独立 IDE。所以有 `isDarwinProcessRunning`：`pgrep` 不中就用 `ps` 兜底（5 秒一份快照，所有 pattern 共用）。Windows 不需要对应处理：`tasklist` 按镜像名精确匹配，不依赖 argv。
