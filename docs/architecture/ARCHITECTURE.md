# Arquitectura técnica: AI Sales Assistant

> Estado: **propuesta definitiva v1** (FASE 1). Las decisiones marcadas como
> *pendiente* se cierran con el propietario del producto; ver `DECISIONS.md`.

## 1. Visión general

AI Sales Assistant es un SaaS multiempresa. Nuestro código (web, api, worker) es
la **única fuente de verdad comercial** (productos, precios, stock, pedidos,
clientes, estado de atención). Los cuatro proyectos de terceros se integran como
**servicios independientes**, por API/webhooks y con imágenes Docker oficiales,
sin modificar su código:

| Componente | Rol | Versión fijada | Licencia |
|---|---|---|---|
| WhatsApp Cloud API (Meta) | Canal oficial de mensajería | Graph API (versión a fijar en FASE 4) | Términos de Meta |
| Evolution API | Canal alternativo / desarrollo (opcional) | `evoapicloud/evolution-api:v2.3.7` | Apache 2.0 + condiciones |
| n8n | Automatizaciones internas | `n8nio/n8n:3.2.0` | Sustainable Use License |
| Chatwoot | Bandeja humana y supervisión | `chatwoot/chatwoot:v4.19.1` | MIT (salvo `enterprise/`) |
| Dify | Motor de IA (interpretación y redacción) | `1.19.0` (compose oficial) | Apache 2.0 modificada |

Versiones verificadas el 2026-11-10 contra las etiquetas de cada repositorio y los
manifiestos de Docker Hub. Detalle de licencias en `/LICENSES.md`.

## 2. Diagrama de componentes

```mermaid
flowchart LR
  subgraph Cliente final
    WA[WhatsApp del cliente]
  end
  subgraph Meta
    CAPI[WhatsApp Cloud API]
  end
  subgraph "AI Sales Assistant (nuestro código)"
    WEB[apps/web<br/>Next.js]
    API[apps/api<br/>NestJS REST + WS]
    WK[apps/worker<br/>BullMQ]
    PG[(PostgreSQL 17<br/>RLS por tenant)]
    RD[(Redis<br/>colas + caché)]
    FS[(Almacenamiento<br/>archivos / S3)]
  end
  subgraph "Servicios integrados"
    CW[Chatwoot]
    DF[Dify]
    N8N[n8n]
    EVO[Evolution API<br/>opcional]
  end

  WA <--> CAPI
  CAPI -- webhook firmado --> API
  API -- encola --> RD
  RD --> WK
  WK -- envía mensajes --> CAPI
  EVO -. alternativa .- WK
  WK <-- interpreta / redacta --> DF
  WK -- espejo de conversación --> CW
  CW -- webhook (respuesta de agente, asignación) --> API
  API -- eventos de negocio --> N8N
  N8N -- API interna con token --> API
  WEB <--> API
  API --> PG
  WK --> PG
  API --> FS
```

**Regla de oro:** solo `apps/worker` envía mensajes a WhatsApp. Chatwoot nunca
habla directamente con Meta; así se evita que bot y agente respondan dos veces.

## 3. Aplicaciones propias

### apps/api (NestJS + TypeScript)
- Módulos: `auth`, `tenants`, `users`, `plans/usage`, `catalog` (productos,
  categorías, variantes, imágenes, historial), `inventory` (movimientos),
  `customers`, `orders`, `conversations`, `ai-tools`, `integrations`
  (whatsapp, chatwoot, dify, n8n), `reports`, `audit`, `health`.
- REST versionado (`/api/v1`), validación con DTO (class-validator), OpenAPI.
- WebSockets (Socket.IO, salas por tenant) para bandeja y dashboard en vivo.
- Autenticación: contraseñas con **Argon2id**; access token JWT corto (15 min) +
  refresh token rotatorio almacenado *hasheado* en BD, en cookie `HttpOnly`,
  `Secure`, `SameSite=Lax`; protección CSRF con *double submit token* en
  mutaciones basadas en cookie.
