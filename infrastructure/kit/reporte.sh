#!/usr/bin/env bash
# =============================================================================
# Reporte de la instalación a la plataforma central (ADR 052). Solo existe en
# las instalaciones administradas: el agente deja /opt/aisa/monitor.env (600)
# con el token de solo reporte y lo programa cada 10 minutos.
# Envía salud de los servicios y la puesta en marcha (WhatsApp, IA, correo,
# automatizaciones, catálogo): estados y conteos, sin datos de clientes.
# Para dejar de reportar: borra /opt/aisa/monitor.env (o cancela en el panel).
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")" || exit 1
MONITOR_ENV="${AISA_MONITOR_ENV:-/opt/aisa/monitor.env}"
[[ -f "$MONITOR_ENV" ]] || { echo "Sin $MONITOR_ENV: esta instalación no reporta a la plataforma"; exit 0; }
# shellcheck disable=SC1090
source "$MONITOR_ENV"
COMPOSE=(docker compose -f docker-compose.prod.yml --env-file .env.production)
if ./salud.sh >/dev/null 2>&1; then sano=true; else sano=false; fi
body="$("${COMPOSE[@]}" exec -T api node dist/cli.js estado --sano "$sano" 2>/dev/null | tail -1)"
if [[ "$body" != "{"* ]]; then
  # La API no responde: se informa igual, como instalación con problemas
  version="$(grep -E '^APP_VERSION=' .env.production | tail -1 | cut -d= -f2-)"
  body="{\"version\":\"${version:-0.0.0}\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"healthy\":false,\"tenants\":[]}"
fi
out="$(curl -sS --max-time 30 --retry 3 --retry-all-errors -H "Authorization: Bearer $MONITOR_TOKEN" -H 'Content-Type: application/json' \
  -d "$body" "$API_URL/api/v1/public/provisioning/$RUN_ID/heartbeat" 2>&1)"; rc=$?
echo "$(date -Is) salud=$sano envío=$rc ${out:0:200}"
exit $rc
