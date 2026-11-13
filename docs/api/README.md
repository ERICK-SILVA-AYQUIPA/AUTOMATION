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
| GET | `/tenant/onboarding` | `tenant:read`: la misma lista de puesta en marcha que ve la plataforma |
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
| GET | `/platform/tenants?q=&status=ACTIVE\|SUSPENDED\|ONBOARDING&page=&pageSize=` | Empresas con plan y nº de usuarios |
| PATCH | `/platform/tenants/:id/status` | `ACTIVE` / `SUSPENDED` (bloquea el acceso de inmediato). Reactivar una empresa nunca activada la devuelve a `ONBOARDING` |
| PATCH | `/platform/tenants/:id/plan` | Cambio manual de plan (sin cobro) |
| GET | `/platform/plans` | Planes activos con precio |
| POST | `/platform/tenants/:id/payments` | Registra un pago manual `{planCode, months 1-24, amount, currency, method: YAPE\|PLIN\|BANK_TRANSFER\|CASH\|OTHER, reference?, paidAt?}`: activa el plan; si el periodo sigue vigente los meses se suman al final |
| GET | `/platform/tenants/:id/payments` | Historial de pagos de la empresa |
| POST | `/platform/tenants/:id/cancel-subscription` | Cancela: la empresa queda en solo lectura de inmediato |
| GET | `/platform/metrics` | Empresas, suscripciones por **estado de acceso calculado** y por plan, renovaciones pendientes, ingresos (mes y 30 días, por moneda), consumo de IA del mes, mensajes, pedidos, automatizaciones y errores |
| POST | `/platform/tenants` | **Alta** (ADR 039): perfil + `customDomain?`, `deploymentMode`, `enabledModules`, `planCode`, `startsAt?`, `endsAt` (periodo inicial, máx. 1 año), `admin {name, email}`, `idempotencyKey` (uuid) y opcionalmente `templateKey` + `templateCategories` (aplica reglas, automatizaciones, asistente publicado y categorías de la plantilla en la misma transacción). 201 la crea en `ONBOARDING` e invita al administrador; 200 si esa clave ya se usó. Responde `{tenant, created, invitation: {sent, error?}}` |
| GET | `/platform/tenants/:id/onboarding` | Lista de puesta en marcha `{status, activatedAt, tasks[{key,label,done,required,hint}], canActivate}` |
| POST | `/platform/tenants/:id/activate` | Activa si todas las tareas obligatorias están hechas; si no, 409 `ONBOARDING_INCOMPLETE` con `pending` |
| POST | `/platform/tenants/:id/resend-invitation` | Reenvía la invitación a los administradores que no entraron |
| GET | `/platform/tenants/:id` | Ficha: perfil, administradores, acceso, números de WhatsApp, integraciones y consumo |
| PATCH | `/platform/tenants/:id` | Perfil + `customDomain` (único), `deploymentMode` (SAAS\|DEDICATED\|CUSTOM), `enabledModules` |
| GET | `/platform/plans/all` | Todos los planes con límites y nº de empresas |
| PATCH | `/platform/plans/:code` | `{name?, priceMonthly?, currency?, limits?, isActive?}` (auditado) |
| GET | `/platform/templates` | Plantillas por sector (ADR 043): `RETAIL`, `RESTAURANT`, `DISTRIBUTOR`, `SERVICES` con `{key, version, name, description, businessType, includes, modules, settings, automations, ai, categories}` |
| GET | `/platform/tenants/:id/template?key=` | **Vista previa** con el estado real de la empresa: `{template, current {key, version}, changes[{section, field, from, to}], blocked[{…, note}]}` (no aplica nada) |
| POST | `/platform/tenants/:id/template` | `{key, sections[]}` con `sections` ⊂ `modules, settings, automations, ai, categories`: aplica **solo** esas secciones (lo del asistente va al **borrador**; las categorías solo se crean si faltan; las automatizaciones que el plan no incluye no se encienden). Auditado `platform.template_applied` |

