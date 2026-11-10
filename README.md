# AI Sales Assistant

Plataforma SaaS multiempresa de ventas y atención al cliente por WhatsApp con
inteligencia artificial: catálogo, inventario, pedidos, clientes, bandeja humana
y automatizaciones.

> **Estado:** FASE 1 (infraestructura) y FASE 2 (backend: base de datos,
> autenticación, multiempresa con RLS) completadas y probadas. El frontend y las
> integraciones se construyen en las fases 3–8 (ver
> [`docs/architecture/PLAN.md`](docs/architecture/PLAN.md)). Este README solo
> describe lo que ya existe y está probado.

## Arquitectura

Ver [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md)
(diagramas de componentes y de secuencia), [`DECISIONS.md`](docs/architecture/DECISIONS.md)
y [`RISKS.md`](docs/architecture/RISKS.md). Licencias de terceros en [`LICENSES.md`](LICENSES.md).

```
apps/            web (Next.js), api (NestJS), worker (BullMQ)        [FASE 2–3]
services/        n8n, chatwoot, dify, evolution-api (configuración e instaladores)
infrastructure/  docker/postgres/init, nginx, scripts/
database/        schema, migrations, seeds                            [FASE 2]
docs/            architecture, installation, integrations, api
tests/           pruebas e2e                                           [FASE 2+]
```

## Requisitos (MacBook Apple Silicon)

- macOS 14+, **16 GB de RAM** recomendado para el stack completo.
- [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) con
  Compose ≥ 2.35 (Dify lo exige). Asignar a Docker ≥ 8 GB de RAM y ~40 GB de disco.
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

# Dify (proyecto compose separado, opcional hasta FASE 6)
./services/dify/install.sh && ./services/dify/dify.sh up
```

| Servicio | URL local | Perfil |
|---|---|---|
| PostgreSQL 17 | `127.0.0.1:5433` | siempre |
| Redis 7 | `127.0.0.1:6380` | siempre |
| n8n | http://localhost:5678 | `automation` |
| Chatwoot | http://localhost:3100 | `chatwoot` |
| Evolution API | http://localhost:8080 | `evolution` |
| Dify | http://localhost:8090 | proyecto `dify` |
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
repositorio. Las credenciales de Meta, Dify y SMTP se rellenan en sus fases.

## Pruebas

```bash
# Una vez: migraciones en la base de pruebas (la crea el init de Postgres)
APP_DB_NAME=ai_sales_test pnpm --filter @aisa/api exec prisma migrate deploy
pnpm --filter @aisa/api test        # unitarias
pnpm --filter @aisa/api test:e2e    # integración contra PostgreSQL real (base ai_sales_test)

# Prueba de humo en navegador (Chromium + Playwright) con la API y la web en marcha.
# Crea una empresa nueva con correo único; lee los enlaces de correo desde Mailpit.
set -a; . ./.env; set +a
MAILPIT_URL=http://localhost:8025 pnpm --filter @aisa/web test:e2e

# WhatsApp de punta a punta en navegador: la API y el worker deben arrancar con
# WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:4999 (el script levanta ahí un servidor
# local que responde como la Graph API de Meta; no se conecta a Meta)
MAILPIT_URL=http://localhost:8025 node apps/web/e2e/whatsapp.mjs
```
Conectar un número real de WhatsApp: [`docs/integrations/whatsapp-cloud-api.md`](docs/integrations/whatsapp-cloud-api.md).
La prueba de humo usa `playwright` instalado en el sistema; en la FASE 8 se
integra como dependencia de desarrollo y en CI.

Endpoints documentados en [`docs/api/README.md`](docs/api/README.md).

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

Las secciones de conexión de WhatsApp, n8n, Dify, Chatwoot, pruebas y
despliegue se completan al terminar sus fases.
