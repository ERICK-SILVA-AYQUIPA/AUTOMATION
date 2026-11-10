#!/usr/bin/env bash
# Se ejecuta automáticamente UNA vez, cuando el volumen de PostgreSQL está vacío.
# Es idempotente: puede relanzarse a mano para aplicar cambios:
#   docker compose exec -T postgres bash /docker-entrypoint-initdb.d/01-create-databases.sh
#
# Crea una base de datos y un rol por servicio (mínimo privilegio) y, para la
# aplicación, tres roles:
#   APP_DB_USER          propietario: solo ejecuta migraciones
#   APP_DB_RUNTIME_USER  peticiones de usuarios. SIN BYPASSRLS -> RLS obligatoria
#   APP_DB_SYSTEM_USER   procesos de sistema (login, enrutado de webhooks,
#                        panel de plataforma). BYPASSRLS, uso acotado en el código
set -euo pipefail

PSQL=(psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -q)

create_db() {
  local db="$1" user="$2" pass="$3"
  echo ">> Rol '$user' y base '$db'"
  "${PSQL[@]}" --dbname postgres -v db="$db" -v usr="$user" -v pwd="$pass" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'usr', :'pwd')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'usr') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'usr')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SQL
}

# Permisos de los roles de ejecución y sistema sobre una base de la aplicación.
# ALTER DEFAULT PRIVILEGES es por base de datos, por eso se aplica a cada una.
app_db_grants() {
  local db="$1"
  "${PSQL[@]}" --dbname postgres -v db="$db" -v rt="$APP_DB_RUNTIME_USER" -v sy="$APP_DB_SYSTEM_USER" <<'SQL'
SELECT format('GRANT CONNECT ON DATABASE %I TO %I, %I', :'db', :'rt', :'sy') \gexec
SQL
  "${PSQL[@]}" --dbname "$db" -v rt="$APP_DB_RUNTIME_USER" -v sy="$APP_DB_SYSTEM_USER" -v own="$APP_DB_USER" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
SELECT format('GRANT USAGE ON SCHEMA public TO %I, %I', :'rt', :'sy') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I, %I', :'own', :'rt', :'sy') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I, %I', :'own', :'rt', :'sy') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I, %I', :'own', :'rt', :'sy') \gexec
-- Tablas ya existentes (si se relanza tras migrar)
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I, %I', :'rt', :'sy') \gexec
SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I, %I', :'rt', :'sy') \gexec
SQL
}

# --- Bases por servicio ------------------------------------------------------
create_db "$APP_DB_NAME"       "$APP_DB_USER"       "$APP_DB_PASSWORD"
create_db "$CHATWOOT_DB_NAME"  "$CHATWOOT_DB_USER"  "$CHATWOOT_DB_PASSWORD"
create_db "$N8N_DB_NAME"       "$N8N_DB_USER"       "$N8N_DB_PASSWORD"
create_db "$EVOLUTION_DB_NAME" "$EVOLUTION_DB_USER" "$EVOLUTION_DB_PASSWORD"

# --- Roles de la aplicación ---------------------------------------------------
"${PSQL[@]}" --dbname postgres \
  -v rt="$APP_DB_RUNTIME_USER" -v rtp="$APP_DB_RUNTIME_PASSWORD" \
  -v sy="$APP_DB_SYSTEM_USER" -v syp="$APP_DB_SYSTEM_PASSWORD" -v own="$APP_DB_USER" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOBYPASSRLS PASSWORD %L', :'rt', :'rtp')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'rt') \gexec
SELECT format('CREATE ROLE %I LOGIN BYPASSRLS PASSWORD %L', :'sy', :'syp')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'sy') \gexec
-- DESARROLLO: CREATEDB para la "shadow database" de `prisma migrate dev`.
-- En producción solo se ejecuta `prisma migrate deploy` y no hace falta.
SELECT format('ALTER ROLE %I CREATEDB', :'own') \gexec
SQL
app_db_grants "$APP_DB_NAME"

# --- Base de pruebas automatizadas (solo desarrollo) ---------------------------
if [[ "${CREATE_TEST_DB:-true}" == "true" ]]; then
  create_db "${APP_DB_NAME}_test" "$APP_DB_USER" "$APP_DB_PASSWORD"
  app_db_grants "${APP_DB_NAME}_test"
fi

# --- Chatwoot: extensiones que requieren superusuario --------------------------
"${PSQL[@]}" --dbname "$CHATWOOT_DB_NAME" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
SQL

# --- Evolution: esquema propio dentro de su base ----------------------------------
"${PSQL[@]}" --dbname "$EVOLUTION_DB_NAME" -v usr="$EVOLUTION_DB_USER" <<'SQL'
SELECT format('CREATE SCHEMA IF NOT EXISTS evolution_api AUTHORIZATION %I', :'usr') \gexec
SQL

echo ">> Bases de datos inicializadas"
