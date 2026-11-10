# Chatwoot

Imagen oficial `chatwoot/chatwoot` (`CHATWOOT_VERSION`), servicios `rails` y
`sidekiq` según su `docker-compose.production.yaml`, con PostgreSQL (`chatwoot`,
extensiones `vector`, `pgcrypto`, `pg_stat_statements`) y Redis DB 0.

Primera vez:
1. `./infrastructure/scripts/chatwoot-init.sh` (ejecuta `rails db:chatwoot_prepare`).
2. Abrir `http://localhost:3100` y crear el super administrador.
3. FASE 5: crear un *Platform App* en `/super_admin` y guardar su token en
   `CHATWOOT_PLATFORM_TOKEN`. El backend crea una Account + inbox API por empresa.

`ENABLE_ACCOUNT_SIGNUP=false`: las cuentas solo las crea nuestra plataforma.