### Entrega de sistemas (ADR 044)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/platform/tenants/:id/deliveries` | Entregas de la empresa |
| POST | `/platform/tenants/:id/deliveries` | `{systemName, domain?, supportContact, notes?}` → 201 con `manifest`. `domain` obligatorio en DEDICATED/CUSTOM (400 `DOMAIN_REQUIRED`) y prohibido en SaaS (400 `DOMAIN_NOT_ALLOWED`) |
| GET | `/platform/deliveries/:id` | Entrega con su `manifest` (sin secretos) |
| POST | `/platform/deliveries/:id/refresh` | Vuelve a tomar la foto; solo en `DRAFT` (409 `DELIVERY_FROZEN` si ya hay paquete) |
| GET | `/platform/deliveries/:id/package` | ZIP (`application/zip`, cabecera `X-Package-Sha256`). La primera vez pasa a `GENERATED` y guarda la huella; después se comprueba contra ella (409 `NOT_REPRODUCIBLE` / `VERSION_CHANGED`) |
| POST | `/platform/deliveries/:id/delivered` | Marca entregada (409 `NOT_GENERATED` si aún no hay paquete) |

### Sistema y actualizaciones (ADR 045)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/platform/system` | `{version, migrations: {applied, last, failed[]}, updates[] (últimas 20), installationsBehind[]}`. Solo `platform:manage` |

CLI dentro del contenedor de la API: `node dist/cli.js version` y `node dist/cli.js registrar-actualizacion --desde X.Y.Z --hasta X.Y.Z --estado SUCCEEDED|FAILED|ROLLED_BACK --inicio <ISO> [--respaldo <ruta>] [--detalle <texto>]` (lo usan `deploy.sh` y `actualizar.sh`).

## Módulos por empresa (ADR 038)

`GET /auth/me` devuelve `tenant.enabledModules` (subconjunto de `conversations, ai, catalog, inventory, orders, customers, reports, automations, reservations`) y `tenant.settings` (reglas de operación). Las rutas de un módulo apagado responden **403** `{ code: "MODULE_DISABLED" }`.

## Asistente IA (`/ai`), permiso `ai:configure`, módulo `ai`

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/ai/settings` | `{isEnabled, published, draft, hasUnpublishedChanges, draftUpdatedAt, draftTestedAt, publishedAt, testRequired, monthlyTokenCap, usage{period,tokens,replies,planTokenLimit,effectiveCap}, knowledge{maxDocs,budgetChars}, provider{configured,model}}` (nunca la clave) |
| PUT | `/ai/settings/draft` | Guarda el borrador completo (esquema en `apps/api/src/ai/ai-profile.ts`; 400 con `errors` si no es válido). Anula la prueba anterior |
| DELETE | `/ai/settings/draft` | Descarta el borrador y los cambios de documentos sin publicar (204) |
| POST | `/ai/settings/publish` | Publica borrador y documentos. 409 `TEST_REQUIRED` si hay proveedor de IA y no se probó; 409 `NOTHING_TO_PUBLISH`. Auditado con los campos cambiados |
| PATCH | `/ai/settings` | Inmediato: `{isEnabled?, monthlyTokenCap? (≥1000 o null)}`; 403 `PLAN_LIMIT` si supera `maxAiTokensPerMonth` del plan |
| POST | `/ai/test` | `{target: draft\|published, messages[]}` → `{reply, tools, handoff, tokens}`. No envía nada ni crea pedidos. 503 `AI_NOT_CONFIGURED`/`AI_PROVIDER_ERROR`, 409 `AI_CAP_REACHED` |
| GET | `/ai/knowledge` | Documentos con `state`: `new`, `modified`, `published`, `pending_delete` |
| POST | `/ai/knowledge` | `{title, content}` (texto, hasta 20 000 caracteres); 403 `PLAN_LIMIT_REACHED` según `maxKnowledgeDocs` |
| PUT / DELETE | `/ai/knowledge/:id` | Editar (queda sin publicar) / quitar (uno publicado se quita al publicar) |

## Reglas de operación (`/tenant/settings`), ADR 043

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/tenant/settings` | `tenant:read` → `{settings, template: {key, name, version, latestVersion} \| null}` |
| PATCH | `/tenant/settings` | `tenant:settings`. Cambios parciales por sección; se valida el resultado completo (400 `INVALID_SETTINGS` con `errors[{path, message}]`). Auditado `tenant.settings_updated` |

