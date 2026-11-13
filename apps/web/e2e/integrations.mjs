/**
 * Centro de integraciones (evolución, fase 6) en navegador real: estado de
 * cada servicio con su última prueba, prueba de correo que llega a Mailpit,
 * clave propia de Gemini validada antes de guardarse, webhooks firmados que
 * el worker entrega a un receptor que verifica la firma, historial de
 * entregas, y la pestaña de integraciones del panel general.
 *
 * Sin claves reales de Google, el script levanta un servidor local que
 * responde como la Gemini API (models.get y generateContent) y otro que hace
 * de sistema del cliente (recibe los webhooks y comprueba el HMAC). La API y
 * el worker deben arrancarse apuntando a ellos y con la red privada permitida
 * para webhooks (solo desarrollo):
 *
 *   GEMINI_API_KEY=clave-local GEMINI_BASE_URL=http://127.0.0.1:4998 \
 *   WEBHOOKS_ALLOW_PRIVATE_NETWORK=true node dist/main.js   (y dist/worker.js)
 *   MAILPIT_URL=http://localhost:8025 PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... node e2e/integrations.mjs
 */
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const SHOTS = process.env.SHOTS_DIR ?? 'e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);
const company = `Bodega Integra ${stamp}`;
const email = `int-${stamp}@example.com`;
const password = 'ClaveSegura123';
const OWN_KEY = `AIzaClavePropiaLocal_${stamp}_0001`;

// ------------------------------------------------------------------ Gemini local
const PLATFORM_KEY = 'clave-local';
const geminiKeys = [];
const gemini = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    const key = req.headers['x-goog-api-key'];
    geminiKeys.push({ method: req.method, key });
    if (key !== PLATFORM_KEY && key !== OWN_KEY) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }));
    }
    // Lista de modelos (Centro de APIs) y models.get (clave del servidor)
    if (req.method === 'GET' && req.url.startsWith('/v1beta/models?')) return res.end(JSON.stringify({ models: [{ name: 'models/gemini-3.8-flash', displayName: 'Gemini local', supportedGenerationMethods: ['generateContent'] }] }));
    if (req.method === 'GET') return res.end(JSON.stringify({ name: req.url.replace('/v1beta/', '') }));
    res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '¡Hola! ¿En qué te ayudo?' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } }));
  });
});
await new Promise((r) => gemini.listen(Number(process.env.GEMINI_PORT ?? 4998), '127.0.0.1', r));

// ------------------------------------------------------------------ Sistema del cliente
let secret = '';
let receiverStatus = 200;
const received = [];
const receiver = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const [t, v1] = String(req.headers['x-aisa-signature'] ?? '').split(',').map((x) => x.split('=')[1]);
    const valid = !!secret && createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex') === v1 && Math.abs(Date.now() / 1000 - Number(t)) < 300;
    received.push({ event: req.headers['x-aisa-event'], valid, body: JSON.parse(raw) });
    res.statusCode = valid ? receiverStatus : 401;
    res.end(valid ? 'ok' : 'firma no válida');
  });
});
await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
const RECEIVER_URL = `http://127.0.0.1:${receiver.address().port}/aisa/webhook`;

