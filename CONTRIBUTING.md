# Contributing

**English** | [简体中文](./CONTRIBUTING.zh-CN.md)

Keep changes small and focused. Run the minimum verification before you commit.

## Prerequisites

- **Node 22** (locked in `.nvmrc` / `.node-version` / `engines`). `better-sqlite3` is a native module; ABI must match Node — **do not switch versions**. The bundled agent runtime also uses Node **22.19.0**.
- **pnpm** (`packageManager` pins the version; `corepack enable` or install that version yourself). Workspace source of truth is `pnpm-workspace.yaml`; npm's `package-lock.json` is gone.
- After clone: `pnpm install` — installs every `packages/*` workspace once, plus the husky git hooks (`prepare`).
- When running the server, `cp .env.example .env` if you need it. Loopback starts with no `AUTH_*` at all (single-user `none` mode).

```bash
nvm use          # Node 22
pnpm install
```

## Common commands

| Command | What it does |
|---|---|
| `pnpm run dev` | Vite only (`http://localhost:5173`). Backend URL is `VITE_RELAY_URL` (`packages/web/.env.development` → `http://127.0.0.1:3000`; production uses the page origin) |
| `pnpm run dev:server` | This repo's Fastify server |
| `pnpm run dev:relay` | Same server under `tsx watch` |
| `pnpm run agent` | Local agent (separate terminal when you need CDP) |
| `npx tsc --noEmit` | Typecheck |
| `pnpm lint` | ESLint (`@antfu/eslint-config`, flat config in `eslint.config.mjs`) — must stay clean |
| `pnpm lint:fix` | Same, with autofix — this **is** the formatter (there is no prettier) |
| `pnpm test` | Full suite (`node:test` + tsx, `tests/*.test.ts`) |
| `pnpm run build` | Server build (`tsc`; copies `dist/cli/lifeline.mjs` into `dist/client/public/` when present) |
| `pnpm run build:web` | Frontend production build (Vite) |
| `pnpm run build:cli` | Single-file CLI bundle |
| `pnpm run build:runtime` | Agent runtime tarball (server distributes it under `/public/`) |
| `pnpm run build:docker` | Self-host image (see [`docs/selfhost.md`](docs/selfhost.md)) |

Version number source of truth is the root `package.json`. Client upgrades go through `lifeline update` (compared against the server's `/public/cli-latest.txt`).

Lint + format is `@antfu/eslint-config` (`eslint.config.mjs`) — there is no prettier. A handful of rules are deliberately overridden for this codebase (`node:test` titles, semicolons, the global `process`, one-line arrow bodies); each override carries its reason next to it. The advisory rules at the end of the config are expected to pass as warnings: they flag pre-linter code that still needs a human pass.

**Minimum verification after every change:**

```bash
npx tsc --noEmit && pnpm lint && pnpm test
```

**Two pnpm hard rules** (they fail on the user's machine, not yours, if you get them wrong):

- `allowBuilds.better-sqlite3: true` in `pnpm-workspace.yaml` **must stay**. pnpm skips dependency build scripts by default, and the package does not ship a prebuilt `.node`. Delete it and local DB tests plus the server will not start.
- Copies of packages out of `node_modules` in `scripts/pack-runtime.ts` **must use `dereference: true`**. pnpm's top-level packages are symlinks; without dereference the runtime tarball contains dangling links.

## Layout

| Package | Role |
|---|---|
| `packages/server` | Cloud: static pages + Fastify + socket.io; machine register and ownership filter; session mirror. **No CDP.** |
| `packages/agent` | Local thin client: CDP live stack + on-disk session projection + command dispatch (`COMMAND_EVENTS` in protocol; handlers in `src/command-router.ts`) |
| `packages/cli` | `lifeline` CLI; config at `~/.lifeline/config.json` |
| `packages/web` | Vite + React: landing (`/`) + console (`/console`). Path literals live only in `src/lib/routes.ts`. Wire types re-exported from `src/net/protocol.ts`. |
| `packages/protocol` | Shared types, `IDE_KINDS`, `COMMAND_EVENTS` |

Architecture boundaries, entry-point table, and do-not-revert criteria: [`AGENTS.md`](AGENTS.md). That file is the agent-context source of truth; `CLAUDE.md` is a symlink to it — **edit `AGENTS.md` only**.

## Commits and branches

- Default branch is `master`. A merge can ship. Sizeable work goes on `feat/xxx` / `fix/xxx` and a merge request; tiny fixes may land directly.
- Commit messages follow `type(scope): short summary`. Types: `feat` / `fix` / `docs` / `chore` / `test` / `refactor`. Examples:
  - `fix(agent): keep Linux as a content source; push identity checks to the connection layer`
  - `docs: keep agent context in AGENTS.md only`
  - `chore: bump 0.1.67 (CDP: do not pre-reserve ports; classify failures)`
- Enforced, not just written down: husky runs commitlint on `commit-msg` (`commitlint.config.mjs`) and `lint-staged` (eslint --fix, staged files only) on `pre-commit` (`lint-staged.config.mjs`). `pnpm commit` opens the commitizen prompt for the same shape, with the package names as scopes.
- One commit, one job. Opportunistic refactors go in their own commit.

## Where docs go

| Content | Where |
|---|---|
| Always-needed conclusions (what it is, how to run, how to verify) | `AGENTS.md` — conclusions only (English; no language pair) |
| Public topic docs | English at `docs/<name>.md` (canonical), 简体中文 at `docs/zh-CN/<name>.md`. Root `README` / `CONTRIBUTING` use sibling `*.zh-CN.md` |
| Implementation detail, war stories, design specs, plans | Topic docs under `docs/` (e.g. [`ide-drivers.md`](docs/ide-drivers.md), [`selfhost.md`](docs/selfhost.md), [`lifeline-intro.md`](docs/lifeline-intro.md), [`naming-brief.md`](docs/naming-brief.md)). Edit English first, then the Chinese pair |

New pitfalls go in the matching `docs/` topic file. `AGENTS.md` gets at most a one-line pointer.

## Red lines

- **Unauthenticated CDP = arbitrary code execution.** Port 9222 must never be on the public internet. The agent reaches it over loopback only.
- Secrets stay out of the tree and out of commits: server `.env`, per-machine `~/.lifeline/config.json`.
- Do not ship a shared `AGENT_TOKEN`. Machine ownership is the login identity at enroll time — first registration sticks, not transferable.
- Do not shrink `EVALUATE_TIMEOUT_MS`. Do not switch Node versions.
- Implementations marked **Do not revert** in `AGENTS.md` (auth exemption is those three paths only; Linux is a content source; SIGTERM has a hard timeout; timeline is not re-virtualized; `session-index-reporter` does not call `listSessions()`; Windows shortcut classes include `^`): read the code comments and the matching `docs/` topic first.
- `agentId` is `machine-<uuid>`. Do not fall back to a hostname-derived id.
- Linux control is not a product surface (`canControlIde()`). The escape hatch is `LIFELINE_LINUX_CDP=1`, not probing `DISPLAY`.
