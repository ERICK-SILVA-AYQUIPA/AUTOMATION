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

## Fase A: centro comercial (ADR 047)

| Criterio | Cómo se demuestra | Estado |
|---|---|---|
| Registrar prospectos con nombre, empresa, teléfono, correo, sector, necesidad, fuente, presupuesto, solución de interés, responsable y próxima acción | `sales.mjs` (formulario completo) y `sales.e2e-spec.ts` | Probado en local |
| Duplicados por correo o teléfono | Aviso con enlace al existente; se registra solo con confirmación | Probado |
| 11 etapas y embudo visual | Columnas con cantidad y presupuesto; arrastrar entre etapas comerciales | Probado |
| Etapas protegidas | Pago confirmado solo validando el pago; instalación pendiente solo al convertir; cliente activo solo al activar la empresa; perder exige motivo | Probado (API y navegador) |
| Historial completo e inalterable | Disparador en la base; ni el rol de sistema lo cambia o borra | Probado |
| Convertir en cliente | El asistente de alta llega con los datos del prospecto, crea la empresa en preparación e invita al administrador | Probado en local (correo en Mailpit) |
| Separación de nuestro negocio y el de las empresas | Las tablas no son accesibles para el rol de ejecución; una empresa recibe 403 | Probado |

## Fase B: página comercial y agente comercial (ADR 048)

| Criterio | Cómo se demuestra | Estado |
|---|---|---|
| Página con presentación, problemas, beneficios, funciones, sectores, modalidades, planes, cómo contratar, preguntas y contacto | `commercial.mjs` (visitante sin sesión) | Probado en local |
| Funciones y planes reales, sin precios inventados | Módulos, plantillas y planes salen del sistema; el precio solo si la plataforma lo publica (`commercial.e2e-spec.ts`) | Probado |
| Testimonios solo reales | Exigen fecha de autorización; sin testimonios no hay sección | Probado |
| Recorrido del visitante: sector, necesidad, planes, demostración | «Es mi sector» abre el formulario con el sector elegido; la solicitud crea el prospecto con próxima acción | Probado en navegador |
| Agente que explica, compara planes, registra prospectos, agenda demostraciones y deriva a un vendedor | Chat web con la IA de la empresa interna (servidor local que responde como Anthropic) | Probado en local; **con un modelo real: pendiente de clave** |
| No inventa precios, no acepta contratos ni pagos | No tiene herramientas para eso; reglas fijas en el sistema; prueba: precio no publicado no aparece | Probado |
| Operaciones registradas | Prospecto, solicitud, derivación e historial del chat en el centro comercial | Probado |
| Agente por WhatsApp | Responde en la empresa interna con el número que da Meta y deriva a la bandeja (`commercial.e2e-spec.ts`) | Probado en local; **con número real de Meta: pendiente** |
| Seguimiento con consentimiento | Consentimiento guardado con fecha y canal; seguimiento como tarea del equipo | Parcial: **el envío automático al prospecto no está implementado** |

## Fase C: cotizaciones, contratos y pagos (ADR 049)

| Criterio | Cómo se demuestra | Estado |
|---|---|---|
| Generador con plan, usuarios, módulos, instalación, servidor, configuración, integraciones, servicios, soporte, mantenimiento, precio de instalación, mensualidad y vigencia | Editor en la ficha del prospecto (`quotes.mjs`) | Probado en local |
| Número, cliente, servicios, precios, moneda, impuestos, condiciones, vigencia y estado | `quotes.e2e-spec.ts`; impuesto incluido o agregado calculado en centavos | Probado |
| Documento PDF profesional | Vista previa del equipo y descarga del cliente (se verifica que es PDF) | Probado |
| Aceptación con condiciones y versión del contrato | El cliente acepta con nombre y documento; se guardan IP, navegador, fecha y versión; si el contrato cambió no acepta | Probado |
| Una cotización enviada no se altera | Disparador en la base; el panel ya no permite editar | Probado |
| Métodos de pago configurables por país y cliente | Métodos por país y moneda; el equipo puede limitar los de una orden | Probado |
| Un comprobante no prueba el pago | El cliente solo informa; pagado exige validación con importe exacto y la casilla «verifiqué el ingreso en la cuenta», o una pasarela oficial | Probado (API y navegador) |
| Registro contable | Asiento por pago validado (bruto, impuesto, neto), inalterable y exportable a CSV | Probado |
| Orden de instalación solo con pago validado | Nace en la misma transacción del pago; la conversión en cliente la enlaza a la empresa | Probado |
| Pasarela oficial | Confirmación idempotente lista, **sin ruta pública: no hay proveedor elegido ni probado** | Pendiente de Rick |
| Datos reales (Yape, cuentas, precios, impuesto, contrato) | Se cargan en Cotizaciones y pagos › Catálogo y Configuración | **Pendiente de Rick** |

