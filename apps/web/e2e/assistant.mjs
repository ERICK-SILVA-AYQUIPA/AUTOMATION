/**
 * Asistente de IA (FASE 6) de punta a punta en navegador real: configurar el
 * asistente, probarlo desde el panel y ver cómo responde solo a un mensaje de
 * WhatsApp usando el precio real del catálogo, y cómo pasa a una persona.
 *
 * Sin claves reales de Meta ni de Google, el script levanta dos servidores
 * locales: uno que responde como la Graph API y otro que responde como la
 * Gemini API (generateContent con llamadas a herramientas). La API y el worker
 * deben arrancarse apuntando a ellos:
 *
 *   WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:4999 GEMINI_API_KEY=clave-local \
 *   GEMINI_BASE_URL=http://127.0.0.1:4998 AI_REPLY_DELAY_MS=300 node dist/main.js   (y dist/worker.js)
 *   WEB_URL=http://localhost:3000 MAILPIT_URL=http://localhost:8025 node e2e/assistant.mjs
 *
 * La prueba con Gemini real se hace desde «Asistente IA → Probar el asistente».
 */
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const GRAPH_PORT = Number(process.env.GRAPH_PORT ?? 4999);
const SHOTS = process.env.SHOTS_DIR ?? 'e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);
const email = `ia-${stamp}@example.com`;
const password = 'ClaveSegura123';
const PHONE_NUMBER_ID = `9${Date.now()}`.slice(0, 15);
const TOKEN = `EAAG-token-local-${stamp}-0123456789`;
const APP_SECRET = createHmac('sha256', stamp).update('secret').digest('hex').slice(0, 32);
const CUSTOMER = '51987000111';

// ------------------------------------------------------------------ Graph API local
const sent = [];
let seq = 0;
const graph = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } }));
    }
    const m = /^\/v\d+\.\d+\/(\d+)(\/messages)?$/.exec(req.url);
    if (req.method === 'GET' && m && !m[2]) return res.end(JSON.stringify({ id: m[1], display_phone_number: '+51 900 000 001', verified_name: 'Bodega Local', quality_rating: 'GREEN' }));
    if (req.method === 'POST' && m?.[2]) {
      const b = JSON.parse(body);
      sent.push(b);
      return res.end(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: b.to, wa_id: b.to }], messages: [{ id: `wamid.LOCAL${stamp}${++seq}` }] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: 'Unknown path', code: 100 } }));
  });
});
await new Promise((r) => graph.listen(GRAPH_PORT, '127.0.0.1', r));


// ------------------------------------------------------------------ Gemini API local
// Comportamiento fijo: si el cliente pide hablar con alguien deriva; si no, busca
// en el catálogo y responde con el precio que devuelve la herramienta.
const GEMINI_PORT = Number(process.env.GEMINI_PORT ?? 4998);
const geminiCalls = [];
const gemini = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-goog-api-key'] !== 'clave-local' || !/^\/v1beta\/models\/[\w.-]+:generateContent$/.test(req.url)) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { code: 401, message: 'API key not valid' } }));
    }
    const body = JSON.parse(raw);
    geminiCalls.push(body);
    const last = body.contents.at(-1);
    const fr = last.parts.find((p) => p.functionResponse)?.functionResponse;
    const reply = (parts) => res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 } }));
    if (fr?.name === 'buscar_productos') {
      const r = fr.response.result.resultados?.[0];
      return reply([{ text: r ? `¡Hola! ${r.producto} cuesta S/ ${r.variantes[0].precio}. ¿Cuántas deseas?` : 'No encontré ese producto.' }]);
    }
    if (fr?.name === 'derivar_a_humano') return reply([{ text: 'Te paso con una persona del equipo.' }]);
    const text = last.parts.map((p) => p.text ?? '').join(' ').toLowerCase();
    if (/reclamo|queja/.test(text)) return reply([{ functionCall: { name: 'derivar_a_humano', args: { motivo: 'reclamo del cliente' } }, thoughtSignature: 'sig-local' }]);
    return reply([{ functionCall: { name: 'buscar_productos', args: { consulta: 'gaseosa' } }, thoughtSignature: 'sig-local' }]);
  });
});
await new Promise((r) => gemini.listen(GEMINI_PORT, '127.0.0.1', r));

