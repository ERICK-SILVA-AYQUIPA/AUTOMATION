#!/usr/bin/env bash
# Muestra el estado de salud de cada contenedor y prueba los endpoints HTTP.
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; source .env; set +a
fail=0
echo "== Contenedores"
while IFS=$'\t' read -r svc state health; do
  printf '  %-20s %-10s %s\n' "$svc" "$state" "${health:-sin-healthcheck}"
  [[ "$state" != "running" || ( -n "$health" && "$health" != "healthy" ) ]] && fail=1
done < <(docker compose ps --format '{{.Service}}\t{{.State}}\t{{.Health}}')

probe() { # nombre url
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$2" || echo 000)
  printf '  %-20s %-40s HTTP %s\n' "$1" "$2" "$code"
  [[ "$code" =~ ^(2|3) ]] || fail=1
}
echo "== Endpoints"
profiles=",${COMPOSE_PROFILES:-},"
[[ "$profiles" == *",automation,"* ]] && probe n8n "http://127.0.0.1:${N8N_HOST_PORT:-5678}/healthz"
[[ "$profiles" == *",chatwoot,"*   ]] && probe chatwoot "http://127.0.0.1:${CHATWOOT_HOST_PORT:-3100}/api"
[[ "$profiles" == *",evolution,"*  ]] && probe evolution "http://127.0.0.1:${EVOLUTION_HOST_PORT:-8080}/"
if curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${DIFY_HTTP_PORT:-8090}/"; then
  probe dify "http://127.0.0.1:${DIFY_HTTP_PORT:-8090}/console/api/ping"
fi
[[ $fail -eq 0 ]] && echo "RESULTADO: todo sano" || echo "RESULTADO: hay servicios con problemas"
exit $fail
