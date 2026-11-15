#!/usr/bin/env bash
# =============================================================================
# Agente de instalación administrada (ADR 051). Lo descarga el cloud-init del
# servidor nuevo y lo ejecuta como root. Informa cada paso a la plataforma:
#   Configurando servidor → Instalando servicios → Migrando base de datos →
#   Configurando integraciones
# Es idempotente: si algo falla, se corrige y se vuelve a ejecutar
#   sudo /opt/aisa/agente.sh
# Registro: /var/log/aisa-instalacion.log. Configuración: /opt/aisa/agente.env (600).
# =============================================================================
set -uo pipefail
umask 077
# Rutas fijas en producción; las pruebas automáticas las cambian para no tocar el sistema
DIR="${AISA_DIR:-/opt/aisa}"
LOG="${AISA_LOG:-/var/log/aisa-instalacion.log}"
CRON_FILE="${AISA_CRON_FILE:-/etc/cron.d/aisa}"
MONITOR_ENV="${AISA_MONITOR_ENV:-$DIR/monitor.env}"
cd "$DIR" || exit 1
# shellcheck disable=SC1091
source "$DIR/agente.env"
[[ -t 1 ]] || exec >>"$LOG" 2>&1
KIT="$DIR/instalacion"
export DEBIAN_FRONTEND=noninteractive

json() { python3 -c 'import json,sys; print(json.dumps(dict(zip(sys.argv[1::2], sys.argv[2::2]))))' "$@"; }
report() { # paso estado mensaje
  local out
  out=$(curl -sS --max-time 30 --retry 5 --retry-all-errors -H "Authorization: Bearer $AGENT_TOKEN" -H 'Content-Type: application/json' \
    -d "$(json step "$1" state "$2" message "${3:-}")" "$API_URL/api/v1/public/provisioning/$RUN_ID/report") || true
  echo "  [informe $1 $2] ${out:0:300}"
  # Si la plataforma la canceló o la detuvo, no se sigue
  if [[ "$2" != failed && "$out" == *'"proceed":false'* ]]; then echo "La plataforma indicó detenerse"; exit 3; fi
}
die() { report "$1" failed "$2"; echo "ERROR ($1): $2"; exit 1; }
fetch() { # ruta destino
  curl -fsS --max-time 3600 --retry 5 --retry-all-errors -H "Authorization: Bearer $AGENT_TOKEN" -D "$DIR/cabeceras.txt" -o "$2" "$API_URL/api/v1/public/provisioning/$RUN_ID/$1"
}
public_ip() { curl -4 -fsS --max-time 10 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 2>/dev/null || hostname -I | awk '{print $1}'; }

echo "== $(date -Is) agente · instalación $RUN_ID · versión $APP_VERSION · $APP_DOMAIN"

# ---------------------------------------------------------------- 1. Configurando servidor
STEP=CONFIGURING_SERVER
report $STEP started "Sistema $(. /etc/os-release && echo "$PRETTY_NAME")"
. /etc/os-release
[[ "$ID" == ubuntu || "$ID" == debian ]] || die $STEP "Sistema no soportado: $PRETTY_NAME (Ubuntu o Debian)"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  # Repositorio oficial de Docker con su clave firmada (https://docs.docker.com/engine/install/)
  apt-get update -q && apt-get install -y -q ca-certificates curl gnupg unzip unattended-upgrades || die $STEP "No se pudieron instalar los paquetes base"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc || die $STEP "No se pudo descargar la clave de Docker"
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -q && apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || die $STEP "No se pudo instalar Docker"
  systemctl enable --now docker || die $STEP "Docker no arranca"
else
  apt-get install -y -q unzip >/dev/null 2>&1 || true
fi
# Actualizaciones de seguridad automáticas del sistema
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
report $STEP progress "Docker $(docker version --format '{{.Server.Version}}') y Compose $(docker compose version --short)"
# El certificado HTTPS necesita que el dominio apunte a este servidor: se espera hasta 3 h
IP="$(public_ip)"
for n in $(seq 1 180); do
  resolved="$(getent ahostsv4 "$APP_DOMAIN" | awk 'NR==1{print $1}')"
  [[ "$resolved" == "$IP" ]] && break
  (( n == 1 || n % 10 == 0 )) && report $STEP progress "Esperando que $APP_DOMAIN apunte a $IP (registro DNS A); ahora: ${resolved:-sin registro}"
  sleep 60
done
[[ "$resolved" == "$IP" ]] || die $STEP "$APP_DOMAIN no apunta a $IP después de 3 horas"
report $STEP done "Docker listo y $APP_DOMAIN → $IP"

# ---------------------------------------------------------------- 2. Instalando servicios
STEP=INSTALLING
report $STEP started "Descargando el paquete de la versión $APP_VERSION"
fetch package "$DIR/paquete.zip" || die $STEP "No se pudo descargar el paquete de entrega"
want="$(grep -i '^x-package-sha256:' "$DIR/cabeceras.txt" | awk '{print $2}' | tr -d '\r')"
have="$(sha256sum "$DIR/paquete.zip" | awk '{print $1}')"
[[ -n "$want" && "$want" == "$have" ]] || die $STEP "El paquete no coincide con su huella (esperada ${want:-ninguna}, recibida $have)"
rm -rf "$DIR/paquete" && mkdir -p "$DIR/paquete" && unzip -q -o "$DIR/paquete.zip" -d "$DIR/paquete" || die $STEP "No se pudo descomprimir el paquete"
(cd "$DIR/paquete" && sha256sum -c --quiet SHA256SUMS) || die $STEP "SHA256SUMS del paquete no coincide"
# Se actualiza el kit sin tocar .env.production ni los datos de una ejecución anterior
mkdir -p "$KIT" && cp -a "$DIR/paquete/instalacion/." "$KIT/" || die $STEP "El paquete no trae la carpeta instalacion/"
IMG="$KIT/aisa-imagenes-$APP_VERSION.tar.gz"
if [[ ! -f "$IMG" ]] || [[ "$(sha256sum "$IMG" | awk '{print $1}')" != "$IMAGES_SHA256" ]]; then
  report $STEP progress "Descargando las imágenes de la aplicación"
  fetch images "$IMG.part" || die $STEP "No se pudieron descargar las imágenes"
  [[ "$(sha256sum "$IMG.part" | awk '{print $1}')" == "$IMAGES_SHA256" ]] || die $STEP "Las imágenes no coinciden con su huella SHA-256"
  mv "$IMG.part" "$IMG"
