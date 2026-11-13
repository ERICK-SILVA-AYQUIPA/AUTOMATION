# API REST (apps/api)

Base: `http://localhost:4000/api/v1`. Autenticación: `Authorization: Bearer <accessToken>`
salvo las rutas marcadas como públicas. Errores con formato uniforme:

```json
{ "statusCode": 400, "message": "Datos inválidos", "code": "VALIDATION_ERROR",
  "errors": [{ "path": "email", "message": "Correo inválido" }], "requestId": "..." }
```

## Autenticación (`/auth`)

| Método | Ruta | Acceso | Descripción |
|---|---|---|---|
| POST | `/auth/register` | pública, 10/min | Registra empresa + administrador. Envía correo de verificación. |
| POST | `/auth/verify-email` | pública | `{token}` del correo (un solo uso, 24 h). |
| POST | `/auth/resend-verification` | pública | Respuesta idéntica exista o no la cuenta. |
| POST | `/auth/login` | pública, 10/min | Devuelve `accessToken` (15 min) y fija cookies `aisa_rt` (HttpOnly, path `/api/v1/auth`) y `aisa_csrf`. Bloqueo de 15 min tras 5 fallos. |
| POST | `/auth/refresh` | cookie + cabecera `X-CSRF-Token` | Rota el refresh token. Reutilizar uno viejo revoca toda la familia de sesiones. |
| POST | `/auth/logout` | cookie + `X-CSRF-Token` | Revoca la sesión. |
| GET | `/auth/me` | autenticado | Usuario, empresa, plan y lista de permisos. |
| GET | `/auth/sessions` | autenticado | Sesiones activas del usuario. |
| DELETE | `/auth/sessions/:id` | autenticado | Cierra una sesión propia. |
| POST | `/auth/forgot-password` | pública, 10/min | Envía enlace (30 min). No revela si el correo existe. |
| POST | `/auth/reset-password` | pública | `{token, password}`. Cierra todas las sesiones. |
| POST | `/auth/accept-invitation` | pública | `{token, password, name?}` para usuarios invitados. |

Contraseñas: mínimo 10 caracteres con letras y números; hash Argon2id.

