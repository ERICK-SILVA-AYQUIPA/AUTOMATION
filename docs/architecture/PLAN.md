# Plan de implementación y lista de tareas

Leyenda: [x] hecho y verificado · [~] en curso · [ ] pendiente

## FASE 1: entorno, arquitectura, Docker
- [x] Inspección del entorno (Node 22, pnpm 10, Docker 29 + Compose v5, PG/Redis vía Docker)
- [x] Verificación de versiones estables, imágenes y licencias de los 4 proyectos
- [x] Arquitectura, ADR, riesgos, diagramas de secuencia
- [x] Estructura del monorepo
- [x] `docker-compose.yml` (Postgres 17 + pgvector, Redis, n8n, Chatwoot, Evolution) con health checks y puertos solo en localhost
- [x] `.env.example` + `setup.sh` que genera secretos aleatorios
- [x] Scripts: up, down, healthcheck, chatwoot-init, backup, restore
- [x] Dify: instalador del compose oficial fijado a 1.19.0
- [x] Arranque de Dify 1.19.0 verificado (`/console/api/ping` → pong), todos los puertos en 127.0.0.1

## FASE 2: backend, BD, auth, multiempresa
- [x] apps/api NestJS 12, configuración validada con Zod, logs estructurados (pino) con redacción de secretos, health live/ready
- [x] Esquema Prisma (30 tablas): planes, suscripciones, uso, usuarios, sesiones, tokens, sucursales, categorías, productos, variantes, imágenes, historial, stock por sucursal, movimientos, clientes, pedidos, conversaciones, mensajes, webhooks, outbox, WhatsApp, IA, automatizaciones, integraciones, notificaciones, auditoría
- [x] Roles de BD (propietario / ejecución sin BYPASSRLS / sistema) + 32 políticas RLS + restricciones CHECK
- [x] Registro de empresa, login, logout, refresh rotatorio, verificación de correo, recuperación de contraseña, invitaciones, gestión de sesiones
- [x] RBAC con guards; rate limiting; CORS; Helmet; CSRF double-submit; bloqueo por intentos
- [x] Panel de plataforma: empresas, planes, suspensión, métricas
- [x] Tests: 10 unitarios + 26 e2e contra PostgreSQL real (casos 1, 2 y 11)
- [ ] Rate limiting con almacenamiento en Redis para varias instancias (FASE 8)
- [x] Mailpit en compose (perfil `mail`) para ver correos en desarrollo

## FASE 3: catálogo, inventario, pedidos y panel web
- [x] API: categorías, productos con variantes, imágenes (validadas por contenido), historial, importación todo-o-nada y exportación CSV/XLSX, búsqueda por código de barras
- [x] API: inventario por variante y sucursal con libro inmutable, ajustes, transferencias (plan Empresarial), alertas de stock
- [x] API: clientes, pedidos idempotentes con precios de la BD, transiciones de estado con descuento/devolución de stock, exportación CSV
- [x] API: panel de métricas en la zona horaria de la empresa y reporte de ventas CSV
- [x] Next.js 16 + Tailwind 4: menú lateral por permisos, búsqueda global (Ctrl+K), tema claro/oscuro/sistema, móvil con menú desplegable
- [x] Pantallas: inicio, productos (alta, edición, variantes, imágenes, historial, movimientos, importar/exportar, lector de códigos con cámara), categorías, inventario, pedidos, clientes, reportes, usuarios, configuración, plataforma
- [x] Prueba de humo en Chromium real: 22 pasos (registro → verificación → login → catálogo → stock → pedido → anulación → roles → suspensión)
- [ ] Conversaciones, asistente IA, automatizaciones e integraciones: se muestran como "Pronto" hasta sus fases

## FASE 4: WhatsApp + n8n
- [x] Adaptador Cloud API: números por empresa (credenciales cifradas y verificadas con Meta), webhook firmado por número, envío de texto y plantillas, estados de entrega, ventana de 24 h, BSUID
- [x] Worker con colas BullMQ (entrada y salida) y reintentos según los códigos de Meta
- [x] Panel: Integraciones (conectar número, datos del webhook, comprobar, prueba, desactivar) y bandeja de conversaciones con respuesta manual
- [x] Flujos n8n versionados en `services/n8n/workflows` (3 pedido nuevo, 4 stock bajo, 7 alerta de error) con bandeja de salida y API interna; probados con el n8n real
- [ ] Adaptador Evolution opcional (pendiente; ver reporte de la fase)
- [ ] Prueba con un número de prueba real de Meta (requiere tus credenciales; guía en `docs/integrations/whatsapp-cloud-api.md`)

## FASE 5: Chatwoot
- [x] Cuenta, usuario técnico y buzón API por empresa desde Integraciones (Platform API), reanudable si falla a mitad
- [x] Copia de mensajes y estados de WhatsApp a Chatwoot (cola `chatwoot-sync`)
- [x] Respuestas de agentes en Chatwoot salen por WhatsApp (webhook firmado, sin duplicados, error visible fuera de 24 h)
- [x] Pausa/reactivación del asistente según lo que haga el agente; aviso "Atención humana" en el panel
- [x] "Abrir en Chatwoot" con acceso único; retirada de acceso al desactivar o cambiar el rol
- [x] Cierre del asistente de instalación de Chatwoot (`setup-platform.sh`)
- [ ] Adjuntos reales (FASE 7) y publicación segura de Chatwoot por HTTPS (FASE 8)

