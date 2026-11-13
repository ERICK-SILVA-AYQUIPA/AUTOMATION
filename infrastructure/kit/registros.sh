#!/usr/bin/env bash
# Registros de los servicios:  ./registros.sh [servicio…] [--since 1h]
#   servicios: api worker web caddy migrate postgres redis (n8n chatwoot-rails si están activos)
cd "$(dirname "$0")" && exec docker compose -f docker-compose.prod.yml --env-file .env.production logs --tail=200 "$@"