## Empresa (`/tenant`) y usuarios (`/users`)

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/tenant` | `tenant:read` (empresa, plan, límites y uso del periodo) |
| PATCH | `/tenant` | `tenant:settings`. Perfil: `name, currency, timezone, legalName, taxId (RUC de 11 dígitos si country=PE), country, address, phone, contactEmail, businessType (RETAIL\|RESTAURANT\|DISTRIBUTOR\|SERVICES\|PHARMACY\|OTHER), logoUrl (https), brandColor (#rrggbb)`. Dominio, modalidad y módulos no: los fija la plataforma |
| GET | `/users`, `/users/:id` | `users:read` |
| POST | `/users` | `users:manage` (invitación por correo; respeta `maxUsers` del plan) |
| POST | `/users/:id/resend-invitation` | `users:manage` |
| PATCH | `/users/:id` | `users:manage` (nombre, rol, ACTIVE/DISABLED; desactivar revoca sesiones) |

## Suscripción y solo lectura (ADR 036)

`GET /auth/me` y `GET /tenant` incluyen `subscription.access = { state: TRIAL|ACTIVE|GRACE|EXPIRED|CANCELED, readOnly, endsAt, graceEndsAt, daysLeft }`.
Con `readOnly`, toda petición que modifica datos responde **402** `{ code: "SUBSCRIPTION_EXPIRED" }`, salvo `/auth/*` y el acceso a Chatwoot. Las lecturas siguen funcionando.
`GET /tenant/payments` (administrador de la empresa): pagos registrados.

## Plataforma (`/platform`), solo ADMINISTRADOR GENERAL

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/platform/tenants?q=&status=&page=&pageSize=` | Empresas con plan y nº de usuarios |
| PATCH | `/platform/tenants/:id/status` | `ACTIVE` / `SUSPENDED` (bloquea el acceso de inmediato) |
| PATCH | `/platform/tenants/:id/plan` | Cambio manual de plan (sin cobro) |
| GET | `/platform/plans` | Planes activos con precio |
| POST | `/platform/tenants/:id/payments` | Registra un pago manual `{planCode, months 1-24, amount, currency, method: YAPE\|PLIN\|BANK_TRANSFER\|CASH\|OTHER, reference?, paidAt?}`: activa el plan; si el periodo sigue vigente los meses se suman al final |
| GET | `/platform/tenants/:id/payments` | Historial de pagos de la empresa |
| POST | `/platform/tenants/:id/cancel-subscription` | Cancela: la empresa queda en solo lectura de inmediato |
| GET | `/platform/metrics` | Empresas, suscripciones por **estado de acceso calculado** y por plan, renovaciones pendientes, ingresos (mes y 30 días, por moneda), consumo de IA del mes, mensajes, pedidos, automatizaciones y errores |
| GET | `/platform/tenants/:id` | Ficha: perfil, administradores, acceso, números de WhatsApp, integraciones y consumo |
| PATCH | `/platform/tenants/:id` | Perfil + `customDomain` (único), `deploymentMode` (SAAS\|DEDICATED\|CUSTOM), `enabledModules` |
| GET | `/platform/plans/all` | Todos los planes con límites y nº de empresas |
| PATCH | `/platform/plans/:code` | `{name?, priceMonthly?, currency?, limits?, isActive?}` (auditado) |

## Módulos por empresa (ADR 038)

`GET /auth/me` devuelve `tenant.enabledModules` (subconjunto de `conversations, ai, catalog, inventory, orders, customers, reports, automations`). Las rutas de un módulo apagado responden **403** `{ code: "MODULE_DISABLED" }`.

## Avisos (`/notifications`), cualquier usuario de la empresa

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/notifications?unread=true&limit=30` | `{items, unread}`: avisos de la empresa y los dirigidos al usuario (derivación a persona, WhatsApp desconectado, stock bajo, automatización fallida) |
| POST | `/notifications/:id/read` | Marca como leído (204) |
| POST | `/notifications/read-all` | Marca todos como leídos (204) |

## WhatsApp (`/whatsapp/numbers`) — permiso `integrations:manage`

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/whatsapp/numbers` | Números de la empresa (nunca devuelve secretos) |
| POST | `/whatsapp/numbers` | `{phoneNumberId, accessToken, appSecret, wabaId?, label?}`. Verifica con Meta antes de guardar; respeta `maxWhatsappNumbers` del plan |
| PATCH | `/whatsapp/numbers/:id` | `{label?, accessToken?, appSecret?, isActive?}` |
| GET | `/whatsapp/numbers/:id/webhook` | URL de webhook y token de verificación para Meta |
| POST | `/whatsapp/numbers/:id/check` | Vuelve a comprobar las credenciales con Meta |
| POST | `/whatsapp/numbers/:id/test-message` | `{to, template, language}`: envía una plantilla aprobada |

## Webhook de Meta (público)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/webhooks/whatsapp/:key` | Verificación (`hub.mode`, `hub.verify_token`, `hub.challenge`) |
| POST | `/webhooks/whatsapp/:key` | Eventos. Exige `X-Hub-Signature-256` válida; responde `EVENT_RECEIVED` y procesa en el worker |

## Conversaciones (`/conversations`)

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/conversations?status=&q=&view=human\|mine\|unassigned&tag=&page=&pageSize=` | `conversations:read` |
| GET | `/conversations/:id` | `conversations:read` (últimos 500 mensajes, notas internas, `people` con los nombres de autores y asignado, y fin de la ventana de 24 h) |
| POST | `/conversations/:id/messages` | `conversations:reply`. `{text, idempotencyKey}`; fuera de la ventana responde `OUTSIDE_SERVICE_WINDOW`. Pausa la IA y asigna la conversación a quien responde si no tenía a nadie |
| PATCH | `/conversations/:id` | `conversations:reply`. `{status?: OPEN\|RESOLVED, botStatus?: ACTIVE\|PAUSED, assignedUserId?, tags?}`. Asignar a otra persona exige `conversations:assign`; cerrar reactiva la IA para la próxima conversación |
| POST | `/conversations/:id/notes` | `conversations:reply`. `{body}`: nota interna (el cliente no la ve; no se edita ni se borra) |

## Chatwoot (`/integrations/chatwoot`)

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/integrations/chatwoot` | `conversations:read`. `{available, status, lastError, accountId, inboxId, updatedAt}` (sin secretos) |
| POST | `/integrations/chatwoot/connect` | `integrations:manage`. Crea o completa la cuenta de Chatwoot de la empresa; idempotente. `503 CHATWOOT_ERROR` si Chatwoot falla |
| POST | `/integrations/chatwoot/sso` | `conversations:reply`. `{url}`: enlace de acceso único a Chatwoot para el usuario actual |

`PATCH /users/:id` con `status: DISABLED` o un rol nuevo también retira el acceso a Chatwoot; si Chatwoot falla responde `503 CHATWOOT_ERROR` (el cambio queda guardado; repetirlo reintenta la retirada).

## Webhook de Chatwoot (público)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/webhooks/chatwoot/:key` | Exige `X-Chatwoot-Signature` y `X-Chatwoot-Timestamp` válidos (HMAC con el secreto del buzón, 5 min). Respuestas de agentes → WhatsApp; cambios de estado/asignación → pausa o reactivación del asistente |

## API interna para n8n (`/internal`) — no se publica por la web

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/internal/notify` | Cabecera `X-Internal-Token` y origen en red privada. `{eventId, subject, text}`: correo a los administradores de la empresa del evento, una sola vez por evento |

## Salud

`GET /health/live` (proceso vivo) y `GET /health/ready` (PostgreSQL y Redis), públicos.

## Matriz de permisos

Definida en `apps/api/src/common/permissions.ts` (única fuente de verdad).
