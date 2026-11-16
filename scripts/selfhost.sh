#!/bin/sh
# Lifeline self-host installer: one command to start the server.
#
#   mkdir lifeline && cd lifeline
#   curl -fsSL <url of selfhost.sh> | sh
#
# Steps (all idempotent, safe to re-run):
#   1. Generate .env (leave it alone if it already exists)
#   2. Generate docker-compose.yml (leave it alone if it already exists)
#   3. Require PUBLIC_ORIGIN=https://... and refuse AUTH_PASSWORD, before docker starts
#   4. Detect docker (compose v2 subcommand or standalone)
#   5. docker compose up -d + wait for /healthz
#
# The published port is 127.0.0.1 only. Put a reverse proxy on 443, then register at /register.
# The first run writes .env and stops until PUBLIC_ORIGIN is an https origin.
set -e

IMAGE="${LIFELINE_IMAGE:-ghcr.io/zhangpaopao0609/lifeline:latest}"
PORT="${LIFELINE_PORT:-8080}"

# ---- Validate env vars before they enter the heredoc (unquoted heredoc is raw text substitution; values with spaces/
#      quotes/newlines produce broken YAML or even inject arbitrary compose keys) ----
case "$IMAGE" in
  ''|*[!A-Za-z0-9._:/@-]*)
    echo "错误：LIFELINE_IMAGE 含非法字符（只允许 镜像名:tag 的字符集）：$IMAGE" >&2
    exit 1
    ;;
esac
case "$PORT" in
  ''|*[!0-9]*)
    echo "错误：LIFELINE_PORT 必须是纯数字：$PORT" >&2
    exit 1
    ;;
esac

# ---- docker / podman detection (detect after files are generated: if compose is missing the files are already ready,
#      so the user can install compose and re-run this script without starting over) ----
detect_compose() {
  if command -v docker >/dev/null 2>&1; then
    ENGINE="docker"
  elif command -v podman >/dev/null 2>&1; then
    ENGINE="podman"
  else
    echo "提示：未找到 docker/podman——.env 与 docker-compose.yml 已生成，装好容器运行时后重跑本脚本即可。" >&2
    return 1
  fi
  if $ENGINE compose version >/dev/null 2>&1; then
    COMPOSE="$ENGINE compose"
  elif command -v "$ENGINE-compose" >/dev/null 2>&1; then
    COMPOSE="$ENGINE-compose"
  else
    echo "提示：未找到 $ENGINE compose——.env 与 docker-compose.yml 已生成，装好 compose 后重跑本脚本即可。" >&2
    return 1
  fi
  return 0
}

# ---- .env (idempotent: do not overwrite if it already exists) ----
if [ ! -f .env ]; then
  cat > .env <<'ENVEOF'
# Lifeline server config. Password accounts: register a username at /register.
# The process listens on all container interfaces, so PUBLIC_ORIGIN must be https
# or the server refuses to start. AUTH_PASSWORD is rejected; delete it if present.
# AUTH_REGISTRATION=0 closes sign-up after the accounts you want exist.
#
# Common knobs (full table: https://github.com/zhangpaopao0609/lifeline docs/selfhost.md):
#   LIFELINE_PORT     # host port, published on 127.0.0.1 only — changing it requires deleting docker-compose.yml and re-running this script
#   AUTH_REGISTRATION=0
#   AUTH_HEADER=      # gateway-injected user header (CF Access / Authelia / nginx auth_request)
#   AUTH_TRUSTED_PROXY=1   # required for AUTH_HEADER off loopback, and for X-Real-IP rate limits behind nginx
#   PUBLIC_ORIGIN=https://lifeline.example.com
#   TZ=Asia/Shanghai
ENVEOF
  echo "已生成 .env（默认 password 模式）"
else
  echo ".env 已存在，保持不动"
fi

# ---- compose file (idempotent) ----
if [ ! -f docker-compose.yml ]; then
  cat > docker-compose.yml <<YMLEOF
