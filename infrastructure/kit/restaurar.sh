#!/usr/bin/env bash
# Restaura UNA base desde un volcado de ./respaldo.sh (pide confirmación).
#   ./restaurar.sh /var/backups/aisa/<fecha>/ai_sales.dump ai_sales
cd "$(dirname "$0")" && PROD=1 exec ./infrastructure/scripts/restore.sh "$@"
