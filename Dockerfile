FROM oven/bun:1 AS builder
# Point installs at a registry supplied at build time; defaults to public npmjs so
# this is a no-op anywhere else. On the NAS build server, Coolify sets NPM_REGISTRY
# to the local Verdaccio cache (http://192.168.1.2:4873/) so bun installs are cached
# and survive transient npmjs tarball failures.
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV BUN_CONFIG_REGISTRY=${NPM_REGISTRY}
ENV NPM_CONFIG_REGISTRY=${NPM_REGISTRY}
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
# Firebase web config (SPEC 18) as one line of JSON, read by vite at build time.
# Empty until the production config is committed to web/src/lib/firebaseConfig.ts.
ARG VITE_FIREBASE_CONFIG=""
RUN bun run build
# Runtime needs production dependencies only.
RUN rm -rf node_modules && bun install --frozen-lockfile --production

FROM oven/bun:1
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/web/dist ./web/dist

VOLUME /data
EXPOSE 3000
# Migrations run at boot (server/db/index.ts).
CMD ["bun", "server/index.ts"]
