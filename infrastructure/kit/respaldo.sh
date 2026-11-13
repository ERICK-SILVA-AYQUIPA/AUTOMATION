#!/usr/bin/env bash
# Respaldo: volcado de cada base de datos + volúmenes de archivos.
#   ./respaldo.sh /var/backups/aisa      (KEEP_DAYS=14 por defecto)
cd "$(dirname "$0")" && PROD=1 exec ./infrastructure/scripts/backup.sh "${1:-./respaldos}"
