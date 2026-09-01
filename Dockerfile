# NFR-OPS-02: container image used for both web and worker on Railway.
FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates gosu && rm -rf /var/lib/apt/lists/* \
  && useradd -m -u 1001 erp
COPY --from=builder /app/public ./public
COPY --from=builder --chown=erp:erp /app/.next/standalone ./
COPY --from=builder --chown=erp:erp /app/.next/static ./.next/static
COPY --from=builder --chown=erp:erp /app/prisma ./prisma
COPY --from=builder --chown=erp:erp /app/tools ./tools
COPY --from=builder --chown=erp:erp /app/node_modules ./node_modules
COPY --from=builder --chown=erp:erp /app/package.json ./package.json
# The worker runs from source with tsx, so it needs src/ and the tsconfig that resolves the
# "@/*" path alias. Without these the image builds and the web service starts fine while the
# worker exits immediately on "cannot find module" — and a worker that never runs means the
# outbox is never drained: no notifications, no contract-expiry reminders, no retention run.
COPY --from=builder --chown=erp:erp /app/src ./src
COPY --from=builder --chown=erp:erp /app/tsconfig.json ./tsconfig.json
# schema.prisma deliberately carries no datasource url; prisma.config.ts supplies it from
# DATABASE_URL. Without this file `prisma migrate deploy` starts, finds no config, and stops
# with "datasource.url is required" — which never showed up locally, where migrations run
# through tools/migrate.mjs instead of the Prisma CLI.
COPY --from=builder --chown=erp:erp /app/prisma.config.ts ./prisma.config.ts
COPY --chown=root:root docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
# Deliberately no `USER erp` here: the entrypoint needs root to chown the mounted volume and
# drops to erp with gosu before exec'ing the command, so nothing the app runs is privileged.
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