- Autorización: RBAC (`PLATFORM_ADMIN`, `TENANT_ADMIN`, `SUPERVISOR`, `SELLER`)
  con guards por permiso, **tenant_id tomado siempre del token**, nunca del
  cuerpo de la petición.

### apps/worker (Node + BullMQ)
Procesa colas con reintentos exponenciales y *dead letter queue*:
`inbound-message`, `outbound-message`, `chatwoot-sync`, `notifications`,
`stock-alerts`, `reports`. Es quien orquesta la conversación con la IA.

### apps/web (Next.js App Router + React + Tailwind)
Panel con sidebar, dashboard, tablas, gráficos, modo claro/oscuro, lector de
códigos de barras por cámara (API `BarcodeDetector` con *fallback* a librería
ZXing), responsive.

## 4. Multiempresa y aislamiento

Tres capas, ninguna depende del frontend:

1. **Aplicación:** cada consulta del repositorio filtra por `tenantId` del
   contexto de la petición (AsyncLocalStorage). Tests de aislamiento obligatorios.
2. **Base de datos (RLS):** todas las tablas de negocio llevan `tenant_id` y
   políticas `USING (tenant_id = current_setting('app.tenant_id')::uuid)`
   con `FORCE ROW LEVEL SECURITY`. La app se conecta con un rol **sin**
   `BYPASSRLS`; cada transacción ejecuta `SELECT set_config('app.tenant_id', $1, true)`.
   Las migraciones usan un rol propietario distinto.
3. **Servicios externos:** una *Account* de Chatwoot por empresa (Platform API);
   en Dify se pasan `tenant_id` y el contexto en `inputs` controlados por el
   backend, y `user = tenant:<id>:customer:<id>`, de modo que las sesiones
   nunca se mezclan.

## 5. Asistente IA y herramientas seguras

La IA **no** accede a la base de datos. El flujo es:

1. El worker recibe el mensaje (texto no confiable) y construye el contexto:
   empresa, cliente, carrito en curso, últimos productos consultados.
2. Dify interpreta la intención y propone una acción estructurada.
3. El backend ejecuta la herramienta autorizada con el `tenant_id` de la sesión
   (no el que diga el modelo): `buscar_productos`, `consultar_stock`,
   `consultar_precio`, `consultar_pedido`, `crear_pedido`,
   `solicitar_atencion_humana`. Cada una valida argumentos (zod), permisos,
   límites del plan y reglas de negocio.
4. Dify redacta la respuesta en español usando **solo** los datos devueltos.
5. Validación de salida: si la respuesta menciona precios/stock que no vienen de
   la herramienta, se descarta y se responde con plantilla segura.

`crear_pedido` exige un resumen mostrado al cliente y su confirmación explícita
("sí, confirmo"), con **clave de idempotencia** = hash(conversación + carrito
confirmado). El descuento de stock ocurre en una transacción con
`SELECT ... FOR UPDATE` y una restricción única `(order_id, type)` en los
movimientos para impedir dobles descuentos.

## 6. Diagramas de secuencia

### 6.1 Mensaje entrante con respuesta automática

```mermaid
sequenceDiagram
  autonumber
  participant C as Cliente (WhatsApp)
  participant M as Meta Cloud API
  participant A as api
  participant Q as Redis/BullMQ
  participant W as worker
  participant D as Dify
  participant CW as Chatwoot
  C->>M: "¿Tienen Nike talla 42?"
  M->>A: POST /webhooks/whatsapp (X-Hub-Signature-256)
  A->>A: Verifica firma HMAC, guarda evento (wamid ÚNICO)
  A-->>M: 200 OK (rápido)
  A->>Q: encola inbound-message
  Q->>W: procesa
  W->>W: resuelve tenant por phone_number_id, cliente y conversación
  W->>CW: espejo del mensaje entrante
  alt bot ACTIVO
    W->>D: interpretar (inputs controlados por backend)
    D-->>W: intención + parámetros
    W->>W: buscar_productos / consultar_stock (tenant de la sesión)
    W->>D: redactar con resultados reales
    D-->>W: texto final
    W->>M: enviar mensaje (outbox idempotente)
    W->>CW: espejo de la respuesta (marcada como bot)
  else bot PAUSADO (humano a cargo)
    W->>W: no responde
  end
```

