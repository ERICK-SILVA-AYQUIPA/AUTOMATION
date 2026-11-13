#!/usr/bin/env bash
# =============================================================================
# Instalador de una instancia independiente de AI Sales Assistant (ADR 044).
#   ./instalar.sh --verificar   solo comprueba los requisitos (no cambia nada)
#   ./instalar.sh --verificar --carpeta <dir>   comprueba una instalación existente
#                               con los requisitos de este paquete (actualizar.sh)
#   ./instalar.sh               comprueba, instala, verifica la salud y carga
#                               la configuración de la empresa (una sola vez)
# No continúa si falta un requisito. Todo queda en instalacion-<fecha>.log.
# =============================================================================
set -uo pipefail
KIT="$(cd "$(dirname "$0")" && pwd)"
ONLY_CHECK=0; TARGET=""
while (( $# )); do
  case "$1" in
    --verificar) ONLY_CHECK=1;;
    # Lo usa actualizar.sh: comprueba una instalación existente con los requisitos de ESTE paquete
    --carpeta) TARGET="${2:-}"; shift;;
    *) echo "Uso: ./instalar.sh [--verificar] [--carpeta <instalación existente>]"; exit 2;;
  esac
  shift
done
[[ -z "$TARGET" || $ONLY_CHECK -eq 1 ]] || { echo "--carpeta solo se usa con --verificar"; exit 2; }
# Versión del kit (la del paquete); configuracion-cliente.json solo se usa en la primera instalación
VERSION="$(grep -E '^APP_VERSION=' "$KIT/.env.production.example" 2>/dev/null | tail -1 | cut -d= -f2-)"
[[ -n "$VERSION" && ( -n "$TARGET" || -f "$KIT/configuracion-cliente.json" ) ]] || { echo "Faltan .env.production.example o configuracion-cliente.json: este no es un paquete de entrega válido"; exit 1; }
cd "${TARGET:-$KIT}" || exit 2
DIR="$(pwd)"
ENV_FILE=.env.production
COMPOSE=(docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE")
LOG="$DIR/instalacion-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

ok=0; bad=0; warn=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; ok=$((ok+1)); }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; bad=$((bad+1)); }
note() { printf '  \033[33m!\033[0m %s\n' "$1"; warn=$((warn+1)); }
envval() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
ver_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }

echo "AI Sales Assistant ${VERSION} · instalación independiente · $(date -Is)"

# ---------------------------------------------------------------- 1. Requisitos
echo "== Requisitos del servidor"
case "$(uname -s)/$(uname -m)" in Linux/x86_64|Linux/aarch64) pass "Sistema $(uname -s) $(uname -m)";; *) fail "Sistema no soportado: $(uname -s) $(uname -m) (Linux x86_64 o arm64)";; esac
for bin in docker curl openssl; do command -v "$bin" >/dev/null && pass "$bin instalado" || fail "Falta $bin"; done
if docker info >/dev/null 2>&1; then
  dv="$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
  ver_ge "$dv" 24.0.0 && pass "Docker Engine $dv" || fail "Docker Engine $dv: se necesita 24 o superior"
  cv="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
  [[ -n "$cv" ]] && ver_ge "$cv" 2.20.0 && pass "Docker Compose $cv" || fail "Docker Compose ${cv:-no instalado}: se necesita 2.20 o superior"
  root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  free_gb=$(( $(df -Pk "$root" 2>/dev/null | awk 'NR==2{print $4}') / 1024 / 1024 ))
  # INSTALAR_DISCO_MINIMO_GB solo para pruebas en máquinas pequeñas: queda como aviso en el registro
  min_gb="${INSTALAR_DISCO_MINIMO_GB:-20}"; [[ "$min_gb" =~ ^[0-9]+$ ]] || min_gb=20
  (( min_gb < 20 )) && note "Mínimo de disco reducido a ${min_gb} GB por INSTALAR_DISCO_MINIMO_GB (no recomendado en producción)"
  (( free_gb >= min_gb )) && pass "Disco libre en $root: ${free_gb} GB" || fail "Disco libre en $root: ${free_gb} GB (mínimo ${min_gb} GB)"
