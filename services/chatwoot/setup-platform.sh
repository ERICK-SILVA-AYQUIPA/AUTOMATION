#!/usr/bin/env bash
# Crea (o reutiliza) la Platform App "AI Sales Assistant" en Chatwoot y guarda su token
# en .env (CHATWOOT_PLATFORM_TOKEN). Idempotente. Usa el comando oficial `rails runner`.
#   bash services/chatwoot/setup-platform.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

# 1) Cierra el asistente de instalación de Chatwoot. Mientras está abierto, CUALQUIERA
#    que llegue a /installation/onboarding puede crearse super administrador. Se crea
#    el super administrador de la plataforma (PLATFORM_ADMIN_EMAIL) con una contraseña
#    aleatoria guardada en .env (CHATWOOT_SUPER_ADMIN_PASSWORD) y se cierra el asistente.
set -a; . ./.env; set +a
if [ -z "${CHATWOOT_SUPER_ADMIN_PASSWORD:-}" ]; then
  CHATWOOT_SUPER_ADMIN_PASSWORD="Aa1!$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-28)"
  if grep -q '^CHATWOOT_SUPER_ADMIN_PASSWORD=' .env; then
    sed -i.bak "s|^CHATWOOT_SUPER_ADMIN_PASSWORD=.*|CHATWOOT_SUPER_ADMIN_PASSWORD=${CHATWOOT_SUPER_ADMIN_PASSWORD}|" .env && rm -f .env.bak
  else
    echo "CHATWOOT_SUPER_ADMIN_PASSWORD=${CHATWOOT_SUPER_ADMIN_PASSWORD}" >> .env
  fi
fi
docker compose exec -T -e CW_SA_EMAIL="${PLATFORM_ADMIN_EMAIL}" -e CW_SA_PASSWORD="${CHATWOOT_SUPER_ADMIN_PASSWORD}" chatwoot-rails \
  bundle exec rails runner '
    email = ENV.fetch("CW_SA_EMAIL").downcase
    unless SuperAdmin.exists?(email: email)
      raise "#{email} ya existe en Chatwoot como usuario normal" if User.exists?(email: email)
      SuperAdmin.create!(name: "Administrador de la plataforma", email: email, password: ENV.fetch("CW_SA_PASSWORD"), confirmed_at: Time.current)
    end
    ::Redis::Alfred.delete(::Redis::Alfred::CHATWOOT_INSTALLATION_ONBOARDING)
    print "SUPERADMIN=OK"' 2>/dev/null | grep -q 'SUPERADMIN=OK' || { echo "No se pudo crear el super administrador de Chatwoot" >&2; exit 1; }
echo "OK: asistente de instalación de Chatwoot cerrado; super administrador ${PLATFORM_ADMIN_EMAIL} (/super_admin)."

# 2) Platform App
token=$(docker compose exec -T chatwoot-rails bundle exec rails runner \
  'app = PlatformApp.find_or_create_by!(name: "AI Sales Assistant"); print "TOKEN=" + app.access_token.token' 2>/dev/null \
  | grep -o 'TOKEN=[A-Za-z0-9]*' | cut -d= -f2)
if [ -z "$token" ]; then
  echo "No se obtuvo el token. ¿Está Chatwoot en marcha? (docker compose ps chatwoot-rails)" >&2
  exit 1
fi
if grep -q '^CHATWOOT_PLATFORM_TOKEN=' .env; then
  sed -i.bak "s|^CHATWOOT_PLATFORM_TOKEN=.*|CHATWOOT_PLATFORM_TOKEN=${token}|" .env && rm -f .env.bak
else
  echo "CHATWOOT_PLATFORM_TOKEN=${token}" >> .env
fi
echo "OK: CHATWOOT_PLATFORM_TOKEN guardado en .env (reinicia la API y el worker)."
