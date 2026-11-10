#!/usr/bin/env bash
# Se ejecuta UNA sola vez, cuando el volumen de PostgreSQL está vacío.
# Crea una base de datos y un rol por servicio (principio de mínimo privilegio).
set -euo pipefail

create_db() {
  local db="$1" user="$2" pass="$3"
  echo ">> Creando rol '$user' y base '$db'"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
       -v db="$db" -v usr="$user" -v pwd="$pass" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'usr', :'pwd')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'usr') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'usr')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SQL
}

create_db "$APP_DB_NAME"       "$APP_DB_USER"       "$APP_DB_PASSWORD"
create_db "$CHATWOOT_DB_NAME"  "$CHATWOOT_DB_USER"  "$CHATWOOT_DB_PASSWORD"
create_db "$N8N_DB_NAME"       "$N8N_DB_USER"       "$N8N_DB_PASSWORD"
create_db "$EVOLUTION_DB_NAME" "$EVOLUTION_DB_USER" "$EVOLUTION_DB_PASSWORD"

# Chatwoot necesita extensiones que requieren superusuario para instalarse.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$CHATWOOT_DB_NAME" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
SQL

# Base de la aplicación: extensiones usadas por el backend (UUID, búsqueda difusa).
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$APP_DB_NAME" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
SQL

# Evolution usa el esquema evolution_api dentro de su base.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$EVOLUTION_DB_NAME" \
     -v usr="$EVOLUTION_DB_USER" <<'SQL'
SELECT format('CREATE SCHEMA IF NOT EXISTS evolution_api AUTHORIZATION %I', :'usr') \gexec
SQL

echo ">> Bases de datos inicializadas"
