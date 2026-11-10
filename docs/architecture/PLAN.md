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
- [~] Arranque de Dify: instalador listo; descarga de imágenes bloqueada por el límite anónimo de Docker Hub en el entorno de construcción (pendiente de verificar)

## FASE 2: backend, BD, auth, multiempresa
- [x] apps/api NestJS 12, configuración validada con Zod, logs estructurados (pino) con redacción de secretos, health live/ready
- [x] Esquema Prisma (30 tablas): planes, suscripciones, uso, usuarios, sesiones, tokens, sucursales, categorías, productos, variantes, imágenes, historial, stock por sucursal, movimientos, clientes, pedidos, conversaciones, mensajes, webhooks, outbox, WhatsApp, IA, automatizaciones, integraciones, notificaciones, auditoría
- [x] Roles de BD (propietario / ejecución sin BYPASSRLS / sistema) + 32 políticas RLS + restricciones CHECK
- [x] Registro de empresa, login, logout, refresh rotatorio, verificación de correo, recuperación de contraseña, invitaciones, gestión de sesiones
- [x] RBAC con guards; rate limiting; CORS; Helmet; CSRF double-submit; bloqueo por intentos
- [x] Panel de plataforma: empresas, planes, suspensión, métricas
- [x] Tests: 10 unitarios + 26 e2e contra PostgreSQL real (casos 1, 2 y 11)
- [ ] Rate limiting con almacenamiento en Redis para varias instancias (FASE 8)
- [ ] Mailpit en compose para ver correos en desarrollo (imagen no descargable en este entorno por el límite de Docker Hub)

## FASE 3: frontend
- [ ] Next.js + Tailwind, layout con sidebar, tema claro/oscuro
- [ ] Dashboard con datos reales y filtros/exportación
- [ ] Productos (CRUD, imágenes, import/export CSV/XLSX, historial, lector de códigos)
- [ ] Inventario, clientes, pedidos

## FASE 4: WhatsApp + n8n
- [ ] Adaptador Cloud API (webhook verificado, envío, plantillas) y adaptador Evolution opcional
- [ ] Flujos n8n versionados en `services/n8n/workflows`
- [ ] Pruebas con número de prueba de Meta

## FASE 5: Chatwoot
- [ ] Provisión de Account/inbox API por empresa, espejo de mensajes, webhooks, pausa/reanudación del bot

## FASE 6: Dify + IA
- [ ] App de Dify (interpretación + redacción), herramientas seguras en backend, validación de salida

## FASE 7: automatizaciones, pedidos, inventario, notificaciones
## FASE 8: seguridad, pruebas E2E, optimización, documentación, producción
