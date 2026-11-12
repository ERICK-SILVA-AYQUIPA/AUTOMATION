# Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| **Licencia Dify**: prohíbe operar un entorno multiempresa sin autorización. | Resuelto | Dify ya no se usa: IA directa a Gemini (ADR 037). |
| **IA**: el modelo podría inventar un precio pese a las reglas, o Google cambiar el modelo por defecto. | Medio | Precios y stock solo por herramientas; pedidos siempre pendientes de confirmación humana; `GEMINI_MODEL` configurable; prueba en «Asistente IA» antes de activar. Plan de pago de Gemini para que Google no use los mensajes. |
| **Licencia n8n** (Sustainable Use): permitido como capa interna si los clientes no acceden a la UI ni editan flujos. | Medio | El módulo "Automatizaciones" del panel solo activa/desactiva y parametriza flujos predefinidos; nunca expone un editor. Casos dudosos → license@n8n.io. |
| **Licencia Evolution API**: Apache 2.0 + aviso visible de uso. | Bajo | Si se usa, mostrar aviso en Configuración > Integraciones y en la documentación. |
| **Evolution/Baileys** usa WhatsApp Web no oficial. | Alto | Bloqueo de números y violación de términos de Meta. Solo desarrollo/demos; producción con Cloud API. |
| Requisitos de Meta (verificación de negocio, plantillas para mensajes fuera de la ventana de 24 h, costes por conversación). | Medio | Documentar onboarding; gestionar plantillas aprobadas; medir uso por plan. |
| Webhook de Meta requiere HTTPS público. | Medio | Túnel HTTPS en desarrollo; reverse proxy con TLS en producción. |
| Alucinaciones de la IA sobre precios/stock. | Alto | Datos solo vía herramientas; validación de salida; test obligatorio nº 14. |
| *Prompt injection* desde mensajes de clientes. | Alto | Mensajes como datos no confiables; tenant y permisos fijados por el backend; acciones sensibles con confirmación. |
| Respuestas duplicadas (webhooks repetidos, bot + agente). | Medio | Eventos con clave única, outbox idempotente, pausa del bot sincronizada con Chatwoot. |
| Consumo de recursos en el Mac (Dify + Chatwoot). | Medio | Perfiles de compose; ≥16 GB RAM recomendado. |
| Límite de descargas anónimas de Docker Hub (HTTP 429). | Bajo | Iniciar sesión con `docker login`; reintentar. Observado en este entorno. |
| Coste del proveedor LLM. | Medio | Límites de conversaciones por plan, caché de catálogo, modelos económicos para clasificación. |
| Envío duplicado si el worker muere justo después de que Meta acepte un mensaje y antes de guardar el `wamid`. | Bajo | La ventana es de milisegundos; BullMQ reintenta el trabajo y el mensaje podría salir dos veces. Meta no ofrece clave de idempotencia en el envío. Se registra cada intento; se revisará con métricas en la FASE 8. |
| La cabecera `X-Forwarded-For` que llega a la web se reenvía tal cual a la API. | Medio | En producción el reverse proxy debe sobrescribirla (FASE 8). La API interna ya no pasa por la web (ADR 029). |
| Errores de Meta en inglés dentro de los avisos por correo. | Bajo | Se muestra el texto original junto al código; la tabla de códigos está en `docs/integrations/whatsapp-cloud-api.md`. |
| Chatwoot no reintenta los webhooks de buzones API: si la API está caída justo cuando un agente responde, esa respuesta no sale por WhatsApp. | Medio | El agente lo nota porque el mensaje queda sin doble check; la API debe tener alta disponibilidad (FASE 8). |
| Un Chatwoot recién instalado deja que cualquiera se haga super administrador en `/installation/onboarding`. | Alto | `setup-platform.sh` lo cierra; en producción además se bloquean `/super_admin` e `/installation` en el proxy. |
