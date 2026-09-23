# AGENTS.md

Project context for AI agents working in this repo. Tool-agnostic. `CLAUDE.md` is a symlink to this file — **edit this file only**.

Keep this document to what you need on every turn (what it is, how to run it, how to verify). Implementation detail and war stories live under [`docs/`](docs/) ([`ide-drivers.md`](docs/ide-drivers.md), [`selfhost.md`](docs/selfhost.md), …). New pitfalls go in the matching topic doc; at most add a one-line pointer here.

## Project

Lifeline: remote-control Cursor / CodeBuddy on a local machine — watch the IDE sessions, approve actions, and send tasks from a phone or browser. External name is always **Lifeline** / `lifeline`. Default branch `master`. TypeScript `strict`. Shared wire types come from `@lifeline/protocol` (`packages/protocol`); agent/server `types.ts` files re-export those plus process-local config.

Internal protocol identifiers (`AGENT_TOKEN`, socket event names, …) are not the product name — do not rename them for branding. Web path literals live in exactly one file: `packages/web/src/lib/routes.ts` (`/` landing, `/console` console).

## Architecture

```
browser  --HTTP/WS-->  packages/server  <--outbound WS /agent-io + per-machine token--  packages/agent  --CDP(loopback)-->  Cursor / CodeBuddy
```

- **server** (`packages/server`): cloud Fastify + socket.io. **No CDP.**
- **agent** (`packages/agent`): on-machine thin client. DOM is live state only (status / tabs / approvals / input / queue) — do not scrape the transcript. Disk adapters project the session. One slot per IDE (`cursor` and `codebuddy`).
- **web** (`packages/web`): Vite + React landing + console.
- **cli** (`packages/cli`): the only distribution entry (Unix `install.sh`, Windows `install.ps1`). No VS Code extension. No requirement that Node is preinstalled on the machine.
- **protocol** (`packages/protocol`): shared types, `IDE_KINDS`, and `COMMAND_EVENTS`.

| Concern | Start here |
|---|---|
| Command dispatch | `packages/agent/src/command-router.ts` (`COMMAND_EVENTS` in protocol) |
| Machine register / ownership | `packages/server/src/agent-hub.ts`, `identity-store.ts` |
| Session mirror / ledger | `packages/server/src/session-store.ts` |
| Outbound connection | `packages/agent/src/uplink.ts` |
| IDE adapters | `packages/agent/src/drivers/` (see [`ide-drivers.md`](docs/ide-drivers.md)) |
| Shared wire types | `packages/protocol` (`@lifeline/protocol`) |
| Auth exemption | `packages/server/src/public-paths.ts` (only `/public/*`, `/healthz`, `/agent-io`) |
| Browser auth | `packages/server/src/auth/` (matrix in root `.env.example`) |
| CLI | `packages/cli/` (`~/.lifeline/config.json`) |

## How to run / verify

```bash
pnpm install            # workspace source of truth = pnpm-workspace.yaml; do not bring back package-lock.json
pnpm run dev            # Vite :5173; data source is VITE_RELAY_URL (dev default http://127.0.0.1:3000; production uses page origin)
pnpm run dev:server     # this repo's Fastify (CDP needs a separate `pnpm run agent`)
pnpm run agent          # local agent (CDP + disk projection)
npx tsc --noEmit
pnpm lint               # ESLint (@antfu/eslint-config); also the formatter — no prettier
pnpm test
pnpm run build
pnpm run build:cli
pnpm run build:runtime  # agent runtime tarball (server serves it under /public/ to new machines)
pnpm run build:docker   # self-host image (the ship form; see docs/selfhost.md)
```

Minimum verification: `npx tsc --noEmit && pnpm lint && pnpm test`.

Local **Node 22** (`.node-version` / `.nvmrc` / `engines`) — do not switch. Package manager **pnpm@11.2.2**. `allowBuilds.better-sqlite3: true` in `pnpm-workspace.yaml` must stay. Bundled runtime Node is **22.19.0**.

Secrets stay out of the tree: server `.env`, per-machine `~/.lifeline/config.json`. Do not ship a shared `AGENT_TOKEN`. `agentId` = `machine-<uuid>` — do not fall back to a hostname-derived id.

## Do not revert

Read the matching code and topic doc before touching these. Criteria only:

- CDP evaluate timeout `EVALUATE_TIMEOUT_MS = 12000`. Port 9222 must never be on the public internet; the agent talks to it over loopback only. Live DOM is gone when the IDE window is occluded.
- Linux is a **content source only** (`canControlIde()` allows `darwin | win32`). Do not probe `DISPLAY` / `WAYLAND_DISPLAY`. Escape hatch is `LIFELINE_LINUX_CDP=1`, not a code change.
- SIGTERM (container stop / restart) must have a hard timeout (`Relay.stop` closes `engine` first). Do not re-virtualize the timeline (window indices are segments; see `packages/web/src/lib/timeline-window.ts`). `session-index-reporter` must not fall back to `listSessions()` (heads / `indexSignal` only).
- Windows: approval-shortcut character classes must include `^` (Ctrl glyph). `daemon install` restarts an IDE that has no debug port — during development, do not install the daemon on CodeBuddy without one.

Probes live in `scripts/probes/` (some burn model quota). `temp/` is throwaway.
