# Criterios de aceptación final: evidencia

Estado al 2026-11-13, versión 0.9.0. Cada criterio indica **cómo se demuestra** y
**con qué servicios** se probó. «Local» quiere decir con los servicios reales del
proyecto (PostgreSQL, Redis, n8n, Chatwoot, Mailpit) en una máquina de desarrollo.
Donde interviene Meta o Google, las pruebas usan un servidor local que responde como
sus API (el código es el mismo; solo cambia `WHATSAPP_GRAPH_BASE_URL` /
`GEMINI_BASE_URL`). **Nada de lo marcado «pendiente» se ha probado con el servicio real.**

Pruebas en navegador: `apps/web/e2e/<script>.mjs` (ver README, «Pruebas»).
Pruebas de la API: `apps/api/test/*.e2e-spec.ts` contra PostgreSQL real.

| # | Criterio | Cómo se demuestra | Estado |
|---|---|---|---|
| 1 | Crear una empresa desde el panel central | `provisioning.mjs`: asistente de `/plataforma/nueva`, idempotente; `provisioning.e2e-spec.ts` | Probado en local |
| 2 | Configurar su identidad y su administrador | `provisioning.mjs`: datos de la empresa, administrador invitado por correo que crea su contraseña; `assistant.mjs`: perfil con RUC | Probado en local (correo en Mailpit; SMTP real pendiente) |
| 3 | Elegir una plantilla | `templates.mjs` (paso «Sector» del alta y aplicación por secciones a una empresa existente); `templates.e2e-spec.ts` | Probado en local |
| 4 | Activar módulos | `provisioning.mjs` y `assistant.mjs` (apagar «Pedidos» lo quita del menú y la API responde 403) | Probado en local |
| 5 | Configurar WhatsApp | `whatsapp.mjs`: credenciales validadas, verificación del webhook, firma | Probado con el servidor local que responde como Meta. **Pendiente**: número real de Meta (credenciales de Rick) |
| 6 | Conectar su asistente IA | `assistant.mjs`: borrador, prueba, publicación; `integrations.mjs`: clave propia de Gemini validada antes de guardarse | Probado con el servidor local que responde como Gemini. **Pendiente**: petición real con una clave de Google |
| 7 | Registrar sus productos | `smoke.mjs` (producto con stock y con variantes), `catalog-inventory-orders.e2e-spec.ts` | Probado en local |
| 8 | Activar automatizaciones | `automations.mjs` (activar, configurar, historial, reintento; avisos por n8n real) | Probado en local con n8n real |
| 9 | Probar un mensaje real | `whatsapp.mjs` y `assistant.mjs`: mensaje entrante por el webhook, respuesta enviada por el worker | Recorrido completo probado contra el servidor local de Meta. **Pendiente**: mensaje real de ida y vuelta con un número de Meta |
| 10 | Consultar un producto real | `assistant.mjs`: el asistente responde con el precio del catálogo (herramienta `buscar_productos` del backend) | Probado con el servidor local de Gemini. **Pendiente**: con la clave real |
| 11 | Registrar un pedido | `smoke.mjs` (pedido confirmado que descuenta stock y anulación que lo devuelve); el asistente crea pedidos PENDIENTES (`ai.e2e-spec.ts`) | Probado en local |
| 12 | Transferir una conversación a un trabajador | `assistant.mjs` (un reclamo deriva y pausa la IA, aviso en la campana); `chatwoot.mjs` (agente en Chatwoot real con inicio de sesión único) | Probado en local con Chatwoot real |
| 13 | Consultar reportes | `smoke.mjs`: panel de inicio con la venta del día y CSV de ventas de `/reportes` con el pedido confirmado | Probado en local |
| 14 | Generar su paquete de entrega | `deliveries.mjs` (ZIP reproducible, huella SHA-256, sin secretos), `deliveries.e2e-spec.ts` | Probado en local |
| 15 | Instalar una instancia independiente | Fase 8: instalación real con `instalar.sh` desde el paquete (imágenes cargadas desde el `.tar.gz`, HTTPS con certificados locales de Caddy, salud, importación de la empresa, invitación por correo, entrada del administrador) | Probado en local. **Pendiente**: servidor, dominio y certificado reales |
| 16 | Actualizarla sin perder sus datos | Fase 9: `actualizar.sh` de 0.8.0 a 0.9.0 sobre esa instancia, con productos, stock y reglas propias y archivos del kit modificados: ensayo de recuperación (vuelve a 0.8.0 intacta) y actualización definitiva (2 migraciones, datos y personalizaciones intactos, historial en el panel) | Probado en local. **Pendiente**: en el servidor real |
| 17 | Demostrar el aislamiento entre dos empresas | `tenant-isolation.e2e-spec.ts`: API (403/404 entre empresas) y PostgreSQL con el rol de ejecución (RLS en lectura y escritura, sin filtro por empresa no se ve nada) y una comprobación estructural: toda tabla accesible para ese rol tiene RLS con políticas | Probado en local |

