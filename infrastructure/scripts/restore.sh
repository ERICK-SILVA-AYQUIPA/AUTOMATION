#!/usr/bin/env bash
# Restaura UNA base desde un volcado .dump creado por backup.sh.
# Uso: ./infrastructure/scripts/restore.sh <archivo.dump> <nombre_base>
#      PROD=1 ./infrastructure/scripts/restore.sh ...   (producción: docker-compose.prod.yml + .env.production)
# ATENCIÓN: reemplaza los datos actuales de esa base. Pide confirmación.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ "${PROD:-}" == "1" ]]; then ENV_FILE=.env.production; COMPOSE=(docker compose -f docker-compose.prod.yml --env-file .env.production)
else ENV_FILE=.env; COMPOSE=(docker compose); fi
set -a; source "$ENV_FILE"; set +a
CHATWOOT_DB_NAME=${CHATWOOT_DB_NAME:-chatwoot}; CHATWOOT_DB_USER=${CHATWOOT_DB_USER:-chatwoot}
N8N_DB_NAME=${N8N_DB_NAME:-n8n}; N8N_DB_USER=${N8N_DB_USER:-n8n}
EVOLUTION_DB_NAME=${EVOLUTION_DB_NAME:-evolution}; EVOLUTION_DB_USER=${EVOLUTION_DB_USER:-evolution}
POSTGRES_SUPERUSER=${POSTGRES_SUPERUSER:-postgres}
FILE="${1:?archivo .dump}"; DB="${2:?nombre de base}"
[[ -f "$FILE" ]] || { echo "No existe $FILE" >&2; exit 1; }
case "$DB" in "$APP_DB_NAME") OWNER=$APP_DB_USER;; "$CHATWOOT_DB_NAME") OWNER=$CHATWOOT_DB_USER;;
  "$N8N_DB_NAME") OWNER=$N8N_DB_USER;; "$EVOLUTION_DB_NAME") OWNER=$EVOLUTION_DB_USER;;
  *) echo "Base desconocida: $DB" >&2; exit 1;; esac
if [[ "${CONFIRMAR:-}" == "$DB" ]]; then ans="$DB"   # sin pregunta: CONFIRMAR=<nombre_base>
else read -r -p "Se reemplazará la base '$DB'. Escribe el nombre para confirmar: " ans; fi
[[ "$ans" == "$DB" ]] || { echo "Cancelado."; exit 1; }
# Las extensiones (y sus comentarios) son del superusuario y ya existen en la base:
# se excluyen para que el resto se restaure como el propietario sin errores
"${COMPOSE[@]}" exec -T postgres sh -c "cat > /tmp/aisa-restore.dump && pg_restore -l /tmp/aisa-restore.dump | grep -vE ' EXTENSION ' > /tmp/aisa-restore.list && pg_restore -U '$POSTGRES_SUPERUSER' -d '$DB' --clean --if-exists --no-owner --role='$OWNER' --exit-on-error -L /tmp/aisa-restore.list /tmp/aisa-restore.dump" < "$FILE"
echo "OK: '$DB' restaurada. Reinicia los servicios que la usan."