const results = [];
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    await page.screenshot({ path: `${SHOTS}/integraciones-fallo.png` }).catch(() => undefined);
    console.log(`✗ ${name}\n  ${e.message.split('\n').slice(0, 3).join('\n  ')}`);
    throw e;
  }
};
async function mailTo(to, query, pattern) {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to} ${query}`)}`).then((x) => x.json());
    const id = r.messages?.[0]?.ID;
    if (id) {
      const msg = await fetch(`${MAILPIT}/api/v1/message/${id}`).then((x) => x.json());
      if (!pattern) return msg.Text;
      const m = pattern.exec(msg.Text)?.[0];
      if (m) return m;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No llegó el correo «${query}» a ${to}`);
}
const until = async (fn, what, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) if (await fn()) return;
  throw new Error(`Tiempo agotado: ${what}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'es-PE', timezoneId: 'America/Lima' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const label = (l, p = page) => p.getByLabel(l, { exact: true });
const card = (name) => page.locator('div.rounded-xl').filter({ has: page.getByRole('heading', { name, exact: true }) }).last();
let token = '';
const apiCall = async (path, body) => {
  const r = await fetch(`${WEB}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};

try {
  await step('Registro, verificación e inicio de sesión', async () => {
    await page.goto(`${WEB}/registro`);
    await label('Nombre del negocio').fill(company);
    await label('Tu nombre').fill('Ana Integra');
    await label('Correo').fill(email);
    await label('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Crear cuenta' }).click();
    await page.getByText(/revisa tu correo|te enviamos/i).first().waitFor({ timeout: 10_000 });
    const link = await mailTo(email, '', /https?:\/\/\S+verificar-correo\?token=[^\s"<]+/);
    await page.goto(link.replace(/^https?:\/\/[^/]+/, WEB));
    await page.getByText(/verificado|confirmado/i).first().waitFor({ timeout: 10_000 });
    await page.goto(`${WEB}/login`);
    await label('Correo').fill(email);
    await label('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL(/\/inicio$/);
    token = (await fetch(`${WEB}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }).then((r) => r.json())).accessToken;
  });

  await step('Integraciones muestra el estado real de cada servicio', async () => {
    await page.getByRole('link', { name: 'Integraciones' }).click();
    await page.waitForURL(/\/integraciones$/);
    for (const n of ['WhatsApp Business (Cloud API)', 'Inteligencia artificial (asistente)', 'Correo saliente', 'Automatizaciones (n8n)', 'Chatwoot (bandeja de agentes)', 'Webhooks salientes', 'Pagos']) {
      await page.getByRole('heading', { name: n, exact: true }).waitFor();
    }
    await card('WhatsApp Business (Cloud API)').getByText('Sin configurar', { exact: true }).waitFor();
    await card('Inteligencia artificial (asistente)').getByText(/Google Gemini \(clave del servidor\)/).waitFor();
    await card('Pagos').getByText(/No hay cobros automáticos/).waitFor();
  });

  await step('«Probar» el correo envía un correo real (Mailpit) y queda registrado', async () => {
    await card('Correo saliente').getByRole('button', { name: 'Probar Correo saliente' }).click();
    await page.getByText(`Enviado a ${email}`).first().waitFor();
    await mailTo(email, 'subject:"Correo de prueba"');
    await card('Correo saliente').getByText(/Última prueba .*correcta/).waitFor();
  });

  await step('Clave propia de Gemini (Centro de APIs): una clave rechazada no se guarda; una válida se guarda y solo se ve el final', async () => {
    const ai = page.locator('div.rounded-xl').filter({ hasText: 'Proveedor del asistente' }).last();
    await ai.getByRole('button', { name: 'Conectar clave' }).click();
    const dlg = page.getByRole('dialog');
    await label('Proveedor', dlg).selectOption('gemini');
    await label('API Key', dlg).fill('AIzaClaveQueGoogleRechaza_000000');
    await dlg.getByRole('button', { name: 'Probar y guardar' }).click();
    await dlg.getByText(/no aceptó la credencial \(Error de autenticación\): Gemini 400: API key not valid/).waitFor();
    await label('API Key', dlg).fill(OWN_KEY);
    await dlg.getByRole('button', { name: 'Probar y guardar' }).click();
    await page.getByText(/Google Gemini aceptó la credencial \(…0001\)/).waitFor();
    await ai.getByText('…0001', { exact: true }).waitFor();
    if (await page.getByText(OWN_KEY).count()) throw new Error('La clave completa aparece en pantalla');
    if (!geminiKeys.some((k) => k.method === 'GET' && k.key === OWN_KEY)) throw new Error('La clave no se validó con Gemini');
    await ai.getByRole('button', { name: 'Usar en el asistente' }).click();
    await label('Modelo', page.getByRole('dialog')).selectOption('gemini-3.8-flash');
    await page.getByRole('dialog').getByRole('button', { name: 'Guardar' }).click();
    await ai.getByText('Google Gemini (clave propia) · gemini-3.8-flash').waitFor();
    await ai.getByRole('button', { name: 'Probar IA' }).click();
    await page.getByText(/Google Gemini \(clave propia\) · gemini-3.8-flash: respondió/).first().waitFor();
    if (!geminiKeys.some((k) => k.method === 'POST' && k.key === OWN_KEY)) throw new Error('La prueba no usó la clave propia');
    await card('Inteligencia artificial (asistente)').getByText('Conectado', { exact: true }).waitFor();
  });

  await step('Webhook nuevo: el secreto se muestra una vez y el ping llega firmado', async () => {
    await page.getByRole('button', { name: 'Añadir webhook' }).click();
    await label('URL de tu sistema').fill('ftp://erp.local/x');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await page.getByText('La URL debe empezar por https://').first().waitFor();
    await label('URL de tu sistema').fill(RECEIVER_URL);
    await label('Descripción (opcional)').fill('ERP de almacén');
    await page.getByRole('button', { name: 'Guardar' }).click();
    secret = await page.getByLabel('Secreto de firma').inputValue();
    if (!/^whsec_/.test(secret)) throw new Error('No se mostró el secreto');
    await page.screenshot({ path: `${SHOTS}/integraciones-secreto.png` });
    await page.getByRole('button', { name: 'Ya lo guardé' }).click();
    await page.getByText(`Secreto …${secret.slice(-4)}`, { exact: false }).waitFor();
    if (await page.getByText(secret).count()) throw new Error('El secreto sigue en pantalla');
    await page.getByRole('button', { name: 'Probar', exact: true }).click();
    await page.getByText('Tu sistema respondió 200').waitFor();
    const ping = received.at(-1);
    if (ping?.event !== 'ping' || !ping.valid) throw new Error('El ping no llegó con firma válida');
  });

  await step('Un pedido llega al sistema del cliente por el worker, firmado, y se ve en el historial', async () => {
    const p = await apiCall('/products', { sku: `INT-${stamp}`, name: 'Arroz Integra 5 kg', salePrice: '25.00', initialStock: 10 });
    const o = await apiCall('/orders', { customer: { phone: '51911100555' }, items: [{ variantId: p.variants[0].id, quantity: 2 }] });
    await until(() => received.some((r) => r.event === 'order.created' && r.body.data.orderId === o.id), 'el worker no entregó order.created');
    const r = received.find((x) => x.event === 'order.created');
    if (!r.valid || r.body.data.items[0].sku !== `INT-${stamp}`) throw new Error('Entrega sin firma válida o con datos erróneos');
    await page.getByRole('button', { name: 'Entregas' }).click();
    const row = page.getByRole('row').filter({ hasText: 'order.created' }).first();
    await row.getByText('Entregado').waitFor();
    await page.screenshot({ path: `${SHOTS}/integraciones-entregas.png` });
    await page.getByRole('button', { name: 'Cerrar', exact: true }).last().click();
  });

  await step('Si el sistema del cliente falla se ve el error y queda en el historial de pruebas', async () => {
    receiverStatus = 500;
    await page.getByRole('button', { name: 'Probar', exact: true }).click();
    await page.getByText(/Respondió 500/).first().waitFor();
    await page.getByText('Último envío con error').waitFor();
    await card('Webhooks salientes').getByRole('button', { name: 'Probar Webhooks salientes' }).click();
    await card('Webhooks salientes').getByText('Con errores', { exact: true }).waitFor();
    await page.getByText(/Errores recientes en las pruebas/).click();
    await page.getByText(/webhooks · 1 de 1 URL\(s\) no respondieron 2xx/).waitFor();
    receiverStatus = 200;
    await page.screenshot({ path: `${SHOTS}/integraciones-resumen.png`, fullPage: true });
  });

  await step('Panel general: pestaña Integraciones con prueba real de servicios del servidor', async () => {
    const adminCtx = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'es-PE', timezoneId: 'America/Lima' });
    const admin = await adminCtx.newPage();
    admin.on('pageerror', (e) => errors.push(e.message));
    await admin.goto(`${WEB}/login`);
    await label('Correo', admin).fill(process.env.PLATFORM_ADMIN_EMAIL);
    await label('Contraseña', admin).fill(process.env.PLATFORM_ADMIN_PASSWORD);
    await admin.getByRole('button', { name: 'Entrar' }).click();
    await admin.waitForURL(/\/plataforma$/);
    await admin.getByRole('tab', { name: 'Integraciones' }).click();
    const pcard = (n) => admin.locator('div.rounded-xl').filter({ has: admin.getByRole('heading', { name: n, exact: true }) }).last();
    for (const [n, re] of [['Base de datos (PostgreSQL)', /Responde/], ['Gemini (IA)', /Clave válida/]]) {
      await pcard(n).getByRole('button', { name: `Probar ${n}` }).click();
      await pcard(n).getByText('Funciona', { exact: true }).waitFor();
      await pcard(n).getByText(re).first().waitFor();
    }
    await pcard('Pagos').getByText('Sin proveedor').waitFor();
    await admin.screenshot({ path: `${SHOTS}/plataforma-integraciones.png`, fullPage: true });
    await adminCtx.close();
  });

  if (errors.length) throw new Error(`Errores de JavaScript: ${errors.join(' | ').slice(0, 400)}`);
} finally {
  await browser.close();
  gemini.close();
  receiver.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} pasos correctos`);
  process.exitCode = results.every((r) => r.ok) && !errors.length ? 0 : 1;
}