Secciones: `catalog {label, trackStockDefault, volumePricing, durations}`, `orders {minAmount|null}`, `customers {businessFields}`, `reservations {kind TABLE|APPOINTMENT, slotMinutes, durationMinutes, capacity|null, maxPartySize, minNoticeMinutes, maxDaysAhead, hours|null, requireConfirmation}`. Capacidad, horario y pedido mínimo **nunca** los rellena una plantilla: mientras `capacity` u `hours` sean null no se aceptan reservas.

Efecto en el resto de la API:

- **Productos**: `trackStock` (por defecto `catalog.trackStockDefault`; si es `false` no admite stock inicial ni movimientos → 409 `NOT_STOCKED`, y los pedidos no mueven inventario), `durationMinutes` (5-1440) y en cada variante `priceTiers[{minQty ≥ 2, unitPrice}]` (máx. 6, cantidades crecientes y precios decrecientes, menores que el precio base). `GET /products?trackStock=true|false` filtra.
- **Pedidos**: con `volumePricing` el backend aplica el tramo alcanzado por la cantidad; con `minAmount` responde 409 `ORDER_MINIMUM` `{minimum, subtotal}` si el subtotal no llega.
- **Clientes**: `customerType` (`PERSON`\|`BUSINESS`) y `businessName` (obligatorio si es `BUSINESS`); `GET /customers?type=` filtra y la búsqueda incluye la razón social. La ficha añade `stats.lastPurchaseAt`, `topProducts[{name, quantity, total}]` (lo vendido, sin pendientes ni anulados) y `reservations`.

## Reservas y citas (`/reservations`), módulo `reservations`

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/reservations?date=AAAA-MM-DD&status=&customerId=&page=` | `reservations:read`. Sin `date`, las próximas (desde hace 2 h). El día es el de la zona horaria de la empresa |
| GET | `/reservations/availability?date=&partySize=&productId=` | Horarios libres `{date, kind, durationMinutes, slots[{time, startsAt, remaining}], reason}`. Para el panel no se aplica la antelación mínima; el asistente sí la aplica |
| POST | `/reservations` | `reservations:write`. `{customerId \| customer {phone, name?}, date, time HH:MM, partySize, productId? (servicio: producto sin stock), notes?, idempotencyKey?}`. Desde el panel nace `CONFIRMED`. Errores 409: `RESERVATIONS_NOT_CONFIGURED`, `PARTY_TOO_LARGE`, `OUTSIDE_HOURS`, `IN_THE_PAST`, `SLOT_FULL`, `SERVICE_UNAVAILABLE` (y `OUTSIDE_WINDOW` solo para el asistente: el equipo puede saltarse la antelación mínima) |
| PATCH | `/reservations/:id/status` | `{status, note?}`: `PENDING → CONFIRMED \| CANCELLED`; `CONFIRMED → COMPLETED \| NO_SHOW \| CANCELLED` (409 `INVALID_TRANSITION`) |

El aforo (`TABLE`: personas; `APPOINTMENT`: citas simultáneas) se controla con un bloqueo por empresa: varias reservas a la vez nunca superan la capacidad. Las reservas no se borran (el rol de ejecución no tiene `DELETE`). El asistente tiene las herramientas `consultar_disponibilidad`, `crear_reserva` (queda `PENDING` si `requireConfirmation`; avisa al equipo) y `ver_reservas_del_cliente`. La automatización `RESERVATION_REMINDER` (backend) envía por WhatsApp un recordatorio `hoursBefore` horas antes de cada reserva confirmada, una sola vez.

## Integraciones (`/integrations`), permiso `integrations:manage`

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/integrations` | Lista de 7 servicios (`whatsapp, ai, email, automations, chatwoot, webhooks, payments`) con `{status, detail, lastCheck, testable, howTo}`; `ai.ownKey` con `hint` (nunca la clave) |
| POST | `/integrations/:service/test` | `whatsapp`, `ai`, `email` (correo al usuario actual), `webhooks` (ping a cada URL) → `{ok, ms, detail}`; queda en el historial |
| GET | `/integrations/checks?service=&ok=` | Últimas 50 comprobaciones de la empresa |
| PUT | `/integrations/ai/key` | `{apiKey}`: se valida con Google; 400 `INVALID_KEY` si la rechaza. Guarda cifrado → `{status, hint, detail}` |
| DELETE | `/integrations/ai/key` | Quita la clave propia (vuelve a la de la plataforma) |
| GET / POST | `/integrations/webhooks` | Lista `{events, items}` / crea `{url, description?, events[]}` → incluye `secret` **solo en esta respuesta**. 400 `INVALID_URL`, 403 `LIMIT_REACHED` (5) |
| PATCH / DELETE | `/integrations/webhooks/:id` | `{url?, description?, events?, isActive?}` / borrar |
| POST | `/integrations/webhooks/:id/rotate-secret` | Nuevo secreto (el anterior deja de valer) → `{id, secret}` |
| POST | `/integrations/webhooks/:id/test` | Envía un `ping` firmado al momento → `{ok, status, error}` |
| GET | `/integrations/webhooks/:id/deliveries?page=` | Historial de entregas |
| POST | `/integrations/webhooks/deliveries/:id/retry` | Reencola una entrega `FAILED` (no los ping) |

