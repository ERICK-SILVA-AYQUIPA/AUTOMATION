/**
 * Prueba de punta a punta de la FASE 5 contra un Chatwoot REAL (docker compose,
 * perfil "chatwoot") y en navegador real:
 *   activar la bandeja de agentes → un mensaje de WhatsApp aparece en Chatwoot →
 *   el agente entra sin contraseña (SSO) y responde desde Chatwoot → la respuesta
 *   sale por WhatsApp, el asistente se pausa y el estado "leído" vuelve a Chatwoot →
 *   resolver en Chatwoot resuelve la conversación en el panel.
 *
 * Solo WhatsApp (Meta) se sustituye por un servidor local que responde como la
 * Graph API, igual que en e2e/whatsapp.mjs. Requisitos:
 *   - .env con CHATWOOT_PLATFORM_TOKEN (services/chatwoot/setup-platform.sh)
 *   - API y worker con WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:4999
 *   - Mailpit (perfil "mail") para el correo de verificación
 *
 *   WEB_URL=http://localhost:3000 MAILPIT_URL=http://localhost:8025 \
 *   CHATWOOT_URL=http://localhost:3100 node e2e/chatwoot.mjs
 */
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const CW = (process.env.CHATWOOT_URL ?? 'http://localhost:3100').replace(/\/$/, '');
const GRAPH_PORT = Number(process.env.GRAPH_PORT ?? 4999);
const SHOTS = process.env.SHOTS_DIR ?? 'e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);
const email = `cw-${stamp}@example.com`;
const password = 'ClaveSegura123';
const PHONE_NUMBER_ID = `8${Date.now()}`.slice(0, 15);
const TOKEN = `EAAG-token-local-${stamp}-0123456789`;
const APP_SECRET = createHmac('sha256', stamp).update('secret').digest('hex').slice(0, 32);
const CUSTOMER = `519870${String(Date.now()).slice(-5)}`;
const CUSTOMER_NAME = `Lucía ${stamp}`;
const AGENT_REPLY = `Hola Lucía, le atiende Rosa. Tenemos stock (${stamp}).`;

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
    if (req.method === 'GET' && m && !m[2]) return res.end(JSON.stringify({ id: m[1], display_phone_number: '+51 900 000 002', verified_name: 'Bodega Chatwoot', quality_rating: 'GREEN' }));
    if (req.method === 'POST' && m?.[2]) {
      const b = JSON.parse(body);
      const id = `wamid.CW${stamp}${++seq}`;
      sent.push({ ...b, id });
      return res.end(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: b.to, wa_id: b.to }], messages: [{ id }] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: 'Unknown path', code: 100 } }));
  });
});
await new Promise((r) => graph.listen(GRAPH_PORT, '127.0.0.1', r));

// ------------------------------------------------------------------ utilidades
const results = [];
let page;
let cwPage;
const consoleErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message.split('\n')[0] });
    await page?.screenshot({ path: `${SHOTS}/chatwoot-fallo.png` }).catch(() => undefined);
    await cwPage?.screenshot({ path: `${SHOTS}/chatwoot-fallo-chatwoot.png` }).catch(() => undefined);
    if (consoleErrors.length) console.log(`  Consola: ${consoleErrors.slice(0, 3).join(' | ').slice(0, 800)}`);
    console.log(`✗ ${name}\n  ${e.message.split('\n').slice(0, 3).join('\n  ')}`);
    throw e;
  }
};
const until = async (what, fn, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Tiempo agotado esperando: ${what}`);
    await sleep(400);
  }
};
async function verifyLink(to) {
  return until(`correo de verificación para ${to}`, async () => {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`).then((x) => x.json());
    const id = r.messages?.[0]?.ID;
    if (!id) return null;
    const msg = await fetch(`${MAILPIT}/api/v1/message/${id}`).then((x) => x.json());
    return /https?:\/\/\S+verificar-correo\?token=[^\s"<]+/.exec(msg.Text)?.[0] ?? null;
  });
}
const envelope = (value) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '51900000002', phone_number_id: PHONE_NUMBER_ID }, ...value } }] }] });
async function postWebhook(url, payload) {
  const raw = JSON.stringify(payload);
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}` }, body: raw });
  if (r.status !== 200) throw new Error(`Webhook devolvió ${r.status}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-PE', timezoneId: 'America/Lima' });
