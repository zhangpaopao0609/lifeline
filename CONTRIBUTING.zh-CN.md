# 贡献指南

[English](./CONTRIBUTING.md) | **简体中文**

改动保持小而聚焦，提交前跑完最低验证。

## 前置

- **Node 22**（`.nvmrc` / `.node-version` / `engines` 三处锁定）。`better-sqlite3` 是原生模块，ABI 必须与 Node 一致，**别换版本**。bundle 的 agent runtime 也用 Node **22.19.0**。
- **pnpm**（`packageManager` 钉了版本，`corepack enable` 或自行装同版本）。工作区真源是 `pnpm-workspace.yaml`；npm 的 `package-lock.json` 已删除。
- 拉代码后 `pnpm install`：一次装齐 `packages/*`，并经 `prepare` 装上 husky git hooks。
- 调 server 时按需 `cp .env.example .env`；本地 loopback 不配任何 `AUTH_*` 也能起（单用户 `none` 模式）。

```bash
nvm use          # Node 22
pnpm install
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm run dev` | 只起 Vite（`http://localhost:5173`）。后端地址看 `VITE_RELAY_URL`（`packages/web/.env.development` → `http://127.0.0.1:3000`；生产用页面 origin） |
| `pnpm run dev:server` | 只起本仓库 Fastify server |
| `pnpm run dev:relay` | 同一 server，用 `tsx watch` |
| `pnpm run agent` | 起本地 agent（要调 CDP 时另开一个终端） |
| `npx tsc --noEmit` | 类型检查 |
| `pnpm lint` | ESLint（`@antfu/eslint-config`，扁平配置 `eslint.config.mjs`）——必须干净 |
| `pnpm lint:fix` | 同上并自动修复，它就是格式化工具（没有 prettier） |
| `pnpm test` | 全量测试（node:test + tsx，跑 `tests/*.test.ts`） |
| `pnpm run build` | 服务端构建（tsc，并把 `dist/cli/lifeline.mjs` 复制进 `dist/client/public/`，若已有） |
| `pnpm run build:web` | 前端生产构建（Vite） |
| `pnpm run build:cli` | CLI 单文件打包 |
| `pnpm run build:runtime` | agent runtime tarball（server 经 `/public/` 分发） |
| `pnpm run build:docker` | 自托管镜像（见 [`docs/zh-CN/selfhost.md`](docs/zh-CN/selfhost.md)） |

版本号唯一真源是根 `package.json`；客户端升级走 `lifeline update`（与 server 的 `/public/cli-latest.txt` 比对）。

lint + 格式化用 `@antfu/eslint-config`（`eslint.config.mjs`），没有 prettier。少数规则按本仓库习惯显式覆盖（node:test 的用例标题、分号、全局 `process`、单行箭头函数体），每条覆盖旁边都写了理由。配置末尾的 advisory 规则允许以 warning 通过：它们盯的是引入 lint 之前的老代码，需要人工过一遍。

**每次改动后的最低验证**：

```bash
npx tsc --noEmit && pnpm lint && pnpm test
```

**pnpm 的两条硬规矩**（错了要在用户机器上才发作）：

- `pnpm-workspace.yaml` 的 `allowBuilds` 里 `better-sqlite3: true` **不能删**：pnpm 默认不跑依赖的构建脚本，而包里不带预编译 `.node`，删了本地 DB 测试和 server 全起不来。
- `scripts/pack-runtime.ts` 拷 `node_modules` 下的包**必须 `dereference: true`**：pnpm 的顶层包是符号链接，不 dereference 就把悬空链接打进 runtime tarball。

## 代码结构

| 包 | 职责 |
|---|---|
| `packages/server` | 云端：静态页 + Fastify + socket.io，机器注册与归属过滤、会话镜像；**不做任何 CDP** |
| `packages/agent` | 本地瘦客户端：CDP 活态栈 + 磁盘会话投影 + 命令执行（`COMMAND_EVENTS` 在 protocol；handler 在 `src/command-router.ts`） |
| `packages/cli` | `lifeline` CLI；配置在 `~/.lifeline/config.json` |
| `packages/web` | Vite + React：官网（`/`）+ 控制台（`/console`），路径字面量只有 `src/lib/routes.ts` 一份。线协议类型从 `src/net/protocol.ts` 再导出 |
| `packages/protocol` | 共享类型、`IDE_KINDS`、`COMMAND_EVENTS` |

架构边界、改动入口表与「别改回」判据见 [`AGENTS.md`](AGENTS.md)（英文，无中文配对）。它是本仓库给 AI agent 的上下文真源，`CLAUDE.md` 是它的软链，**改内容只改 `AGENTS.md`**。

## 提交与分支

- 主分支 `master`，合入即可能上线。成块的改动开 `feat/xxx` / `fix/xxx` 分支走合并请求；小修可直接提交。
- 提交信息沿用 `type(scope): short summary`。type 用 `feat` / `fix` / `docs` / `chore` / `test` / `refactor`，例如：
  - `fix(agent): keep Linux as a content source; push identity checks to the connection layer`
  - `docs: keep agent context in AGENTS.md only`
  - `chore: bump 0.1.67 (CDP: do not pre-reserve ports; classify failures)`
- 不只是约定：husky 在 `commit-msg` 跑 commitlint（规则在 `commitlint.config.mjs`），在 `pre-commit` 跑 lint-staged（只对暂存文件 eslint --fix，配置 `lint-staged.config.mjs`）；`pnpm commit` 打开 commitizen 交互式提交，格式同上，scope 直接选包名。
- 一次提交只做一件事，顺手重构请单独提。

## 文档写在哪

| 内容 | 去处 |
|---|---|
| 每次都用得上的结论（是什么、怎么跑、怎么验） | `AGENTS.md`，只留结论（英文单份，无语言配对） |
| 对外专题文档 | 英文 `docs/<name>.md`（真源），简体中文 `docs/zh-CN/<name>.md`。根目录 `README` / `CONTRIBUTING` 用兄弟文件 `*.zh-CN.md` |
| 实现细节、踩坑、设计 spec、计划 | `docs/` 下的专题（如 [`ide-drivers.md`](docs/zh-CN/ide-drivers.md)、[`selfhost.md`](docs/zh-CN/selfhost.md)、[`lifeline-intro.md`](docs/zh-CN/lifeline-intro.md)、[`naming-brief.md`](docs/zh-CN/naming-brief.md)）。先改英文，再同步中文 |

新踩的坑写进 `docs/` 下对应专题文档，`AGENTS.md` 最多加一行指过去。

## 红线

- **CDP 无鉴权 = 任意代码执行**：9222 绝不能暴露公网，agent 只从 loopback 访问。
- 密钥不进代码、不进提交：server 的 `.env`、各机器的 `~/.lifeline/config.json`。
- 不要发共享 `AGENT_TOKEN`：机器归属靠接入时的登录身份，第一次注册定死、不可转让。
- 不要把 `EVALUATE_TIMEOUT_MS` 改小；不要换 Node 版本。
- `AGENTS.md` 里标注 **Do not revert** 的实现（免登录白名单只三条、Linux 只做数据源、停机 SIGTERM 硬超时、时间线不重新虚拟化、`session-index-reporter` 不调用 `listSessions()`、Windows 审批快捷键字符类含 `^`）：动之前先读代码注释与 `docs/` 下的专题文档。
- `agentId` 是 `machine-<uuid>`。不要退回主机名派生。
- Linux 控制不是产品面（`canControlIde()`）。逃生口是 `LIFELINE_LINUX_CDP=1`，不是探测 `DISPLAY`。
