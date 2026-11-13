/**
 * Cobro manual en navegador real: una empresa nueva vence su prueba, queda en
 * solo lectura, el administrador general registra el pago por Yape desde
 * /plataforma y la empresa vuelve a operar. Usa una empresa nueva (correo único).
 *
 *   MAILPIT_URL=http://localhost:8025 PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... node e2e/billing.mjs
 *
 * Para simular el paso del tiempo cambia la fecha de fin de la prueba en la base
 * de desarrollo (docker compose exec postgres psql); nunca se ejecuta en producción.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR ?? 'e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);
const company = `Bodega Cobro ${stamp}`;
const email = `cobro-${stamp}@example.com`;
const password = 'ClaveSegura123';
const results = [];
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`✗ ${name}\n  ${e.message.split('\n').slice(0, 3).join('\n  ')}`);
    throw e;
  }
};

function sql(query) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'postgres', 'sh', '-c', `psql -U "$POSTGRES_USER" -d "\${APP_DB_NAME:-ai_sales}" -tAc "$0"`, query], { cwd: '../..', encoding: 'utf8' }).trim();
}

async function verifyLink(to) {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`).then((x) => x.json());
    const id = r.messages?.[0]?.ID;
    if (id) {
      const m = await fetch(`${process.env.MAILPIT_URL}/api/v1/message/${id}`).then((x) => x.json());
      const link = /https?:\/\/\S+verificar-correo\?token=[^\s"<]+/.exec(m.Text)?.[0];
      if (link) return link.replace(/^https?:\/\/[^/]+/, WEB);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('No llegó el correo de verificación');
}

const browser = await chromium.launch();
const opts = { viewport: { width: 1360, height: 900 }, locale: 'es-PE', timezoneId: 'America/Lima' };
const tenantCtx = await browser.newContext(opts);
const adminCtx = await browser.newContext(opts);
const page = await tenantCtx.newPage();
const admin = await adminCtx.newPage();
const errors = [];
for (const p of [page, admin]) p.on('pageerror', (e) => errors.push(e.message));
const label = (p, l) => p.getByLabel(l, { exact: true });

try {
  await step('Empresa nueva en prueba: sin aviso (quedan 14 días)', async () => {
    await page.goto(`${WEB}/registro`);
    await label(page, 'Nombre del negocio').fill(company);
    await label(page, 'Tu nombre').fill('Rosa Cobro');
    await label(page, 'Correo').fill(email);
    await label(page, 'Contraseña').fill(password);
    await page.getByRole('button', { name: 'Crear cuenta' }).click();
    await page.getByText(/revisa tu correo|te enviamos/i).first().waitFor({ timeout: 10_000 });
    await page.goto(await verifyLink(email));
    await page.getByText(/verificado|confirmado/i).first().waitFor({ timeout: 10_000 });
    await page.goto(`${WEB}/login`);
    await label(page, 'Correo').fill(email);
    await label(page, 'Contraseña').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL(/\/inicio$/);
    await page.getByText('Configuración').first().waitFor();
    if (await page.getByText(/prueba gratuita termina|solo lectura/).count()) throw new Error('No debía mostrarse aviso');
  });

  await step('Prueba por terminar (2 días): aviso con la fecha', async () => {
    sql(`UPDATE subscriptions SET trial_ends_at = now() + interval '2 days', current_period_end = now() + interval '2 days' WHERE tenant_id = (SELECT tenant_id FROM users WHERE email = '${email}')`);
    await page.reload();
    await page.getByText(/Tu prueba gratuita termina el .*\(quedan 2 días\)/).waitFor();
  });

  await step('Prueba vencida: aviso de solo lectura y crear una categoría se rechaza', async () => {
    sql(`UPDATE subscriptions SET trial_ends_at = now() - interval '1 minute', current_period_end = now() - interval '1 minute' WHERE tenant_id = (SELECT tenant_id FROM users WHERE email = '${email}')`);
    await page.goto(`${WEB}/categorias`);
    await page.getByRole('alert').filter({ hasText: 'la cuenta está en solo lectura' }).waitFor();
    await page.getByRole('button', { name: 'Nueva categoría' }).first().click();
    await label(page, 'Nombre').fill('Bebidas');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await page.getByText(/periodo de prueba o tu plan venció/).first().waitFor();
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `${SHOTS}/cobro-solo-lectura.png` });
  });

  await step('Administrador general: la empresa figura en "Solo lectura"', async () => {
    await admin.goto(`${WEB}/login`);
    await label(admin, 'Correo').fill(process.env.PLATFORM_ADMIN_EMAIL);
    await label(admin, 'Contraseña').fill(process.env.PLATFORM_ADMIN_PASSWORD);
    await admin.getByRole('button', { name: 'Entrar' }).click();
    await admin.waitForURL(/\/plataforma$/);
    await admin.getByLabel('Buscar empresa').fill(company);
    const row = admin.getByRole('row').filter({ hasText: company });
    await row.getByText('Solo lectura').waitFor();
  });

  await step('Registrar pago por Yape: plan Profesional, 1 mes', async () => {
    const row = admin.getByRole('row').filter({ hasText: company });
    await row.getByRole('button', { name: 'Cobro', exact: true }).click();
    const dlg = admin.getByRole('dialog');
    await dlg.getByText('Sin pagos registrados.').waitFor();
    await dlg.getByLabel('Plan').selectOption('PROFESSIONAL');
    await dlg.getByLabel('Importe recibido').fill('79');
    await dlg.getByLabel(/N\.º de operación/).fill(`YAPE-${stamp}`);
    await admin.screenshot({ path: `${SHOTS}/cobro-registrar-pago.png` });
    await dlg.getByRole('button', { name: 'Registrar pago y activar' }).click();
    await admin.getByText(`Pago registrado: ${company} queda activa`).waitFor();
    await row.getByText('Pagado').waitFor();
    await row.getByRole('combobox').filter({ hasText: 'Profesional' }).waitFor();
    await admin.screenshot({ path: `${SHOTS}/cobro-plataforma.png` });
  });

  await step('La empresa vuelve a operar y ve su pago en Configuración', async () => {
    await page.goto(`${WEB}/categorias`);
    if (await page.getByRole('alert').filter({ hasText: 'solo lectura' }).count()) throw new Error('Sigue el aviso de solo lectura');
    await page.getByRole('button', { name: 'Nueva categoría' }).first().click();
    await label(page, 'Nombre').fill('Bebidas');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await page.getByRole('cell', { name: 'Bebidas', exact: true }).waitFor();
    await page.goto(`${WEB}/configuracion`);
    await page.getByText('Plan Profesional').waitFor();
    await page.getByText(/Pagado hasta el/).waitFor();
    await page.getByText('Pagos registrados').waitFor();
    await page.getByText('(Yape)').waitFor();
    await page.screenshot({ path: `${SHOTS}/cobro-configuracion.png`, fullPage: true });
  });

  if (errors.length) throw new Error(`Errores de JavaScript en la página: ${errors.join(' | ')}`);
} finally {
  await browser.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} pasos correctos`);
  process.exitCode = ok === results.length && !errors.length ? 0 : 1;
}
