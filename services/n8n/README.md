# n8n

Imagen oficial `n8nio/n8n` (versión en `.env`: `N8N_VERSION`), base de datos
PostgreSQL propia (`n8n`). UI de administración solo en `http://localhost:5678`
(nunca expuesta a internet ni a clientes; ver `LICENSES.md`).

- Flujos versionados en `workflows/` (JSON exportado), montados en el contenedor
  en `/workflows` (solo lectura). Se importan con
  `docker compose exec n8n n8n import:workflow --separate --input=/workflows`.
- `./services/n8n/setup.sh` importa la credencial **AISA token interno** (Header Auth,
  cabecera `X-Internal-Token` = `N8N_INTERNAL_TOKEN`, cifrada por n8n) y los flujos, y
  los publica. n8n mantiene bloqueado `$env` en los nodos (ADR 028).
- El backend nunca llama a n8n directamente desde una petición: escribe el evento en
  `automation_events` dentro de la misma transacción y el **worker** lo entrega a
  `N8N_WEBHOOK_BASE_URL/<ruta>` con reintentos (hasta 8, espera creciente). Si se agotan,
  el evento queda `FAILED` y se avisa a los administradores dentro del panel.
- Los flujos responden llamando a `callbackUrl` (`N8N_API_BASE_URL/api/v1/internal/notify`),
  que exige el token y una IP privada y entrega cada aviso **una sola vez**.
- `N8N_ENCRYPTION_KEY` cifra las credenciales guardadas en n8n: si se pierde,
  las credenciales no se pueden recuperar. Inclúyela en la copia de seguridad de secretos.

## Los 7 flujos del encargo

| Flujo | Dónde se ejecuta | Estado |
|---|---|---|
| 1 · Mensaje entrante | Backend + worker: webhook firmado → evento con clave única → cola → empresa por número → cliente por teléfono o BSUID → conversación | Hecho (FASE 4) |
| 2 · Consulta de producto | Worker + Dify (interpreta) + herramientas del backend (catálogo y stock) | FASE 6 |
| 3 · Registro de pedido | Backend (validación, stock, confirmación, creación en una transacción) → n8n `03-aisa-pedido-nuevo` (notificación) | Notificación hecha; creación desde WhatsApp en FASE 6 |
| 4 · Stock bajo | Backend detecta el cruce del mínimo → n8n `04-aisa-stock-bajo` → correo a administradores | Hecho |
| 5 · Seguimiento | Worker + herramienta `consultar_pedido` | FASE 6 |
| 6 · Transferencia humana | Worker pausa la IA y avisa en el panel → n8n `06-aisa-derivacion` (correo a administradores, si la empresa la activa) | Hecho (evolución, fase 4) |
| 7 · Recuperación de errores | Registro en BD → reintento controlado (colas y bandeja de salida) → n8n `07-aisa-error` (alerta) | Hecho |

Las acciones comerciales (pedidos, stock) solo ocurren en el backend; n8n nunca escribe en
la base de datos. Así un webhook repetido no duplica pedidos ni movimientos.

### Probado con el n8n real (2026-11-10)
API + worker + n8n 3.2.0 + Mailpit: stock 6 → 4 con mínimo 5 y un pedido nuevo generan los
correos "Stock bajo: …" y "Pedido nuevo #1 · PEN 7.00"; un evento de error genera
"Mensaje de WhatsApp no entregado". Webhooks de n8n sin token o con token incorrecto → 403.


### Flujo 06 probado con el n8n real (2026-11-13)
API + worker + n8n + Mailpit: un evento `HANDOFF_NOTIFICATION` se entregó al webhook
`aisa-derivacion` y llegó el correo «Atención humana: …» con el motivo y el enlace a la
conversación. El reintento manual desde el panel (Automatizaciones → Historial) de una
alerta de stock fallida también llegó por n8n (`apps/web/e2e/automations.mjs`).
