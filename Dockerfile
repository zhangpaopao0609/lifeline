# Lifeline server self-host image.
#
# Two stages: build (pnpm install + three builds + linux-x64 runtime pack) → run
# (dist + node_modules + /data volume). Build and run share the same base
# (node:22-bookworm-slim): better-sqlite3's prebuilt .node must match the
# runtime Node ABI.
#
# Only the linux-x64 runtime tarball is built here: the container platform is
# fixed. The other four platform tarballs are assets the agent installs on the
# user's machine; the server only serves them statically (change PACK_TARGETS
# or hang a CDN in front to ship all platforms — see docs/selfhost.md).

# ---- build ----
FROM node:22-bookworm-slim AS build
# curl/ca-certificates/xz-utils: pack-runtime fetches Node's official dist and
# the better-sqlite3 prebuild.
#
# Deliberately **not** installing python3/make/g++ (the node-gyp toolchain).
# It would not buy anything: `build:runtime` already downloads better-sqlite3's
# prebuild from GitHub (pack-runtime's sqlitePrebuildUrl), so "the builder can
# reach GitHub" is a hard prerequisite of this Dockerfile. If GitHub is down
# the later step fails anyway; extra toolchain just pulls ~200MB per build
# (measured: this layer can stall for minutes on a slow mirror).
#
# Note that `pnpm install` does run better-sqlite3's
# `prebuild-install || node-gyp rebuild` (allowBuilds in pnpm-workspace.yaml
# permits it). In practice it takes the prebuild-install download branch and
# finishes in 1–2s — confirming the compile toolchain is unused.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      curl ca-certificates xz-utils \
 && rm -rf /var/lib/apt/lists/*
# Install deps with pnpm (the lockfile is pnpm-lock.yaml + pnpm-workspace.yaml).
# Version matches packageManager in the root package.json. Install it explicitly
# rather than enabling corepack: corepack's shim wants a root-writable directory
# and then downloads another copy from the cwd packageManager field. The image
# only needs a pnpm that can run install.
RUN npm install -g pnpm@11.2.2
WORKDIR /repo
# Cache the dependency layer on its own: install hits the cache as long as the
# four manifest files are unchanged.
#
# Simpler than the old npm split (root npm ci, then a second install for
# packages/web): npm ci drops every dependency of a workspace that the lockfile
# declares but the filesystem does not yet contain. pnpm actually scans the
# globs in pnpm-workspace.yaml, so a missing workspace is simply skipped and
# **does not** take other packages with it — one layer is enough
# (see docs/selfhost.md).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/cli/package.json packages/cli/
COPY packages/agent/package.json packages/agent/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build:cli \
 && pnpm run build \
 && pnpm run build:web \
 && PACK_TARGETS=linux-x64 pnpm run build:runtime

# ---- run ----
FROM node:22-bookworm-slim
WORKDIR /app
# server-version.ts clientDir()/repoRoot() locate the repo root via package.json
COPY --from=build /repo/package.json ./
COPY --from=build /repo/dist ./dist
# Whole node_modules: the slim image does not care about size, and this skips
# maintaining a runtime-dep list (better-sqlite3's .node was already installed
# during the build stage)
COPY --from=build /repo/node_modules ./node_modules
ENV NODE_ENV=production \
    DATA_DIR=/data \
    SERVER_PORT=18765 \
    SERVER_HOST=0.0.0.0
# SERVER_HOST=0.0.0.0 is container semantics (the exposure surface is compose
# ports plus auth factory guards: no AUTH config → password provider + first-boot claim)
EXPOSE 18765
VOLUME /data
CMD ["node", "dist/packages/server/src/index.js"]
