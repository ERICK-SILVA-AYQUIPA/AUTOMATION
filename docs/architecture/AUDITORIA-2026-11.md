# Auditoría del repositorio (13 de noviembre de 2026)

Esta auditoría es la fase 1 del encargo «Evolución profesional de AI Sales
Assistant». Se revisó el código y se ejecutaron las pruebas. Ninguna función
se dio por buena solo porque tuviera pruebas.

Estado de partida:

- Commit: `b0c23a1`.
- CI de GitHub: en verde en los dos últimos commits.
- Pruebas de la API: 92 de integración y 21 unitarias, todas pasan.
- Pruebas en navegador: 5 scripts que pasan contra la pila local.
  - `smoke`: 22 de 22 pasos.
  - `whatsapp`: 10 de 10.
  - `chatwoot`: 10 de 10.
  - `billing`: 6 de 6.
  - `assistant`: 6 de 6.

## 1. Tecnologías y versiones

| Capa | Tecnología |
|---|---|
| Monorepo | pnpm 10.28 workspaces (`apps/api`, `apps/web`) |
| API y worker | NestJS 12 (ESM), Zod 4, Vitest 4, oxlint |
| Datos | PostgreSQL 17, Prisma 7.10 con `adapter-pg`, 7 migraciones SQL con RLS |
| Colas | Redis 7 y BullMQ 6.5. Colas: `wa-inbound`, `wa-outbound`, `chatwoot-sync`, `ai-reply` |
| Web | Next.js 16 (standalone), React, TanStack Query, Tailwind |
| IA | Gemini API (`generateContent`) con un cliente REST propio y herramientas |
| Mensajería | WhatsApp Cloud API (Graph), Chatwoot v4.19.1 (Platform API y SSO) |
| Automatización | n8n, con 3 flujos importables y una bandeja de salida (outbox) |
| Despliegue | Docker multi-stage, `docker-compose.prod.yml`, Caddy con HTTPS, scripts de despliegue y copias |

## 2. Funcionalidades existentes, verificadas en código y con pruebas

- **Multiempresa con tres barreras.**
  - El `tenantId` se toma siempre de la sesión en la base de datos, nunca del frontend.
  - Hay RLS en todas las tablas de negocio.
  - Hay mínimo privilegio por rol (`20261112120000_least_privilege`).
  - Las pruebas negativas están en `tenant-isolation.e2e-spec.ts`: 12 casos.
- **Autenticación.**
  - Contraseñas con Argon2id.
  - JWT corto y refresh rotatorio con detección de reutilización.
  - CSRF de doble envío y verificación de correo.
  - Bloqueo atómico por intentos fallidos.
  - Límite de peticiones en Redis.
- **Catálogo.** Productos, variantes, SKU, código de barras, imágenes, importación y exportación CSV, e historial de cambios.
- **Inventario.**
  - Stock por variante y sucursal.
  - Libro de movimientos inmutable con restricciones CHECK.
  - Alertas de stock bajo.
- **Pedidos.**
  - Precios tomados de la base de datos.
  - Idempotencia.
  - El stock se descuenta una sola vez, al confirmar.
  - Anular un pedido devuelve el stock.
  - Transiciones de estado controladas.
- **WhatsApp Cloud API por empresa.**
  - Credenciales cifradas con AES-256-GCM y verificadas con Meta antes de guardarlas.
  - Un webhook por número, con firma HMAC.
  - Eventos idempotentes y worker con reintentos.
  - Ventana de 24 horas y estados que nunca retroceden.
- **Chatwoot.** Una cuenta por empresa, espejo de mensajes, SSO, retirada de acceso al desactivar un usuario y pausa del bot cuando responde un agente.
- **n8n.** Outbox transaccional, entrega con reintentos, `/internal/notify` idempotente y bloqueado desde internet.
- **Cobro manual.** Acceso calculado por fechas (prueba, gracia, vencido, cancelado), solo lectura con HTTP 402, pagos auditados y panel de pagos.
- **Asistente Gemini.**
  - Herramientas que ejecuta el backend.
  - Pedidos siempre en estado PENDIENTE.
  - Derivación a una persona.
  - Cola con reintentos.
  - Prueba desde el panel.
- **Producción.** Imágenes Docker, Caddy con HTTPS y HSTS, rutas internas que responden 404, validación de la configuración de producción, copias de seguridad, restauración y guía.

Avances anteriores revisados uno a uno:

