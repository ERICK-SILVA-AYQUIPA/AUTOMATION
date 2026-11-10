/**
 * Prueba de punta a punta de la FASE 4 en navegador real: conectar un número,
 * recibir un mensaje firmado por el webhook, verlo en la bandeja, responder y
 * ver el estado "leído".
 *
 * Meta no se puede usar en una prueba automática sin credenciales reales, así que
 * este script levanta un servidor HTTP local que responde como la Graph API
 * (solo las dos rutas que usamos). La API y el worker deben arrancarse apuntando a él:
 *
 *   WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:4999 node dist/main.js
 *   WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:4999 node dist/worker.js
 *   WEB_URL=http://localhost:3000 MAILPIT_URL=http://localhost:8025 node e2e/whatsapp.mjs
 *
 * La prueba con Meta real se hace a mano siguiendo docs/integrations/whatsapp-cloud-api.md.
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
const email = `wa-${stamp}@example.com`;
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
    await page?.screenshot({ path: `${SHOTS}/whatsapp-fallo.png` }).catch(() => undefined);
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
let verifyToken = '';

try {
  await step('Registro, verificación e inicio de sesión', async () => {
    await page.goto(`${WEB}/registro`);
    await label('Nombre del negocio').fill(`Bodega WA ${stamp}`);
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
    await page.getByText('Aún no hay números conectados').waitFor();
  });

  await step('Credenciales incorrectas: Meta las rechaza y no se guarda nada', async () => {
    await page.getByRole('button', { name: 'Conectar número' }).first().click();
    await label('Phone number ID').fill(PHONE_NUMBER_ID);
    await label('App Secret').fill(APP_SECRET);
    await label('Token de acceso').fill('EAAG-token-equivocado-0123456789');
    await page.getByRole('button', { name: 'Verificar y guardar' }).click();
    await page.getByText(/Meta rechazó las credenciales/).waitFor();
    // El 400 de ese intento es esperado: no cuenta como error de la página
    consoleErrors.length = 0;
  });

  await step('Conectar número con credenciales válidas y ver datos del webhook', async () => {
    await label('Token de acceso').fill(TOKEN);
    await page.getByRole('button', { name: 'Verificar y guardar' }).click();
    await page.getByRole('heading', { name: 'Configurar el webhook en Meta' }).waitFor();
    webhookUrl = await page.getByRole('textbox', { name: 'URL de devolución de llamada (Callback URL)' }).inputValue();
    verifyToken = await page.getByRole('textbox', { name: 'Token de verificación (Verify token)' }).inputValue();
    if (!/\/api\/v1\/webhooks\/whatsapp\/[A-Za-z0-9_-]{20,}$/.test(webhookUrl)) throw new Error(`URL inesperada: ${webhookUrl}`);
    await page.getByRole('button', { name: 'Copiar URL de devolución de llamada (Callback URL)' }).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    if (clip !== webhookUrl) throw new Error('El botón copiar no copió la URL');
    await page.screenshot({ path: `${SHOTS}/whatsapp-webhook.png` });
    await page.getByRole('button', { name: 'Listo' }).click();
    await page.getByText('Credenciales válidas').waitFor();
    await page.getByText('Aún no llega ningún aviso de Meta').waitFor();
  });

  await step('Meta verifica el webhook (hub.challenge) con el token mostrado', async () => {
    const ok = await fetch(`${webhookUrl}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=1158201444`);
    if (ok.status !== 200 || (await ok.text()) !== '1158201444') throw new Error(`Verificación falló: ${ok.status}`);
    const bad = await fetch(`${webhookUrl}?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1`);
    if (bad.status !== 403) throw new Error(`Token incorrecto devolvió ${bad.status}`);
  });

  await step('Un aviso con firma falsa se rechaza', async () => {
    const status = await postWebhook(webhookUrl, envelope({ messages: [] }), 'ffffffffffffffffffffffffffffffff');
    if (status !== 401 && status !== 403) throw new Error(`Firma falsa devolvió ${status}`);
  });

  await step('Mensaje del cliente llega por el webhook y aparece en la bandeja', async () => {
    const payload = envelope({
      contacts: [{ profile: { name: 'Carla Cliente' }, wa_id: CUSTOMER }],
      messages: [{ from: CUSTOMER, id: `wamid.IN${stamp}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hola, ¿tienen gaseosa de 500 ml? <script>alert(1)</script>' } }],
    });
    const status = await postWebhook(webhookUrl, payload);
    if (status !== 200) throw new Error(`Webhook devolvió ${status}`);
    // Meta reintenta: el duplicado no debe crear otro mensaje
    await postWebhook(webhookUrl, payload);
    await page.getByRole('link', { name: 'Conversaciones' }).click();
    await page.getByRole('button', { name: /Carla Cliente/ }).click({ timeout: 15_000 });
    await page.getByText('Hola, ¿tienen gaseosa de 500 ml? <script>alert(1)</script>').waitFor();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/whatsapp-entrante.png` });
    const count = await page.locator('section').getByText(/tienen gaseosa de 500 ml/).count();
    if (count !== 1) throw new Error(`El mensaje aparece ${count} veces en el hilo: el reintento de Meta lo duplicó`);
    await page.locator('aside').getByText(/tienen gaseosa de 500 ml/).waitFor();
  });

  await step('Responder desde la bandeja: el worker lo envía a WhatsApp', async () => {
    await page.getByLabel('Respuesta').fill('Sí, a S/ 3.50. ¿Cuántas desea?');
    await page.getByRole('button', { name: 'Enviar' }).click();
    await page.getByText('Sí, a S/ 3.50. ¿Cuántas desea?').waitFor();
    await page.getByLabel('Enviado').waitFor({ timeout: 15_000 });
    const out = sent.at(-1);
    if (!out || out.to !== CUSTOMER || out.text?.body !== 'Sí, a S/ 3.50. ¿Cuántas desea?') throw new Error(`Envío inesperado: ${JSON.stringify(out)}`);
  });

  await step('Estado "leído" de Meta se refleja en el mensaje', async () => {
    const wamid = `wamid.LOCAL${stamp}${seq}`;
    const st = await postWebhook(webhookUrl, envelope({ statuses: [{ id: wamid, status: 'read', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: CUSTOMER }] }));
    if (st !== 200) throw new Error(`Webhook de estado devolvió ${st}`);
    await page.getByLabel('Leído').waitFor({ timeout: 15_000 });
    await page.screenshot({ path: `${SHOTS}/whatsapp-bandeja.png` });
  });

  await step('Integraciones muestra la hora del último aviso; desactivar bloquea respuestas', async () => {
    await page.getByRole('link', { name: 'Integraciones' }).click();
    await page.getByText(/Último aviso de Meta/).waitFor();
    await page.getByRole('button', { name: 'Desactivar' }).click();
    await page.getByText('Desactivado', { exact: true }).waitFor();
    await page.screenshot({ path: `${SHOTS}/whatsapp-integraciones.png` });
    await page.goBack();
    await page.getByText('El número de WhatsApp de esta conversación está desactivado.').waitFor({ timeout: 10_000 });
  });

  await step('Sin errores en la consola del navegador', async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.join(' | '));
  });
} finally {
  await browser.close();
  graph.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} pasos correctos`);
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}
