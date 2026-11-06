# Record Server production image.
#
# Target: AWS Graviton (`t4g.small`), so linux/arm64. Build it with
#   docker build --platform linux/arm64 -t receipts-api:<sha> server/
#
# Debian slim rather than Alpine, deliberately. The dependency tree includes
# `better-sqlite3`, a native module, and musl builds of native Node modules
# are a recurring source of works-locally-fails-in-CI. The extra size is
# worth not having that class of problem on a service that runs one
# container per instance.
#
# Multi-stage, so the runtime image carries no compiler, no dev dependencies,
# no TypeScript sources and no tests.

# --- build -----------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json ./

# `npm ci` honours the lockfile exactly; `npm install` may resolve
# differently and makes the image non-reproducible.
#
# The build toolchain is insurance, not a requirement: `better-sqlite3` ships
# a prebuilt binary for linux-arm64 and linux-x64, so on those platforms
# nothing is compiled. It is here so a platform without a prebuild fails with
# a compiler error rather than a confusing `node-gyp not found`. It stays in
# this stage and never reaches the runtime image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Re-resolve to production dependencies only, now the build has consumed the
# dev ones.
RUN npm ci --omit=dev

# --- prune -----------------------------------------------------------------
# Two things survive `--omit=dev` that the runtime provably does not need.
#
# `TARGETARCH` is supplied by buildx (`arm64` or `amd64`) and lets this stay
# correct for either target rather than hard-coding one.
ARG TARGETARCH

RUN set -eux; \
    # 1. `better-sqlite3` bundles a prebuilt binary for eight platforms,
    #    ~16 MB, of which exactly one is loadable here. Keeping the others
    #    ships Windows and macOS binaries to a Linux server.
    find node_modules/better-sqlite3/prebuilds -mindepth 1 -maxdepth 1 \
         ! -name "linux-${TARGETARCH}.node" -delete; \
    # 2. `typescript` is an OPTIONAL PEER dependency of viem, abitype and ox.
    #    npm installs optional peers by default, but it is used only for type
    #    inference at compile time -- the server runs compiled JavaScript and
    #    never requires it. The smoke test after the build is what verifies
    #    this rather than assuming it.
    rm -rf node_modules/typescript

# --- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# Unprivileged. The `node` user (uid 1000) ships with the base image.
USER node
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

EXPOSE 8080

# Container-level check, in addition to the reverse proxy's. /health returns
# 503 when the database is unreachable, so compose replaces a task that
# cannot serve rather than leaving it in rotation.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `node dist/server.js` directly, not `npm start`. npm would sit between the
# container runtime and the process, and SIGTERM would reach npm rather than
# the server, breaking the graceful shutdown in server.ts.
#
# No `--env-file`: in production every variable comes from the environment
# the orchestrator provides, and no .env file is ever copied into the image.
CMD ["node", "dist/server.js"]
