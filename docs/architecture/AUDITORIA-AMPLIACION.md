# Auditoría para la ampliación estratégica (13 de noviembre de 2026)

Punto de partida: versión 0.9.0, commit `2ca9493`, CI en verde, 154 pruebas de
integración y 41 unitarias de la API, 91 pasos en navegador (ver
[`ACEPTACION.md`](ACEPTACION.md)).

La ampliación pide dos niveles de automatización que comparten piezas:

- **(A) Nuestro negocio.** Vender, cotizar, cobrar, crear el servidor e instalar.
- **(B) El negocio de cada cliente.** Su sistema de ventas por WhatsApp. Ya existe.

Esta auditoría dice, para cada sección, qué se reutiliza, qué falta y qué
depende de algo externo. **Nada de lo que falta se da por hecho.**

## 0. Diagnóstico: qué funciona de verdad, qué está simulado y qué falta

**Funciona de verdad.** Está probado con los servicios reales del proyecto en
local: PostgreSQL, Redis, n8n, Chatwoot y Docker.

- Multiempresa con RLS. Las pruebas negativas y la comprobación estructural pasan.
- Catálogo, variantes, inventario, pedidos con descuento y devolución de stock, clientes, reservas y reportes.
- Usuarios y roles, sesiones revocables, auditoría y límite de intentos.
- Alta de empresas con plantillas y módulos.
- Automatizaciones con n8n real.
- Bandeja de agentes con Chatwoot real.
- Paquete de entrega, instalación desde el paquete y actualización con recuperación. Probado en una máquina local con certificados propios de Caddy.
- Cobro manual: el administrador registra un pago de Yape o transferencia. No hay pasarela.

**Probado solo contra servidores locales que imitan la API real.** El código es el
de producción; la URL base solo se cambia en desarrollo y pruebas.

- **WhatsApp Cloud API (Meta).** Validación de credenciales, webhook firmado y envío.
- **Gemini.** Validación de la clave, respuestas del asistente con herramientas del catálogo.
- **Correo.** Va a Mailpit, que atrapa los correos en local. No se ha enviado por un SMTP real.

Ninguno de los tres se ha conectado nunca al servicio real. Faltan las credenciales.

**Datos provisionales.**

- Los precios de los planes del `seed` (29, 79… USD) son orientativos y se editan
  desde el panel. No son precios aprobados.
- Dify y Evolution API siguen en el repositorio sin usarse. Retirarlos necesita
  autorización.

**No existe todavía (lo pide la ampliación):**

- CRM de prospectos y embudo.
- Página comercial pública y agente comercial.
- Cotizaciones en PDF, contratos y órdenes de pago.
- Gestor de proveedores de infraestructura y orquestador de aprovisionamiento.
- Instalación remota automática.
- Centro de soporte, encuestas y renovaciones automáticas.
- Panel de rentabilidad.
- IA con otros proveedores: hoy solo existe Gemini, con una clave por empresa.

No hay botones decorativos en el panel actual. Una búsqueda de «simulado»,
«mock», «TODO» y «próximamente» en `apps/api/src` y `apps/web/src` no encontró
funciones a medio hacer.

## 1. Qué ya existe y se reutiliza

| Pieza | Dónde | Uso en la ampliación |
|---|---|---|
| Multiempresa con RLS, rol de ejecución y rol de sistema | `database/`, `db.tenant()` / `db.system` | Toda tabla nueva sigue la misma regla. La comprobación estructural de `tenant-isolation.e2e-spec.ts` vigila también las tablas futuras |
| Cifrado AES-256-GCM de secretos (`DATA_ENCRYPTION_KEY`) | `common/crypto` | Bóveda de credenciales de IA, infraestructura y pagos |
| Panel de integraciones de la empresa y de la plataforma, con historial de comprobaciones | `integrations/`, `integration_checks` | Base del **Centro de APIs**: se amplía, no se reemplaza |
| Abstracción del modelo de IA (`ChatModel`) y herramientas del asistente | `ai/chat-model.ts`, `ai/ai-tools.ts` | Se generaliza para varios proveedores. Hoy solo la implementa Gemini |
| Consumo de IA por empresa y tope mensual | `usage_counters`, `ai_settings.monthly_token_cap` | Se mantiene. Se añade el registro por llamada con proveedor, modelo y credencial |
| Planes editables, suscripciones, pagos manuales (Yape, transferencia) | `plans`, `payments`, `plataforma/plans-editor.tsx` | Base del catálogo comercial y de los pagos centralizados |
| Alta de empresas idempotente con plantilla y módulos | `platform/provisioning.service.ts` | Paso «configurar empresa» del asistente de nueva venta |
| Paquete de entrega, instalador, actualizador, salud, respaldo | `deliveries/`, `infrastructure/kit/` | Fase F: es lo que el orquestador ejecuta en el servidor nuevo |
| Colas BullMQ, worker, outbox con reintentos | `queues/`, `automation_events`, `webhook_deliveries` | El orquestador usa el mismo patrón: tareas idempotentes y reintentables |
| Auditoría de solo anexar, notificaciones, límite de intentos | `audit/`, `notifications/` | Registro de operaciones facturables y alertas |
| Webhooks firmados con HMAC e idempotencia por id | `webhooks/` | Mismo esquema para los webhooks de pago |

