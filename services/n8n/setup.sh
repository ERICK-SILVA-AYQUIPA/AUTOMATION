#!/usr/bin/env bash
# Importa en n8n la credencial del token interno y los flujos versionados, y los publica.
# Idempotente: se puede ejecutar de nuevo tras cambiar el token o actualizar los flujos.
#   bash services/n8n/setup.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

token=$(grep -E '^N8N_INTERNAL_TOKEN=' .env | cut -d= -f2-)
if [ -z "$token" ] || [ "${#token}" -lt 32 ]; then
  echo "N8N_INTERNAL_TOKEN falta o es corto en .env (ejecuta infrastructure/scripts/setup.sh)" >&2
  exit 1
fi

# Credencial "Header Auth" (cabecera X-Internal-Token). n8n la cifra con N8N_ENCRYPTION_KEY
# al importarla; el archivo temporal se borra en cuanto termina la importación.
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
chmod 600 "$tmp"
printf '[{"id":"aisaInternalTok1","name":"AISA token interno","type":"httpHeaderAuth","data":{"name":"X-Internal-Token","value":"%s"}}]' "$token" > "$tmp"
# Se pasa por stdin (no queda en la línea de comandos ni en la imagen)
docker compose exec -T n8n sh -c 'umask 077; f=$(mktemp); cat > "$f"; n8n import:credentials --input="$f"; rc=$?; rm -f "$f"; exit $rc' < "$tmp"

docker compose exec -T n8n n8n import:workflow --separate --input=/workflows
for id in aisaFlujo03Pedid aisaFlujo04Stock aisaFlujo07Error; do
  docker compose exec -T n8n n8n publish:workflow --id="$id"
done

# Los webhooks de producción se registran al arrancar
docker compose restart n8n >/dev/null
echo "Flujos de n8n importados y publicados. Reiniciando n8n..."
for _ in $(seq 1 30); do
  if docker compose exec -T n8n wget -qO- http://127.0.0.1:5678/healthz >/dev/null 2>&1; then echo "n8n listo"; exit 0; fi
  sleep 2
done
echo "n8n no respondió a tiempo; revisa: docker compose logs n8n" >&2
exit 1
