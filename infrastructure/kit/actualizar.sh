#!/usr/bin/env bash
# =============================================================================
# Actualizador de una instalación independiente de AI Sales Assistant (ADR 045).
# Se ejecuta desde la carpeta instalacion/ del paquete de la versión NUEVA:
#
#   ./actualizar.sh /opt/aisa/instalacion --verificar   muestra qué cambiaría (no toca nada)
#   ./actualizar.sh /opt/aisa/instalacion               respalda, actualiza, migra y comprueba
#
# Opciones:
#   --base <SHA256SUMS>            huellas del paquete con el que se instaló (solo para
#                                  instalaciones 0.8.x, que no guardaban .kit-sha256)
#   --sobrescribir-personalizados  reemplaza también los archivos del kit que se
#                                  modificaron a mano (se guardan en el respaldo)
#   --ensayar-recuperacion         actualiza y luego fuerza la recuperación, para
#                                  comprobar que el respaldo vuelve a la versión anterior
#   --recuperar <respaldo>         repite solo la recuperación desde un respaldo de
#                                  actualizar.sh (si la automática no terminó)
#
# Pasos: comprobaciones → respaldo completo (bases y volúmenes) → archivos del kit
# (sin pisar lo personalizado ni .env.production) → migraciones y servicios →
# salud → registro. Si algo falla después del respaldo, vuelve solo a la versión
# anterior con sus datos. Todo queda en actualizacion-<fecha>.log de la instalación.
# =============================================================================
set -uo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="" BASE="" RECOVER="" ONLY_CHECK=0 OVERWRITE=0 DRILL=0
while (( $# )); do
  case "$1" in
    --verificar) ONLY_CHECK=1;;
    --sobrescribir-personalizados) OVERWRITE=1;;
    --ensayar-recuperacion) DRILL=1;;
    --base) BASE="${2:-}"; shift;;
    --recuperar) RECOVER="${2:-}"; shift;;
    -*) echo "Opción desconocida: $1"; exit 2;;
    *) DEST="$1";;
  esac
  shift
done
[[ -n "$DEST" && -f "$DEST/docker-compose.prod.yml" && -f "$DEST/.env.production" ]] || {
  echo "Uso: ./actualizar.sh <carpeta de la instalación actual> [--verificar] [--base SHA256SUMS] [--sobrescribir-personalizados]"
  echo "La carpeta debe contener docker-compose.prod.yml y .env.production (la de ./instalar.sh)."; exit 2; }
DEST="$(cd "$DEST" && pwd)"
[[ "$DEST" != "$SRC" ]] || { echo "Ejecuta el actualizador desde el paquete nuevo, no desde la instalación"; exit 2; }
[[ -f "$SRC/.kit-sha256" && -f "$SRC/.env.production.example" ]] || { echo "Este paquete no trae .kit-sha256: no es un paquete de actualización válido"; exit 2; }

STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$DEST/actualizacion-$STAMP.log"
exec > >(tee -a "$LOG") 2>&1
ENV_FILE="$DEST/.env.production"
COMPOSE=(docker compose --project-directory "$DEST" -f "$DEST/docker-compose.prod.yml" --env-file "$ENV_FILE")
envval() { grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
older() { [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$1" ]]; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
die() { echo "ERROR: $*"; echo "No se cambió nada."; exit 1; }

FROM="$(envval APP_VERSION "$ENV_FILE")"
TO="$(envval APP_VERSION "$SRC/.env.production.example")"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
echo "AI Sales Assistant · actualización $FROM → $TO · $DEST · $(date -Is)"

BK=""
record() { # estado detalle → historial en la base (si la versión en marcha lo admite) y en el registro
  local estado="$1" detalle="$2"
  echo "{\"fecha\":\"$(date -Is)\",\"desde\":\"$FROM\",\"hasta\":\"$TO\",\"estado\":\"$estado\",\"respaldo\":\"$BK\"}" >> "$DEST/actualizaciones.jsonl"
  local out
  if out="$("${COMPOSE[@]}" exec -T api node dist/cli.js registrar-actualizacion --desde "$FROM" --hasta "$TO" --estado "$estado" --inicio "$STARTED" --respaldo "$BK" --detalle "$detalle" 2>&1)"; then
    echo "  $(tail -1 <<<"$out")"
  else
    echo "  (la versión en marcha no registra actualizaciones en la base: queda en actualizaciones.jsonl)"
  fi
}

rollback() {
  local why="$1"
  echo "== RECUPERACIÓN: $why"
  echo "  volviendo a $FROM con los datos del respaldo $BK"
  "${COMPOSE[@]}" stop >/dev/null 2>&1
  (cd "$DEST" && find . -mindepth 1 -maxdepth 1 ! -name respaldos ! -name 'actualizacion-*.log' ! -name 'instalacion-*.log' ! -name 'actualizaciones.jsonl' ! -name 'aisa-imagenes-*' -exec rm -rf -- {} +)
  tar xzf "$BK/kit-$FROM.tgz" -C "$DEST" || { echo "  ✗ No se pudo restaurar el kit: hazlo a mano desde $BK/kit-$FROM.tgz"; return 1; }
  local su; su="$(envval POSTGRES_SUPERUSER "$ENV_FILE")"; su="${su:-postgres}"
  "${COMPOSE[@]}" up -d --no-build --wait postgres redis >/dev/null 2>&1
  for dump in "$BK"/*.dump; do
    db="$(basename "$dump" .dump)"
    echo "  restaurando la base $db"
    "${COMPOSE[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U "$su" -d postgres -qc "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" || return 1
    # Recrea bases, roles y permisos (idempotente) y restaura el volcado como su propietario
    "${COMPOSE[@]}" exec -T postgres bash /docker-entrypoint-initdb.d/01-create-databases.sh >/dev/null || return 1
    owner="$("${COMPOSE[@]}" exec -T postgres psql -U "$su" -d postgres -tAc "select pg_get_userbyid(datdba) from pg_database where datname='$db'")"
    # Las extensiones y los esquemas que ya creó el script de inicio no se repiten; el resto, como el propietario
    "${COMPOSE[@]}" exec -T postgres sh -c "cat > /tmp/aisa-restore.dump && psql -U '$su' -d '$db' -tAc \"select ' SCHEMA - '||nspname||' ' from pg_namespace\" | grep . > /tmp/aisa-schemas && pg_restore -l /tmp/aisa-restore.dump | grep -vE ' EXTENSION ' | grep -vFf /tmp/aisa-schemas > /tmp/aisa-restore.list && pg_restore -U '$su' -d '$db' --no-owner --role='$owner' --exit-on-error -L /tmp/aisa-restore.list /tmp/aisa-restore.dump" < "$dump" || return 1
  done
  for tgz in "$BK"/*.tgz; do
    vol="$(basename "$tgz" .tgz)"; [[ "$vol" == kit-* ]] && continue
    full="aisa-prod_$vol"; docker volume inspect "$full" >/dev/null 2>&1 || continue
    echo "  restaurando el volumen $vol"
    docker run --rm --entrypoint sh -v "$full":/v -v "$BK":/b:ro redis:7-alpine -c "find /v -mindepth 1 -delete && tar xzf /b/$vol.tgz -C /v" || return 1
  done
  "${COMPOSE[@]}" up -d --no-build --wait --remove-orphans >/dev/null 2>&1 || return 1
  "$DEST/salud.sh" | sed 's/^/  /' || return 1
}

finish_failed() {
  local why="$1"
  if rollback "$why"; then
    echo "  ✓ La instalación volvió a $FROM con sus datos"
    record ROLLED_BACK "$why"
    echo "RESULTADO: actualización revertida. Revisa $LOG y ./registros.sh antes de reintentar."
  else
    echo "  ✗ La recuperación automática no terminó. Datos y archivos de $FROM: $BK (ver docs/instalacion.md, «Recuperación manual»)."
    echo "{\"fecha\":\"$(date -Is)\",\"desde\":\"$FROM\",\"hasta\":\"$TO\",\"estado\":\"FAILED\",\"respaldo\":\"$BK\"}" >> "$DEST/actualizaciones.jsonl"
    echo "RESULTADO: actualización FALLIDA y sin revertir."
  fi
  exit 1
}

# Volver a ejecutar solo la recuperación (si la automática no terminó): --recuperar <carpeta del respaldo>
if [[ -n "$RECOVER" ]]; then
  BK="$(cd "$RECOVER" 2>/dev/null && pwd)" || { echo "No existe $RECOVER"; exit 2; }
  kit="$(ls "$BK"/kit-*.tgz 2>/dev/null | head -1)"
  [[ -n "$kit" ]] || { echo "$BK no es un respaldo de actualizar.sh (falta kit-<versión>.tgz)"; exit 2; }
  FROM="$(basename "$kit" .tgz)"; FROM="${FROM#kit-}"
  finish_failed "Recuperación pedida con --recuperar"
fi

# ---------------------------------------------------------------- 1. Comprobaciones
echo "== Versiones"
[[ -n "$FROM" && -n "$TO" ]] || die "No se pudo leer APP_VERSION de la instalación o del paquete"
if [[ "$FROM" == "$TO" ]]; then echo "  La instalación ya está en $TO: no hay nada que actualizar."; exit 0; fi
older "$FROM" "$TO" || die "El paquete ($TO) es anterior a la instalación ($FROM): para volver atrás usa el respaldo, no el actualizador"
echo "  instalada $FROM · nueva $TO"

echo "== Estado actual"
"$DEST/salud.sh" >/dev/null 2>&1 || die "La instalación actual no está sana ($DEST/salud.sh). Corrígelo antes de actualizar para poder volver atrás con seguridad."
echo "  ✓ La instalación $FROM está sana"

echo "== Imágenes $TO"
need=(); for img in aisa-api aisa-web aisa-migrate; do docker image inspect "$img:$TO" >/dev/null 2>&1 || need+=("$img:$TO"); done
if (( ${#need[@]} )); then
  tarball="$SRC/aisa-imagenes-$TO.tar.gz"
  [[ -f "$tarball" ]] || die "Faltan ${need[*]}: copia aisa-imagenes-$TO.tar.gz junto a este script"
  if [[ -f "$tarball.sha256" ]]; then (cd "$SRC" && sha256sum -c --quiet "$(basename "$tarball").sha256") || die "La huella de $tarball no coincide"; fi
  if (( ONLY_CHECK )); then echo "  ! se cargarán desde $(basename "$tarball")"
  else docker load -i "$tarball" >/dev/null || die "No se pudieron cargar las imágenes"; fi
fi
for img in aisa-api aisa-web aisa-migrate; do docker image inspect "$img:$FROM" >/dev/null 2>&1 || die "Falta $img:$FROM (la versión actual): sin ella no se podría volver atrás"; done
echo "  ✓ Imágenes de $FROM (para volver atrás) y de $TO disponibles"

echo "== Archivos del kit"
declare -A base=()
if [[ -f "$DEST/.kit-sha256" ]]; then src_base="$DEST/.kit-sha256"
elif [[ -n "$BASE" && -f "$BASE" ]]; then src_base="$BASE"
else die "La instalación no tiene .kit-sha256 (se instaló con la 0.8.x). Indica las huellas del paquete con el que se instaló: --base <carpeta del ZIP anterior>/SHA256SUMS"; fi
while read -r h p; do [[ -n "${p:-}" ]] && base["${p#instalacion/}"]="$h"; done < "$src_base"
replace=() add=() custom=() same=() kept=()
while read -r h p; do
  [[ -n "${p:-}" ]] || continue
  [[ "$(sha "$SRC/$p")" == "$h" ]] || die "El paquete está alterado: $p no coincide con .kit-sha256"
  if [[ ! -e "$DEST/$p" ]]; then add+=("$p")
  else
    cur="$(sha "$DEST/$p")"
    if [[ "$cur" == "$h" ]]; then same+=("$p")
    elif [[ -n "${base[$p]:-}" && "$cur" == "${base[$p]}" ]]; then replace+=("$p")
    elif [[ -n "${base[$p]:-}" && "$h" == "${base[$p]}" ]]; then kept+=("$p")   # personalizado y sin novedades en $TO
    else custom+=("$p"); fi
  fi
done < "$SRC/.kit-sha256"
echo "  ${#replace[@]} se actualizan · ${#add[@]} nuevos · ${#same[@]} sin cambios · $(( ${#custom[@]} + ${#kept[@]} )) personalizados"
for p in "${replace[@]}"; do echo "    actualiza  $p"; done
for p in "${add[@]}"; do echo "    nuevo      $p"; done
for p in "${kept[@]}"; do echo "    conserva   $p (personalizado; $TO no lo cambia)"; done
for p in "${custom[@]}"; do
  if (( OVERWRITE )); then echo "    REEMPLAZA  $p (personalizado; la versión actual queda en el respaldo)"
  else echo "    conserva   $p (personalizado; la versión $TO se deja como $p.nuevo-$TO)"; fi
done

echo "== Variables de .env.production (nunca se reemplaza; solo cambia APP_VERSION y se añaden las nuevas)"
newvars=()
while IFS= read -r line; do
  [[ "$line" =~ ^([A-Z0-9_]+)= ]] || continue
  k="${BASH_REMATCH[1]}"; grep -qE "^$k=" "$ENV_FILE" || newvars+=("$line")
done < "$SRC/.env.production.example"
if (( ${#newvars[@]} )); then for l in "${newvars[@]}"; do echo "    nueva      ${l%%=*}"; done; else echo "  sin variables nuevas"; fi

echo "== Migraciones de la base de datos"
POSTGRES_USER_="$(envval POSTGRES_SUPERUSER "$ENV_FILE")"; DBNAME="$(envval APP_DB_NAME "$ENV_FILE")"
applied="$("${COMPOSE[@]}" exec -T postgres psql -U "${POSTGRES_USER_:-postgres}" -d "${DBNAME:-ai_sales}" -tAc "select migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null" 2>/dev/null)" \
  || die "No se pudo leer el estado de las migraciones"
bundled="$(docker run --rm --entrypoint ls "aisa-migrate:$TO" /repo/database/migrations 2>/dev/null | grep -E '^[0-9]{14}_')" || bundled=""
pending=(); for m in $bundled; do grep -qx "$m" <<<"$applied" || pending+=("$m"); done
if (( ${#pending[@]} )); then for m in "${pending[@]}"; do echo "    pendiente  $m"; done; else echo "  ninguna pendiente"; fi

if (( ONLY_CHECK )); then echo "== Comprobación terminada: ejecuta sin --verificar para actualizar"; exit 0; fi

# ---------------------------------------------------------------- 2. Respaldo previo (obligatorio)
echo "== Respaldo previo"
mkdir -p "$DEST/respaldos"
bk_out="$("$DEST/respaldo.sh" "$DEST/respaldos/antes-de-$TO" 2>&1)" || { echo "$bk_out"; die "El respaldo falló"; }
echo "$bk_out" | sed 's/^/  /'
BK="$(sed -n 's/^OK: copia en //p' <<<"$bk_out" | tail -1)"
[[ -n "$BK" && -d "$BK" ]] || die "No se encontró la carpeta del respaldo"
BK="$(cd "$BK" && pwd)"
# Copia de los archivos del kit y de la configuración tal como estaban
(cd "$DEST" && tar czf "$BK/kit-$FROM.tgz" --exclude='./respaldos' --exclude='./actualizacion-*.log' --exclude='./instalacion-*.log' --exclude='./aisa-imagenes-*' .) || die "No se pudo copiar el kit actual"
chmod 600 "$BK/kit-$FROM.tgz"
echo "  ✓ Respaldo completo en $BK"

# ---------------------------------------------------------------- 3. Archivos del kit
echo "== Archivos"
copy() { mkdir -p "$(dirname "$DEST/$1")" && cp -p "$SRC/$1" "$DEST/$1"; }
for p in "${replace[@]}" "${add[@]}"; do copy "$p" || finish_failed "No se pudo copiar $p"; done
for p in "${custom[@]}"; do
  if (( OVERWRITE )); then copy "$p" || finish_failed "No se pudo copiar $p"
  else cp -p "$SRC/$p" "$DEST/$p.nuevo-$TO"; fi
done
tmp="$(mktemp "$DEST/.env.XXXXXX")" && chmod 600 "$tmp"
sed -E "s/^APP_VERSION=.*/APP_VERSION=$TO/" "$ENV_FILE" > "$tmp"
if (( ${#newvars[@]} )); then
  printf '\n# ---------- Añadidas al actualizar a %s (%s) ----------\n' "$TO" "$(date +%F)" >> "$tmp"
  for l in "${newvars[@]}"; do
    [[ "$l" =~ ^[A-Z0-9_]+=__GENERATE__$ ]] && l="${l%%=*}=$(openssl rand -hex 32)"
    printf '%s\n' "$l" >> "$tmp"
  done
fi
mv "$tmp" "$ENV_FILE"
cp "$SRC/.kit-sha256" "$DEST/.kit-sha256"
echo "  ✓ Kit $TO aplicado"

echo "== Requisitos de $TO"
"$SRC/instalar.sh" --verificar --carpeta "$DEST" | sed -n '/== Resultado/,$p' | sed 's/^/  /'
(( PIPESTATUS[0] == 0 )) || finish_failed "La versión $TO no cumple los requisitos (ver arriba)"

# ---------------------------------------------------------------- 4. Migraciones y servicios
echo "== Migraciones y servicios"
"${COMPOSE[@]}" up -d --no-build --wait --remove-orphans || finish_failed "Los servicios de $TO no arrancaron (¿migración fallida? ./registros.sh migrate api)"
echo "== Salud"
"$DEST/salud.sh" | sed 's/^/  /'
(( PIPESTATUS[0] == 0 )) || finish_failed "La comprobación de salud de $TO falló"
(( DRILL )) && finish_failed "Ensayo de recuperación pedido con --ensayar-recuperacion (la versión $TO estaba sana)"

# ---------------------------------------------------------------- 5. Registro
detail="$(( ${#replace[@]} + ${#add[@]} )) archivos del kit actualizados"
(( ${#kept[@]} )) && detail+="; personalizados sin novedades conservados: ${kept[*]}"
if (( ${#custom[@]} )); then
  if (( OVERWRITE )); then detail+="; personalizados reemplazados con autorización: ${custom[*]}"
  else detail+="; personalizados conservados (revisar *.nuevo-$TO): ${custom[*]}"; fi
fi
(( ${#newvars[@]} )) && detail+="; variables nuevas: $(for l in "${newvars[@]}"; do printf '%s ' "${l%%=*}"; done)"
record SUCCEEDED "$detail"
echo "RESULTADO: actualizada a $TO. Respaldo previo en $BK"
(( ${#custom[@]} )) && (( ! OVERWRITE )) && echo "Revisa los archivos *.nuevo-$TO: tus cambios se conservaron y no incluyen las novedades de $TO."
exit 0
