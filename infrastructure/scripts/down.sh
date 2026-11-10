#!/usr/bin/env bash
# Detiene los contenedores. Los datos (volúmenes) se conservan.
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose down