else
  fail "No se puede usar Docker (¿está instalado y en marcha? ¿el usuario está en el grupo docker?)"
fi
mem_gb=$(awk '/MemTotal/{printf "%.1f", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo 0)
awk "BEGIN{exit !($mem_gb >= 3.5)}" && pass "Memoria: ${mem_gb} GB" || fail "Memoria: ${mem_gb} GB (mínimo 4 GB)"

echo "== Imágenes de la aplicación ${VERSION}"
missing=()
for img in aisa-api aisa-web aisa-migrate; do docker image inspect "$img:$VERSION" >/dev/null 2>&1 || missing+=("$img:$VERSION"); done
if (( ${#missing[@]} )) && [[ -f "$KIT/aisa-imagenes-$VERSION.tar.gz" ]]; then
  if (( ONLY_CHECK )); then note "Se cargarán desde aisa-imagenes-$VERSION.tar.gz al instalar"; missing=()
  else
    echo "  cargando aisa-imagenes-$VERSION.tar.gz…"
    if docker load -i "$KIT/aisa-imagenes-$VERSION.tar.gz" >/dev/null; then missing=(); for img in aisa-api aisa-web aisa-migrate; do docker image inspect "$img:$VERSION" >/dev/null 2>&1 || missing+=("$img:$VERSION"); done; fi
  fi
fi
(( ${#missing[@]} )) && fail "Faltan imágenes: ${missing[*]} (copia aisa-imagenes-$VERSION.tar.gz junto a este script)" || pass "Imágenes de la versión $VERSION disponibles"

echo "== Configuración ($ENV_FILE)"
created=0
if [[ ! -f "$ENV_FILE" ]]; then
  if (( ONLY_CHECK )); then fail "Falta $ENV_FILE (se crea con ./instalar.sh)"
  else
    # Secretos aleatorios solo en las líneas CLAVE=__GENERATE__ (nunca en comentarios)
    umask 077
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" =~ ^[A-Z0-9_]+=__GENERATE__$ ]]; then line="${line%%=*}=$(openssl rand -hex 32)"; fi
      printf '%s\n' "$line"
    done < "$KIT/.env.production.example" > "$ENV_FILE"
    chmod 600 "$ENV_FILE"; created=1
    note "Creado $ENV_FILE con secretos aleatorios (permisos 600). Guarda una copia fuera del servidor"
  fi
fi
if [[ -f "$ENV_FILE" ]]; then
  [[ "$(stat -c %a "$ENV_FILE")" == "600" ]] && pass "$ENV_FILE con permisos 600" || note "$ENV_FILE debería tener permisos 600 (chmod 600 $ENV_FILE)"
  grep -qE '^[A-Z0-9_]+=__GENERATE__$' "$ENV_FILE" && fail "Quedan valores __GENERATE__ en $ENV_FILE"
  [[ "$(envval APP_VERSION)" == "$VERSION" ]] && pass "APP_VERSION=$VERSION" || fail "APP_VERSION en $ENV_FILE ($(envval APP_VERSION)) no coincide con el paquete ($VERSION)"
  for k in APP_DOMAIN ACME_EMAIL SMTP_HOST MAIL_FROM PLATFORM_ADMIN_EMAIL; do
    v="$(envval "$k")"
    if [[ -z "$v" || "$v" == *"tu-dominio.com"* ]]; then fail "Completa $k en $ENV_FILE"; else pass "$k definido"; fi
  done
  for k in POSTGRES_SUPERUSER_PASSWORD APP_DB_PASSWORD APP_DB_RUNTIME_PASSWORD APP_DB_SYSTEM_PASSWORD REDIS_PASSWORD JWT_SECRET DATA_ENCRYPTION_KEY PLATFORM_ADMIN_PASSWORD; do
    v="$(envval "$k")"; (( ${#v} >= 32 )) || fail "$k debe tener al menos 32 caracteres"
  done
  [[ -n "$(envval GEMINI_API_KEY)" ]] && pass "GEMINI_API_KEY definida (se valida con Google desde Integraciones)" || note "Sin GEMINI_API_KEY: el asistente no responde hasta que se configure una clave"

  echo "== Dominio y red"
  domain="$(envval APP_DOMAIN)"; local_certs=0; [[ "$(envval CADDY_GLOBAL_OPTIONS)" == *local_certs* ]] && local_certs=1
  if [[ -n "$domain" && "$domain" != *"tu-dominio.com"* ]]; then
    ip="$(getent ahosts "$domain" 2>/dev/null | awk 'NR==1{print $1}')"
    if [[ -z "$ip" ]]; then (( local_certs )) && note "$domain no resuelve (modo de prueba local_certs)" || fail "$domain no resuelve en DNS: crea el registro A hacia este servidor"
    elif [[ "$ip" =~ ^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]] && (( ! local_certs )); then fail "$domain apunta a una IP privada ($ip): Let's Encrypt no podrá emitir el certificado"
    else pass "$domain resuelve a $ip"; fi
  fi
  running_caddy="$("${COMPOSE[@]}" ps -q caddy 2>/dev/null)"
  for port in 80 443; do
    if [[ -z "$running_caddy" ]] && (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then fail "El puerto $port ya está en uso por otro programa"; else pass "Puerto $port disponible"; fi
  done
  smtp="$(envval SMTP_HOST)"; sport="$(envval SMTP_PORT)"
  if [[ -n "$smtp" ]]; then
    if timeout 5 bash -c "exec 3<>/dev/tcp/$smtp/${sport:-587}" 2>/dev/null; then pass "SMTP $smtp:${sport:-587} accesible"
    else note "No se pudo conectar a SMTP $smtp:${sport:-587} desde el servidor (revisa el proveedor o el firewall; si es un servicio interno de Docker, ignóralo)"; fi
  fi
fi

echo "== Resultado: $ok correctos, $warn avisos, $bad errores"
if (( bad )); then echo "No se instala nada hasta corregir los errores."; exit 1; fi
if (( ONLY_CHECK )); then echo "Requisitos correctos. Ejecuta ./instalar.sh para instalar."; exit 0; fi
if (( created )); then echo "Revisa $ENV_FILE (SMTP_*, ACME_EMAIL, MAIL_FROM, PLATFORM_ADMIN_EMAIL) y vuelve a ejecutar ./instalar.sh."; exit 0; fi

# ---------------------------------------------------------------- 2. Instalación
echo "== Migraciones y servicios"
if ! "${COMPOSE[@]}" up -d --no-build --wait --remove-orphans; then
  echo "ERROR: los servicios no arrancaron. Revisa ./registros.sh migrate api"; exit 1
fi
"${COMPOSE[@]}" ps

echo "== Salud"
./salud.sh || { echo "ERROR: la comprobación de salud falló"; exit 1; }

# ---------------------------------------------------------------- 3. Configuración de la empresa (una vez)
echo "== Configuración de la empresa"
if "${COMPOSE[@]}" run --rm --no-deps -T -v "$DIR/configuracion-cliente.json:/entrega/configuracion-cliente.json:ro" api \
     node dist/cli.js importar-entrega /entrega/configuracion-cliente.json; then
  echo "OK: instalación completa. Panel: https://$(envval APP_DOMAIN)"
  echo "    Administrador general: $(envval PLATFORM_ADMIN_EMAIL) (contraseña en PLATFORM_ADMIN_PASSWORD de $ENV_FILE)"
else
  echo "ERROR: no se pudo cargar la configuración de la empresa (los servicios siguen en marcha). Corrige y repite ./instalar.sh"; exit 1
fi
