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
- [x] Fase 5: asistente IA configurable (ADR 041)
  - [x] Personalidad, idioma, horario con modo fuera de horario, pagos, entregas, devoluciones, preguntas frecuentes, preguntas previas, mensajes de derivación e indicaciones adicionales
  - [x] Borrador → prueba en el panel → publicación (auditada); los clientes solo ven lo publicado
  - [x] Documentos de conocimiento en texto con límite por plan
  - [x] Tope mensual de tokens (plan y empresa) con derivación y aviso al alcanzarlo
  - [ ] Prueba con la clave real de Gemini: **pendiente de Rick** (todo lo anterior se probó con un servidor Gemini simulado)
- [x] Fase 6: integraciones centralizadas (ADR 042)
  - [x] Centro de integraciones de la empresa: estado real de WhatsApp, Gemini, correo, n8n, Chatwoot, webhooks y pagos, con última prueba, botón «Probar» (petición real) e historial de errores
  - [x] Clave propia de Gemini por empresa: validada con Google antes de guardarse, cifrada, solo se muestra el final; el asistente la usa en lugar de la de la plataforma
  - [x] Webhooks salientes firmados (HMAC-SHA256) con reintentos, historial de entregas, reintento manual, rotación de secreto y protección SSRF
  - [x] Pestaña «Integraciones» del panel general: prueba real de base de datos, Redis, Gemini, SMTP, n8n y Chatwoot, con las variables de entorno de cada uno
  - [ ] Pagos: sin proveedor (cobro manual, ADR 036) hasta que Rick elija y se pruebe uno
  - [ ] Prueba con claves reales de Gemini y Meta y con un SMTP real: **pendiente de Rick** (probado con servidores simulados y Mailpit)
- [x] Fase 7: plantillas por sector (ADR 043)
  - [x] Cuatro plantillas (tienda, restaurante, distribuidora, servicios) sobre los mismos módulos: módulos, reglas, automatizaciones, indicaciones del asistente y categorías
  - [x] Alta con plantilla y, en empresas existentes, vista previa con el estado real y aplicación por secciones (el asistente va a borrador); auditado
  - [x] Reglas de operación personalizables por la empresa (Configuración › Operación)
  - [x] Productos sin stock (platos, servicios) y con duración; precios por volumen calculados por el backend; pedido mínimo
  - [x] Clientes comerciales (razón social) e historial de compras
  - [x] Reservas de mesa y citas con horario, aforo protegido ante reservas simultáneas, estados, herramientas del asistente, webhooks y recordatorio por WhatsApp
  - [ ] Capacidad y horario reales de cada negocio: **los define cada empresa** (no se inventan)
- [x] Fase 8: entrega de sistemas (ADR 044)
  - [x] Entregas desde el panel general: foto sin secretos con módulos, funciones, configuración, requisitos, integraciones pendientes y acceso inicial
  - [x] ZIP reproducible (huella SHA-256 comprobada en cada descarga) con manuales, guías de WhatsApp e IA y soporte
  - [x] Kit de instalación independiente: Docker Compose de la versión, variables de ejemplo, Caddy/HTTPS, migraciones, instalador que valida requisitos, salud, respaldo, restauración y registros
  - [x] Carga de la configuración de la empresa en la instancia nueva, una sola vez
  - [ ] Instalación en el servidor real del cliente: **pendiente de Rick** (servidor, dominio y SMTP); probado en local con certificados propios de Caddy
- [ ] Fase 9: actualizaciones
- [ ] Fase 10: cierre (pruebas, seguridad, documentación)

## FASE 7: automatizaciones, pedidos, inventario, notificaciones
## FASE 8: seguridad, pruebas E2E, optimización, documentación, producción
