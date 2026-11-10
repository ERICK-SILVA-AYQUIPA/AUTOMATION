#!/usr/bin/env bash
# Prepara el entorno local: comprueba requisitos y genera .env con secretos.
# Uso: ./infrastructure/scripts/setup.sh [--force]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: falta '$1'. $2" >&2; exit 1; }; }
need docker  "Instala Docker Desktop: https://docs.docker.com/desktop/setup/install/mac-install/"
need openssl "Viene preinstalado en macOS."
docker compose version >/dev/null 2>&1 || { echo "ERROR: se requiere 'docker compose' v2." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "ERROR: Docker no está en ejecución. Abre Docker Desktop." >&2; exit 1; }

if [[ -f .env && "${1:-}" != "--force" ]]; then
  echo ".env ya existe; no se sobrescribe (usa --force para regenerarlo, PERDERÁS los secretos actuales)."
  exit 0
fi

tmp="$(mktemp)"
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == *"__GENERATE__"* ]]; then
    line="${line//__GENERATE__/$(openssl rand -hex 32)}"
  fi
  printf '%s\n' "$line"
done < .env.example > "$tmp"
mv "$tmp" .env
chmod 600 .env
echo "OK: .env generado con secretos aleatorios (permisos 600)."
echo "Siguiente paso: ./infrastructure/scripts/up.sh"
