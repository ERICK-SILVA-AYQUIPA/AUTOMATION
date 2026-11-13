/**
 * Alta de empresas desde la plataforma (evolución, fase 3) en navegador real:
 * asistente de alta (con recarga a mitad: se retoma el borrador), invitación
 * por correo, cuenta en preparación, lista de tareas que se completa con datos
 * reales, activación, y aviso de vencimiento que se actualiza sin recargar.
 *
 * Usa una Graph API local (como whatsapp.mjs). La API y el worker deben
 * arrancarse con WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:4999.
 *
 *   MAILPIT_URL=http://localhost:8025 PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... node e2e/provisioning.mjs
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
const company = `Distribuidora ${stamp}`;
const adminEmail = `alta-${stamp}@example.com`;
const password = 'ClaveSegura123';
const PHONE_NUMBER_ID = `8${Date.now()}`.slice(0, 15);
const TOKEN = `EAAG-token-alta-${stamp}-0123456789`;
const APP_SECRET = createHmac('sha256', stamp).update('alta').digest('hex').slice(0, 32);

// Graph API local: solo valida el número y acepta envíos
const graph = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: 'Invalid token', type: 'OAuthException', code: 190 } }));
    }
    const m = /^\/v\d+\.\d+\/(\d+)(\/messages)?$/.exec(req.url);
    if (req.method === 'GET' && m && !m[2]) return res.end(JSON.stringify({ id: m[1], display_phone_number: '+51 900 000 002', verified_name: 'Distribuidora', quality_rating: 'GREEN' }));
    if (req.method === 'POST' && m?.[2]) return res.end(JSON.stringify({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: `wamid.ALTA${Date.now()}` }] }));
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise((r) => graph.listen(Number(process.env.GRAPH_PORT ?? 4999), '127.0.0.1', r));

const results = [];
const errors = [];
let shotPage;
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    await shotPage?.screenshot({ path: `${SHOTS}/alta-fallo.png` }).catch(() => undefined);
    console.log(`✗ ${name}\n  ${e.message.split('\n').slice(0, 3).join('\n  ')}`);
    throw e;
  }
};
async function linkFor(to, path) {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`).then((x) => x.json());
    const id = r.messages?.[0]?.ID;
    if (id) {
      const msg = await fetch(`${MAILPIT}/api/v1/message/${id}`).then((x) => x.json());
      const link = new RegExp(`https?://\\S+${path}\\?token=[^\\s"<]+`).exec(msg.Text)?.[0];
      if (link) return link.replace(/^https?:\/\/[^/]+/, WEB);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No llegó el correo ${path} a ${to}`);
}

const browser = await chromium.launch();
const newPage = async () => {
  const p = await (await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'es-PE', timezoneId: 'America/Lima' })).newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  return p;
};
const admin = await newPage();
const page = await newPage();
const L = (p, l) => p.getByLabel(l, { exact: true });

try {
  await step('Plataforma: asistente de alta, con recarga a mitad (el borrador se conserva)', async () => {
    shotPage = admin;
    await admin.goto(`${WEB}/login`);
    await L(admin, 'Correo').fill(process.env.PLATFORM_ADMIN_EMAIL);
    await L(admin, 'Contraseña').fill(process.env.PLATFORM_ADMIN_PASSWORD);
    await admin.getByRole('button', { name: 'Entrar' }).click();
    await admin.waitForURL(/\/plataforma$/);
    await admin.getByRole('link', { name: 'Nueva empresa' }).click();
    // Paso «Sector»: sin plantilla (las plantillas tienen su propia prueba, templates.mjs)
    await admin.getByRole('radio', { name: /^Sin plantilla/ }).check();
    await admin.getByRole('button', { name: 'Siguiente' }).click();
    await L(admin, 'Nombre comercial').fill(company);
    await L(admin, 'Razón social').fill(`${company} S.A.C.`);
    await L(admin, 'RUC').fill('20601234567');
    await L(admin, 'Tipo de negocio').selectOption('DISTRIBUTOR');
    await L(admin, 'Correo de contacto').fill(`contacto-${stamp}@example.com`);
    await admin.getByRole('button', { name: 'Siguiente' }).click();
    await L(admin, 'Modalidad').selectOption('DEDICATED');
    await admin.getByLabel('Automatizaciones').uncheck();
    await admin.reload();
    await admin.getByRole('button', { name: 'Siguiente' }).click();
    if ((await L(admin, 'Nombre comercial').inputValue()) !== company) throw new Error('Se perdió el borrador al recargar');
    await admin.getByRole('button', { name: 'Siguiente' }).click();
    await L(admin, 'Modalidad').selectOption('DEDICATED');
    if (await admin.getByLabel('Automatizaciones').isChecked()) throw new Error('Se perdió la elección de módulos');
    await admin.getByRole('button', { name: 'Siguiente' }).click();
    await L(admin, 'Plan').selectOption('PROFESSIONAL');
    await admin.getByRole('button', { name: 'Siguiente' }).click();
    await L(admin, 'Nombre del administrador').fill('Marta Alta');
    await L(admin, 'Correo del administrador').fill(adminEmail);
    await admin.getByRole('button', { name: 'Siguiente' }).click();
    await admin.getByText(`${company} S.A.C.`).waitFor();
    await admin.getByText('Instancia dedicada').waitFor();
    await admin.screenshot({ path: `${SHOTS}/alta-revisar.png` });
    await admin.getByRole('button', { name: 'Crear empresa y enviar invitación' }).click();
    await admin.waitForURL(/\/plataforma\?empresa=[0-9a-f-]{36}$/);
    const dlg = admin.getByRole('dialog');
    await dlg.getByText('Puesta en marcha').waitFor();
    await dlg.getByText('En preparación').first().waitFor();
    if (!(await dlg.getByRole('button', { name: 'Activar empresa' }).isDisabled())) throw new Error('Se puede activar con tareas pendientes');
    await admin.screenshot({ path: `${SHOTS}/alta-ficha-pendiente.png` });
  });

  await step('El administrador recibe la invitación, crea su contraseña y entra con la cuenta en preparación', async () => {
    shotPage = page;
    await page.goto(await linkFor(adminEmail, 'aceptar-invitacion'));
    await L(page, 'Contraseña').fill(password);
    await L(page, 'Repite la contraseña').fill(password);
    await page.getByRole('button', { name: 'Guardar' }).click();
    await page.waitForURL(/\/login/);
    await L(page, 'Correo').fill(adminEmail);
    await L(page, 'Contraseña').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL(/\/inicio$/);
    await page.getByText('Cuenta en preparación: el asistente aún no responde a tus clientes.').waitFor();
    await page.getByRole('heading', { name: 'Puesta en marcha' }).waitFor();
    await page.getByText(/Faltan 2 tareas obligatorias/).waitFor();
    const nav = page.getByRole('navigation', { name: 'Menú principal' });
    if (await nav.getByText('Automatizaciones').count()) throw new Error('Se muestra un módulo no contratado');
    await page.screenshot({ path: `${SHOTS}/alta-empresa-inicio.png`, fullPage: true });
  });

  await step('Conectar WhatsApp y recibir el primer webhook completa las tareas obligatorias', async () => {
    await page.goto(`${WEB}/integraciones`);
    await page.getByRole('button', { name: 'Conectar número' }).first().click();
    await L(page, 'Phone number ID').fill(PHONE_NUMBER_ID);
    await L(page, 'App Secret').fill(APP_SECRET);
    await L(page, 'Token de acceso').fill(TOKEN);
    await page.getByRole('button', { name: 'Verificar y guardar' }).click();
    await page.getByRole('heading', { name: 'Configurar el webhook en Meta' }).waitFor();
    const url = await page.getByRole('textbox', { name: 'URL de devolución de llamada (Callback URL)' }).inputValue();
    await page.getByRole('button', { name: 'Listo' }).click();
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '51900000002', phone_number_id: PHONE_NUMBER_ID }, contacts: [{ profile: { name: 'Cliente Prueba' }, wa_id: '51987000999' }], messages: [{ from: '51987000999', id: `wamid.ALTAIN${stamp}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hola' } }] } }] }] });
    const st = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}` }, body: raw }).then((r) => r.status);
    if (st !== 200) throw new Error(`Webhook respondió ${st}`);
    await page.goto(`${WEB}/inicio`);
    await page.getByText('Ya está todo listo: la plataforma puede activarla.').waitFor({ timeout: 15_000 });
  });

  await step('La plataforma activa la empresa; el equipo recibe el aviso y desaparece el estado de preparación', async () => {
    shotPage = admin;
    await admin.reload();
    const dlg = admin.getByRole('dialog');
    const btn = dlg.getByRole('button', { name: 'Activar empresa' });
    await btn.waitFor();
    if (await btn.isDisabled()) throw new Error('No se habilitó la activación');
    await btn.click();
    await admin.getByText(`${company} está activa`).waitFor();
    await dlg.getByText(/Activa desde/).waitFor();
    await admin.screenshot({ path: `${SHOTS}/alta-activada.png` });
    shotPage = page;
    await page.reload();
    await page.getByRole('button', { name: /^Avisos sin leer: [1-9]/ }).click();
    await page.getByRole('dialog', { name: 'Avisos' }).getByText('Tu cuenta está activa').waitFor();
    if (await page.getByText('Cuenta en preparación').count()) throw new Error('Sigue el aviso de preparación');
  });

  await step('Si la plataforma cancela el plan, el aviso de solo lectura aparece sin recargar', async () => {
    shotPage = page;
    await page.keyboard.press('Escape');
    await page.goto(`${WEB}/categorias`);
    await page.getByRole('button', { name: 'Nueva categoría' }).first().waitFor();
    shotPage = admin;
    await admin.keyboard.press('Escape');
    await admin.getByLabel('Buscar empresa').fill(company);
    const row = admin.getByRole('row').filter({ hasText: company });
    await row.getByRole('button', { name: 'Cobro', exact: true }).click();
    await admin.getByRole('button', { name: 'Cancelar suscripción…' }).click();
    await admin.getByRole('button', { name: 'Confirmar cancelación' }).click();
    await admin.getByText(/queda en solo lectura/).waitFor();
    // La página de la empresa sigue abierta desde antes: el intento de escribir
    // recibe 402 y el panel relee la cuenta sin recargar
    shotPage = page;
    if (await page.getByText('La suscripción está cancelada').count()) throw new Error('El aviso ya estaba antes de intentar escribir');
    await page.getByRole('button', { name: 'Nueva categoría' }).first().click();
    await L(page, 'Nombre').fill('Bebidas');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await page.getByText('La suscripción está cancelada. Puedes consultar tus datos, pero no crear ni modificar nada.').waitFor({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `${SHOTS}/alta-solo-lectura-en-vivo.png` });
  });

  if (errors.length) throw new Error(`Errores de JavaScript: ${errors.join(' | ').slice(0, 400)}`);
} finally {
  await browser.close();
  graph.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} pasos correctos`);
  process.exitCode = results.every((r) => r.ok) && !errors.length ? 0 : 1;
}
