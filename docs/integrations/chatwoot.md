# Chatwoot: bandeja de agentes por empresa (FASE 5)

Versión probada: **Chatwoot v4.19.1** (imagen oficial `chatwoot/chatwoot`, `CHATWOOT_VERSION`).
Todo lo de este documento se comprobó contra el código fuente de esa versión y contra
el Chatwoot real del `docker-compose.yml` (prueba `apps/web/e2e/chatwoot.mjs`).

## Qué hace

| Paso | Dónde ocurre |
|---|---|
| La empresa pulsa **Integraciones → Bandeja de agentes → Activar** | La API crea con la *Platform API* una cuenta de Chatwoot para la empresa, un usuario técnico (administrador, correo `aisa-bot-<empresa>@aisa.invalid`), su token y un buzón de tipo **API** cuyo webhook apunta a `/api/v1/webhooks/chatwoot/<clave>` |
| Llega un WhatsApp del cliente | El worker lo guarda y, en la cola `chatwoot-sync` (concurrencia 1, conserva el orden), crea en Chatwoot el contacto, la conversación y el mensaje entrante |
| Alguien responde desde el panel | Se envía por WhatsApp y se copia a Chatwoot como mensaje saliente (sin volver a enviarse) |
| Un agente responde **en Chatwoot** | Chatwoot avisa por webhook firmado; la API encola el envío por WhatsApp (clave `chatwoot:<id>`, nunca duplica) y **pausa el asistente** en esa conversación |
| Meta informa enviado / entregado / leído / fallido | El estado se copia al mensaje de Chatwoot (doble check o error visible al agente) |
| Fuera de la ventana de 24 h | El mensaje del agente se marca como fallido en Chatwoot con el motivo |
| El agente **resuelve** la conversación | Se resuelve en el panel y el asistente vuelve a estar activo |
| Un agente se asigna, la pospone o la reabre con asignado | El asistente se pausa |
| **Abrir en Chatwoot** (panel) | Enlace de acceso único de la Platform API; la primera vez crea el usuario de Chatwoot con el rol según el del panel (administrador o supervisor → administrador; vendedor → agente) y lo añade al buzón |
| Se desactiva a un usuario o cambia su rol en el panel | Se le quita de la cuenta de Chatwoot (Chatwoot lo saca de los buzones y desasigna sus conversaciones). Si vuelve, su siguiente acceso único lo añade con el rol nuevo |

Solo nuestro worker envía a WhatsApp (ADR 012): Chatwoot no tiene credenciales de Meta.

## Puesta en marcha (una vez por instalación)

```bash
docker compose --profile chatwoot up -d            # o COMPOSE_PROFILES con "chatwoot"
./infrastructure/scripts/chatwoot-init.sh          # rails db:chatwoot_prepare (solo la primera vez)
bash services/chatwoot/setup-platform.sh           # super admin + cierre del asistente + Platform App
# reinicia la API y el worker para que lean CHATWOOT_PLATFORM_TOKEN
```

`setup-platform.sh` es idempotente y hace tres cosas:

1. **Cierra el asistente de instalación.** Un Chatwoot recién instalado deja que
   *cualquiera* que abra `/installation/onboarding` se cree super administrador
   (comprobado en `Installation::OnboardingController`). El script crea el super
   administrador de la plataforma (`PLATFORM_ADMIN_EMAIL`, contraseña aleatoria en
   `CHATWOOT_SUPER_ADMIN_PASSWORD` de `.env`) y borra la marca de Redis
   `CHATWOOT_INSTALLATION_ONBOARDING`.
2. Crea (o reutiliza) la Platform App "AI Sales Assistant".
3. Guarda su token en `.env` como `CHATWOOT_PLATFORM_TOKEN`.

## Variables