| Avance | Verificación | Resultado |
|---|---|---|
| Compilación en GitHub | CI `f1d409a` y `4fdcfe2` en verde | Correcto |
| Protección de planes y estado | La prueba RLS «permission denied» al cambiar `status` o `plan_id` | Correcto |
| Login limitado en Redis | `RedisThrottlerStorage` y prueba de instancia compartida | Correcto, con apertura segura si Redis cae: es una decisión, y queda anotada como riesgo |
| Configuración de producción | `productionProblems()` y `env.spec.ts` | Correcto |
| Dependencias de la imagen de la API | CI «La API arranca sin dependencias de desarrollo» | Correcto |
| Rutas internas de n8n | Caddy `@internal` sin distinguir mayúsculas | Correcto. Probado en local por HTTPS, sin dominio real |
| Restricción al vencer la prueba | `billing.e2e-spec.ts` (7 casos) y navegador | Correcto |
| Cobro Yape y transferencia | Ídem | Correcto, pero incompleto: ver 3 |
| Asistente Gemini | `ai.e2e-spec.ts` (8 casos) y navegador, con Gemini **simulado** | Funciona. **No probado con una clave real** |
| Pedidos pendientes | El stock no cambia y no hay duplicados al reintentar | Correcto |
| Paso a atención humana | Se pausa el bot y se crea una notificación | **Incompleto: ver 4.1 y 4.2** |

## 3. Funcionalidades incompletas

| Área | Qué falta |
|---|---|
| Empresas | Solo hay autorregistro. No hay alta desde el panel central. Faltan razón social, RUC, país, dirección, teléfono, tipo de negocio, logotipo, colores, dominio y modalidad |
| Planes | No se pueden editar desde el panel. Los precios iniciales están en USD (29, 79, 199) y los cobros en soles |
| Pagos | No hay comprobante adjunto ni estado «por validar». Registrar un pago lo aprueba directamente |
| Panel general | Las métricas usan el estado guardado de la suscripción, no el calculado: una empresa vencida figura como «ACTIVE». No hay ingresos, consumo de IA, errores ni estado de servicios |
| Automatizaciones | La tabla `automations` existe, pero **no hay ninguna API ni pantalla** para activarlas o desactivarlas (el menú dice «Pronto»). No hay historial visible de ejecuciones ni botón de reintento |
| Conversaciones | No hay asignación a vendedores, notas internas, etiquetas, cierre de la conversación desde el panel ni reactivación de la IA |
| Asistente IA | La configuración es básica: nombre, tono, saludo, información libre y palabras clave. Faltan idioma, horarios, preguntas frecuentes, políticas, documentos de conocimiento y mensaje de derivación configurable. La clave de Gemini es global, sin tope de gasto por empresa |
| Integraciones | Hay WhatsApp (con verificación) y Chatwoot. No hay un registro central con estado, última comprobación y botón de prueba para todas. Faltan el SMTP por empresa, n8n por empresa y los webhooks externos |
| Plantillas por sector | No existen |
| Entrega de sistemas | Hay un compose de producción y una guía. No hay generador de paquetes ni instalador con verificación de requisitos |
| Actualizaciones | `deploy.sh` actualiza y migra. No hay versión visible ni registro de actualizaciones, y la copia de seguridad previa es manual |
| Ventas y suscripción | No hay módulo «Ventas» separado de Pedidos. La suscripción se ve dentro de Configuración |

## 4. Errores encontrados

1. **Las notificaciones no se pueden ver.**
   - El backend crea notificaciones en estos casos:
     - derivación a una persona;
     - token de WhatsApp caducado;
     - stock bajo;
     - fallo de entrega a n8n;
     - avisos de n8n.
   - Pero no existe ningún endpoint ni pantalla para leerlas. La campana solo muestra alertas de stock.
   - **Consecuencia:** cuando la IA pasa una conversación a una persona, nadie se entera desde el panel.
2. **La IA no se puede reactivar desde el panel.**
   - Una conversación derivada queda con `botStatus = PAUSED` para siempre, salvo que se resuelva en Chatwoot.
   - Tampoco se puede cerrar una conversación desde el panel.