## FASE 6: IA (Gemini directo, ADR 037)
- [x] Cliente de la Gemini API (`generateContent` con herramientas, firmas de pensamiento) detrás de la interfaz `ChatModel`
- [x] Herramientas seguras en el backend: buscar productos, ver pedidos del cliente, pedido PENDIENTE (sin tocar stock, idempotente) y pasar a una persona
- [x] Cola `ai-reply` en el worker: junta mensajes seguidos, respeta atención humana, suscripción, límite de conversaciones del plan y ventana de 24 h; reintenta cuota/caídas y, si se agotan, pasa a una persona
- [x] Pantalla «Asistente IA»: configuración y prueba en vivo sin enviar por WhatsApp
- [x] Pruebas: 8 de integración contra un Gemini simulado y 6 pasos en navegador (`apps/web/e2e/assistant.mjs`)
- [ ] Prueba con la clave real de Gemini (pendiente: la clave está en otro entorno de la nube)
- [ ] Validación automática de la respuesta (precios citados sin herramienta): hoy lo controlan las reglas del prompt

## EVOLUCIÓN (2026-11-13): plataforma reutilizable. Ver `AUDITORIA-2026-11.md`
- [x] Fase 1: auditoría del repositorio
- [x] Fase 2: núcleo multiempresa (ADR 038)
  - [x] Avisos visibles: API `/notifications` y campana con enlace a la conversación, producto o integración
  - [x] Bandeja: reactivar o pausar la IA, cerrar y reabrir, asignar, etiquetas, notas internas, filtros (atención humana, mías, sin asignar, etiqueta)
  - [x] Responder desde el panel pausa la IA y asigna la conversación (error encontrado en esta fase)
  - [x] Métricas de la plataforma con el estado de acceso real, ingresos, consumo de IA y errores
  - [x] Perfil completo de la empresa; ficha de la empresa en la plataforma (dominio, modalidad, módulos)
  - [x] Planes editables (precio, moneda, límites, funciones) con auditoría
  - [x] Módulos por empresa: menú filtrado y API con 403 `MODULE_DISABLED`
  - [ ] Precios reales de los planes en soles: **los decide Rick** desde Plataforma → Planes y precios
  - [x] Aviso de vencimiento en vivo sin recargar (error 4): resuelto en la fase 3
- [x] Fase 3: alta de empresas desde la plataforma (ADR 039)
  - [x] Asistente de alta en 5 pasos (empresa, marca y modalidad, plan y periodo, administrador, revisión) con borrador recuperable
  - [x] Alta idempotente (también en paralelo) y transaccional; administrador invitado por correo
  - [x] Estado «en preparación»: el equipo configura, el asistente no responde a clientes
  - [x] Lista de puesta en marcha calculada (empresa y plataforma) y activación solo con las tareas obligatorias hechas
  - [x] Reenvío de invitación si el correo falló; aviso «Tu cuenta está activa»
  - [x] El panel relee la cuenta al volver a la pestaña, cada 5 min y al recibir 402 o MODULE_DISABLED
  - [x] Métrica «solo por IA» de Inicio: solo conversaciones que el asistente respondió sin intervención humana
  - [ ] Dominio propio: se registra, pero el DNS y el certificado se configuran en el servidor (fase 8)
- [x] Fase 4: automatizaciones (ADR 040)
  - [x] Catálogo con 6 automatizaciones, ejecutor (backend o n8n), destinatario, plan necesario y versión
  - [x] Configuración por empresa validada (canales e importe mínimo del aviso de pedido; estados y textos del aviso al cliente; horas del recordatorio)
  - [x] Nuevas: estado del pedido al cliente por WhatsApp, recordatorio de pedidos sin confirmar, aviso por correo de derivación a una persona (flujo n8n `06-aisa-derivacion`, probado con el n8n real)
  - [x] Historial con filtros, motivo de omisión, errores y reintento manual; aviso en el panel si se agotan los reintentos
  - [x] Versiones: la empresa ve qué cambia y la aplica sin perder su configuración
  - [ ] Mensajes al cliente fuera de las 24 h: requieren plantillas aprobadas por Meta (pendiente de credenciales reales)
- [ ] Fase 5: asistente IA ampliado
- [ ] Fase 6: integraciones centralizadas
- [ ] Fase 7: plantillas por sector
- [ ] Fase 8: entrega de sistemas
- [ ] Fase 9: actualizaciones
- [ ] Fase 10: cierre (pruebas, seguridad, documentación)

## FASE 7: automatizaciones, pedidos, inventario, notificaciones
## FASE 8: seguridad, pruebas E2E, optimización, documentación, producción
