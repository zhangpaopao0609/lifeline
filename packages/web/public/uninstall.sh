#!/bin/sh
# Lifeline agent uninstaller
# Removes the local agent: launchd plist / systemd user unit / background
# process, managed Cursor/CodeBuddy CDP argv, config, install.sh CLI, and an
# npm-global lifeline if present.
#
# Prints a short report: one row per thing it actually removed. Paths that were
# never there stay silent, so a re-run on a clean machine says "nothing to
# remove" and nothing else. A two-column layout keeps it readable — labels are
# literals, so printf %-10s is enough to line the values up.
set -e

BIN_DIR="${LIFELINE_BIN_DIR:-$HOME/.local/bin}"
os=$(uname -s)

removed_any=0
row() {
  printf '  %-10s %s\n' "$1" "$2"
  removed_any=1
}
note() {
  printf '  %-10s %s\n' "note" "$1"
}

# $HOME/... prints as ~/..., which reads better in a report.
short_path() {
  case "$1" in
    "$HOME"/*) printf '~%s' "${1#$HOME}" ;;
    *) printf '%s' "$1" ;;
  esac
}

echo ""
echo "Lifeline uninstall"
echo ""

# --- daemon (launchd / systemd --user / detached process) -------------------

bootout_label() {
  label="$1"
  plist="$HOME/Library/LaunchAgents/${label}.plist"
  if [ "$os" = Darwin ]; then
    uid="$(id -u)"
    launchctl bootout "gui/${uid}/${label}" >/dev/null 2>&1 || true
    if [ -f "$plist" ]; then
      rm -f "$plist"
      return 0
    fi
  fi
  return 1
}

# Prints a summary of what it stopped or removed; empty when there was nothing.
linux_daemon_stop() {
  summary=""
  unit_name="lifeline.service"
  unit="$HOME/.config/systemd/user/$unit_name"
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl --user disable --now "$unit_name" >/dev/null 2>&1; then
      summary="stopped systemd user unit"
    fi
  fi
  if [ -f "$unit" ]; then
    rm -f "$unit"
    summary="${summary:+$summary; }removed systemd unit file"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi
  fi
  pid_file="$HOME/.lifeline/daemon.pid"
  if [ -f "$pid_file" ]; then
    pid=$(cat "$pid_file" 2>/dev/null || true)
    case "$pid" in
      ''|*[!0-9]*) ;;
      *)
        if kill -TERM "$pid" 2>/dev/null; then
          summary="${summary:+$summary; }stopped background agent (pid $pid)"
        fi
        ;;
    esac
    rm -f "$pid_file"
  fi
  printf '%s' "$summary"
}

daemon_summary=""
if [ "$os" = Darwin ]; then
  plists=0
  if bootout_label "com.lifeline.agent"; then plists=$((plists + 1)); fi
  if [ "$plists" -eq 1 ]; then
    daemon_summary="removed 1 plist file"
  elif [ "$plists" -gt 1 ]; then
    daemon_summary="removed $plists plist files"
  fi
elif [ "$os" = Linux ]; then
  daemon_summary=$(linux_daemon_stop)
else
  daemon_summary="skipped (unsupported platform)"
fi
if [ -n "$daemon_summary" ]; then
  row daemon "$daemon_summary"
fi

# --- Orphan agent processes -------------------------------------------------
# launchd / systemd only send SIGTERM first; if the agent is stuck in teardown the process
# survives (PPID=1), and this script is about to delete its runtime directory — leaving an
# orphan still on old code, still attached to the IDE CDP (we've seen this in the wild).
# Match our own entry on the command line and reap once more.
orphans=0
orphan_pids=""
found=$(pgrep -f 'runtime/lifeline\.mjs' 2>/dev/null || true)
if [ -n "$found" ]; then
  orphan_pids="$orphan_pids $found"
  for pid in $found; do orphans=$((orphans + 1)); done
fi
if [ "$orphans" -gt 0 ]; then
  for pid in $orphan_pids; do kill -TERM "$pid" 2>/dev/null || true; done
  sleep 1
  for pid in $orphan_pids; do
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
  done
  row "agent" "stopped $orphans orphaned process(es)"
fi

# --- managed CDP argv (Cursor / CodeBuddy) ----------------------------------

# 0 = stripped our flag, 1 = nothing of ours in there (or no file), 2 = no node
# to edit it with (the file may be left with the flag still in it).
strip_managed_cdp_argv() {
  path="$1"
  if [ ! -f "$path" ]; then
    return 1
  fi
  if ! grep -q -e 'Lifeline CDP' "$path"; then
    return 1
  fi
  NODE_FOR_ARGV="$HOME/.lifeline/runtime/node"
  if [ ! -x "$NODE_FOR_ARGV" ]; then
    NODE_FOR_ARGV=$(command -v node 2>/dev/null || true)
  fi
  if [ -z "$NODE_FOR_ARGV" ]; then
    echo "warning: no node found, cannot strip remote-debugging-port from $path" >&2
    return 2
  fi
  ARGV_PATH="$path" "$NODE_FOR_ARGV" -e '
const fs = require("fs");
const p = process.env.ARGV_PATH;
const raw = fs.readFileSync(p, "utf8");
const markers = ["Lifeline CDP"];
const keyRe = /"remote-debugging-port"\s*:/;
const out = [];
for (const line of raw.split("\n")) {
  if (markers.some((m) => line.includes(m)) || keyRe.test(line)) continue;
  out.push(line);
}
let joined = out.join("\n");
joined = joined.replace(/,(\s*\})/g, "$1");
if (!joined.endsWith("\n")) joined += "\n";
fs.writeFileSync(p, joined);
'
  return 0
}

argv_stripped=0
for argv_path in \
  "$HOME/.cursor/argv.json" \
  "$HOME/.config/Cursor/argv.json" \
  "$HOME/Library/Application Support/CodeBuddy CN/argv.json" \
  "$HOME/Library/Application Support/CodeBuddy/argv.json" \
  "$HOME/.config/CodeBuddy CN/argv.json" \
  "$HOME/.config/CodeBuddy/argv.json"
do
  if strip_managed_cdp_argv "$argv_path"; then
    argv_stripped=$((argv_stripped + 1))
  fi
done
if [ "$argv_stripped" -eq 1 ]; then
  row "cdp argv" "stripped remote-debugging-port from 1 IDE file"
elif [ "$argv_stripped" -gt 1 ]; then
  row "cdp argv" "stripped remote-debugging-port from $argv_stripped IDE files"
fi

# --- config directories -----------------------------------------------------

removed_dirs=""
for dir in "$HOME/.lifeline"; do
  # Also check -L: an npm install may be a symlink, and -e is false once the target is gone.
  if [ -e "$dir" ] || [ -L "$dir" ]; then
    rm -rf "$dir"
    removed_dirs="${removed_dirs:+$removed_dirs, }$(short_path "$dir")"
  fi
done
if [ -n "$removed_dirs" ]; then
  row config "removed $removed_dirs"
fi

# --- CLI (install.sh shim + npm global) -------------------------------------

removed_bins=""
for bin in "$BIN_DIR/lifeline"; do
  if [ -e "$bin" ] || [ -L "$bin" ]; then
    rm -f "$bin"
    removed_bins="${removed_bins:+$removed_bins, }$(short_path "$bin")"
  fi
done

npm_removed=0
if command -v npm >/dev/null 2>&1; then
  if npm uninstall -g lifeline >/dev/null 2>&1; then npm_removed=1; fi
fi

cli_summary="$removed_bins"
if [ "$npm_removed" = 1 ]; then
  cli_summary="${cli_summary:+$cli_summary, }npm global lifeline"
fi
if [ -n "$cli_summary" ]; then
  row cli "removed $cli_summary"
fi

# --- result -----------------------------------------------------------------

if [ "$removed_any" = 0 ]; then
  echo "  nothing to remove"
fi

leftover=$(command -v lifeline 2>/dev/null || true)
if [ -n "$leftover" ]; then
  case "$leftover" in
    */fnm_multishells/*)
      # fnm builds a temporary shim directory per shell session; after the npm global package
      # is removed this symlink dangles, and a new shell makes it go away — nothing for the user to do.
      note "fnm's per-shell shim lingers until you open a new shell"
      ;;
    *)
      note "CLI still on PATH ($leftover); remove it if setup keeps asking for a token"
      ;;
  esac
fi
echo ""
