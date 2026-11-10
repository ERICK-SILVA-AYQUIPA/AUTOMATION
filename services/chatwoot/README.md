# Chatwoot

Imagen oficial `chatwoot/chatwoot` (`CHATWOOT_VERSION`), servicios `rails` y
`sidekiq` según su `docker-compose.production.yaml`, con PostgreSQL (`chatwoot`,
extensiones `vector`, `pgcrypto`, `pg_stat_statements`) y Redis DB 0.

Primera vez:
1. `./infrastructure/scripts/chatwoot-init.sh` (ejecuta `rails db:chatwoot_prepare`).
2. `bash services/chatwoot/setup-platform.sh`: crea el super administrador
   (`PLATFORM_ADMIN_EMAIL`, contraseña en `CHATWOOT_SUPER_ADMIN_PASSWORD`), **cierra el
   asistente de instalación** (abierto, deja que cualquiera se haga super administrador)
   y guarda el token de la Platform App en `CHATWOOT_PLATFORM_TOKEN`.
3. Reinicia la API y el worker. Cada empresa activa su bandeja en Integraciones.

`ENABLE_ACCOUNT_SIGNUP=false`: las cuentas solo las crea nuestra plataforma.
`SAFE_FETCH_ALLOW_PRIVATE_NETWORK` sale de `CHATWOOT_ALLOW_PRIVATE_NETWORK` (solo
`true` en desarrollo) y `extra_hosts` da acceso a `host.docker.internal`.

Funcionamiento, variables y seguridad: `docs/integrations/chatwoot.md`.
