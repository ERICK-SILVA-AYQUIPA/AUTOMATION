# AI Sales Assistant

Plataforma SaaS multiempresa de ventas y atención al cliente por WhatsApp con
inteligencia artificial: catálogo, inventario, pedidos, clientes, bandeja humana
y automatizaciones.

> **Estado (0.9.0, 2026-11-13):** las 10 fases de la evolución están implementadas y
> probadas en local (ver [`docs/architecture/PLAN.md`](docs/architecture/PLAN.md) y la
> [lista de aceptación](docs/architecture/ACEPTACION.md)). Lo que depende de servicios
> o datos reales (servidor y dominio, SMTP, clave de Gemini, número de WhatsApp de Meta,
> precios, proveedor de pagos) está marcado como pendiente: no se afirma probado.

## Qué incluye

- **Multiempresa** con aislamiento en dos capas (autorización en la API y RLS de PostgreSQL), modalidades SaaS, instancia dedicada y a medida, módulos por empresa.
- **Panel general** (`/plataforma`): alta de empresas idempotente, planes y precios, cobro manual, integraciones del servidor, plantillas por sector, **entrega de sistemas** (ZIP reproducible con instalador) y **sistema y versiones** (historial de actualizaciones).
- **Panel de cada empresa**: bandeja de WhatsApp, asistente de IA configurable (borrador, prueba y publicación; Gemini), catálogo, inventario, pedidos, clientes, reservas, automatizaciones (n8n para avisos, backend para lo crítico), integraciones (Gemini propio, Meta, Chatwoot, webhooks firmados), reportes y auditoría.
- **Operación**: despliegue con Docker Compose y Caddy (HTTPS), respaldo y restauración, instalador y actualizador con recuperación automática para servidores de clientes.

## Arquitectura

Ver [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md)
(diagramas de componentes y de secuencia), [`DECISIONS.md`](docs/architecture/DECISIONS.md)
y [`RISKS.md`](docs/architecture/RISKS.md). Licencias de terceros en [`LICENSES.md`](LICENSES.md).

```
apps/api         API REST NestJS + worker BullMQ + CLI (dist/cli.js)
apps/web         Panel Next.js (salida standalone) y pruebas en navegador (e2e/*.mjs)
database/        esquema Prisma, migraciones SQL (con RLS) y datos base
infrastructure/  docker (imágenes de producción), caddy, postgres/init, scripts/, kit/ (instalador y actualizador)
services/        n8n (flujos de avisos), chatwoot; dify y evolution-api son restos de fases
                 anteriores que ya no se usan (ADR 037): retirarlos está pendiente de autorización
docs/            architecture, installation, integrations, api
```

## Requisitos (MacBook Apple Silicon)

- macOS 14+, **16 GB de RAM** recomendado para el stack completo.
- [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) con
  Compose ≥ 2.20. Asignar a Docker ≥ 8 GB de RAM y ~40 GB de disco.
- Node.js 22 LTS y pnpm 10 (`corepack enable`) para las fases 2+.
- Git y OpenSSL (incluidos en macOS).
- Recomendado: `docker login` para evitar el límite de descargas anónimas de Docker Hub.

Todas las imágenes usadas publican variante `arm64`.

## Instalación (desarrollo)

```bash
git clone <repo> ai-sales-assistant && cd ai-sales-assistant
./infrastructure/scripts/setup.sh          # genera .env con secretos aleatorios
docker compose up -d --wait postgres redis
./infrastructure/scripts/chatwoot-init.sh  # solo la primera vez
./infrastructure/scripts/up.sh             # levanta todo y espera a que esté sano
bash services/chatwoot/setup-platform.sh   # solo la primera vez: cierra el asistente de Chatwoot y crea su token
./infrastructure/scripts/healthcheck.sh

# Backend (apps/api)
corepack enable && pnpm install
pnpm --filter @aisa/api db:deploy      # aplica migraciones
pnpm --filter @aisa/api db:seed        # planes + administrador general
pnpm --filter @aisa/api start:dev      # http://localhost:4000/api/v1/health/ready
pnpm --filter @aisa/api start:worker:dev  # worker: colas de WhatsApp y eventos para n8n
# (producción: pnpm --filter @aisa/api build && start:prod + start:worker)

# n8n: importa la credencial interna y los flujos 3, 4 y 7, y los publica (una vez,
# y de nuevo tras cambiar N8N_INTERNAL_TOKEN o los flujos)
./services/n8n/setup.sh

# Panel web (apps/web): reenvía /api/v1 a la API, así web y API comparten origen
pnpm --filter @aisa/web dev            # desarrollo: http://localhost:3000
# o producción local:
pnpm --filter @aisa/web build && pnpm --filter @aisa/web start

# Dify y Evolution API ya no se usan (la IA llama directo a Gemini, ADR 037; WhatsApp
# va por la Cloud API de Meta): no hace falta levantarlos.
```