## 2. Qué falta, por sección

| Sección | Falta | Bloqueo externo |
|---|---|---|
| Centro universal de APIs | Credenciales de varios proveedores por empresa y de la plataforma, catálogo de modelos, asignación por servicio, registro de uso por llamada, adaptadores Claude, OpenAI y DeepSeek | Claves reales de Anthropic, OpenAI, DeepSeek y Google para la prueba real |
| A. Sales Center / CRM | Prospectos, estados, embudo, actividades, próxima acción y responsable | — |
| B. Página comercial y agente | Página pública, solicitud de demo, agente comercial con herramientas de solo lectura y registro de prospectos | Textos comerciales, testimonios reales (si no hay, no se muestran) y número de WhatsApp comercial |
| C. Cotizaciones, contrato, pagos | Catálogo comercial (planes, servicios extra, instalación), cotización numerada en PDF, aceptación con versión, orden de pago, validación manual, contabilización | **Precios en soles, impuestos, condiciones y texto del contrato** (los decide Rick) y pasarela de pago |
| D. Infrastructure Manager | Adaptadores de proveedores, credenciales, regiones, tamaños, precios, presupuestos y límites | **Token de Hetzner Cloud** (o de otro proveedor) y autorización de gasto |
| E. Orquestador | Estados, tareas idempotentes con compensación y reintentos, alertas | — |
| F. Instalación automática | Acceso al servidor nuevo (clave SSH efímera), ejecución del kit, dominio y HTTPS | Dominio y DNS reales |
| G. WhatsApp, IA, automatizaciones en la instancia nueva | Configuración remota tras la instalación | Credenciales de Meta por cliente |
| H. Pruebas y entrega | Escenario de 20 pasos | Todo lo anterior con servicios reales |
| I. Posventa | Centro de soporte (incidencias), encuestas, avisos de vencimiento | — |
| J. Seguridad y rentabilidad | Costos por empresa, margen, MRR, presupuestos y alertas | Costos reales de servidor, IA y WhatsApp (sin ellos el margen se muestra «incompleto») |

## 3. Riesgos y decisiones de diseño

- **`tenant_integrations` admite una sola fila por tipo y empresa.** No sirve para
  varias credenciales ni para credenciales de la plataforma asignables. Se crea una
  bóveda nueva (`provider_credentials`) y una asignación por servicio. Las claves
  propias de Gemini ya guardadas se trasladan sin descifrarlas: el formato del
  cifrado es el mismo.
- **Compartir credenciales entre empresas** se impide en la base de datos con un
  disparador, no solo en el código.
- **Cambio de proveedor.** No se cambia de proveedor en silencio. El respaldo
  automático solo usa otra credencial del mismo proveedor, salvo autorización
  explícita registrada en la asignación.
- **Modelos.** No se escriben identificadores de modelo en el código. Se leen del
  proveedor (`GET /v1/models` de Anthropic y OpenAI, `GET /models` de DeepSeek,
  `GET /v1beta/models` de Gemini). El administrador puede completarlos a mano, y
  quedan marcados como «manual».
- **Pruebas.** Las pruebas automáticas usan servidores locales que responden como
  cada API. La URL base solo se puede cambiar en desarrollo y pruebas. Un estado
  «Conectado» en producción viene siempre de una respuesta real del proveedor.
- **Infraestructura facturable.** Ninguna operación que cueste dinero se ejecuta
  sin estas tres condiciones:
  - pago verificado;
  - autorización de una persona con permiso;
  - presupuesto disponible.

  Un agente de IA no tiene herramientas para crear ni borrar servidores.
- **Dependencias nuevas.** Se añaden los SDK oficiales `@anthropic-ai/sdk` 1.3.0 y
  `openai` 7.45.1, ambos con licencia Apache-2.0. Se fijó en cada uno la versión
  publicada hace más de dos semanas. DeepSeek se usa con el SDK de OpenAI, como
  indica su documentación (`https://api.deepseek.com`, formato OpenAI).

## 4. Orden de trabajo

1. Centro universal de APIs: es la base que usan el agente comercial, la instalación y la rentabilidad.
2. Fases A a J en orden. La fase D empieza por Hetzner Cloud.

Después de cada fase se entregan:

- pruebas;
- documentación;
- un resumen con lo que funciona de verdad y lo que depende de Rick.
