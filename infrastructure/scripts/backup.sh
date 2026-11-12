#!/usr/bin/env bash
# Copia de seguridad: volcado lógico de cada base + volúmenes de archivos.
# Desarrollo:  ./infrastructure/scripts/backup.sh [directorio_destino]
# Producción:  PROD=1 ./infrastructure/scripts/backup.sh /var/backups/aisa
#   (usa docker-compose.prod.yml y .env.production; KEEP_DAYS borra copias antiguas, por defecto 14)
# Programar a diario (cron):  15 3 * * * cd /opt/aisa && PROD=1 ./infrastructure/scripts/backup.sh /var/backups/aisa
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ "${PROD:-}" == "1" ]]; then
  ENV_FILE=.env.production; COMPOSE=(docker compose -f docker-compose.prod.yml --env-file .env.production); PROJECT=aisa-prod
  VOLUMES=(app_storage chatwoot_storage n8n_data)
else
  ENV_FILE=.env; COMPOSE=(docker compose); PROJECT=ai-sales-assistant
  VOLUMES=(chatwoot_storage n8n_data evolution_instances)
fi
set -a; source "$ENV_FILE"; set +a
ROOT_DEST="${1:-./backups}"
DEST="$ROOT_DEST/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
chmod 700 "$ROOT_DEST" "$DEST"
for db in "${APP_DB_NAME:-ai_sales}" "${CHATWOOT_DB_NAME:-chatwoot}" "${N8N_DB_NAME:-n8n}" "${EVOLUTION_DB_NAME:-evolution}"; do
  if "${COMPOSE[@]}" exec -T postgres psql -U "${POSTGRES_SUPERUSER:-postgres}" -lqt | cut -d'|' -f1 | grep -qw "$db"; then
    echo ">> pg_dump $db"
    "${COMPOSE[@]}" exec -T postgres pg_dump -U "${POSTGRES_SUPERUSER:-postgres}" -Fc --no-owner "$db" > "$DEST/$db.dump"
  fi
done
"${COMPOSE[@]}" exec -T postgres pg_dumpall -U "${POSTGRES_SUPERUSER:-postgres}" --globals-only > "$DEST/globals.sql"
for vol in "${VOLUMES[@]}"; do
  full="${PROJECT}_${vol}"
  if docker volume inspect "$full" >/dev/null 2>&1; then
    echo ">> volumen $vol"
    docker run --rm --entrypoint tar -v "$full":/v:ro -v "$(cd "$DEST" && pwd)":/b redis:7-alpine czf "/b/$vol.tgz" -C /v .  # imagen ya presente en el stack
  fi
done
( cd "$DEST" && { sha256sum -- * > SHA256SUMS 2>/dev/null || shasum -a 256 -- * > SHA256SUMS; } )
if [[ "${PROD:-}" == "1" ]]; then
  find "$ROOT_DEST" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime +"${KEEP_DAYS:-14}" -exec rm -r -- {} +
fi
echo "OK: copia en $DEST"
echo "Guarda también $ENV_FILE en un gestor de secretos: sin DATA_ENCRYPTION_KEY y N8N_ENCRYPTION_KEY las copias no sirven del todo."
echo "Copia el directorio a otro servidor o almacenamiento (una copia en el mismo disco no protege de su pérdida)."
