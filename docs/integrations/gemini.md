# Asistente de IA con Gemini

El asistente responde por WhatsApp usando la Gemini API de Google (ADR 037).
Sin clave, todo lo demás funciona y los mensajes los atiende tu equipo.

## Configurar

1. Crea una clave en [Google AI Studio](https://aistudio.google.com/apikey) y
   **activa la facturación** del proyecto: en el plan gratuito Google puede usar
   los mensajes de tus clientes para mejorar sus productos, y los límites son bajos.
2. En el servidor, en `.env.production`:
   ```
   GEMINI_API_KEY=<tu clave>          # nunca en el código ni en el chat
   GEMINI_MODEL=gemini-3.8-flash      # o gemini-3.5-flash-lite (más barato)
   ```
3. `./infrastructure/scripts/deploy.sh` (reinicia API y worker).
4. Entra como administrador de una empresa → **Asistente IA**. Debe decir
   «Activo». Escribe la información del negocio y usa **Probar el asistente**:
   esa prueba llama a Gemini de verdad con tu catálogo, sin enviar nada por WhatsApp.

Modelos disponibles: https://ai.google.dev/gemini-api/docs/models

## Qué hace y qué no

- Consulta precios y stock solo con la herramienta del catálogo.
- Registra pedidos **pendientes**; el stock se descuenta cuando tu equipo los confirma.
- Pasa la conversación a una persona si el cliente lo pide, usa una palabra de
  derivación, tiene un reclamo o Gemini falla. Mientras haya atención humana no responde.
- No responde si la suscripción venció o se superó el límite de conversaciones del plan.
- Consumo: contadores `ai_replies` y `ai_tokens` por mes en `usage_counters`.

## Pruebas

- Integración (Gemini simulado): `pnpm --filter @aisa/api test:e2e` (`test/ai.e2e-spec.ts`).
- Navegador: `apps/web/e2e/assistant.mjs` (instrucciones en su cabecera).
