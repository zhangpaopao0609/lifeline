# Self-hosting (Docker)

**English** | [简体中文](./zh-CN/selfhost.md)

> Two-stage `Dockerfile` + `docker-compose.yml` template + `scripts/selfhost.sh` (idempotent installer).

## Quick start

```bash
mkdir lifeline && cd lifeline
curl -fsSL <url-to-selfhost.sh> | sh     # or copy scripts/selfhost.sh from the repo
# open http://<host>:8080
docker logs lifeline                   # copy the first-boot claim code → set the password on the page
```

## Image layout (read this before editing the Dockerfile)

- **Same base on both stages** (`node:22-bookworm-slim`): better-sqlite3's prebuilt `.node` must match the runtime Node ABI. The run stage keeps the full `node_modules` from the build stage (do not split the dependency list to save bytes; slim is fine).
- **One install layer** (after the pnpm move). It used to be two: `npm ci` **drops the entire dependency tree** of a workspace that is declared in the lockfile but missing on disk, so web needed a second `npm --prefix packages/web install`. **pnpm does not do that** — it globs `pnpm-workspace.yaml` and a missing workspace is simply skipped. The flow is: COPY every workspace `package.json` plus the four manifest files, then one `pnpm install --frozen-lockfile`. Two layers would still work; **do not go back to npm** (there is no `package-lock.json`; `npm ci` will fail).
- **Publish with buildx multi-platform** (`--platform linux/amd64,linux/arm64`): a plain local `build` is **this arch only** — an arm64 Mac image has no matching manifest on an x64 `pull`. Same theme as “same base for ABI”.
- **Runtime tarball is linux-x64 only** (`PACK_TARGETS=linux-x64`): the container platform is fixed; the other four platform tarballs are assets the agent installs on user machines, and the server only serves them statically. For all-platform distribution, change that line or put a CDN in front.
- `.dockerignore` **excludes only the root** `node_modules` / `dist` (`/` prefix). A recursive exclude breaks workspace resolution.

## Env vars (`.env`)

| Variable | Role |
|---|---|
| `LIFELINE_PORT` | Compose-side port (default 8080; changing it means delete `docker-compose.yml` and re-run selfhost.sh, or edit `ports` by hand) |
| `AUTH_PASSWORD` | Preset password, skip claim (automation; the value is visible in process env) |
| `AUTH_HEADER` + `AUTH_TRUSTED_PROXY=1` | Gateway-injected user header (CF Access / Authelia / nginx auth_request; the gateway must strip the same header from the client) |
| `PUBLIC_ORIGIN` | Public URL behind the proxy (`https://lifeline.example.com`) — password-mode WS Origin checks and cookie Secure both use it |
| `AUTH_AVATAR_URL` | Avatar URL template (must contain `{userId}`, e.g. `https://cdn.example.com/avatars/{userId}.png`); unset → the page draws an initial block |
| `TZ` | Timezone |

> ⚠️ **Do not change these three in a container** (the image pins them): `SERVER_HOST` / `SERVER_PORT` / `DATA_DIR`. Compose `env_file` **overrides** image ENV — copying `.env.example` with `SERVER_HOST=127.0.0.1` breaks port mapping, and `DATA_DIR=./data` writes SQLite into the container layer (data gone on `down`/`up`).

Full auth matrix (including explicit `AUTH_PROVIDER` and `AUTH_INSECURE_ALLOW`) is in the root `.env.example`.

## Reverse proxy (optional)

Minimal Caddy for password mode + https:

```
lifeline.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

nginx equivalent (**must** pass Host or X-Forwarded-Host; WS Origin checks depend on it):

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # WS (/socket.io and /agent-io)
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400;
}
```

## Data and upgrades

- **All state is the `./data` volume** (`lifeline.sqlite`: users / machines / session mirrors / `auth_local` password and session keys). Backup = that directory (prefer stopping the container, then `sqlite3 data/lifeline.sqlite ".backup …"`). The container runs as root; Docker creates `./data` owned by root — non-root copies need `sudo`.
- **Upgrade**: `docker compose pull && docker compose up -d`. DB migrations (if any) run when the server opens the DB (idempotent ALTER chain in `applySchema`, see `db/open.ts`). Pin production images to a tag (`ghcr.io/…:v0.1.x`), not `latest` — upgrade = change the tag and `up`; rollback = the old tag (`latest` cannot roll back).
- **Rollback**: previous image tag + restore the backed-up data directory (migrations are one-way — backup before upgrading).

## Enrolling a machine

Once the server is up, enroll commands are served from **its own origin** (`__SERVER_ORIGIN__` rewrite, zero config):

```bash
curl -fsSL http://<server>:8080/public/install.sh | sh
lifeline setup --server-url http://<server>:8080
```

## Known limits (criteria)

- **No compose implementation on macOS/podman locally**: selfhost.sh compose path has been checked for file generation / idempotency / prompt wording against real Docker; a full `up -d` smoke on a Linux host is still outstanding.
- **`SERVER_HOST=0.0.0.0` inside the container is expected**: the attack surface is compose `ports` plus the auth factory (no AUTH config → password provider; never `none` off loopback).
- **`temp/server.log`**: the server mkdirSync-creates `temp/` in the container cwd (`index.ts`); use container stdout for logs.
- **Single replica only**: the machine registry, socket.io rooms, and machine snapshots live in server process memory (the only durable copy is `lifeline.sqlite`) — do not run multiple server instances.
