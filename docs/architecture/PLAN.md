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

## FASE 6: Dify + IA
- [ ] App de Dify (interpretación + redacción), herramientas seguras en backend, validación de salida

## FASE 7: automatizaciones, pedidos, inventario, notificaciones
## FASE 8: seguridad, pruebas E2E, optimización, documentación, producción
