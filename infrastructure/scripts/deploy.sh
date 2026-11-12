#!/usr/bin/env bash
# Despliegue de producción en un servidor Linux con Docker.
#   ./infrastructure/scripts/deploy.sh --init   genera los secretos de .env.production
#   ./infrastructure/scripts/deploy.sh          construye, migra y arranca (o actualiza)
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
    [[ "$line" == *"__GENERATE__"* ]] && line="${line//__GENERATE__/$(openssl rand -hex 32)}"
    printf '%s\n' "$line"
  done < "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "OK: secretos generados en $ENV_FILE (permisos 600)."
  echo "Completa APP_DOMAIN, ACME_EMAIL, SMTP_* y PLATFORM_ADMIN_EMAIL y vuelve a ejecutar sin --init."
  exit 0
fi

[[ -f "$ENV_FILE" ]] || { echo "Falta $ENV_FILE: ejecuta primero $0 --init" >&2; exit 1; }
if grep -q '__GENERATE__' "$ENV_FILE"; then echo "Quedan valores __GENERATE__ en $ENV_FILE: ejecuta $0 --init" >&2; exit 1; fi
for k in APP_DOMAIN ACME_EMAIL SMTP_HOST MAIL_FROM PLATFORM_ADMIN_EMAIL; do
  v="$(grep -E "^$k=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
  if [[ -z "$v" || "$v" == *"tu-dominio.com"* ]]; then echo "Completa $k en $ENV_FILE" >&2; exit 1; fi
done

echo "==> Construyendo imágenes"
"${COMPOSE[@]}" build
echo "==> Base de datos, migraciones y servicios"
"${COMPOSE[@]}" up -d --wait --remove-orphans
"${COMPOSE[@]}" ps
echo "OK: https://$(grep -E '^APP_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"
