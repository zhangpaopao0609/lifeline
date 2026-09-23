#!/bin/sh
# Lifeline agent installer
# Downloads a platform runtime (Node + CLI + better-sqlite3). No system Node required.
set -e

# Default origin is a placeholder: when the server distributes this script it rewrites it to "the origin
# of the request" (see trySendInstaller in packages/server/src/relay.ts), so `curl .../public/install.sh | sh`
# from any Lifeline origin works out of the box. Explicit LIFELINE_SERVER always wins.
# Unauthenticated assets (this script, the runtime package, checksum files) all live under /public.
# Call sites write the full `$BASE/public/...` instead of a constant: the https fallback below (must be opted in) rewrites BASE.
BASE="${LIFELINE_SERVER:-__SERVER_ORIGIN__}"
BIN_DIR="${LIFELINE_BIN_DIR:-$HOME/.local/bin}"
LIB_DIR="${LIFELINE_HOME:-$HOME/.lifeline}"

# Not rewritten by an origin (placeholder still here, e.g. running the copy in the repo locally) → fail closed, don't guess an origin.
# The comparison string is deliberately split in two: the server rewrite is a global replace, so writing the
# whole literal would replace it too, making "BASE == real origin" always true and killing every normally distributed script.
if [ "$BASE" = "__SERVER_ORIGIN""__" ]; then
  echo "错误：本脚本未经源站改写，或未设置 LIFELINE_SERVER。" >&2
  echo "请从你的 Lifeline server 下载执行，例如：" >&2
  echo "  curl -fsSL http://<your-lifeline-server>/public/install.sh | sh" >&2
  exit 1
fi

# Runtime already present = this is an upgrade, not a first install: the closing hint must become "restart the daemon",
# otherwise after re-running curl the daemon is still on old code (path unchanged; no restart, no effect).
if [ -f "$LIB_DIR/runtime/lifeline.mjs" ]; then
  was_installed=1
else
  was_installed=0
fi

os=$(uname -s)
arch=$(uname -m)
target=""
if [ "$os" = Darwin ]; then
  if [ "$arch" = arm64 ]; then
    target=darwin-arm64
  elif [ "$arch" = x86_64 ]; then
    translated=$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)
    if [ "$translated" = 1 ]; then
      target=darwin-arm64
    else
      target=darwin-x64
    fi
  fi
elif [ "$os" = Linux ]; then
  # glibc build; Alpine/musl is not supported. On an arm64 kernel the arch is aarch64.
  if [ "$arch" = x86_64 ]; then
    target=linux-x64
  elif [ "$arch" = aarch64 ] || [ "$arch" = arm64 ]; then
    target=linux-arm64
  fi
fi
if [ -z "$target" ]; then
  echo "错误：当前系统不受支持（需要 macOS 或 Linux，x64 / arm64）。" >&2
  echo "检测到：$os $arch" >&2
  exit 1
fi

PACKAGE="lifeline-${target}.tar.xz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading agent runtime from $BASE ..."
if ! curl -fL --progress-bar "$BASE/public/$PACKAGE" -o "$tmp/$PACKAGE"; then
  # https failure errors out by default — silent downgrade is a public security anti-pattern. Only an explicit
  # LIFELINE_ALLOW_INSECURE_HTTP=1 (e.g. the origin only listens on 80, or 443 gets reset) falls back to http;
  # the package still goes through the sha256 check below, so integrity is unaffected.
  case "$BASE" in
    https://*)
      if [ "${LIFELINE_ALLOW_INSECURE_HTTP:-0}" = "1" ]; then
        BASE="http://${BASE#https://}"
        echo "提示：LIFELINE_ALLOW_INSECURE_HTTP=1 —— https 不可用，改用 $BASE 重试。" >&2
        if ! curl -fL --progress-bar "$BASE/public/$PACKAGE" -o "$tmp/$PACKAGE"; then
          echo "错误：下载安装包失败。" >&2
          echo "$BASE/public/$PACKAGE" >&2
          echo "请检查网络后重试。" >&2
          exit 1
        fi
      else
        echo "错误：下载安装包失败。" >&2
        echo "$BASE/public/$PACKAGE" >&2
        echo "如源站只支持 http，可加 LIFELINE_ALLOW_INSECURE_HTTP=1 重试。" >&2
        echo "请检查网络后重试。" >&2
        exit 1
      fi
      ;;
    *)
      echo "错误：下载安装包失败。" >&2
      echo "$BASE/public/$PACKAGE" >&2
      echo "请检查网络后重试。" >&2
      exit 1
      ;;
  esac
