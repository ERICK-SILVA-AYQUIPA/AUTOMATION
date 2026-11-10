# Dify

Se usa el **compose oficial** de Dify, descargado en `upstream/` (ignorado por
git) a la versión `DIFY_VERSION`, como proyecto Compose independiente `dify`.

```bash
./services/dify/install.sh   # clona la carpeta docker/ del tag y crea su .env
./services/dify/dify.sh up   # arranca
./services/dify/dify.sh ps
```

Configuración aplicada (solo vía `.env` de Dify, mecanismo oficial):
- `DIFY_AGENT_LOCAL_SANDBOX_AUTH_TOKEN` aleatorio (obligatorio).
- `COMPOSE_PROFILES=pgvector,postgresql,collaboration` y `VECTOR_STORE=pgvector`.
- `EXPOSE_NGINX_PORT=127.0.0.1:8090` (solo localhost).
- `SECRET_KEY` aleatorio.

Primer uso: `http://localhost:8090/install` para crear la cuenta propietaria.
En FASE 6 se crea la app y su API key va a `DIFY_APP_API_KEY`.
Producción: revisar `upstream/docker/envs/security.env.example` y sustituir
todas las credenciales por defecto.