page = await ctx.newPage();
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message));
const label = (l) => page.getByLabel(l, { exact: true });
// El panel guarda el access token solo en memoria: se toma de las respuestas de inicio de sesión/renovación
let accessToken = '';
page.on('response', async (r) => {
  if (/\/api\/v1\/auth\/(login|refresh)$/.test(r.url()) && r.ok()) accessToken = (await r.json().catch(() => ({}))).accessToken ?? accessToken;
});
const panelApi = async (path) => {
  const r = await fetch(`${WEB}/api/v1${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let webhookUrl = '';
let conversationId = '';

try {
  await step('Registro, verificación, inicio de sesión y número de WhatsApp conectado', async () => {
    await page.goto(`${WEB}/registro`);
    await label('Nombre del negocio').fill(`Bodega CW ${stamp}`);
    await label('Tu nombre').fill('Rosa Agente');
    await label('Correo').fill(email);
    await label('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Crear cuenta' }).click();
    await page.getByText(/revisa tu correo/i).waitFor({ timeout: 10_000 });
    await page.goto((await verifyLink(email)).replace(/^https?:\/\/[^/]+/, WEB));
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
    webhookUrl = await page.getByRole('textbox', { name: 'URL de devolución de llamada (Callback URL)' }).inputValue();
    await page.getByRole('button', { name: 'Listo' }).click();
  });

  await step('Activar la bandeja de agentes crea la cuenta de Chatwoot de la empresa', async () => {
    await page.getByText('Sin activar').waitFor();
    await page.getByRole('button', { name: 'Activar', exact: true }).click();
    await page.getByText(/^Activa desde/).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Abrir en Chatwoot' }).waitFor();
    await page.screenshot({ path: `${SHOTS}/chatwoot-integraciones.png` });
    const st = await panelApi('/integrations/chatwoot');
    if (st.body?.status !== 'CONNECTED' || !st.body.accountId) throw new Error(`Estado inesperado: ${JSON.stringify(st.body)}`);
  });

  await step('El mensaje del cliente por WhatsApp llega al panel', async () => {
    await postWebhook(webhookUrl, envelope({
      contacts: [{ profile: { name: CUSTOMER_NAME }, wa_id: CUSTOMER }],
      messages: [{ from: CUSTOMER, id: `wamid.IN${stamp}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: `Hola, quiero hablar con una persona (${stamp})` } }],
    }));
    await page.getByRole('link', { name: 'Conversaciones' }).click();
    await page.getByRole('button', { name: new RegExp(CUSTOMER_NAME) }).click({ timeout: 15_000 });
    await page.waitForURL(/\?id=/);
    conversationId = new URL(page.url()).searchParams.get('id');
  });

  await step('"Abrir en Chatwoot" entra sin contraseña y la conversación está copiada allí', async () => {
    const [popup] = await Promise.all([ctx.waitForEvent('page'), page.getByRole('button', { name: 'Abrir en Chatwoot' }).click()]);
    cwPage = popup;
    cwPage.on('pageerror', (e) => console.log(`  (Chatwoot) ${e.message}`));
    await cwPage.waitForURL(new RegExp(`^${CW}/app/accounts/\\d+/`), { timeout: 30_000 });
    // Chatwoot abre en la pestaña "Mías"; la conversación nueva está sin asignar
    await cwPage.getByText(/Sin asignar|Unassigned/).first().click({ timeout: 30_000 });
    await cwPage.getByText(CUSTOMER_NAME).first().waitFor({ timeout: 30_000 });
    await cwPage.getByText(CUSTOMER_NAME).first().click();
    await cwPage.getByText(`Hola, quiero hablar con una persona (${stamp})`).first().waitFor({ timeout: 15_000 });
    await cwPage.screenshot({ path: `${SHOTS}/chatwoot-conversacion.png` });
  });

  await step('El agente responde desde Chatwoot y sale por WhatsApp', async () => {
    const editor = cwPage.locator('.ProseMirror[contenteditable="true"]').first();
    await editor.click();
    await editor.fill(AGENT_REPLY);
    // En esta versión Enter hace salto de línea; se envía con el botón "Enviar (CTRL + ↵)"
    await cwPage.getByRole('button', { name: /^(Enviar|Send)/ }).click();
    const out = await until('envío a la Graph API', () => sent.find((b) => b.text?.body === AGENT_REPLY));
    if (out.to !== CUSTOMER) throw new Error(`Destino inesperado: ${out.to}`);
    if (sent.filter((b) => b.text?.body === AGENT_REPLY).length !== 1) throw new Error('La respuesta se envió más de una vez');
  });

  await step('El panel muestra la respuesta del agente y el asistente queda en pausa', async () => {
    await page.bringToFront();
    await page.getByText(AGENT_REPLY).waitFor({ timeout: 15_000 });
    await page.locator('section').getByText('Atención humana').waitFor({ timeout: 15_000 });
    const c = await panelApi(`/conversations/${conversationId}`);
    const m = c.body.messages.find((x) => x.content === AGENT_REPLY);
    if (m?.senderType !== 'AGENT' || c.body.botStatus !== 'PAUSED') throw new Error(`Inesperado: ${JSON.stringify({ senderType: m?.senderType, bot: c.body.botStatus })}`);
    await page.screenshot({ path: `${SHOTS}/chatwoot-panel.png` });
  });

  await step('Respuesta desde el panel también aparece en Chatwoot (sin reenviarse)', async () => {
    const text = `Le confirmo el pedido (${stamp}).`;
    await page.getByLabel('Respuesta').fill(text);
    await page.getByRole('button', { name: 'Enviar' }).click();
    await until('envío del panel', () => sent.find((b) => b.text?.body === text));
    await cwPage.bringToFront();
    await cwPage.getByText(text).first().waitFor({ timeout: 20_000 });
    await sleep(2000);
    if (sent.filter((b) => b.text?.body === text).length !== 1) throw new Error('El mensaje del panel volvió a enviarse por WhatsApp al copiarse a Chatwoot');
  });

  await step('El estado "leído" de WhatsApp llega a Chatwoot', async () => {
    // Id que Meta asignó a la respuesta del agente (si el asistente IA está activo, antes pudo salir su mensaje)
    const wamid = sent.find((x) => x.text?.body === AGENT_REPLY)?.id;
    if (!wamid) throw new Error('No se encontró el envío de la respuesta del agente');
    await postWebhook(webhookUrl, envelope({ statuses: [{ id: wamid, status: 'read', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: CUSTOMER }] }));
    // Chatwoot muestra el doble check de leído con el título "Read"/"Leído" en la burbuja
    await until('estado leído en Chatwoot', async () => {
      const r = await cwPage.evaluate(async ({ reply }) => {
        const m = /\/app\/accounts\/(\d+)\/.*conversations\/(\d+)/.exec(location.pathname);
        if (!m) return null;
        const info = JSON.parse(decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('cw_d_session_info=')) ?? '=').split('=').slice(1).join('=')) || '{}');
        const h = { 'access-token': info['access-token'], client: info.client, uid: info.uid, 'token-type': 'Bearer' };
        const res = await fetch(`/api/v1/accounts/${m[1]}/conversations/${m[2]}/messages`, { headers: h });
        if (!res.ok) return `http ${res.status}`;
        const j = await res.json();
        return j.payload.find((x) => x.content === reply)?.status ?? null;
      }, { reply: AGENT_REPLY });
      return r === 'read';
    });
  });

  await step('Resolver en Chatwoot resuelve la conversación y reactiva el asistente', async () => {
    await cwPage.getByRole('button', { name: /^(Resolve|Resolver)$/ }).first().click();
    await until('conversación resuelta en el panel', async () => {
      const c = await panelApi(`/conversations/${conversationId}`);
      return c.body.status === 'RESOLVED' && c.body.botStatus === 'ACTIVE';
    });
    await page.bringToFront();
    await page.getByText('Resuelta', { exact: true }).first().waitFor({ timeout: 10_000 });
  });

  await step('Sin errores en la consola del panel', async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.join(' | '));
  });
} finally {
  await browser.close();
  graph.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} pasos correctos`);
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}