## Fase D: gestor de infraestructura (ADR 050)

| Criterio | Cómo se demuestra | Estado |
|---|---|---|
| Adaptadores con una interfaz común, sin acoplarse a un proveedor | `InfraAdapter` y `HetznerAdapter`; el resto de la plataforma solo usa la interfaz | Hecho (un adaptador: Hetzner) |
| Credenciales cifradas, probadas y nunca mostradas completas | Token rechazado no se guarda; respuestas sin el token (`infra.e2e-spec.ts`, `infra.mjs`) | Probado con servidor local |
| Regiones, tamaños, precios y disponibilidad | Leídos del proveedor; tamaños retirados y no disponibles marcados | Probado con servidor local |
| Proyectos y facturación | Hetzner no los ofrece por API: el token es de un proyecto; el costo es una estimación indicada como tal | Limitación del proveedor, documentada |
| Límites y presupuesto | Sin presupuesto no se aprueba; máximo de servidores, regiones y tamaños permitidos; se recalcula al aprobar | Probado |
| No crear infraestructura facturable sin aprobación | Solicitud y aprobación separadas, nombre escrito y gasto autorizado; ninguna llamada de escritura antes de aprobar | Probado (se cuentan las llamadas al proveedor) |
| Sin contraseñas SSH ni claves privadas | Claves privadas rechazadas; contraseña de root descartada; firewall con SSH solo desde redes indicadas | Probado |
| Iniciar, detener, reiniciar, consumo, eliminar con autorización | Acciones del panel; eliminar con nombre y motivo; historial que solo se agrega | Probado con servidor local |
| Ninguna IA crea ni elimina servidores | El módulo no expone herramientas a los asistentes; solo `platform:manage` | Hecho |
| Con Hetzner real | Requiere un token del proyecto y autorizar el primer servidor | **Pendiente de Rick** |
| Servidor propio del cliente (§7B) | Instalador o agente con credenciales temporales | Pendiente (fases E/F) |

## Fases E y F: orquestador e instalación automática (ADR 051)

| Criterio | Cómo se demuestra | Estado |
|---|---|---|
| Estados de punta a punta (solicitud → entrega, error, cancelada, intervención) | Pasos en la pantalla y en `orchestrator.e2e-spec.ts` | Probado |
| Asíncrono, recuperable y con cola y worker | Cola `provisioning`, barrido cada 20 s, arriendo por ejecución | Probado (worker en marcha en `orchestrator.mjs`) |
| Idempotente, sin cobrar ni instalar dos veces | Una ejecución viva por orden (índice único); informes repetidos se ignoran; una solicitud de servidor por orden | Probado |
| Plazos, reintentos limitados y alertas | Plazo vencido → requiere intervención; 40 intentos de prueba → error; correo a los administradores | Probado |
| Auditable | Historial que solo se agrega con origen (plataforma, persona, servidor) y auditoría de acciones | Probado |
| Ninguna creación facturable sin aprobación | El orquestador solo pide el servidor; lo aprueba una persona en Infraestructura | Probado (se cuentan las llamadas al proveedor) |
| Compensación y sin recursos abandonados | Cancelar anula la solicitud pendiente; con servidor creado avisa o lo elimina escribiendo su nombre | Probado |
| Instalación completa (Docker, Compose, base, Redis, API, web, worker, proxy, HTTPS, dominio, variables, migraciones, administrador, respaldos, salud) | Agente real (`agente.sh`) + `instalar.sh` del paquete, con Docker y DNS sustituidos en las pruebas | **Probado sin servidor real**; en servidor real: pendiente de autorización |
| Versiones controladas y secretos fuera de imágenes y repositorios | Imágenes de la versión verificadas por SHA-256; secretos generados en el servidor; SMTP cifrado y borrado al entregar; cloud-init sin secretos duraderos | Probado |
| Pruebas desde afuera antes de entregar | DNS hacia la IP del servidor, API sana por HTTPS con certificado válido, panel publicado | Probado con respuestas sustituidas; en Internet real: pendiente |
| Servidor propio del cliente (§7B) | Paquete de entrega (ADR 044) con su instalador; sin agente automático | Pendiente |

## Fase G: WhatsApp, IA y automatizaciones en instalaciones nuevas (ADR 052)