| Servicio | URL local | Perfil |
|---|---|---|
| PostgreSQL 17 | `127.0.0.1:5433` | siempre |
| Redis 7 | `127.0.0.1:6380` | siempre |
| n8n | http://localhost:5678 | `automation` |
| Chatwoot | http://localhost:3100 | `chatwoot` |
| Evolution API (no se usa) | http://localhost:8080 | `evolution` |
| Dify (no se usa) | http://localhost:8090 | proyecto `dify` |
| Mailpit (correos de desarrollo) | http://localhost:8025 | `mail` |
| Panel web | http://localhost:3000 | `pnpm --filter @aisa/web …` |
| API | http://localhost:4000/api/v1 | `pnpm --filter @aisa/api …` |

El administrador general entra con `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD`
de `.env`. Las empresas se registran en http://localhost:3000/registro; el correo
de verificación llega a Mailpit.

Los perfiles activos se eligen con `COMPOSE_PROFILES` en `.env`.

## Variables de entorno

Documentadas en [`.env.example`](.env.example). Los valores `__GENERATE__` los
sustituye `setup.sh` por secretos de 256 bits. `.env` nunca se sube al
repositorio. Las credenciales de Meta y Gemini de cada empresa se guardan cifradas
desde el panel (Integraciones), nunca en `.env`.

## Pruebas

```bash
# Una vez: migraciones en la base de pruebas (la crea el init de Postgres)
APP_DB_NAME=ai_sales_test pnpm --filter @aisa/api exec prisma migrate deploy
pnpm --filter @aisa/api test        # unitarias
pnpm --filter @aisa/api test:e2e    # integración contra PostgreSQL real (base ai_sales_test)
pnpm --filter @aisa/api lint && pnpm --filter @aisa/web lint

# Pruebas en navegador (Chromium + Playwright) con la API, el worker y la web en marcha.
# Leen los correos de Mailpit. La API y el worker deben arrancar con
# WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:4999 y GEMINI_BASE_URL=http://127.0.0.1:4998:
# los scripts levantan ahí servidores locales que responden como Meta y Gemini
# (no se conectan a los servicios reales).
set -a; . ./.env; set +a
for t in smoke provisioning automations assistant whatsapp chatwoot billing integrations templates deliveries; do
  MAILPIT_URL=http://localhost:8025 WEB_URL=http://localhost:3000 node apps/web/e2e/$t.mjs
done
```

Los inicios de sesión tienen límite de intentos: si se encadenan todos los scripts sin
pausa, alguno puede recibir `429` (es el comportamiento esperado).

Conectar un número real de WhatsApp: [`docs/integrations/whatsapp-cloud-api.md`](docs/integrations/whatsapp-cloud-api.md).
Gemini: [`docs/integrations/gemini.md`](docs/integrations/gemini.md).
Bandeja de agentes (Chatwoot): [`docs/integrations/chatwoot.md`](docs/integrations/chatwoot.md).
Endpoints: [`docs/api/README.md`](docs/api/README.md).
Producción, entregas y actualizaciones: [`docs/installation/production.md`](docs/installation/production.md).

## Copias de seguridad

```bash
./infrastructure/scripts/backup.sh [destino]       # pg_dump de cada base + volúmenes
./infrastructure/scripts/restore.sh <archivo.dump> <base>
```
Guarda también `.env` (contiene `N8N_ENCRYPTION_KEY` y `CHATWOOT_SECRET_KEY_BASE`)
en un gestor de secretos: sin ellos, las copias de n8n/Chatwoot no son utilizables.

## Solución de problemas

| Síntoma | Causa / solución |
|---|---|
| `429 Too Many Requests` al descargar imágenes | Límite anónimo de Docker Hub: `docker login` y reintentar. |
| n8n reinicia con "address '::' is not available" | Red sin IPv6; ya resuelto con `N8N_LISTEN_ADDRESS=0.0.0.0`. |
| Evolution responde `Not allowed by CORS` | `CORS_ORIGIN` debe ser `"*"` (ADR 008). |
| `.env: syntax error near '<'` | Valores con espacios o `<>` deben ir entre comillas. |
| Chatwoot no arranca la primera vez | Ejecuta `chatwoot-init.sh` antes de `up.sh`. |
| Puerto ocupado | Cambia `*_HOST_PORT` en `.env`. |

