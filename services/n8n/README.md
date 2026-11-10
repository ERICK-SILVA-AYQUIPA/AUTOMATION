# n8n

Imagen oficial `n8nio/n8n` (versión en `.env`: `N8N_VERSION`), base de datos
PostgreSQL propia (`n8n`). UI de administración solo en `http://localhost:5678`
(nunca expuesta a internet ni a clientes; ver `LICENSES.md`).

- Flujos versionados en `workflows/` (JSON exportado), montados en el contenedor
  en `/workflows` (solo lectura). Se importan con
  `docker compose exec n8n n8n import:workflow --separate --input=/workflows`.
- El backend llama a n8n por webhooks; n8n llama al backend con la cabecera
  `X-Internal-Token` (`N8N_INTERNAL_TOKEN`), disponible en n8n como variable de
  entorno `AISA_INTERNAL_TOKEN`, y la URL base como `AISA_API_URL`.
- `N8N_ENCRYPTION_KEY` cifra las credenciales guardadas en n8n: si se pierde,
  las credenciales no se pueden recuperar. Inclúyela en la copia de seguridad de secretos.
- Los flujos 1–7 se construyen en FASE 4 y FASE 7.