### 6.2 Registro de pedido

```mermaid
sequenceDiagram
  autonumber
  participant C as Cliente
  participant W as worker
  participant D as Dify
  participant A as api (OrdersService)
  participant P as PostgreSQL
  participant N as n8n
  C->>W: "Quiero 2 pares talla 42"
  W->>D: interpretar
  W->>A: consultar_stock + consultar_precio
  W->>C: Resumen: 2 x Nike Air (T42) S/ 399.00 c/u = S/ 798.00 ¿Confirmas?
  C->>W: "Sí, confirmo"
  W->>A: crear_pedido(idempotency_key)
  A->>P: BEGIN; lock variantes; valida stock; inserta pedido + movimientos SALIDA_VENTA; COMMIT
  A-->>W: pedido #1024 creado (o el existente si la clave se repite)
  W->>C: Pedido #1024 registrado
  A->>N: evento order.created
  N->>N: notifica al vendedor / administrador
```

### 6.3 Transferencia a humano y reanudación

```mermaid
sequenceDiagram
  autonumber
  participant C as Cliente
  participant W as worker
  participant A as api
  participant CW as Chatwoot
  participant V as Vendedor
  C->>W: "Quiero hablar con una persona" / reclamo
  W->>A: solicitar_atencion_humana(motivo)
  A->>A: conversación.bot_status = PAUSADO (handoff)
  A->>CW: estado open, etiqueta "transferido", nota interna con resumen
  W->>C: "Te paso con un asesor"
  CW->>V: notificación / asignación
  V->>CW: responde
  CW->>A: webhook message_created (outgoing, agente)
  A->>W: encola outbound-message
  W->>C: mensaje del vendedor
  V->>CW: resuelve conversación
  CW->>A: webhook conversation_status_changed (resolved)
  A->>A: bot_status = ACTIVO
```

## 7. Fiabilidad e idempotencia

- Todo webhook entrante se registra en `inbound_events` con clave única del
  proveedor (`wamid`, id de Chatwoot). Duplicados → 200 sin reprocesar.
- Envíos salientes por *outbox* (`outbound_messages` con estado), reintentos con
  *backoff* y DLQ; errores de WhatsApp clasificados en reintentables / no.
- Operaciones comerciales (pedido, movimiento de stock) con claves de
  idempotencia y restricciones únicas en BD.
- Health checks: `/health/live`, `/health/ready` (PG, Redis, colas) y estado de
  integraciones externas en el panel.

## 8. Entornos

| | Desarrollo (Mac) | Producción |
|---|---|---|
| Compose | `docker-compose.yml` + Dify aparte | fichero de producción (FASE 8) |
| Puertos | solo `127.0.0.1` | solo reverse proxy 443 |
| TLS | no | obligatorio (Caddy/Nginx + Let's Encrypt) |
| BD | un servidor, una BD y un rol por servicio | instancias separadas o gestionadas, backups automáticos |
| Secretos | `.env` generado (600) | gestor de secretos / variables del orquestador |

**Requieren URL pública con HTTPS:** webhook de WhatsApp Cloud API (Meta no
acepta HTTP ni localhost) y la web/API para usuarios. **No se exponen:** n8n,
Dify consola, Evolution manager, Postgres, Redis. Chatwoot se publica solo para
agentes (subdominio propio, idealmente tras VPN o SSO). En desarrollo, el webhook
de Meta se prueba con un túnel HTTPS (p. ej. Cloudflare Tunnel).

## 9. Requisitos de hardware (desarrollo)

Stack completo (Chatwoot + n8n + Dify + apps) necesita **≥ 16 GB de RAM** y
asignar a Docker Desktop al menos 8–10 GB y ~40 GB de disco. Con 8 GB se trabaja
por perfiles (p. ej. sin Chatwoot o sin Dify).
