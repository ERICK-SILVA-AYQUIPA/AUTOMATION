#!/usr/bin/env bash
# Restaura UNA base desde un volcado .dump creado por backup.sh.
# Uso: ./infrastructure/scripts/restore.sh <archivo.dump> <nombre_base>
# ATENCIÓN: reemplaza los datos actuales de esa base. Pide confirmación.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; source .env; set +a
FILE="${1:?archivo .dump}"; DB="${2:?nombre de base}"
[[ -f "$FILE" ]] || { echo "No existe $FILE" >&2; exit 1; }
case "$DB" in "$APP_DB_NAME") OWNER=$APP_DB_USER;; "$CHATWOOT_DB_NAME") OWNER=$CHATWOOT_DB_USER;;
  "$N8N_DB_NAME") OWNER=$N8N_DB_USER;; "$EVOLUTION_DB_NAME") OWNER=$EVOLUTION_DB_USER;;
  *) echo "Base desconocida: $DB" >&2; exit 1;; esac
read -r -p "Se reemplazará la base '$DB'. Escribe el nombre para confirmar: " ans
[[ "$ans" == "$DB" ]] || { echo "Cancelado."; exit 1; }
docker compose exec -T postgres pg_restore -U "$POSTGRES_SUPERUSER" -d "$DB" --clean --if-exists --no-owner --role="$OWNER" < "$FILE"
echo "OK: '$DB' restaurada. Reinicia los servicios que la usan."
