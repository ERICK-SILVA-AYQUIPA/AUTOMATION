# syntax=docker/dockerfile:1
# =============================================================================
# Imágenes de producción de AI Sales Assistant (un solo Dockerfile, varios destinos):
#   --target api      API REST (node dist/main.js) y, con otro comando, el worker
#   --target web      Panel web Next.js (salida standalone)
#   --target migrate  Aplica migraciones y datos base (planes, administrador)
# Se construye desde la raíz del repositorio (ver docker-compose.prod.yml).
# =============================================================================
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------- compilación
FROM base AS build
# prisma.config.ts exige credenciales; para generar el cliente basta una URL ficticia
ENV DATABASE_MIGRATION_URL=postgresql://build:build@localhost:5432/build
# La web reenvía /api a la API por la red interna (se fija al compilar)
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/prisma.config.ts apps/api/
COPY apps/web/package.json apps/web/
COPY database/schema database/schema
# extra_ca (opcional): certificado de un proxy corporativo para descargar paquetes
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile
COPY . .
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm --filter @aisa/api exec prisma generate \
 && pnpm --filter @aisa/api build \
 && pnpm --filter @aisa/web build \
 && pnpm --filter @aisa/api deploy --prod --legacy /out/api

# ---------------------------------------------------------------- migraciones (una vez por despliegue)
FROM build AS migrate
# La URL ficticia de compilación no debe usarse aquí: se compone con APP_DB_*
ENV DATABASE_MIGRATION_URL=
CMD ["sh", "-c", "pnpm --filter @aisa/api exec prisma migrate deploy && pnpm --filter @aisa/api db:seed"]

# ---------------------------------------------------------------- API y worker
FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production STORAGE_DIR=/data/storage
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./
# Kit de instalación independiente de esta versión (paquetes de entrega, ADR 044)
COPY --from=build --chown=node:node /repo/docker-compose.prod.yml /repo/.env.production.example /app/kit/
COPY --from=build --chown=node:node /repo/infrastructure/caddy /app/kit/infrastructure/caddy
COPY --from=build --chown=node:node /repo/infrastructure/docker/postgres /app/kit/infrastructure/docker/postgres
COPY --from=build --chown=node:node /repo/infrastructure/scripts /app/kit/infrastructure/scripts
COPY --from=build --chown=node:node /repo/infrastructure/kit /app/kit/infrastructure/kit
COPY --from=build --chown=node:node /repo/services/n8n /app/kit/services/n8n
COPY --from=build --chown=node:node /repo/services/chatwoot /app/kit/services/chatwoot
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------- web
FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
