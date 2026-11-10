#!/usr/bin/env bash
# Descarga el despliegue Docker OFICIAL de Dify en la versión fijada y lo
# configura para desarrollo local. No se modifica el código de Dify: solo se
# crea su archivo .env (mecanismo oficial de configuración).
#
# Uso: ./services/dify/install.sh        (instala/configura)
#      ./services/dify/dify.sh up|down|ps|logs
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
set -a; source "$ROOT/.env"; set +a
VERSION="${DIFY_VERSION:?define DIFY_VERSION en .env}"
DEST="$HERE/upstream"

if [[ -d "$DEST/.git" ]]; then
  current="$(git -C "$DEST" describe --tags --exact-match 2>/dev/null || echo desconocida)"
  if [[ "$current" != "$VERSION" ]]; then
    echo "Dify instalado en versión $current; .env pide $VERSION."
    echo "Para actualizar: haz backup (ver docs) y borra services/dify/upstream manualmente." >&2
    exit 1
  fi
else
  echo ">> Clonando langgenius/dify@$VERSION (solo carpeta docker/)"
  git clone --depth 1 --branch "$VERSION" --filter=blob:none --sparse \
      https://github.com/langgenius/dify.git "$DEST"
  git -C "$DEST" sparse-checkout set docker
fi

ENVF="$DEST/docker/.env"
if [[ ! -f "$ENVF" ]]; then
  cp "$DEST/docker/.env.example" "$ENVF"
  tok="$(openssl rand -hex 32)"
  # Rellena el token obligatorio del sandbox (paso documentado en docker/README.md)
  vs="${DIFY_VECTOR_STORE:-pgvector}"
  # Token obligatorio del sandbox (paso documentado en docker/README.md) y
  # perfiles: base de vectores pgvector en lugar de Weaviate (menos RAM en el Mac
  # y solo imágenes de Docker Hub). Mecanismo oficial: COMPOSE_PROFILES + VECTOR_STORE.
  awk -v t="$tok" -v vs="$vs" '
    /^DIFY_AGENT_LOCAL_SANDBOX_AUTH_TOKEN=/{print "DIFY_AGENT_LOCAL_SANDBOX_AUTH_TOKEN=" t; next}
    /^COMPOSE_PROFILES=/{print "COMPOSE_PROFILES=" vs ",postgresql,collaboration"; next}
    {print}' \
      "$ENVF" > "$ENVF.tmp" && mv "$ENVF.tmp" "$ENVF"
  cat >> "$ENVF" <<EOT

# ---- Añadido por AI Sales Assistant ----
# Publicar nginx SOLO en localhost y en puertos que no choquen con otros servicios
EXPOSE_NGINX_PORT=127.0.0.1:${DIFY_HTTP_PORT:-8090}
EXPOSE_NGINX_SSL_PORT=127.0.0.1:${DIFY_HTTPS_PORT:-8443}
VECTOR_STORE=${DIFY_VECTOR_STORE:-pgvector}
# Clave de firma propia (no usar la de ejemplo)
SECRET_KEY=$(openssl rand -hex 32)
EOT
  chmod 600 "$ENVF"
  echo ">> Creado $ENVF"
fi
echo "OK: Dify $VERSION listo. Arranca con: ./services/dify/dify.sh up"
