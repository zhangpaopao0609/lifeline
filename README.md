# Lifeline

**English** | [简体中文](./README.zh-CN.md)

**Remote-control Cursor / CodeBuddy on your machine** — watch the IDE sessions, approve actions, and send tasks from a phone or browser.

Your code, IDE, and environment stay on that computer. Lifeline only projects the session onto the web so you can walk away from the desk.

- Two web surfaces: `/` landing (intro + enroll commands), `/console` console
- Product intro (no internals): [`docs/lifeline-intro.md`](docs/lifeline-intro.md)
- Self-hosting (Docker / env / reverse proxy): [`docs/selfhost.md`](docs/selfhost.md)

## What you can do on the web

- **Watch the session**: a live projection of the on-disk session (messages, code, tool calls, plan progress) — not a separate cloud chat
- **Approve / reject**: every button on approval cards (shell, file edits, MCP, mode switches) is drawn on the page
- **Answer questionnaires, send new prompts, stop anytime**: send has three states (delivered / confirmed / failed-retryable); stop is the same key as in the IDE
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
| `lifeline status` | Health: version, config, CDP, server reachability |
| `lifeline update` | Upgrade to the latest (`--force` reinstalls) |
| `lifeline stop` | Stop the daemon, keep the install |
| `lifeline daemon install` / `uninstall` / `status` | Install / remove / inspect the daemon |
| `lifeline start` | Run the agent in the foreground (debug) |
| `lifeline open` | Open the web console |
| `lifeline config path` | Print the config file path |

`lifeline status` compares against the latest; if you are behind it tells you to run `lifeline update`. Re-running `install.sh` also upgrades, but the daemon needs `lifeline daemon install` to pick up the new code.

## Uninstall

```bash
curl -fsSL http://<your-lifeline-server>/public/uninstall.sh | sh
```

`lifeline stop` stops without uninstalling; `lifeline daemon uninstall` removes the daemon.

## Architecture

```
browser  --HTTP/WS-->  packages/server  <--outbound WS + per-machine token--  packages/agent  --CDP(loopback)-->  Cursor / CodeBuddy
```

- **server**: cloud static pages + Fastify + socket.io. **No CDP.**
- **agent**: local thin client; on-disk session projection and the CDP live stack. **Outbound** to the remote (no public inbound on the machine)
- **web**: Vite + React, console + landing

Machine identity and ownership token live in `~/.lifeline/config.json`. The server refuses the handshake if it cannot resolve ownership.

## Repository layout

| Directory | Contents |
|---|---|
| `packages/server` | Fastify + socket.io: machine register, session mirror, static pages |
| `packages/agent` | Local agent: CDP live state, on-disk session projection, command dispatch |
| `packages/cli` | `lifeline` CLI: install, setup, daemon, upgrade |
| `packages/web` | Vite + React landing and console (`public/install.sh` lives here too) |
| `packages/protocol` | Shared types and wire protocol |
| `tests/` | Full `node:test` suite |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Project context for AI agents (architecture, commands, pitfalls) is in [`AGENTS.md`](AGENTS.md).

## Docs

| File | Contents |
|---|---|
| [`docs/lifeline-intro.md`](docs/lifeline-intro.md) | Product intro (features only) |
| [`docs/ide-drivers.md`](docs/ide-drivers.md) | IDE adapter layer (driver registry and criteria) |
| [`docs/selfhost.md`](docs/selfhost.md) | Self-hosting (Docker image, env, reverse proxy) |
| [`docs/naming-brief.md`](docs/naming-brief.md) | Naming notes (why Lifeline / 生命线) |

Public docs are English in the unsuffixed files; 简体中文 is `*.zh-CN.md` at the repo root or `docs/zh-CN/` for topic docs.

## Security

- The CDP port has no auth — equivalent to arbitrary local code execution. **Do not** expose it to the public internet (the agent reaches it over loopback only)
- Secrets live only in the server `.env` and on-machine `~/.lifeline/config.json` — not in the tree, not in commits
- Do not ship a shared `AGENT_TOKEN`: each machine uses the enroller's login identity
- Auth matrix (`AUTH_HEADER` / `AUTH_PASSWORD` / `AUTH_INSECURE_ALLOW`) is in the root `.env.example`

---

## License

[MIT](LICENSE) © 2026 zhangpaopao0609
