# WhatsApp Cloud API: hechos verificados para la integración

Consultado en la documentación oficial de Meta el 2026-11-10. Solo se implementa
lo que está aquí; lo marcado **sin confirmar** no se usa hasta verificarlo.

## Versión de Graph API
- Última: **v26.0** (29-jul-2026). Más antigua aún soportada: v21.0 (hasta 21-ene-2027).
  Fuente: https://developers.facebook.com/docs/graph-api/changelog/
- Se configura con `WHATSAPP_GRAPH_API_VERSION` (sin valor por defecto inventado: `.env.example` trae `v26.0`).

## Webhook
- Verificación (GET): `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`; si el token coincide
  se responde con el valor de `hub.challenge`.
  Fuente: https://developers.facebook.com/docs/graph-api/webhooks/getting-started/
- Firma (POST): cabecera `X-Hub-Signature-256: sha256=<firma>` calculada con SHA-256 sobre el cuerpo
  y el **App Secret** (HMAC-SHA256). Mismo documento.
- Responder 200 siempre que se haya aceptado; Meta reintenta hasta **7 días** con backoff y puede
  enviar **duplicados** → idempotencia por `messages[].id` / `statuses[].id`.
  Fuente: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview/
- Cuerpo hasta 3 MB.

### Mensaje entrante (texto)
`object = "whatsapp_business_account"`, `entry[].changes[]` con `field = "messages"` y `value`:
- `metadata.phone_number_id`, `metadata.display_phone_number`
- `contacts[]`: `profile.name`, `wa_id` (teléfono, **puede faltar**), `user_id` (BSUID)
- `messages[]`: `from` (teléfono, **puede faltar**), `from_user_id` (BSUID), `id` (wamid), `timestamp`
  (segundos Unix, string), `type`, `text.body`; opcionales `context`, `referral`.
- `messages[].errors` con `type = "unsupported"` para tipos no soportados.
Fuente: .../whatsapp/webhooks/reference/messages/text

### Estados
`value.statuses[]`: `id` (wamid enviado), `status` ∈ {`sent`, `delivered`, `read`, `played`, `failed`},
`timestamp`, `recipient_id` (teléfono), `recipient_user_id` (BSUID), `errors[]` (`code`, `title`,
`message`, `error_data.details`). Fuente: .../whatsapp/webhooks/reference/messages/status

## Identificador BSUID (business-scoped user ID)
- Aparece en webhooks desde abril de 2026; formato `CC.<hasta 128 alfanuméricos>` (p. ej. `US.1349…`).
- Es **adicional**: el teléfono (`from`, `wa_id`) puede **omitirse** si el usuario usa nombre de usuario,
  salvo interacción en los últimos 30 días o si está en la libreta de contactos.
- Envío a un BSUID: campo `recipient` en lugar de `to` (no para plantillas de autenticación).
- Cambia si el usuario cambia de número.
- Hay una actualización del 5-nov-2026 en su changelog: **revisar antes de producción**.
Fuente: .../whatsapp/business-scoped-user-ids/

Consecuencia en nuestro modelo: el cliente se identifica por teléfono **o** por BSUID (ADR 024).

## Envío
`POST https://graph.facebook.com/{versión}/{phone_number_id}/messages`, `Authorization: Bearer <token>`:
```json
{ "messaging_product": "whatsapp", "recipient_type": "individual", "to": "<teléfono>",
  "type": "text", "text": { "preview_url": false, "body": "<máx. 4096>" } }
```
Respuesta: `{ "messaging_product": "whatsapp", "contacts": [...], "messages": [{ "id": "wamid..." }] }`.
Fuente: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages

## Ventana de atención
Cada mensaje del usuario abre (o renueva) una ventana de **24 h**; fuera de ella solo se pueden enviar
**plantillas**. Fuente: .../whatsapp/messages/send-messages

## Límites
- 80 mensajes/s por número (por defecto), hasta 1.000 con mejora automática.
- Por par negocio-usuario: 1 mensaje cada 6 s (ráfaga hasta 45); excedido → 131056. Reintento a 4^X s.
Fuentes: .../whatsapp/throughput/ y .../whatsapp/about-the-platform

## Errores y política de reintento del worker
| Código | Significado | Acción |
|---|---|---|
| 130429 | Límite de mensajes/s alcanzado | reintentar con backoff |
| 131056 | Demasiados mensajes al mismo usuario | reintentar tras esperar (4^X s) |
| 131000 | Error desconocido | reintentar; si persiste, soporte |
| 131016 | Servicio no disponible temporalmente | reintentar |
| 4 / 80007 | Límite de llamadas de la app / de la cuenta | reintentar más tarde |
| 131047 | Fuera de la ventana de 24 h | no reintentar; requiere plantilla |
| 131049 | No entregado por salud del ecosistema | no reintentar antes de 24 h |
| 131026 | No se puede entregar (no es WhatsApp, etc.) | no reintentar |
| 131048 | Número restringido por calidad | no reintentar; revisar WhatsApp Manager |
| 130403 / 131050 | Usuario bloqueó / se dio de baja | no reintentar |
| 132000–132069 | Errores de plantilla/flujo | no reintentar sin corregir |
| 190 | Token caducado | no reintentar; renovar token y avisar |
Fuente: .../whatsapp/support/error-codes

## Sin confirmar (no implementado aún)
- Cuerpo exacto de "marcar como leído".
