#!/usr/bin/env bash
# Copia de seguridad: volcado lógico de cada base + volúmenes de archivos.
# Uso: ./infrastructure/scripts/backup.sh [directorio_destino]
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; source .env; set +a
DEST="${1:-./backups}/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
for db in "$APP_DB_NAME" "$CHATWOOT_DB_NAME" "$N8N_DB_NAME" "$EVOLUTION_DB_NAME"; do
  echo ">> pg_dump $db"
  docker compose exec -T postgres pg_dump -U "$POSTGRES_SUPERUSER" -Fc --no-owner "$db" > "$DEST/$db.dump"
done
docker compose exec -T postgres pg_dumpall -U "$POSTGRES_SUPERUSER" --globals-only > "$DEST/globals.sql"
for vol in chatwoot_storage n8n_data evolution_instances; do
  full="ai-sales-assistant_${vol}"
  if docker volume inspect "$full" >/dev/null 2>&1; then
    echo ">> volumen $vol"
    docker run --rm --entrypoint tar -v "$full":/v:ro -v "$(cd "$DEST" && pwd)":/b redis:7-alpine czf "/b/$vol.tgz" -C /v .  # imagen ya presente en el stack
  fi
done
( cd "$DEST" && shasum -a 256 * > SHA256SUMS 2>/dev/null || sha256sum * > SHA256SUMS )
echo "OK: copia en $DEST"
echo "Recuerda: n8n cifra credenciales con N8N_ENCRYPTION_KEY; guarda .env en un gestor de secretos."