| Variable | Uso |
|---|---|
| `CHATWOOT_BASE_URL` | URL de Chatwoot vista desde la API y el worker |
| `CHATWOOT_PLATFORM_TOKEN` | Token de la Platform App (vacío = la tarjeta muestra "No configurado en el servidor") |
| `CHATWOOT_WEBHOOK_BASE_URL` | URL de **nuestra API** vista desde Chatwoot (sus webhooks). En desarrollo `http://host.docker.internal:4000` |
| `CHATWOOT_ALLOW_PRIVATE_NETWORK` | Se pasa a Chatwoot como `SAFE_FETCH_ALLOW_PRIVATE_NETWORK`. Chatwoot bloquea por defecto los webhooks a IPs privadas; `true` solo en desarrollo. En producción `false` y `CHATWOOT_WEBHOOK_BASE_URL` = URL HTTPS pública de la API |
| `CHATWOOT_FRONTEND_URL` | URL pública de Chatwoot; es la que aparece en los enlaces de acceso único |
| `CHATWOOT_SUPER_ADMIN_PASSWORD` | La genera `setup-platform.sh` |

## Seguridad

- Webhooks: `X-Chatwoot-Signature: sha256=HMAC_SHA256(secreto_del_buzón, "<X-Chatwoot-Timestamp>.<cuerpo>")`.
  Se valida con comparación en tiempo constante, se rechaza un sello con más de 5 min
  de diferencia y la URL lleva una clave aleatoria por empresa. El secreto del buzón y
  el token del usuario técnico se guardan cifrados (AES-256-GCM).
- Chatwoot **no reintenta** los webhooks de buzones API: si la API está caída en ese
  momento, la respuesta del agente no sale y el agente no la verá marcada como enviada
  (queda sin doble check). Ver RISKS.md.
- Los mensajes del cliente se copian como texto; Chatwoot los muestra escapados.
- `ENABLE_ACCOUNT_SIGNUP=false`: las cuentas solo las crea nuestra plataforma.
- **Producción (FASE 8):** la interfaz de Chatwoot tiene que estar publicada por HTTPS
  para que los agentes entren, pero `/super_admin` y `/installation` no deben ser
  accesibles desde internet (bloquearlos en el reverse proxy; el administrador entra por
  túnel SSH). Hoy el puerto 3100 solo escucha en 127.0.0.1.

## Detalles comprobados de la API de Chatwoot v4.19.1

- Platform API (`Authorization: Bearer <token de la Platform App>`):
  `POST /platform/api/v1/accounts`, `POST /platform/api/v1/users` (si el correo existe
  devuelve ese usuario; los usuarios creados así no necesitan confirmar el correo),
  `POST|DELETE /platform/api/v1/accounts/{id}/account_users {user_id, role}`,
  `POST /platform/api/v1/users/{id}/token`, `GET /platform/api/v1/users/{id}/login` → `{url}`.
- Un agente que no es miembro del buzón recibe 401 al usarlo: hay que añadirlo con
  `POST /api/v1/accounts/{a}/inbox_members {inbox_id, user_ids}` (solo añade los que faltan).
- `GET /api/v1/accounts/{a}/inboxes/{id}` devuelve `secret` solo a administradores;
  por eso el usuario técnico es administrador.
- Las notas privadas también disparan `message_created` (con `private: true`): se ignoran.
- En la interfaz, el editor envía con **Ctrl + Enter** (Enter hace salto de línea) y una
  conversación nueva aparece en la pestaña **Sin asignar**, no en **Mías**.

## Pruebas

- `apps/api/test/chatwoot.e2e-spec.ts`: 12 pruebas con un Chatwoot simulado (errores,
  reintentos, firmas, aislamiento entre empresas, retirada de acceso).
- `apps/web/e2e/chatwoot.mjs`: navegador real contra el Chatwoot real (10 pasos). Solo
  Meta se sustituye por un servidor local.

```bash
cd apps/web
WEB_URL=http://localhost:3000 MAILPIT_URL=http://localhost:8025 CHATWOOT_URL=http://localhost:3100 node e2e/chatwoot.mjs
```

## Límites conocidos

- Solo se copia el texto de cada mensaje (`messages.content`); los adjuntos reales
  (imágenes, audios, documentos) no se suben a Chatwoot todavía (FASE 7).
- Si una persona pertenece a dos empresas con el mismo correo, en Chatwoot es un solo
  usuario con dos cuentas; el acceso único no elige la cuenta (no probado).
- La "atención humana" se registra ya (pausa real), pero el asistente IA que se pausa
  llega en la FASE 6.