// ------------------------------------------------------------------ utilidades
const results = [];
let page;
const consoleErrors = [];
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message.split('\n')[0] });
    await page?.screenshot({ path: `${SHOTS}/asistente-fallo.png` }).catch(() => undefined);
    if (consoleErrors.length) console.log(`  Consola: ${consoleErrors.slice(0, 3).join(' | ').slice(0, 800)}`);
    console.log(`✗ ${name}\n  ${e.message.split('\n').slice(0, 3).join('\n  ')}`);
    throw e;
  }
};
async function linkFor(to, path) {
  for (let i = 0; i < 20; i++) {
    if (process.env.MAILPIT_URL) {
      const r = await fetch(`${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`).then((x) => x.json());
      const id = r.messages?.[0]?.ID;
      if (id) {
        const msg = await fetch(`${process.env.MAILPIT_URL}/api/v1/message/${id}`).then((x) => x.json());
        const link = new RegExp(`https?://\\S+${path}\\?token=[^\\s"<]+`).exec(msg.Text)?.[0];
        if (link) return link;
      }
    } else {
      const log = readFileSync(process.env.API_LOG, 'utf8');
      const idx = log.lastIndexOf(to);
      const link = idx >= 0 ? new RegExp(`https?://\\S+?${path}\\?token=[A-Za-z0-9%_-]+`).exec(log.slice(idx))?.[0] : null;
      if (link) return link;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No se encontró el enlace ${path} para ${to}`);
}
const envelope = (value) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '51900000001', phone_number_id: PHONE_NUMBER_ID }, ...value } }] }] });
async function postWebhook(url, payload, secret = APP_SECRET) {
  const raw = JSON.stringify(payload);
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` }, body: raw });
  return r.status;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'es-PE', timezoneId: 'America/Lima' });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB });
page = await ctx.newPage();
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message));
const label = (l) => page.getByLabel(l, { exact: true });
let webhookUrl = '';
const inbound = (id, text) =>
  postWebhook(webhookUrl, envelope({ contacts: [{ profile: { name: 'Carla Cliente' }, wa_id: CUSTOMER }], messages: [{ from: CUSTOMER, id: `wamid.${id}${stamp}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] }));

try {
  await step('Registro, verificación y número de WhatsApp conectado', async () => {
    await page.goto(`${WEB}/registro`);
    await label('Nombre del negocio').fill(`Bodega IA ${stamp}`);
    await label('Tu nombre').fill('Rosa Prueba');
    await label('Correo').fill(email);
    await label('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Crear cuenta' }).click();
    await page.getByText(/revisa tu correo/i).waitFor({ timeout: 10_000 });
    await page.goto((await linkFor(email, 'verificar-correo')).replace(/^https?:\/\/[^/]+/, WEB));
    await page.getByText(/verificado/i).first().waitFor({ timeout: 10_000 });
    await page.goto(`${WEB}/login?next=/integraciones`);
    await label('Correo').fill(email);
    await label('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL(/\/integraciones$/);
    await page.getByRole('button', { name: 'Conectar número' }).first().click();
    await label('Phone number ID').fill(PHONE_NUMBER_ID);
    await label('App Secret').fill(APP_SECRET);
    await label('Token de acceso').fill(TOKEN);
    await page.getByRole('button', { name: 'Verificar y guardar' }).click();
    await page.getByRole('heading', { name: 'Configurar el webhook en Meta' }).waitFor();
    webhookUrl = await page.getByRole('textbox', { name: 'URL de devolución de llamada (Callback URL)' }).inputValue();
    await page.getByRole('button', { name: 'Listo' }).click();
  });

  await step('Producto en el catálogo: Gaseosa Cola 500 ml a S/ 3.50', async () => {
    await page.goto(`${WEB}/productos/nuevo`);
    await label('Nombre').fill('Gaseosa Cola 500 ml');
    await label('SKU (código interno)').fill('GAS-500');
    await label('Precio de venta').fill('3.50');
    await page.getByLabel('Stock inicial (opcional)').fill('20');
    await page.getByRole('button', { name: 'Crear producto' }).click();
    await page.waitForURL(/\/productos\/[0-9a-f-]{36}$/);
  });

  await step('Asistente IA: los cambios quedan en borrador y sin probar no se publican', async () => {
    await page.getByRole('link', { name: 'Asistente IA' }).click();
    await page.getByText('Activo', { exact: true }).waitFor();
    await page.getByText(/^Todo publicado/).waitFor();
    await label('Nombre del asistente').fill('Lula');
    await page.getByRole('tab', { name: 'Ventas y políticas' }).click();
    await label('Medios de pago').fill('Yape, transferencia');
    await label('Información general').fill('Delivery en Lima de 9 a 18 h.');
    await page.getByRole('tab', { name: 'Preguntas frecuentes' }).click();
    await page.getByRole('button', { name: 'Agregar pregunta' }).click();
    await label('Pregunta 1').fill('¿Hacen factura?');
    await label('Respuesta').fill('Sí, con tu RUC.');
    await page.getByRole('button', { name: 'Guardar borrador' }).click();
    await page.getByText('Borrador guardado. Pruébalo y publícalo cuando esté listo.').waitFor();
    await page.getByText('Tienes cambios sin publicar').waitFor();
    if (!(await page.getByRole('button', { name: 'Publicar', exact: true }).isDisabled())) throw new Error('Se podía publicar sin probar');
  });

  await step('Probar el borrador desde el panel (precio real, nada enviado) y publicarlo', async () => {
    const before = sent.length;
    await page.getByRole('radio', { name: 'Borrador' }).click();
    await page.getByLabel('Mensaje de prueba').fill('precio de la gaseosa');
    await page.getByRole('button', { name: 'Enviar' }).click();
    await page.getByText('¡Hola! Gaseosa Cola 500 ml cuesta S/ 3.50. ¿Cuántas deseas?').waitFor();
    await page.getByText('consultó el catálogo').waitFor();
    const sys = geminiCalls.at(-1).systemInstruction.parts[0].text;
    if (!sys.includes('Eres Lula') || !sys.includes('Yape, transferencia') || !sys.includes('¿Hacen factura?')) throw new Error('La prueba no usó el borrador');
    if (sent.length !== before) throw new Error('La prueba envió un mensaje por WhatsApp');
    await page.getByText('Borrador probado: ya puedes publicarlo.').waitFor();
    await page.screenshot({ path: `${SHOTS}/asistente-panel.png` });
    await page.getByRole('button', { name: 'Publicar', exact: true }).click();
    await page.getByText('Publicado: el asistente ya usa esta configuración con tus clientes').waitFor();
    await page.getByText(/^Todo publicado/).waitFor();
  });

  await step('Documento del asistente: se agrega como borrador y se publica tras probarlo', async () => {
    await page.getByRole('button', { name: 'Nuevo documento' }).click();
    await label('Título').fill('Zonas de reparto');
    await label('Contenido').fill('Repartimos en Miraflores, Surco y San Isidro.');
    await page.getByRole('button', { name: 'Guardar documento' }).click();
    await page.getByText('Nuevo, sin publicar').waitFor();
    await page.getByText('Tienes cambios sin publicar').waitFor();
    await page.getByRole('radio', { name: 'Borrador' }).click();
    await page.getByLabel('Mensaje de prueba').fill('precio de la gaseosa');
    await page.getByRole('button', { name: 'Enviar' }).click();
    await page.getByText('Borrador probado: ya puedes publicarlo.').waitFor();
    if (!geminiCalls.at(-1).systemInstruction.parts[0].text.includes('### Zonas de reparto')) throw new Error('La prueba no incluyó el documento');
    await page.getByRole('button', { name: 'Publicar', exact: true }).click();
    await page.locator('li').filter({ hasText: 'Zonas de reparto' }).getByText('Publicado', { exact: true }).waitFor();
    await page.screenshot({ path: `${SHOTS}/asistente-documentos.png`, fullPage: true });
  });

  await step('Mensaje real por WhatsApp: el asistente responde solo con el precio del catálogo', async () => {
    if ((await inbound('IN1', 'hola, ¿cuánto está la gaseosa?')) !== 200) throw new Error('Webhook rechazado');
    for (let i = 0; i < 60 && !sent.some((s) => s.text?.body?.includes('S/ 3.50')); i++) await new Promise((r) => setTimeout(r, 250));
    const out = sent.find((s) => s.text?.body?.includes('S/ 3.50'));
    if (!out || out.to !== CUSTOMER) throw new Error(`No se envió la respuesta: ${JSON.stringify(sent)}`);
    await page.getByRole('link', { name: 'Conversaciones' }).click();
    await page.getByRole('button', { name: /Carla Cliente/ }).click({ timeout: 15_000 });
    await page.locator('section').getByText('¡Hola! Gaseosa Cola 500 ml cuesta S/ 3.50. ¿Cuántas deseas?').waitFor();
    await page.screenshot({ path: `${SHOTS}/asistente-whatsapp.png` });
  });

  await step('Un reclamo pasa la conversación a una persona y el asistente deja de responder', async () => {
    await inbound('IN2', 'tengo un reclamo con mi pedido');
    await page.locator('section').getByText(/Te comunico con una persona de nuestro equipo/).waitFor({ timeout: 20_000 });
    await page.locator('section').getByText('Atención humana').first().waitFor({ timeout: 10_000 });
    const calls = geminiCalls.length;
    const outs = sent.length;
    await inbound('IN3', '¿hola?');
    await page.locator('section').getByText('¿hola?').waitFor({ timeout: 15_000 });
    await new Promise((r) => setTimeout(r, 2500));
    if (geminiCalls.length !== calls || sent.length !== outs) throw new Error('El asistente respondió con la conversación en atención humana');
    await page.screenshot({ path: `${SHOTS}/asistente-derivado.png` });
  });

  await step('Aviso en la campana: lleva a la conversación derivada y queda leído', async () => {
    await page.reload();
    const bell = page.getByRole('button', { name: /^Avisos sin leer: [1-9]/ });
    await bell.waitFor({ timeout: 35_000 });
    await bell.click();
    await page.getByRole('dialog', { name: 'Avisos' }).getByRole('button', { name: /Carla Cliente necesita atención/ }).click();
    await page.waitForURL(/\/conversaciones\?id=[0-9a-f-]{36}$/);
    await page.getByText('IA en pausa: palabra clave: reclamo', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Avisos sin leer: 0' }).waitFor({ timeout: 10_000 });
  });

  await step('Nota interna, etiqueta y filtro de la bandeja', async () => {
    await page.getByText(/Notas internas \(0\)/).click();
    await page.getByLabel('Nueva nota interna').fill('Cliente frecuente: ofrecer delivery gratis');
    await page.getByRole('button', { name: 'Guardar', exact: true }).click();
    await page.getByText('Cliente frecuente: ofrecer delivery gratis').waitFor();
    await page.getByText('Rosa Prueba ·', { exact: false }).first().waitFor();
    await page.getByLabel('Nueva etiqueta').fill('Reclamo');
    await page.getByLabel('Nueva etiqueta').press('Enter');
    await page.getByRole('button', { name: 'Quitar etiqueta reclamo' }).waitFor();
    await page.getByLabel('Filtrar bandeja').selectOption('human');
    await page.getByRole('button', { name: /Carla Cliente/ }).waitFor();
    await page.getByLabel('Filtrar por etiqueta').fill('otra');
    await page.getByText('Sin conversaciones').waitFor();
    await page.getByLabel('Filtrar por etiqueta').fill('reclamo');
    await page.getByRole('button', { name: /Carla Cliente/ }).waitFor();
    await page.screenshot({ path: `${SHOTS}/bandeja-controles.png` });
  });

  await step('Reactivar la IA: vuelve a responder; luego se cierra la conversación', async () => {
    await page.getByRole('button', { name: 'Reactivar IA' }).click();
    await page.getByText('La IA vuelve a responder esta conversación').waitFor();
    await page.getByRole('button', { name: 'Pausar IA' }).waitFor();
    const outs = sent.length;
    await inbound('IN4', 'y la gaseosa, ¿cuánto cuesta?');
    for (let i = 0; i < 60 && sent.length === outs; i++) await new Promise((r) => setTimeout(r, 250));
    if (!sent.slice(outs).some((s) => s.text?.body?.includes('S/ 3.50'))) throw new Error('La IA no respondió tras reactivarla');
    await page.getByRole('button', { name: 'Cerrar conversación' }).click();
    await page.getByText('Conversación cerrada').waitFor();
    await page.getByRole('button', { name: 'Reabrir' }).waitFor();
  });

  await step('Configuración: perfil de la empresa con RUC', async () => {
    await page.goto(`${WEB}/configuracion`);
    await label('Razón social').fill('Bodega IA S.A.C.');
    await label('RUC').fill('20123456789');
    await label('Teléfono').fill('+51 900 000 001');
    await label('Tipo de negocio').selectOption('RETAIL');
    await page.getByRole('button', { name: 'Guardar', exact: true }).first().click();
    await page.getByText('Datos de la empresa guardados').waitFor();
    await page.reload();
    if ((await label('RUC').inputValue()) !== '20123456789') throw new Error('No se guardó el RUC');
  });

  if (process.env.PLATFORM_ADMIN_EMAIL) {
    await step('Plataforma: apagar el módulo Pedidos lo quita del menú de la empresa', async () => {
      const admin = await (await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'es-PE' })).newPage();
      admin.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message));
      await admin.goto(`${WEB}/login`);
      await admin.getByLabel('Correo', { exact: true }).fill(process.env.PLATFORM_ADMIN_EMAIL);
      await admin.getByLabel('Contraseña', { exact: true }).fill(process.env.PLATFORM_ADMIN_PASSWORD);
      await admin.getByRole('button', { name: 'Entrar' }).click();
      await admin.waitForURL(/\/plataforma$/);
      await admin.getByText('Por renovar').waitFor();
      await admin.getByText(/^IA \(/).waitFor();
      await admin.getByLabel('Buscar empresa').fill(`Bodega IA ${stamp}`);
      await admin.getByRole('button', { name: `Ver Bodega IA ${stamp}` }).click();
      const dlg = admin.getByRole('dialog');
      await dlg.getByText('Bodega IA S.A.C.').or(dlg.getByLabel('Razón social')).first().waitFor();
      await dlg.getByText('Rosa Prueba').waitFor();
      await dlg.getByLabel('Pedidos').uncheck();
      await dlg.getByRole('button', { name: 'Guardar cambios' }).click();
      await admin.getByText('Empresa actualizada').waitFor();
      await admin.screenshot({ path: `${SHOTS}/plataforma-ficha.png` });
      await admin.keyboard.press('Escape');
      await admin.getByRole('tab', { name: 'Planes y precios' }).click();
      await admin.getByText('Los precios iniciales').waitFor();
      await admin.screenshot({ path: `${SHOTS}/plataforma-planes.png`, fullPage: true });

      await page.reload();
      await page.getByRole('navigation', { name: 'Menú principal' }).getByRole('link', { name: 'Productos', exact: true }).first().waitFor();
      if (await page.getByRole('navigation', { name: 'Menú principal' }).getByRole('link', { name: 'Pedidos', exact: true }).count()) throw new Error('Pedidos sigue en el menú');
      await admin.close();
    });
  }

  if (consoleErrors.length) throw new Error(`Errores en la consola: ${consoleErrors.join(' | ').slice(0, 500)}`);
} finally {
  await browser.close();
  graph.close();
  gemini.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} pasos correctos`);
  process.exitCode = results.every((r) => r.ok) && !consoleErrors.length ? 0 : 1;
}
