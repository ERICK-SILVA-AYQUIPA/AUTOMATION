# Registro de decisiones técnicas (ADR)

Estado: `aceptada` | `pendiente` (requiere confirmación del propietario) | `reemplazada`.

| # | Decisión | Estado | Motivo |
|---|---|---|---|
| 001 | Monorepo pnpm workspaces (`apps/*`, `packages/*`) | aceptada | Tipos compartidos entre api/worker/web, un solo CI. |
| 002 | Backend **NestJS** + TypeScript | aceptada (sugerida en el encargo) | Módulos, DI, guards para RBAC, WebSockets y OpenAPI nativos. |
| 003 | PostgreSQL **17** + pgvector | aceptada | n8n 3.x avisa que PG16 es "compatibility support only" y exige ≥17 (comprobado en arranque); Chatwoot exige `vector`. |
| 004 | Prisma ORM + **RLS** en PostgreSQL | aceptada | Defensa en profundidad del aislamiento; rol de app sin BYPASSRLS. |
| 005 | Redis + **BullMQ** para colas | aceptada | Reintentos, backoff, DLQ, idempotencia de jobs. |
| 006 | Dify con el **compose oficial** en proyecto separado | aceptada | 15+ contenedores; reescribirlo crearía deriva en cada actualización. |
| 007 | Dify con **pgvector** en lugar de Weaviate | aceptada | Menos RAM en el Mac; imagen de Docker Hub. Mecanismo oficial (`VECTOR_STORE`, `COMPOSE_PROFILES`). |
| 008 | Evolution con `CORS_ORIGIN="*"` | aceptada | Con lista de orígenes rechaza llamadas sin cabecera Origin (HTTP 500, comprobado). Solo uso servidor-servidor; protección real = API key + red privada. |
| 009 | Proveedor WhatsApp: **Cloud API oficial** + Evolution como adaptador opcional | **pendiente** | Cloud API es oficial y apta para uso comercial; Evolution/Baileys conlleva riesgo de bloqueo. |
| 010 | Orquestación del camino crítico (mensaje → IA → respuesta → pedido) en **worker propio**; n8n para flujos secundarios (notificaciones, stock bajo, alertas, reportes) | **pendiente** | Transacciones, idempotencia y tests automatizados; n8n sigue documentando y ejecutando los 7 flujos donde aporta. |
| 011 | IA: **Dify interpreta y redacta; el backend ejecuta las herramientas** con el tenant de la sesión | **pendiente** | El modelo nunca decide el tenant ni toca la BD; cumple "Dify no es fuente de datos". |
| 012 | Chatwoot: una Account por empresa vía Platform API, inbox de tipo **API**, solo nuestro worker envía a WhatsApp | aceptada (condicionada a 009) | Evita respuestas duplicadas bot/agente y mantiene el control del estado de atención. |
| 013 | Autenticación propia (Argon2id, JWT corto + refresh rotatorio en cookie HttpOnly) | aceptada | Sin dependencia de terceros de pago; control de sesiones y revocación. |
| 014 | Pagos: estructura de planes/límites sin cobros reales | aceptada | Requisito explícito; proveedor (Stripe/Mercado Pago/etc.) se elige después. |
