#!/bin/sh
# Lifeline self-host installer: one command to start the server.
#
#   mkdir lifeline && cd lifeline
#   curl -fsSL <url of selfhost.sh> | sh
#
# Four steps (all idempotent, safe to re-run):
#   1. Detect docker (compose v2 subcommand or standalone)
#   2. Generate .env (leave it alone if it already exists — your password/gateway config is not overwritten)
#   3. Generate docker-compose.yml (leave it alone if it already exists)
#   4. docker compose up -d + wait for /healthz
#
# Once up: open http://<this-machine-IP>:8080 in a browser → first-boot claim code is in the container logs:
#   docker logs lifeline
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
# Lifeline server config. All blank = password mode (after first opening the browser,
# the one-time claim code is in the container logs: docker logs lifeline).
#
# Common knobs (full table: https://github.com/zhangpaopao0609/lifeline docs/selfhost.md):
#   LIFELINE_PORT     # compose-side port — changing it requires deleting docker-compose.yml and re-running this script (or editing ports by hand)
#   AUTH_PASSWORD=    # preset password (skip claim; for automated deploys; the value is visible in the process environment)
#   AUTH_HEADER=      # gateway-injected user header (CF Access / Authelia / nginx auth_request)
#   AUTH_TRUSTED_PROXY=1   # required when AUTH_HEADER is set and not loopback (the gateway must strip same-named client headers)
#   PUBLIC_ORIGIN=    # public URL behind a reverse proxy (https://lifeline.example.com)
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
      - "${PORT}:18765"
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
    echo "Lifeline 已启动：http://$(hostname 2>/dev/null || echo localhost):${HOST_PORT}"
    echo ""
    echo "首次使用（password 模式）："
    echo "  1. 打开上面的地址"
    echo "  2. 取一次性引导码：$ENGINE logs lifeline"
    echo "     （找 'Open http://… and enter this one-time code:' 那一行的 64 位码）"
    echo "  3. 在页面里输入码 + 设置密码，之后用密码登录"
    echo ""
    echo "接入你的电脑："
    echo "  curl -fsSL http://<本机IP>:${HOST_PORT}/public/install.sh | sh"
    echo "  lifeline setup --server-url http://<本机IP>:${HOST_PORT}"
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
