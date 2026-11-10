#!/usr/bin/env bash
# Inicializa el esquema de Chatwoot (comando oficial db:chatwoot_prepare).
# Es idempotente: si la base ya existe, aplica migraciones pendientes.
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose --profile chatwoot run --rm chatwoot-rails bundle exec rails db:chatwoot_prepare
echo "OK: Chatwoot preparado. Abre ${CHATWOOT_FRONTEND_URL:-http://localhost:3100} para crear el super administrador."