fi
cd "$KIT" || die $STEP "Falta $KIT"
if [[ ! -f .env.production ]]; then
  # instalar.sh crea .env.production con secretos aleatorios generados aquí (no salen del servidor)
  ./instalar.sh >/dev/null 2>&1 || true
  [[ -f .env.production ]] || die $STEP "instalar.sh no creó .env.production"
fi
setenv() { python3 - "$1" "$2" <<'PY'
import sys, re
k, v = sys.argv[1], sys.argv[2]
p = '.env.production'
lines = open(p).read().split('\n')
q = '"' + v.replace('\\', '\\\\').replace('"', '\\"') + '"' if re.search(r'[\s#"\'$`]', v) else v
out, done = [], False
for l in lines:
    if l.startswith(k + '='):
        if not done: out.append(f'{k}={q}'); done = True
    else: out.append(l)
if not done: out.insert(len(out) - 1 if out and out[-1] == '' else len(out), f'{k}={q}')
open(p, 'w').write('\n'.join(out))
PY
}
for k in APP_DOMAIN ACME_EMAIL PLATFORM_ADMIN_EMAIL SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASSWORD MAIL_FROM APP_VERSION; do setenv "$k" "${!k}"; done
chmod 600 .env.production
out="$(./instalar.sh --verificar 2>&1)"; rc=$?
echo "$out"
(( rc == 0 )) || die $STEP "Requisitos no cumplidos: $(echo "$out" | grep -F '✗' | sed 's/\x1b\[[0-9;]*m//g' | head -5 | tr '\n' ' ')"
report $STEP done "Paquete verificado, imágenes listas y configuración escrita"

# ---------------------------------------------------------------- 3 y 4. Migraciones, servicios y configuración de la empresa
STEP=MIGRATING
report $STEP started "Migraciones y arranque de servicios"
out="$(./instalar.sh 2>&1)"; rc=$?
echo "$out"
if (( rc != 0 )); then
  last="$(echo "$out" | grep -E '^== ' | tail -1)"
  msg="$(echo "$out" | grep -E 'ERROR|✗' | sed 's/\x1b\[[0-9;]*m//g' | tail -3 | tr '\n' ' ')"
  if [[ "$last" == *"Configuración de la empresa"* ]]; then
    report $STEP done "Servicios en marcha y salud correcta"
    die CONFIGURING_INTEGRATIONS "${msg:-no se pudo cargar la configuración de la empresa}"
  fi
  die $STEP "${msg:-falló $last}"
fi
report $STEP done "Migraciones aplicadas, servicios en marcha y salud correcta"
STEP=CONFIGURING_INTEGRATIONS
report $STEP started "Configuración de la empresa"

# Token de solo reporte para el monitoreo después de la entrega (ADR 052)
if [[ -n "${MONITOR_TOKEN:-}" ]]; then
  printf "API_URL='%s'\nRUN_ID='%s'\nMONITOR_TOKEN='%s'\n" "$API_URL" "$RUN_ID" "$MONITOR_TOKEN" > "$MONITOR_ENV"
  chmod 600 "$MONITOR_ENV"
fi
# Respaldo diario (03:15), salud cada 5 minutos y reporte a la plataforma cada 10, con registro
cat > "$CRON_FILE" <<CRON
SHELL=/bin/bash
15 3 * * * root cd $KIT && ./respaldo.sh >> /var/log/aisa-respaldo.log 2>&1
*/5 * * * * root cd $KIT && ./salud.sh > /var/log/aisa-salud.log 2>&1 || logger -t aisa "salud: hay servicios con problemas"
*/10 * * * * root cd $KIT && AISA_MONITOR_ENV=$MONITOR_ENV ./reporte.sh >> /var/log/aisa-reporte.log 2>&1
CRON
chmod 644 "$CRON_FILE"
# El paquete descargado ya no hace falta; la contraseña SMTP queda solo en .env.production
rm -rf "$DIR/paquete" "$DIR/paquete.zip" "$DIR/cabeceras.txt"
# Primer reporte ahora mismo (después, cada 10 minutos)
[[ -f "$MONITOR_ENV" ]] && (cd "$KIT" && AISA_MONITOR_ENV="$MONITOR_ENV" ./reporte.sh) || true
sed -i -e "s/^SMTP_PASSWORD=.*/SMTP_PASSWORD=''/" -e "s/^MONITOR_TOKEN=.*/MONITOR_TOKEN=''/" "$DIR/agente.env"
report $STEP done "Empresa cargada, respaldo diario, salud cada 5 minutos y reporte a la plataforma cada 10 programados"
echo "== $(date -Is) agente terminado: la plataforma comprueba ahora https://$APP_DOMAIN desde afuera"