## Centro universal de APIs (ADR 046)

Pruebas: `api-center.e2e-spec.ts` (API y PostgreSQL) y `api-center.mjs` (navegador), con el servidor local `apps/api/test/fake-ai-providers.ts`, que responde con el formato documentado de Anthropic, OpenAI, DeepSeek y Gemini. **Ninguna clave real se ha probado todavía.**

| # | Criterio | Cómo se demuestra | Estado |
|---|---|---|---|
| 1 | Registrar Claude | Plataforma → Centro de APIs → «Agregar proveedor»; la clave se prueba con `models.list` antes de guardarse | Probado con servidor local |
| 2 | Prueba real | «Probar» de la credencial y de la asignación (petición corta al modelo) | Probado con servidor local. **Pendiente**: clave real |
| 3 | Elegir modelo | «Leer modelos» llena el catálogo; precio editable | Probado con servidor local |
| 4 | Asignar a una empresa | «Asignar IA» (empresa, servicio, credencial, modelo, perfil, tope) | Probado |
| 5 | Conversación real | El asistente responde con el precio del catálogo usando Claude (herramienta del backend) | Probado con servidor local |
| 6 | Registrar consumo | `ai_usage_events`, tabla de consumo con costo cuando hay precio | Probado |
| 7 | Cambiar a Gemini (u otro) desde el panel | Cambiar la asignación; la siguiente respuesta usa el nuevo proveedor | Probado (Gemini en la API; OpenAI en navegador) |
| 8 | La empresa sigue funcionando | Pedidos y conversaciones no dependen del proveedor; sin IA, el equipo atiende | Probado |
| 9 | Segunda empresa con credenciales propias | Clave propia de otra empresa, independiente | Probado |
| 10 | Sin fugas entre empresas | RLS, disparador de la base y comprobación en código; claves nunca en respuestas ni en el HTML | Probado |
| 11 | Desconectar | Desactiva las asignaciones, avisa a la empresa y no cambia de proveedor por su cuenta | Probado |
| 12 | Errores claros | Clave rechazada, sin permisos, servicio caído, tope alcanzado | Probado con servidor local |

## Seguridad (fase 10)

- Dependencias de producción: `pnpm audit --prod` sin vulnerabilidades conocidas (2026-11-13). No se añadieron dependencias en las fases 8 y 9: el ZIP y el actualizador usan solo Node y herramientas del sistema.
- Secretos: ninguno en el repositorio (`.env` ignorado, búsqueda de patrones de claves sin resultados reales). Credenciales de cada empresa cifradas con `DATA_ENCRYPTION_KEY` y mostradas solo con sus últimos caracteres. El paquete de entrega se revisa contra los secretos del servidor antes de generarse.
- Exposición: en producción solo Caddy publica puertos (80/443); PostgreSQL y Redis quedan en la red interna; n8n y Chatwoot solo en 127.0.0.1. La API interna para n8n responde 404 desde internet. Comprobado en la instancia instalada (cabeceras HSTS, CSP, `X-Frame-Options`, `nosniff`).
- Límite de intentos de inicio de sesión (`rate-limit.e2e-spec.ts`), sesiones revocables, auditoría de solo anexar.

## Pendientes que dependen de Rick

Servidor, dominio y SMTP reales · claves reales de Claude, OpenAI, DeepSeek o Gemini (con plan de pago) · número y credenciales de Meta · precios en soles, texto de cobro y límites de los planes · proveedor de pagos (hoy el cobro es manual) · capacidad y horarios de cada empresa · autorización para retirar los restos de Dify y Evolution API del repositorio.
