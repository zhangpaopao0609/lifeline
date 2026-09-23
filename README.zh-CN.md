# Lifeline

[English](./README.md) | **简体中文**

**远程控制本机上的 Cursor / CodeBuddy** —— 在手机或浏览器上实时查看 IDE 会话、批准操作、发送任务。

你的代码、IDE、环境都还在那台电脑上；Lifeline 只是把会话投影到网页，让你能从那台电脑前走开。

- 产品介绍：[`docs/zh-CN/lifeline-intro.md`](docs/zh-CN/lifeline-intro.md)
- 自托管：[`docs/zh-CN/selfhost.md`](docs/zh-CN/selfhost.md)

## 在网页上能做什么

- **看会话**：本机磁盘上的会话实时投影到网页（消息、代码、工具调用、计划进度），不是另开的云端会话
- **批准 / 拒绝**：shell 命令、文件修改、MCP 调用、模式切换等审批卡的每个按钮都画出来
- **回答问卷、发新指令、随时叫停**：发送有「送达 / 已确认 / 失败可重试」三态；停止等同于 IDE 里那颗停止键
- **多台机器、两个槽**：同一账号下的机器列表；Cursor 与 CodeBuddy 分开显示、分开控制
- **离线机器也能看**：显示最后一份镜像（只读），不会白屏

## 接入一台电脑

先在任意能跑 Docker 的机器上起一台 server（见 [`docs/zh-CN/selfhost.md`](docs/zh-CN/selfhost.md)），
然后在被控电脑（macOS / Linux，x64 或 arm64）上执行两条命令：

```bash
curl -fsSL http://<your-lifeline-server>/public/install.sh | sh
lifeline setup --server-url http://<your-lifeline-server>
```

- 不需要预装 Node：安装脚本下载自带 runtime（Node + CLI + better-sqlite3），并做 sha256 校验
- 安装位置：runtime 在 `~/.lifeline/`，命令在 `~/.local/bin/lifeline`（不在 PATH 时脚本会给出追加方法）
- 源站地址就是上面那个（自托管常见 `http://<host>:8080`；有证书就用 https）
- `setup` 打开浏览器完成登录（自托管是密码 / 网关鉴权），机器归属记在登录人名下，之后只有本人能看见这台机器
- CDP 端口由 agent 自行拉起，不用手动配置
- 不支持 Alpine（musl）

## 日常命令

| 命令 | 作用 |
|---|---|
| `lifeline setup --server-url <url>` | 浏览器登录并拉起 agent |
| `lifeline status` | 体检：版本、配置、CDP、服务器连通性 |
| `lifeline update` | 升级到最新版（`--force` 强制重装） |
| `lifeline stop` | 停守护进程，但保留安装 |
| `lifeline daemon install` / `uninstall` / `status` | 守护进程的装 / 卸 / 看 |
| `lifeline start` | 前台跑 agent（调试用） |
| `lifeline open` | 打开网页控制台 |
| `lifeline config path` | 打印配置文件位置 |

`lifeline status` 会与最新版比对，落后即提示 `lifeline update`。重跑 `install.sh` 也算升级，但要守护进程跑上新代码需 `lifeline daemon install` 重启。

## 卸载

```bash
curl -fsSL http://<your-lifeline-server>/public/uninstall.sh | sh
```

`lifeline stop` 只停不卸；`lifeline daemon uninstall` 才卸守护进程。

## 架构

```
浏览器 ──HTTP/WS──> packages/server  <──出站 WS + 机级 token──  packages/agent ──CDP(loopback)──> Cursor / CodeBuddy
```

- **server**：云端，静态页 + Fastify + socket.io，**不做任何 CDP**
- **agent**：本地瘦客户端，跑磁盘会话投影与 CDP 活态栈，**出站**连接远端（不需要公网入口）
- **web**：Vite + React，控制台 + 官网

机器身份与归属 token 存在 `~/.lifeline/config.json`；server 侧握手认不出归属就拒连。

## 仓库结构

| 目录 | 内容 |
|---|---|
| `packages/server` | Fastify + socket.io：机器注册、会话镜像、静态页 |
| `packages/agent` | 本地 agent：CDP 活态、磁盘会话投影、命令执行 |
| `packages/cli` | `lifeline` CLI：安装、setup、守护进程、升级 |
| `packages/web` | Vite + React 控制台与官网（`public/install.sh` 也在这里） |
| `packages/protocol` | 前后端共享类型与协议 |
| `tests/` | node:test 全量测试 |

## 参与开发

见 [`CONTRIBUTING.zh-CN.md`](CONTRIBUTING.zh-CN.md)。给 AI agent 的项目上下文（架构、命令、踩坑）在 [`AGENTS.md`](AGENTS.md)（英文，无中文配对）。

## 文档

| 文件 | 内容 |
|---|---|
| [`docs/zh-CN/lifeline-intro.md`](docs/zh-CN/lifeline-intro.md) | 产品介绍（只谈功能） |
| [`docs/zh-CN/ide-drivers.md`](docs/zh-CN/ide-drivers.md) | IDE 适配层（driver 注册表与踩坑判据） |
| [`docs/zh-CN/selfhost.md`](docs/zh-CN/selfhost.md) | 自托管（Docker 镜像、env、反代） |
| [`docs/zh-CN/naming-brief.md`](docs/zh-CN/naming-brief.md) | 命名记录（为何叫 Lifeline / 生命线） |

公开文档英文在无后缀文件，中文在 `*.zh-CN.md`（根目录）或 `docs/zh-CN/`（专题）。

## 安全

- CDP 端口无鉴权，等同本机任意代码执行：**不得**暴露到公网（agent 只从 loopback 访问它）
- 密钥只存在于 server 的 `.env` 与本机 `~/.lifeline/config.json`，不进代码、不进提交
- 不分发共享 `AGENT_TOKEN`：每台机器用接入者自己的登录身份
- 鉴权矩阵（`AUTH_HEADER` / `AUTH_PASSWORD` / `AUTH_INSECURE_ALLOW`）见根 `.env.example`

---

## 许可证

[MIT](LICENSE) © 2026 zhangpaopao0609