services:
  lifeline:
    image: ${IMAGE}
    container_name: lifeline
    restart: unless-stopped
    ports:
      - "127.0.0.1:${PORT}:18765"
    volumes:
      - ./data:/data
    env_file:
      - .env
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:18765/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
YMLEOF
  echo "已生成 docker-compose.yml（镜像 ${IMAGE}）"
else
  echo "docker-compose.yml 已存在，保持不动"
fi

# ---- PUBLIC_ORIGIN / AUTH_PASSWORD (before docker: a missing https origin never becomes healthy) ----
# Read a single KEY=value. Do not source the file. Comments are ignored.
env_value() {
  key=$1
  file=$2
  val=$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)
  val=$(printf '%s' "$val" | tr -d '\r')
  case "$val" in
    \"*\") val=${val#\"}; val=${val%\"} ;;
    \'*\') val=${val#\'}; val=${val%\'} ;;
  esac
  printf '%s' "$val" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

# https origin, no userinfo, no query, no hash, path empty or "/". Scheme is case-insensitive.
https_origin_ok() {
  origin_lc=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$origin_lc" in
    https://*) ;;
    *) return 1 ;;
  esac
  rest=${origin_lc#https://}
  case "$rest" in
    ''|*'@'*|*'?'*|*'#'*|*'\'*|*[[:space:]]*) return 1 ;;
  esac
  host=${rest%%/*}
  path=${rest#"$host"}
  [ -n "$host" ] || return 1
  [ -z "$path" ] || [ "$path" = "/" ]
}

if [ -f .env ]; then
  auth_password=$(env_value AUTH_PASSWORD .env)
  public_origin=$(env_value PUBLIC_ORIGIN .env)
else
  auth_password=
  public_origin=
fi

if [ -n "$auth_password" ]; then
  echo "错误：AUTH_PASSWORD 已不再使用。从 .env 里删掉它。账号在 /register 注册，要关闭注册就设置 AUTH_REGISTRATION=0。" >&2
  exit 1
fi

if ! https_origin_ok "$public_origin"; then
  echo "错误：请在 .env 里设置 PUBLIC_ORIGIN=https://<你的域名>（https，不能带账号、查询或路径）。" >&2
  echo "容器监听 0.0.0.0，没有这个值时进程会拒绝启动，/healthz 不会就绪。" >&2
  echo "写好之后重新运行本脚本。" >&2
  exit 1
fi
public_origin=${public_origin%/}

# ---- start + health probe ----
if ! detect_compose; then
  exit 1
fi
$COMPOSE up -d

HOST_PORT="${PORT}"
# Minimal systems may not have curl — fall back to node fetch inside the container (the engine always has it)
if command -v curl >/dev/null 2>&1; then
  probe() { curl -fsS --max-time 2 "http://127.0.0.1:${HOST_PORT}/healthz" >/dev/null 2>&1; }
else
  probe() { $ENGINE exec lifeline node -e "fetch('http://127.0.0.1:18765/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; }
fi
printf '等待 /healthz ...'
i=0
while [ $i -lt 60 ]; do
  if probe; then
    echo " ok"
    echo ""
    echo "Lifeline 已在本机 127.0.0.1:${HOST_PORT} 就绪。"
    echo "用 nginx 或 Caddy 把 443 反代到这个端口，并设置 AUTH_TRUSTED_PROXY=1 与 X-Real-IP。"
    echo ""
    echo "首次使用："
    echo "  1. 打开 ${public_origin}/register ，注册用户名和密码"
    echo "  2. 账号够了之后，把 AUTH_REGISTRATION=0 写进 .env 再重启，关掉注册"
    echo ""
    echo "接入你的电脑："
    echo "  curl -fsSL ${public_origin}/public/install.sh | sh"
    echo "  lifeline setup --server-url ${public_origin}"
    exit 0
  fi
  printf '.'
  i=$((i + 1))
  sleep 1
done
echo ""
echo "错误：约 60 轮探活后 /healthz 仍未就绪（每轮最多 2s 探测 + 1s 间隔）。排查：" >&2
echo "  $ENGINE logs lifeline" >&2
echo "  $COMPOSE ps" >&2
exit 1
