# Evolution API (opcional)

Imagen oficial `evoapicloud/evolution-api` (`EVOLUTION_VERSION`). Se activa
añadiendo `evolution` a `COMPOSE_PROFILES`. Autenticación por cabecera `apikey`
(`EVOLUTION_API_KEY`); sin ella responde 401.

Diferencias frente a WhatsApp Cloud API oficial:
- Conexión **Baileys** (escaneo de QR, WhatsApp Web): no oficial, riesgo de
  bloqueo del número e incumplimiento de términos de Meta. Solo desarrollo/demos.
- Canal `WHATSAPP-BUSINESS` de Evolution: usa la Cloud API de Meta por debajo;
  añade una capa intermedia sin ventajas para nuestra arquitectura.
- Licencia: exige aviso visible de uso (ver `LICENSES.md`).

`CORS_ORIGIN="*"` es intencional (ver ADR 008).