Panel general (permiso `platform:manage`): `GET /platform/integrations` (servicios del servidor con `configured`, variables de entorno y última prueba; números de WhatsApp por estado y con error; fallos de 7 días) y `POST /platform/integrations/:service/test` (`database, redis, gemini, smtp, n8n, chatwoot`; auditado).

### Recibir webhooks

Eventos: `order.created`, `order.status_changed`, `stock.low`, `conversation.handoff`, `reservation.created`, `reservation.status_changed`.

Cada entrega es un `POST` JSON `{id, event, occurredAt, tenantId, data}` con las cabeceras `X-AISA-Event`, `X-AISA-Delivery` (= `id`, úsalo para descartar duplicados) y `X-AISA-Signature: t=<unix>,v1=<hex>`. Para verificarla:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(secret, rawBody, header) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // más de 5 min: reenvío
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return v1?.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

Usa el cuerpo **sin parsear**. Responde 2xx en menos de 10 s; cualquier otra respuesta se reintenta hasta 6 veces (30 s, 1 min, 2 min, 4 min, 8 min) y después queda `FAILED` con un aviso en el panel.

## Automatizaciones (`/automations`), permiso `automations:manage`, módulo `automations`

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/automations` | `{n8nConfigured, items[]}`: cada automatización del catálogo con `enabled`, `config` efectiva, `fields` (formulario), `executor` (`n8n`\|`backend`), `audience`, `moduleEnabled`, `featureAvailable`, `version`, `latestVersion`, `updateAvailable`, `pendingChanges`, `stats30d` |
| PATCH | `/automations/:key` | `{enabled?, config?}`. La configuración se combina con la guardada y se valida con el catálogo (409 `INVALID_CONFIG` con `errors`). Activar sin el módulo → 409 `MODULE_DISABLED`; sin la función del plan → 403 `PLAN_FEATURE`. Auditado |
| POST | `/automations/:key/upgrade` | Aplica la versión nueva del catálogo conservando la configuración |
| GET | `/automations/events?key=&status=&page=&pageSize=` | Historial paginado (`PENDING`, `SENT`, `FAILED`, `SKIPPED`) con intentos y último error o motivo |
| POST | `/automations/events/:id/retry` | Fallido u omitido → en cola con los intentos a cero (409 si ya se reintentó, si la automatización está desactivada o si n8n no está configurado) |

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
