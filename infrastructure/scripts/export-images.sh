#!/usr/bin/env bash
# Construye las imágenes de la versión actual y las guarda en un archivo para
# las instalaciones independientes (paquetes de entrega, ADR 044):
#   ./infrastructure/scripts/export-images.sh [directorio_destino]
# Resultado: aisa-imagenes-<versión>.tar.gz y su .sha256. No contiene secretos:
# las imágenes no llevan .env (ver .dockerignore).
set -euo pipefail
cd "$(dirname "$0")/../.."
VERSION="$(node -p "require('./apps/api/package.json').version")"
OUT="${1:-./dist-entregas}"
mkdir -p "$OUT"
for target in migrate api web; do
  echo "==> aisa-$target:$VERSION"
  docker build -f infrastructure/docker/app.Dockerfile --target "$target" -t "aisa-$target:$VERSION" ${EXTRA_CA:+--secret id=extra_ca,src=$EXTRA_CA} .
done
FILE="$OUT/aisa-imagenes-$VERSION.tar.gz"
echo "==> $FILE"
docker save "aisa-migrate:$VERSION" "aisa-api:$VERSION" "aisa-web:$VERSION" | gzip -1 > "$FILE"
(cd "$OUT" && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256")
echo "OK: $(du -h "$FILE" | cut -f1) · $(cat "$FILE.sha256")"
