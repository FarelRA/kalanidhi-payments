# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage. Dev dependencies are needed for `tsc`.
# The pinned merchantid tarball is vendored, so neither git nor the provider
# repository is required at build time.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force

# ---------------------------------------------------------------------------
# Runtime stage. No build tools, no source, no .env, no secrets.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STORE_PATH=/var/lib/kalanidhi/payments.sqlite

WORKDIR /app

RUN addgroup -S app \
  && adduser -S -G app -h /app app \
  && mkdir -p /var/lib/kalanidhi \
  && chown app:app /var/lib/kalanidhi /app

COPY --from=build --chown=app:app /app/package.json /app/package-lock.json ./
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist

USER app

EXPOSE 8080

# The internal key is read from the runtime environment; it is never baked in.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/v1/health',{headers:{'x-internal-key':process.env.INTERNAL_API_KEY||''}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
