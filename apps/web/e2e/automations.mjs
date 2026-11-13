/**
 * Automatizaciones (evolución, fase 4) en navegador real: catálogo con el
 * estado de cada una, bloqueo por plan, configuración validada que persiste,
 * activar/desactivar, y reintento manual desde el historial que el worker
 * entrega de verdad a n8n.
 *
 * Requiere API + worker + n8n (services/n8n/setup.sh) + Mailpit en marcha. El
 * evento fallido se siembra con psql en el contenedor de PostgreSQL de
 * desarrollo (simula un fallo previo de n8n); todo lo demás pasa por el panel.
 *
 *   MAILPIT_URL=http://localhost:8025 node e2e/automations.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const PG = process.env.PG_CONTAINER ?? 'ai-sales-assistant-postgres-1';
const SHOTS = process.env.SHOTS_DIR ?? 'e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);
const company = `Bodega Auto ${stamp}`;
const email = `auto-${stamp}@example.com`;
const password = 'ClaveSegura123';
const sql = (q) => execFileSync('docker', ['exec', PG, 'psql', '-U', 'postgres', '-d', process.env.APP_DB_NAME ?? 'ai_sales', '-At', '-c', q], { encoding: 'utf8' }).trim();

const results = [];
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    await page.screenshot({ path: `${SHOTS}/automatizaciones-fallo.png` }).catch(() => undefined);
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
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'es-PE', timezoneId: 'America/Lima' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const label = (l) => page.getByLabel(l, { exact: true });
const card = (name) => page.locator('div.rounded-xl, section div').filter({ has: page.getByRole('heading', { name, exact: true }) }).last();

try {
  await step('Registro, verificación e inicio de sesión', async () => {
    await page.goto(`${WEB}/registro`);
    await label('Nombre del negocio').fill(company);
    await label('Tu nombre').fill('Marta Prueba');
    await label('Correo').fill(email);
    await label('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Crear cuenta' }).click();
    await page.getByText(/revisa tu correo|te enviamos/i).first().waitFor({ timeout: 10_000 });
    await page.goto(await linkFor(email, 'verificar-correo'));
    await page.getByText(/verificado|confirmado/i).first().waitFor({ timeout: 10_000 });
    await page.goto(`${WEB}/login`);
    await label('Correo').fill(email);
    await label('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL(/\/inicio$/);
  });

  await step('El menú lleva a Automatizaciones con el catálogo y el estado de cada una', async () => {
    await page.getByRole('link', { name: 'Automatizaciones' }).click();
    await page.waitForURL(/\/automatizaciones$/);
    for (const n of ['Aviso de pedido nuevo', 'Alerta de stock bajo', 'Aviso de derivación a una persona', 'Alerta de errores de WhatsApp', 'Estado del pedido al cliente', 'Recordatorio de pedidos sin confirmar']) {
      await page.getByRole('heading', { name: n, exact: true }).waitFor();
    }
    await card('Aviso de pedido nuevo').getByText('Activa', { exact: true }).waitFor();
    await card('Aviso de derivación a una persona').getByText('Inactiva', { exact: true }).waitFor();
  });

  await step('Lo que el plan no incluye se muestra bloqueado, no como un botón que falla', async () => {
    const c = card('Estado del pedido al cliente');
    await c.getByText('Tu plan no incluye esta automatización').waitFor();
    if (!(await c.getByRole('button', { name: 'Activar Estado del pedido al cliente' }).isDisabled())) throw new Error('El botón Activar debería estar deshabilitado');
  });

  await step('La configuración se valida y se guarda de verdad', async () => {
    const c = card('Aviso de pedido nuevo');
    await c.getByRole('button', { name: 'Configurar' }).click();
    await c.getByLabel('Pedidos por WhatsApp').uncheck();
    await c.getByLabel('Pedidos creados en el panel').uncheck();
    await c.getByRole('button', { name: 'Guardar configuración' }).click();
    await page.getByText('La configuración no es válida').waitFor();
    await c.getByLabel('Pedidos por WhatsApp').check();
    await c.getByLabel('Importe mínimo').fill('150');
    await c.getByRole('button', { name: 'Guardar configuración' }).click();
    await page.getByText('Configuración de «Aviso de pedido nuevo» guardada').waitFor();
    await page.reload();
    const c2 = card('Aviso de pedido nuevo');
    await c2.getByRole('button', { name: 'Configurar' }).click();
    if ((await c2.getByLabel('Importe mínimo').inputValue()) !== '150') throw new Error('El importe mínimo no se guardó');
    if (await c2.getByLabel('Pedidos creados en el panel').isChecked()) throw new Error('El canal desmarcado volvió a aparecer');
    await page.screenshot({ path: `${SHOTS}/automatizaciones-config.png` });
  });

  await step('Activar y desactivar una automatización', async () => {
    const c = card('Aviso de derivación a una persona');
    await c.getByRole('button', { name: 'Activar Aviso de derivación a una persona' }).click();
    await page.getByText('«Aviso de derivación a una persona» activada').waitFor();
    await c.getByText('Activa', { exact: true }).waitFor();
    await c.getByRole('button', { name: 'Desactivar Aviso de derivación a una persona' }).click();
    await c.getByText('Inactiva', { exact: true }).waitFor();
  });

  await step('Un aviso fallido se reintenta desde el historial y el worker lo entrega a n8n', async () => {
    const tenantId = sql(`SELECT id FROM tenants WHERE name = '${company}'`);
    if (!/^[0-9a-f-]{36}$/.test(tenantId)) throw new Error('No se encontró la empresa');
    sql(`INSERT INTO automation_events (id, tenant_id, key, payload, status, attempts, last_error)
         VALUES (gen_random_uuid(), '${tenantId}', 'LOW_STOCK_ALERT', '{"productName":"Arroz 5 kg","sku":"ARZ-5","stock":2,"minStock":5}', 'FAILED', 8, 'Sin conexión con n8n: fetch failed')`);
    await page.reload();
    await page.getByLabel('Filtrar por estado').selectOption('FAILED');
    const row = page.getByRole('row').filter({ hasText: 'Alerta de stock bajo' });
    await row.getByText('Sin conexión con n8n: fetch failed').waitFor();
    await row.getByRole('button', { name: 'Reintentar' }).click();
    await page.getByText('Reintento en cola').waitFor();
    await page.getByLabel('Filtrar por estado').selectOption('');
    const done = page.getByRole('row').filter({ hasText: 'Alerta de stock bajo' });
    for (let i = 0; i < 40 && !(await done.getByText('Ejecutada').count()); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      await page.getByLabel('Filtrar por estado').selectOption('SENT');
      await page.getByLabel('Filtrar por estado').selectOption('');
    }
    await done.getByText('Ejecutada').waitFor({ timeout: 2000 });
    await done.getByText('Reintentada a mano').waitFor();
    await page.screenshot({ path: `${SHOTS}/automatizaciones-historial.png` });
    // n8n armó el correo y el backend lo envió al administrador
    for (let i = 0; i < 30; i++) {
      const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email} subject:"Arroz 5 kg"`)}`).then((x) => x.json());
      if (r.messages?.length) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('No llegó el correo de stock bajo al administrador');
  });

  if (errors.length) throw new Error(`Errores de JavaScript: ${errors.join(' | ').slice(0, 400)}`);
} finally {
  await browser.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} pasos correctos`);
  process.exitCode = results.every((r) => r.ok) && !errors.length ? 0 : 1;
}
