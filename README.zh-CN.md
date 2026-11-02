# Lifeline

[English](./README.md) | **简体中文**

**远程控制本机上的 Cursor / CodeBuddy IDE** —— 在手机或浏览器上实时查看会话、批准操作、发送任务。

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
| `lifeline start` | 确保后台 agent 在跑 |
| `lifeline start --foreground` | 前台调试运行 |
| `lifeline status` | 体检：版本、配置、CDP、服务器连通性 |
| `lifeline update` | 升级到最新版（`--force` 强制重装） |
| `lifeline stop` | 停守护进程，但保留安装 |
| `lifeline uninstall` | 卸掉后台服务（保留 ~/.lifeline 和 CLI） |
| `lifeline open` | 打开网页控制台 |
| `lifeline config path` | 打印配置文件位置 |

`lifeline status` 会与最新版比对，落后即提示 `lifeline update`。

## DeepSeek Harness 命令行（macOS）

Lifeline 也支持通过 ACP profile 创建和控制 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 会话。请先在本机安装 `dsh` 并配置好它的模型服务凭据。`lifeline setup` 会从 PATH 自动发现 `dsh`；已安装的用户也可以在 `~/.lifeline/config.json` 中设置绝对路径 `dshCliPath`，再运行 `lifeline start`。

在控制台新建 CLI 会话，选择 **DeepSeek Harness**，填写工作目录的绝对路径，即可选择模型和推理强度、查看回答与工具活动、单次允许或拒绝操作、停止任务。agent 在本机启动 `dsh --profile acp`，凭据沿用本地 DSH 配置。

Lifeline agent 重启后会通过 `session/resume` 恢复 DSH 的模型上下文。DSH 的 ACP 接口不回放历史消息，因此恢复后的网页时间线从空白开始显示后续活动。DSH 不提供终端恢复命令按钮。此功能沿用 Lifeline 现有的 macOS CLI 控制范围。

## 卸载

```bash
curl -fsSL http://<your-lifeline-server>/public/uninstall.sh | sh
```

`lifeline stop` 只停不卸；`lifeline uninstall` 卸掉后台服务。

## 架构

```
浏览器 ──HTTP/WS──> packages/server  <──出站 WS + 机级 token──  packages/agent ──CDP(loopback)──> Cursor / CodeBuddy
```

- **server**：云端，静态页 + Fastify + socket.io，**不做任何 CDP**
- **agent**：本地瘦客户端，跑磁盘会话投影与 CDP 活态栈，**出站**连接远端（不需要公网入口）
- **web**：Vite + React，控制台 + 官网

机器身份与归属 token 存在 `~/.lifeline/config.json`；server 侧握手认不出归属就拒连。

## 参与开发

见 [`CONTRIBUTING.zh-CN.md`](CONTRIBUTING.zh-CN.md)。给 AI agent 的项目上下文（架构、命令、踩坑）在 [`AGENTS.md`](AGENTS.md)（英文，无中文配对）。

## 安全

- CDP 端口无鉴权，等同本机任意代码执行：**不得**暴露到公网（agent 只从 loopback 访问它）
- 密钥只存在于 server 的 `.env` 与本机 `~/.lifeline/config.json`，不进代码、不进提交
- 不分发共享 `AGENT_TOKEN`：每台机器用接入者自己的登录身份
- 鉴权矩阵（`AUTH_HEADER` / `AUTH_PASSWORD` / `AUTH_INSECURE_ALLOW`）见根 `.env.example`

---

## 许可证

[MIT](LICENSE) © 2026 zhangpaopao0609
