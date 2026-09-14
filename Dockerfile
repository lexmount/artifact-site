# Build arguments — every one has a default, so a plain `docker build .` (which is all a PaaS
# source build can run, with no way to pass arguments) behaves exactly as before. They exist for hosts
# that cannot reach Docker Hub / registry.npmjs.org directly: `make build` fills them from .env.
#   NODE_IMAGE     base image for all three stages (e.g. a mirror of node:24-bookworm-slim)
#   NPM_REGISTRY   registry for `npm ci` (empty = npm's default / whatever .npmrc says)
ARG NODE_IMAGE=node:24-bookworm-slim

# ─────────────────────────────────────────────────────────────
# 1. deps — full install (incl. dev deps) needed to build
# ─────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
ARG NPM_REGISTRY=
WORKDIR /app
COPY package.json package-lock.json ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
    && npm ci

# ─────────────────────────────────────────────────────────────
# 2. builder — compile the Next.js standalone bundle
# ─────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ─────────────────────────────────────────────────────────────
# 3. runner — minimal runtime, non-root, persistent /data volume
# ─────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=4300 \
    HOSTNAME=0.0.0.0 \
    ARTIFACT_DATA_DIR=/data

# Dedicated non-root user that owns the state volume. The entrypoint starts as
# root to fix a freshly-mounted volume's ownership, then drops to this user via
# setpriv (util-linux, already in the base image — no apt / build-time network).
RUN set -eux; \
    groupadd --system --gid 1001 nodejs; \
    useradd --system --uid 1001 --gid nodejs nextjs; \
    mkdir -p /data; \
    chown -R nextjs:nodejs /data

# Standalone server + static assets + public files. server.js and its trimmed
# node_modules are emitted by Next's standalone output; nothing else is needed.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY LICENSE-APACHE LICENSE-MIT NOTICE ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 4300
VOLUME ["/data"]

# Uploaded artifacts live under $ARTIFACT_DATA_DIR — keep it on the volume.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4300)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Start as root so the entrypoint can chown a freshly-mounted /data volume, then
# it drops to the unprivileged nextjs user before exec'ing the standalone server.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
