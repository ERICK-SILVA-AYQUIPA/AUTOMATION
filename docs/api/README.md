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
| PATCH | `/tenant` | `tenant:settings` |
| GET | `/users`, `/users/:id` | `users:read` |
| POST | `/users` | `users:manage` (invitación por correo; respeta `maxUsers` del plan) |
| POST | `/users/:id/resend-invitation` | `users:manage` |
| PATCH | `/users/:id` | `users:manage` (nombre, rol, ACTIVE/DISABLED; desactivar revoca sesiones) |

## Plataforma (`/platform`), solo ADMINISTRADOR GENERAL

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/platform/tenants?q=&status=&page=&pageSize=` | Empresas con plan y nº de usuarios |
| PATCH | `/platform/tenants/:id/status` | `ACTIVE` / `SUSPENDED` (bloquea el acceso de inmediato) |
| PATCH | `/platform/tenants/:id/plan` | Cambio manual de plan (sin cobro) |
| GET | `/platform/metrics` | Métricas globales |

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
| GET | `/conversations?status=&q=&page=&pageSize=` | `conversations:read` |
| GET | `/conversations/:id` | `conversations:read` (últimos 500 mensajes y fin de la ventana de 24 h) |
| POST | `/conversations/:id/messages` | `conversations:reply`. `{text, idempotencyKey}`; fuera de la ventana responde `OUTSIDE_SERVICE_WINDOW` |

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
