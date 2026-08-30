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
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
  && useradd -m -u 1001 erp
COPY --from=builder /app/public ./public
COPY --from=builder --chown=erp:erp /app/.next/standalone ./
COPY --from=builder --chown=erp:erp /app/.next/static ./.next/static
COPY --from=builder --chown=erp:erp /app/prisma ./prisma
COPY --from=builder --chown=erp:erp /app/tools ./tools
COPY --from=builder --chown=erp:erp /app/node_modules ./node_modules
COPY --from=builder --chown=erp:erp /app/package.json ./package.json
USER erp
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
