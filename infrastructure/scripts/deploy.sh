#!/usr/bin/env bash
# Despliegue de producción en un servidor Linux con Docker.
#   ./infrastructure/scripts/deploy.sh --init   genera los secretos de .env.production
#   ./infrastructure/scripts/deploy.sh          construye, migra y arranca (o actualiza: respalda antes,
#                                               comprueba la salud y registra la actualización)
# Guía: docs/installation/production.md
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE=(docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE")

if [[ "${1:-}" == "--init" ]]; then
  [[ -f "$ENV_FILE" ]] || cp .env.production.example "$ENV_FILE"
  tmp="$(mktemp)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    # Solo las líneas CLAVE=__GENERATE__ (los comentarios que lo mencionan no se tocan)
    [[ "$line" =~ ^[A-Z0-9_]+=__GENERATE__$ ]] && line="${line%%=*}=$(openssl rand -hex 32)"
    printf '%s\n' "$line"
  done < "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "OK: secretos generados en $ENV_FILE (permisos 600)."
  echo "Completa APP_DOMAIN, ACME_EMAIL, SMTP_* y PLATFORM_ADMIN_EMAIL y vuelve a ejecutar sin --init."
  exit 0
fi

[[ -f "$ENV_FILE" ]] || { echo "Falta $ENV_FILE: ejecuta primero $0 --init" >&2; exit 1; }
if grep -qE '^[A-Z0-9_]+=__GENERATE__$' "$ENV_FILE"; then echo "Quedan valores __GENERATE__ en $ENV_FILE: ejecuta $0 --init" >&2; exit 1; fi
for k in APP_DOMAIN ACME_EMAIL SMTP_HOST MAIL_FROM PLATFORM_ADMIN_EMAIL; do
  v="$(grep -E "^$k=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
  if [[ -z "$v" || "$v" == *"tu-dominio.com"* ]]; then echo "Completa $k en $ENV_FILE" >&2; exit 1; fi
done

# Actualización (ADR 045): versión en marcha y respaldo completo ANTES de tocar nada
FROM=""; BK=""; STARTED="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
if [[ -n "$("${COMPOSE[@]}" ps -q --status running postgres 2>/dev/null)" ]]; then
  FROM="$("${COMPOSE[@]}" exec -T api node dist/cli.js version 2>/dev/null | tail -1 || true)"
  echo "==> Respaldo previo (versión en marcha: ${FROM:-desconocida})"
  out="$(PROD=1 ./infrastructure/scripts/backup.sh "${BACKUP_DIR:-./backups}")" || { echo "$out"; echo "ERROR: el respaldo falló; no se actualiza." >&2; exit 1; }
  echo "$out"
  BK="$(sed -n 's/^OK: copia en //p' <<<"$out" | tail -1)"
fi

fail() {
  echo "ERROR: $1" >&2
  if [[ -n "$BK" ]]; then
    echo "Los datos de antes de actualizar están en $BK. Para volver atrás: git checkout <versión anterior>," >&2
    echo "./infrastructure/scripts/deploy.sh y, si la migración cambió datos, restaura con CONFIRMAR=<base> PROD=1 ./infrastructure/scripts/restore.sh $BK/<base>.dump <base>" >&2
    echo "(guía: docs/installation/production.md, «Actualizar»)." >&2
  fi
  exit 1
}

echo "==> Construyendo imágenes"
"${COMPOSE[@]}" build || fail "no se pudieron construir las imágenes (no se cambió nada)"
echo "==> Base de datos, migraciones y servicios"
"${COMPOSE[@]}" up -d --wait --remove-orphans || fail "los servicios no arrancaron (revisa: docker compose -f docker-compose.prod.yml logs migrate api)"
"${COMPOSE[@]}" ps
TO="$("${COMPOSE[@]}" exec -T api node dist/cli.js version | tail -1)"
for i in $(seq 1 30); do
  "${COMPOSE[@]}" exec -T api node -e "fetch('http://127.0.0.1:4000/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && break
  [[ $i == 30 ]] && fail "la API $TO no responde sana"
  sleep 2
done
if [[ -n "$FROM" && "$FROM" != "$TO" ]]; then
  "${COMPOSE[@]}" exec -T api node dist/cli.js registrar-actualizacion --desde "$FROM" --hasta "$TO" --estado SUCCEEDED --inicio "$STARTED" ${BK:+--respaldo "$BK"} --detalle "deploy.sh"
fi
echo "OK: https://$(grep -E '^APP_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"