fi
if ! curl -fsSL "$BASE/public/$PACKAGE.sha256" -o "$tmp/$PACKAGE.sha256"; then
  echo "错误：下载安装包失败。" >&2
  echo "$BASE/public/$PACKAGE.sha256" >&2
  echo "请检查网络后重试。" >&2
  exit 1
fi

if ! grep -Eq '^[a-f0-9]{64}  ' "$tmp/$PACKAGE.sha256"; then
  echo "错误：校验文件不是 sha256 清单（可能被登录页拦截），未改动现有安装。" >&2
  echo "$BASE/public/$PACKAGE.sha256" >&2
  exit 1
fi

checksum_tool=""
if command -v shasum >/dev/null 2>&1; then
  checksum_tool=shasum
elif command -v sha256sum >/dev/null 2>&1; then
  checksum_tool=sha256sum
else
  echo "错误：找不到 shasum 或 sha256sum，无法校验安装包。" >&2
  exit 1
fi

checksum_ok=0
if [ "$checksum_tool" = shasum ]; then
  if (cd "$tmp" && shasum -a 256 -c "$PACKAGE.sha256") >/dev/null 2>&1; then checksum_ok=1; fi
else
  if (cd "$tmp" && sha256sum -c "$PACKAGE.sha256") >/dev/null 2>&1; then checksum_ok=1; fi
fi
if [ "$checksum_ok" != 1 ]; then
  echo "错误：安装包校验失败（sha256 不匹配），未改动现有安装。" >&2
  exit 1
fi

NEXT="$LIB_DIR/runtime.next"
rm -rf "$NEXT"
mkdir -p "$NEXT"
if ! tar -xJf "$tmp/$PACKAGE" -C "$NEXT"; then
  rm -rf "$NEXT"
  echo "错误：解压安装包失败，未改动现有安装。" >&2
  exit 1
fi
rm -rf "$LIB_DIR/runtime"
mv "$NEXT" "$LIB_DIR/runtime"
chmod +x "$LIB_DIR/runtime/node"

mkdir -p "$BIN_DIR"
NODE_PATH="$LIB_DIR/runtime/node"
MJS_PATH="$LIB_DIR/runtime/lifeline.mjs"
printf '%s\n' '#!/bin/sh' "exec \"$NODE_PATH\" \"$MJS_PATH\" \"\$@\"" > "$BIN_DIR/lifeline"
chmod +x "$BIN_DIR/lifeline"
echo "Installed: $BIN_DIR/lifeline"

path_ok=1
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    path_ok=0
    rc_file="$HOME/.bashrc"
    case "${SHELL:-}" in
      */zsh) rc_file="$HOME/.zshrc" ;;
      */bash) rc_file="$HOME/.bashrc" ;;
    esac
    echo ""
    echo "NOTE: $BIN_DIR is not in your PATH. Add it with:"
    echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> $rc_file && export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

other=""
IFS=":"
for d in $PATH; do
  [ -z "$d" ] && continue
  cand="$d/lifeline"
  if [ -e "$cand" ] && [ "$cand" != "$BIN_DIR/lifeline" ]; then
    other=$cand
    break
  fi
done
unset IFS

echo ""
if [ "$was_installed" = 1 ]; then
  echo "Updated: $LIB_DIR/runtime/lifeline.mjs"
  echo "Restart the background agent so it runs the new version:"
  echo "  lifeline daemon install"
  if [ -n "$other" ]; then
    echo ""
    echo "NOTE: another lifeline is on PATH ($other); the daemon uses $LIB_DIR/runtime."
  fi
  exit 0
fi

setup_cmd="lifeline setup --server-url $BASE"
if [ -n "$other" ]; then
  echo "NOTE: another lifeline is on PATH ($other)."
  echo "Use the full path below so setup opens a browser instead of asking for a token."
  echo ""
  setup_cmd="$BIN_DIR/lifeline setup --server-url $BASE"
elif [ "$path_ok" = 0 ]; then
  setup_cmd="$BIN_DIR/lifeline setup --server-url $BASE"
fi
echo "Next, sign in (opens a browser; no token to type):"
echo "  $setup_cmd"
echo ""
if [ "$os" = Darwin ]; then
  echo "If Cursor is already running, fully quit it (Cmd+Q) and reopen after setup."
else
  echo "If Cursor or CodeBuddy is already running, quit it fully and reopen after setup."
fi

echo ""
echo "To uninstall later:"
if [ "$BIN_DIR" = "$HOME/.local/bin" ]; then
  echo "  curl -fsSL $BASE/public/uninstall.sh | sh"
else
  echo "  curl -fsSL $BASE/public/uninstall.sh | LIFELINE_BIN_DIR=\"$BIN_DIR\" sh"
fi