| Criterio | Cómo se demuestra | Estado |
|---|---|---|
| WhatsApp e IA se configuran en cada instalación con credenciales propias de la empresa | El administrador lo hace en su panel (Integraciones); la lista de puesta en marcha se calcula con pruebas reales (credenciales de Meta verificadas, primer webhook) | Probado (fases anteriores); en una instalación real: pendiente |
| Nuestro panel sigue monitoreando la instalación (§16, paso 20) | `reporte.sh` cada 10 minutos con token de solo reporte; tarjeta «Puesta en marcha y monitoreo» | Probado con el agente real y `node dist/cli.js estado` de verdad (`orchestrator.mjs`) |
| Sin datos de clientes ni credenciales fuera del servidor | Esquema estricto: estados y conteos; campos de más → 400 | Probado |
| Alertas sin repetir | Sin reporte en 30 minutos o servicios con problemas → un correo; se rearma al volver a reportar sana | Probado |
| Revocable | Cancelar revoca el token; en el servidor basta borrar `monitor.env` | Probado |

## Fase H: escenario de aceptación (§16) y asistente (ADR 053)

`apps/web/e2e/acceptance.mjs` recorre el escenario en navegador para **dos empresas** con el mismo código y comprueba que no comparten instalación, servidor, empresa, tokens ni credenciales SMTP (el token de una instalación no sirve en la otra).

| Paso del escenario | Estado |
|---|---|
| 1-4. Visita la página, consulta al agente comercial, pide propuesta | Probado (IA del agente: servidor local con el formato del proveedor) |
| 5. Propuesta real con el catálogo y el contrato | Probado |
| 6-7. Acepta y se registra el pago (comprobante + validación en la cuenta) | Probado |
| 8. Orden de instalación | Probado |
| 9-10. API del proveedor y servidor | Probado contra el servidor local con los formatos de Hetzner; con Hetzner real: pendiente de autorización |
| 11. Se instala AI Sales Assistant | Probado con el agente real y Docker sustituido |
| 12, 15, 16. Empresa, catálogo y automatizaciones dentro del servidor | Pendiente en un servidor real (en la prueba, la carga de la empresa ocurre en el Docker sustituido) |
| 13-14. WhatsApp y Gemini | Pendiente: credenciales reales de Meta y de Gemini del cliente |
| 17. Pruebas reales desde afuera | Pendiente: dominio, DNS y HTTPS reales |
| 18. Paquete de entrega | Probado (el agente lo descarga y verifica su huella) |
| 19. Acceso al cliente | Pendiente: se envía al entregar (paso 17) |
| 20. El panel sigue monitoreando | Probado (primer reporte con `node dist/cli.js estado` real) |

## Fase I: postventa (ADR 054)

| Funcionalidad | Cómo se probó |
|---|---|
| La empresa abre un caso, el equipo recibe correo, otra empresa no lo ve (ni por API ni en la base con el rol de ejecución) | `support.e2e-spec.ts` y `support.mjs` (navegador) |
| Notas internas invisibles para la empresa; la primera respuesta se mide solo con respuestas reales | `support.e2e-spec.ts` (también consulta directa con RLS) y `support.mjs` |
| Esperando o resuelto: la respuesta del cliente lo reabre; la encuesta se responde una vez y cierra el caso; el historial no se puede reescribir | `support.e2e-spec.ts` y `support.mjs` |
| Casos registrados por el equipo a nombre de la empresa; instalación independiente con contacto en lugar de casos | `support.e2e-spec.ts` |
| Incidencia automática del monitoreo (una sola) y resolución automática al volver sana | `orchestrator.e2e-spec.ts` |
| Avisos de vencimiento una vez por periodo, próxima acción en el prospecto, panel de renovaciones | `support.e2e-spec.ts` y `support.mjs` (correo real en Mailpit) |
| Pendiente | El contacto de soporte de las instalaciones independientes lo define Rick (se pide al registrar la instalación). Sin SMTP real, los correos solo se comprobaron en Mailpit |

## Fase J: rentabilidad (ADR 055) y seguridad (§15)

| Funcionalidad | Cómo se probó |
|---|---|
| Sin precio o con un costo desconocido no hay margen y se lista lo que falta (incluido el tipo de cambio) | `profitability.spec.ts`, `finance.e2e-spec.ts`, `finance.mjs` |
| Servidor por horas con tope mensual; IA solo con claves de la plataforma; llamadas sin precio = costo desconocido | `profitability.spec.ts`, `finance.e2e-spec.ts` |
| Margen con costos en PEN, USD y EUR convertidos con los tipos definidos | `finance.e2e-spec.ts` (43.50) y `finance.mjs` (S/ 59.25, 49.4 %) |
| Presupuestos y alertas una vez por mes y nivel; presupuesto en otra moneda | `finance.e2e-spec.ts`, `finance.mjs` (correo real en Mailpit) |
| Costos y márgenes invisibles para las empresas (403 y rol de ejecución sin acceso en la base) | `finance.e2e-spec.ts` |

Controles de §15 y dónde se comprueban:

| Control | Implementación | Evidencia |
|---|---|---|
| Cifrado de secretos | AES-GCM con `DATA_ENCRYPTION_KEY` para credenciales de empresas, proveedores de IA e infraestructura y SMTP de instalaciones; solo se muestran los últimos caracteres | `crypto.spec.ts` (AES-256-GCM), `api-center`, `infra` y `orchestrator` e2e (nunca devuelven el secreto) |
| Permisos y accesos mínimos | Permisos por rol (`permissions.ts`); rol de ejecución con RLS por empresa; tablas de la plataforma sin acceso para ese rol | `tenant-isolation.e2e-spec.ts`; `support` y `finance` e2e con `roleClient('runtime')` |
| Auditoría | Registro de solo anexar de cada cambio sensible | `ai`, `api-center` y `automation-catalog` e2e revisan los registros; `support` e2e prueba que el historial no se reescribe |
| Tokens de corta duración | Acceso de 15 min (`JWT_ACCESS_TTL_SECONDS`), sesiones revocables; tokens de un solo uso para el arranque del servidor; token de monitoreo revocado al cancelar | `auth`, `orchestrator` e2e |
| Rotación de credenciales | Rotación de claves de IA, de proveedores de infraestructura y de secretos de webhooks desde los paneles | `api-center`, `infra` e `integrations` e2e |
| Restricciones de red | Solo Caddy publica 80/443; firewall del servidor con orígenes SSH permitidos (`sshSourceCidrs`) | `infra.e2e-spec.ts`, instalación real (fase 10) |
| Protección contra SSRF | `common/net/outbound.ts`: bloquea direcciones privadas, también tras resolver DNS | `outbound.spec.ts` |
| Validación de webhooks | Firma `X-Hub-Signature-256` de Meta; token Bearer del agente y del monitoreo | `whatsapp` y `orchestrator` e2e |
| Control de costos y límites de servidores | Presupuesto mensual y máximo de servidores por proveedor (`NO_BUDGET`, `OVER_BUDGET`, `MAX_SERVERS`); presupuestos y alertas por empresa | `infra.e2e-spec.ts`, `finance.e2e-spec.ts` |
| Confirmación de operaciones destructivas | Borrar un servidor o cancelar con liberación exige escribir su nombre (`CONFIRM_NAME`) y un motivo | `infra`, `orchestrator` e2e |
| Prevención de órdenes duplicadas | Una orden de pago abierta por cotización (`OPEN_PAYMENT_ORDER`), una orden de instalación por pago (índice único), una instalación por orden (`RUN_EXISTS`), un servidor por orden (`INSTALLATION_HAS_SERVER`), alta de empresa idempotente | `orchestrator` e `infra` e2e (`RUN_EXISTS`, `INSTALLATION_HAS_SERVER`); `provisioning.e2e-spec.ts` (alta idempotente, también en paralelo). `OPEN_PAYMENT_ORDER` está en el código, sin prueba automática dedicada |
| Registro de operaciones facturables | `infra_operations` (crear, borrar, con costo) y asientos contables de los cobros validados | `infra.e2e-spec.ts` (operaciones) y `quotes.e2e-spec.ts` (asiento al validar el pago) |
| La IA no crea servidores ni autoriza gastos | Las herramientas de los agentes son una lista cerrada sin infraestructura, pagos ni credenciales; crear servidores exige aprobación de una persona | `security-policy.spec.ts`, `infra.e2e-spec.ts` |

## Seguridad (fase 10)

- Dependencias de producción: `pnpm audit --prod` sin vulnerabilidades conocidas (2026-11-13). No se añadieron dependencias en las fases 8 y 9: el ZIP y el actualizador usan solo Node y herramientas del sistema.
- Secretos: ninguno en el repositorio (`.env` ignorado, búsqueda de patrones de claves sin resultados reales). Credenciales de cada empresa cifradas con `DATA_ENCRYPTION_KEY` y mostradas solo con sus últimos caracteres. El paquete de entrega se revisa contra los secretos del servidor antes de generarse.
- Exposición: en producción solo Caddy publica puertos (80/443); PostgreSQL y Redis quedan en la red interna; n8n y Chatwoot solo en 127.0.0.1. La API interna para n8n responde 404 desde internet. Comprobado en la instancia instalada (cabeceras HSTS, CSP, `X-Frame-Options`, `nosniff`).
- Límite de intentos de inicio de sesión (`rate-limit.e2e-spec.ts`), sesiones revocables, auditoría de solo anexar.

## Pendientes que dependen de Rick

Servidor, dominio y SMTP reales · claves reales de Claude, OpenAI, DeepSeek o Gemini (con plan de pago) · número y credenciales de Meta · precios en soles, texto de cobro y límites de los planes · proveedor de pagos (hoy el cobro es manual) · capacidad y horarios de cada empresa · autorización para retirar los restos de Dify y Evolution API del repositorio.
