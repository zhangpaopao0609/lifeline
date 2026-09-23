# 自托管（Docker）

[English](../selfhost.md) | **简体中文**

> `Dockerfile`（两阶段）+ `docker-compose.yml`（模板）+ `scripts/selfhost.sh`（幂等安装器）。

## 快速开始

```bash
mkdir lifeline && cd lifeline
curl -fsSL <selfhost.sh 地址> | sh     # 或直接拷仓库 scripts/selfhost.sh
# 浏览器开 http://<host>:8080
docker logs lifeline                   # 抄首启 claim 码 → 页面设密码
```

## 镜像结构（改 Dockerfile 前先读）

- **两阶段同 base**（`node:22-bookworm-slim`）：better-sqlite3 的预编译 `.node` 与运行时 Node 的 ABI 必须一致——run 阶段带 build 阶段装好的整包 `node_modules`（不为省体积拆依赖清单，slim 镜像可接受）。
- **依赖安装只有一层**（pnpm 迁移后）。原来是两层：`npm ci` 对「lockfile 声明、但文件系统里还没有的 workspace」会把它的依赖**整体剔除**，所以 web 必须单独 `npm --prefix packages/web install` 补一层。**pnpm 没有这个行为** —— 它按 `pnpm-workspace.yaml` 的 glob 实际扫目录，缺失的 workspace 只是不参与，不牵连别的包。所以现在是「先 COPY 全部 workspace 的 package.json + 四个清单文件 → 一次 `pnpm install --frozen-lockfile`」。改回两层不是错，但没必要；**别再退回 npm**（仓库里已经没有 `package-lock.json`，`npm ci` 会直接炸）。
- **发布镜像用 buildx 多平台**（`--platform linux/amd64,linux/arm64`）：本机直接 `build` 出的是**本架构**镜像——arm64 Mac 上出的镜像在 x64 服务器 `pull` 报 no matching manifest。与「同 base 保 ABI」同主题。
- **runtime 只打 linux-x64**（`PACK_TARGETS=linux-x64`）：容器平台固定；其余四平台 tarball 是 agent 装在用户机器上的资产，server 只做静态分发。要全平台分发改这行或外挂 CDN。
- `.dockerignore` **只排除根层** `node_modules`/`dist`（`/` 前缀）——全层级排除会挡掉 workspace 依赖解析。

## env 变量（`.env`）

| 变量 | 作用 |
|---|---|
| `LIFELINE_PORT` | compose 侧端口（默认 8080；改端口需删掉 docker-compose.yml 重跑 selfhost.sh，或手改其中的 ports） |
| `AUTH_PASSWORD` | 预设密码，跳过 claim（自动化用；值在进程 env 可见） |
| `AUTH_HEADER` + `AUTH_TRUSTED_PROXY=1` | 网关注入用户头模式（CF Access / Authelia / nginx auth_request；网关必须剥离客户端同名头） |
| `PUBLIC_ORIGIN` | 反代后的对外地址（`https://lifeline.example.com`）——password 模式的 WS Origin 校验与 cookie Secure 都看它 |
| `AUTH_AVATAR_URL` | 头像 URL 模板（必须含 `{userId}`，如 `https://cdn.example.com/avatars/{userId}.png`）；不设则网页画首字母块 |
| `TZ` | 时区 |

> ⚠️ **容器部署别动这三个**（镜像已钉死）：`SERVER_HOST` / `SERVER_PORT` / `DATA_DIR`。compose 的 env_file 优先级**高于**镜像 ENV——抄 `.env.example` 时把 `SERVER_HOST=127.0.0.1` 带进来会废掉端口映射，`DATA_DIR=./data` 会让 SQLite 写进容器层（`down/up` 数据全丢）。

完整鉴权矩阵（含 `AUTH_PROVIDER` 显式指定、`AUTH_INSECURE_ALLOW`）见根 `.env.example`。

## 反代（可选）

password 模式 + https 反代的最小 Caddy：

```
lifeline.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

nginx 等价（**必须**透传 Host 或 X-Forwarded-Host，WS Origin 校验靠它）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # WS（/socket.io 与 /agent-io）
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400;
}
```

## 数据与升级

- **一切状态在 `./data` 卷**（`lifeline.sqlite`：users / machines / 会话镜像 / `auth_local` 密码与会话密钥）——备份 = 备份这个目录（建议停容器后 `sqlite3 data/lifeline.sqlite ".backup …"`）。容器以 root 跑，`./data` 由 docker 以 root 属主创建——非 root 用户拷贝要 `sudo`。
- **升级**：`docker compose pull && docker compose up -d`。DB 迁移（如有）在 server 打开库时自动执行（`applySchema` 的 ALTER 幂等链，见 `db/open.ts`）。生产环境建议把 image pin 到具体 tag（`ghcr.io/…:v0.1.x`）而不是 `latest`——升级 = 改 tag 再 up，回退 = 改回旧 tag（latest 不可回退）。
- **回退**：镜像 tag 回退 + 恢复备份的 data 目录（迁移是单向的——升级前先备份）。

## 接入机器

server 起来后，接入命令从**它自己的 origin** 分发（`__SERVER_ORIGIN__` 改写，零配置）：

```bash
curl -fsSL http://<server>:8080/public/install.sh | sh
lifeline setup --server-url http://<server>:8080
```

## 已知边界（判据）

- **本机（macOS/podman）无 compose 实现**：selfhost.sh 的 compose 路径在真实 docker 环境验证过文件生成/幂等/提示语义，`up -d` 全链路待在 Linux 机器补一次冒烟。
- **容器里 `SERVER_HOST=0.0.0.0` 是预期**：暴露面由 compose `ports` 与 auth factory 守卫共同控制（无 AUTH 配置 → password provider，非 loopback 绝不落 none）。
- **`temp/server.log`**：server 在容器 cwd 自动建 `temp/`（`index.ts` 的 mkdirSync 兜底）；容器日志看 stdout 即可。
- **只跑单副本**：机器注册表、socket.io 房间、机器快照都在 server 进程内存里（持久化只有一份 `lifeline.sqlite`）——不要起多个 server 实例。
