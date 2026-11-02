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

## DeepSeek Harness CLI (macOS)

Lifeline can also create and control [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sessions through its ACP profile. Install `dsh` on your machine and configure its provider credentials locally first. `lifeline setup` discovers `dsh` on PATH; an existing installation can set the absolute `dshCliPath` in `~/.lifeline/config.json` and run `lifeline start`.

In the console, create a CLI session, choose **DeepSeek Harness**, and enter an absolute working directory. You can select the model and reasoning effort, read replies and tool activity, allow or reject individual operations, and stop work. The agent launches `dsh --profile acp`; credentials stay in your local DSH configuration.

After the Lifeline agent restarts, DSH restores the session's model context through `session/resume`. DSH does not replay its previous transcript over ACP, so the restored web timeline starts empty and fills with new activity. There is no terminal resume-command button for DSH. This uses Lifeline's existing macOS CLI control support.

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
