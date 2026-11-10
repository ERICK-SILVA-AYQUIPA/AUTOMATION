#!/usr/bin/env bash
# Atajo para operar el proyecto Compose de Dify (separado del principal).
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)/upstream/docker"
[[ -d "$D" ]] || { echo "Ejecuta primero ./services/dify/install.sh" >&2; exit 1; }
cd "$D"
case "${1:-ps}" in
  up)   docker compose -p dify up -d && docker compose -p dify ps ;;
  down) docker compose -p dify down ;;
  ps)   docker compose -p dify ps --all ;;
  logs) shift; docker compose -p dify logs -f --tail=100 "$@" ;;
  *) echo "uso: $0 up|down|ps|logs [servicio]"; exit 1 ;;
esac