3. **Las métricas de la plataforma no coinciden con el acceso real.** Usan `subscriptions.status` en lugar del estado calculado (ver 3).
4. **El aviso de vencimiento puede quedar desactualizado.** `/auth/me` se lee al iniciar sesión. Si la cuenta vence durante la sesión, el aviso no cambia hasta recargar. La API sí bloquea.
5. **Quedan restos de servicios que no se usan.**
   - `services/dify` y el enum `IntegrationType.DIFY`.
   - Evolution API en el compose de desarrollo, que no es oficial de Meta.
   - El campo `evolutionInstance` en los números.
   - No rompen nada, pero confunden. No se borran sin autorización.

## 5. Riesgos

| Riesgo | Nivel | Tratamiento |
|---|---|---|
| Gemini nunca se probó con una clave real | Alto | Fase 5 y 10: prueba real separada de las simuladas, en el entorno Gemini-Env |
| WhatsApp nunca se probó con Meta real | Alto | Requiere un número y una app de Meta. Guía en `docs/integrations/whatsapp-cloud-api.md` |
| Gasto de IA sin tope por empresa | Medio | Fase 5: límite mensual de respuestas y tokens por plan, con alertas |
| Límite de login abierto si Redis cae | Bajo | Se mantiene así (disponibilidad). El bloqueo por cuenta en la base de datos sigue activo |
| Las pruebas de navegador no corren en CI | Medio | Fase 10 |
| Cambio de modelo por parte de Google | Medio | `GEMINI_MODEL` es configurable |

## 6. Duplicaciones y deuda técnica

- Las etiquetas de estados y métodos de pago se repiten en varias páginas web (`ACCESS`, `METHODS`). Hay que moverlas a `lib/format.ts`.
- Tipos de la API escritos a mano en la web, sin generar desde la API.
- `platform.controller.ts` concentra demasiado. Hay que separarlo en servicios (empresas, cobros, métricas) antes de crecer.
- El seed de planes tiene precios fijos en código. Deben pasar a ser configurables (fase 2).

## 7. Plan de implementación (orden y alcance)

| Fase | Entregables verificables |
|---|---|
| 2. Núcleo multiempresa | Corregir los errores 1 a 4: notificaciones visibles, controles de conversación (asignar, notas, etiquetas, cerrar, reactivar IA) y métricas con el estado real. Perfil completo de la empresa. Planes editables en soles. Módulos por empresa |
| 3. Alta de empresas | Asistente de alta en `/plataforma`: idempotente, con administrador invitado por correo (sin contraseñas en pantalla), lista de tareas pendientes y activación |
| 4. Automatizaciones | Catálogo de automatizaciones con API y pantalla para activar y configurar, historial de ejecuciones, reintentos y más flujos n8n importables |
| 5. Asistente IA | Configuración ampliada, base de conocimiento por empresa, topes de consumo y prueba real con Gemini cuando haya clave |
| 6. Integraciones | Registro central con estado, última comprobación, botón de prueba y secretos enmascarados (WhatsApp, Gemini, SMTP, n8n, Chatwoot) |
| 7. Plantillas | Tienda, restaurante, distribuidora y servicios como configuraciones (módulos, categorías iniciales, IA, automatizaciones) sobre el mismo núcleo |
| 8. Entrega | Paquete de entrega reproducible (ZIP sin secretos), instalador con verificación de requisitos y manuales |
| 9. Actualizaciones | Versión instalada y disponible, actualización con copia previa, migraciones y verificación de salud, con registro |
| 10. Cierre | Pruebas de navegador en CI, pruebas reales separadas de las simuladas, auditoría de seguridad final y documentación |

Lo que depende de decisiones o servicios externos se marca como pendiente en cada fase. Nunca se marca como hecho.

## Seguimiento

| Error | Estado |
|---|---|
| 1. Notificaciones invisibles | Corregido en la fase 2 (`/notifications` y campana) |
| 2. IA sin reactivar ni cierre desde el panel | Corregido en la fase 2 |
| 3. Métricas con el estado guardado | Corregido en la fase 2 (estado de acceso calculado) |
| 4. Aviso de vencimiento desactualizado | Corregido en la fase 3 (relectura de la cuenta en vivo) |
| 5. Restos de Dify y Evolution | Pendiente de autorización para borrarlos |
| Hallado en fase 2: responder desde el panel no pausaba la IA | Corregido |
| Hallado en CI: pedidos simultáneos de un cliente nuevo daban 409 | Corregido con prueba que lo reproduce |
| Hallado en fase 3: «solo por IA» contaba conversaciones sin respuesta del asistente; reactivar la IA borraba el historial de derivación | Corregido |

