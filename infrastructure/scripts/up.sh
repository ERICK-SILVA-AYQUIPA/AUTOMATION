#!/usr/bin/env bash
# Levanta la infraestructura de desarrollo y espera a que esté sana.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
[[ -f .env ]] || { echo "Falta .env: ejecuta ./infrastructure/scripts/setup.sh" >&2; exit 1; }
docker compose up -d --wait --wait-timeout "${WAIT_TIMEOUT:-600}"
docker compose ps
