# Proveedores de IA: Claude, Gemini, OpenAI y DeepSeek (Centro de APIs)

Desde la versión con el Centro de APIs (ADR 046) el proveedor de IA de cada
empresa se elige **desde los paneles**, sin tocar archivos del servidor.

- **Plataforma** (`/plataforma` → «Centro de APIs»): credenciales administradas
  (las paga la plataforma), catálogo de modelos con precios y asignación por empresa.
- **Empresa** (`/integraciones` → «Inteligencia artificial»): ver qué IA usa,
  probarla, conectar su propia clave (el consumo se factura en su cuenta del
  proveedor) y ver su consumo del mes.

Las claves **nunca** se pegan en el chat, en el código ni en archivos: se escriben
una sola vez en el formulario, se prueban con el proveedor, se guardan cifradas y
después solo se ven sus últimos 4 caracteres.

## Conectar una credencial

1. Crea la clave en la consola del proveedor:
   - **Anthropic Claude**: Claude Console → API keys (empieza por `sk-ant-`).
   - **OpenAI**: platform.openai.com → API keys. Organization ID y Project ID son opcionales.
   - **DeepSeek**: platform.deepseek.com → API keys.
   - **Google Gemini**: Google AI Studio → API keys. Activa la facturación: en el plan
     gratuito Google puede usar los datos para mejorar sus productos.
2. «Agregar proveedor» (plataforma) o «Conectar clave» (empresa) → elige el
   proveedor → pega la clave → **Probar y guardar**. Se hace una petición real
   (lista de modelos). Si el proveedor no la acepta, se muestra el motivo
   («Error de autenticación», «Sin permisos», «Servicio no disponible») y **no se guarda**.
3. Plataforma: «Leer modelos» trae la lista real del proveedor. Pon el precio por
   millón de tokens desde la página oficial de precios del proveedor; sin precio
   el consumo se registra igual pero sin costo (el panel lo indica).
4. Asigna la credencial y el modelo a la empresa («Asignar IA») o, como empresa,
   «Usar en el asistente».
5. **Probar** / **Probar IA**: petición real y muy corta al modelo asignado (unos pocos tokens).

## Reglas

- Una empresa no puede usar la clave propia de otra (lo impide la base de datos).
- Nunca se cambia de proveedor solo: el respaldo es otra credencial del mismo
  proveedor; uno de otro proveedor exige marcar la autorización en la asignación.
- Desconectar una credencial deja sin IA a las empresas que la usan (se les avisa
  y sus conversaciones pasan a su equipo) hasta que se les asigne otra.
- Topes mensuales de tokens por asignación y por credencial administrada: al
  alcanzarlos el asistente deriva a una persona.
- Sin asignación, el asistente usa `GEMINI_API_KEY` del servidor si existe (como en 0.9.0).

## Proveedores sin adaptador

Hetzner, DigitalOcean, AWS, pagos, almacenamiento y DNS aparecen en el catálogo
como «sin adaptador»: no basta con pegar una clave, cada servicio necesita su
adaptador probado.

## Pruebas sin claves reales

`apps/api/test/fake-ai-providers.ts` responde con el formato documentado de cada
proveedor. Solo en desarrollo/pruebas se puede apuntar la API a él con
`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `DEEPSEEK_BASE_URL` y `GEMINI_BASE_URL`
(producción rechaza cambiarlas). Eso demuestra el código, **no** la conexión real:
la conexión real se confirma con «Probar» y una clave verdadera.
