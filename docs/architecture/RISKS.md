# Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| **Licencia Dify**: prohíbe operar un entorno *multi-tenant* (workspace = tenant) sin autorización escrita. | Alto (comercial) | Usar UN workspace operado por nosotros; las empresas nunca acceden a Dify; el aislamiento lo hace nuestro backend. **Confirmar por escrito con LangGenius antes del lanzamiento comercial.** Alternativa preparada: LLM directo con *tool calling* desde el worker (ADR 011). |
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
