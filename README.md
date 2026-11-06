# Lifeline

**English** | [简体中文](./README.zh-CN.md)

**Remote-control the Cursor / CodeBuddy IDE on your machine** — watch sessions, approve actions, and send tasks from a phone or browser.

Your code, IDE, and environment stay on that computer. Lifeline only projects the session onto the web so you can walk away from the desk.

- Product intro: [`docs/lifeline-intro.md`](docs/lifeline-intro.md)
- Self-hosting: [`docs/selfhost.md`](docs/selfhost.md)

## What you can do on the web

- **Watch the session**: a live projection of the on-disk session (messages, code, tool calls, plan progress) — not a separate cloud chat
- **Approve / reject**: every button on approval cards (shell, file edits, MCP, mode switches) is drawn on the page
- **Answer questionnaires, send new prompts, stop anytime**: send has three states (delivered / confirmed / failed-retryable); stop is the same key as in the IDE
- **Send files**: the bytes ride inside the message (nothing is stored server-side); the agent drops them on the IDE machine and hands them to the IDE — images arrive as multimodal parts, anything else as an `@`-file chip. Up to 4 files, 5MB each
- **Many machines, two slots**: machines under your account; Cursor and CodeBuddy shown and controlled separately
- **Offline machines stay readable**: last mirror, read-only — no blank screen

## Enroll a computer

Stand up a server on any Docker host (see [`docs/selfhost.md`](docs/selfhost.md)), then on the controlled machine (macOS / Linux, x64 or arm64) run:

```bash
curl -fsSL http://<your-lifeline-server>/public/install.sh | sh
lifeline setup --server-url http://<your-lifeline-server>
```

- No preinstalled Node: the installer downloads a bundled runtime (Node + CLI + better-sqlite3) and checks sha256
- Install layout: runtime under `~/.lifeline/`, command at `~/.local/bin/lifeline` (the script tells you how to append PATH if needed)
- The origin is the server URL above (self-host often `http://<host>:8080`; use https when you have a cert)
- `setup` opens a browser to log in (self-host is password / gateway auth). The machine is owned by that login; only that person can see it afterwards
- The agent brings up the CDP port itself — no manual config
- Alpine (musl) is not supported

## Everyday commands

| Command | What it does |
|---|---|
| `lifeline setup --server-url <url>` | Browser login and start the agent |
| `lifeline start` | Ensure the background agent |
| `lifeline start --foreground` | Attached debug run |
| `lifeline status` | Health: version, config, CDP, server reachability |
| `lifeline update` | Upgrade to the latest (`--force` reinstalls) |
| `lifeline stop` | Stop the daemon, keep the install |
| `lifeline uninstall` | Remove the background service (keeps ~/.lifeline and the CLI) |
| `lifeline open` | Open the web console |
| `lifeline config path` | Print the config file path |

`lifeline status` compares against the latest; if you are behind it tells you to run `lifeline update`.

## Codex CLI (macOS)

Install the official [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login` on the controlled machine. `lifeline setup` discovers `codex` on PATH; existing installations can set an absolute `codexCliPath` in `~/.lifeline/config.json` and run `lifeline start` after upgrading the agent and server.

In Agent CLI, create a session with **Codex** and an absolute working directory. Lifeline uses the native `codex app-server --listen stdio://` protocol and the CLI's local authentication and sandbox settings. It reuses the existing model/effort picker, timeline, one-shot command/file approvals, stop button, and restart recovery. Closing a session unsubscribes and stops its process without archiving the saved Codex thread. The terminal resume command uses `codex resume`.

Use a Codex CLI version that supports app-server v2 and `thread/resume`; paginated history also requires `thread/items/list`. Model catalogs describe the CLI's available choices, not guaranteed account access. Only one-shot command/file approvals are exposed; persistent grants and unsupported interactive tool requests are not accepted automatically. This retains Lifeline's existing macOS CLI control scope.

## Uninstall

```bash
curl -fsSL http://<your-lifeline-server>/public/uninstall.sh | sh
```

`lifeline stop` stops without uninstalling; `lifeline uninstall` removes the background service.

## Architecture

```
browser  --HTTP/WS-->  packages/server  <--outbound WS + per-machine token--  packages/agent  --CDP(loopback)-->  Cursor / CodeBuddy
```

- **server**: cloud static pages + Fastify + socket.io. **No CDP.**
- **agent**: local thin client; on-disk session projection and the CDP live stack. **Outbound** to the remote (no public inbound on the machine)
- **web**: Vite + React, console + landing

Machine identity and ownership token live in `~/.lifeline/config.json`. The server refuses the handshake if it cannot resolve ownership.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Project context for AI agents (architecture, commands, pitfalls) is in [`AGENTS.md`](AGENTS.md).

## Security

- The CDP port has no auth — equivalent to arbitrary local code execution. **Do not** expose it to the public internet (the agent reaches it over loopback only)
- Secrets live only in the server `.env` and on-machine `~/.lifeline/config.json` — not in the tree, not in commits
- Do not ship a shared `AGENT_TOKEN`: each machine uses the enroller's login identity
- Auth matrix (`AUTH_HEADER` / `AUTH_PASSWORD` / `AUTH_INSECURE_ALLOW`) is in the root `.env.example`

---

## License

[MIT](LICENSE) © 2026 zhangpaopao0609
