#!/usr/bin/env bash
# Salud de la instalación: estado de cada contenedor y /api/v1/health/ready por HTTPS.
set -uo pipefail
cd "$(dirname "$0")"
COMPOSE=(docker compose -f docker-compose.prod.yml --env-file .env.production)
domain="$(grep -E '^APP_DOMAIN=' .env.production | tail -1 | cut -d= -f2-)"
# Con local_certs (solo pruebas) el certificado es de la CA interna de Caddy
grep -qE '^CADDY_GLOBAL_OPTIONS=.*local_certs' .env.production && CURL_INSECURE=1
fail=0
echo "== Contenedores"
while IFS=$'\t' read -r svc state health; do
  printf '  %-16s %-10s %s\n' "$svc" "$state" "${health:-sin-healthcheck}"
  [[ "$state" != "running" || ( -n "$health" && "$health" != "healthy" ) ]] && fail=1
done < <("${COMPOSE[@]}" ps --format '{{.Service}}\t{{.State}}\t{{.Health}}')
echo "== Aplicación"
# Se prueba a través de Caddy (dominio y certificado reales); --resolve evita depender del DNS local
for i in $(seq 1 30); do
  body="$(curl -sS --max-time 5 --noproxy "*" ${CURL_INSECURE:+-k} --resolve "$domain:443:127.0.0.1" "https://$domain/api/v1/health/ready" 2>&1)" && break
  sleep 2
done
echo "  https://$domain/api/v1/health/ready → $body"
[[ "$body" == *'"status":"ok"'* ]] || fail=1
echo "== Versión"
want="$(grep -E '^APP_VERSION=' .env.production | tail -1 | cut -d= -f2-)"
have="$("${COMPOSE[@]}" exec -T api node dist/cli.js version 2>/dev/null | tail -1)"
echo "  instalada: ${have:-desconocida} · esperada: ${want:-sin APP_VERSION}"
[[ -n "$want" && "$have" == "$want" ]] || fail=1
[[ $fail -eq 0 ]] && echo "RESULTADO: todo sano" || echo "RESULTADO: hay servicios con problemas"
exit $fail
