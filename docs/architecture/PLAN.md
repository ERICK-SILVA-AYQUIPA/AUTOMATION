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
- [~] Arranque de Dify verificado (bloqueado temporalmente por límite de Docker Hub en este entorno)

## FASE 2: backend, BD, auth, multiempresa
- [ ] apps/api NestJS, configuración validada, logs estructurados (pino), health
- [ ] Esquema Prisma: tenants, plans, subscriptions, users, roles, sessions, categories, products, variants, images, product_history, inventory_movements, customers, orders, order_items, conversations, messages, inbound_events, outbound_messages, whatsapp_numbers, ai_settings, automations, audit_logs, usage_counters
- [ ] Rol de BD sin BYPASSRLS + políticas RLS + migraciones
- [ ] Registro de empresa, login, logout, refresh, verificación de correo, recuperación de contraseña
- [ ] RBAC y guards; rate limiting; CORS; Helmet; CSRF
- [ ] Tests: registro, usuario, aislamiento entre empresas

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
