/**
 * Rentabilidad por instalación (ADR 055) en navegador real: una empresa con su
 * plan pagado; sin costos el margen no se calcula y se dice qué falta; el equipo
 * registra los costos, define el tipo de cambio y aparece el margen estimado; un
 * presupuesto superado genera una sola alerta por correo.
 *
 * Restaura al final los tipos de cambio que había. La empresa de prueba queda
 * (como en las demás pruebas), con un nombre único.
 *
 *   MAILPIT_URL=http://localhost:8025 PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... node e2e/finance.mjs
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR ?? 'e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });
if (!process.env.PLATFORM_ADMIN_EMAIL || !process.env.MAILPIT_URL) throw new Error('Faltan PLATFORM_ADMIN_EMAIL/PLATFORM_ADMIN_PASSWORD y MAILPIT_URL');
const stamp = Date.now().toString(36);
const company = `Ferretería Margen ${stamp}`;
const results = [];
let page;
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    await page?.screenshot({ path: `${SHOTS}/rentabilidad-fallo.png`, fullPage: true }).catch(() => undefined);
    console.log(`✗ ${name}\n  ${e.message.split('\n').slice(0, 3).join('\n  ')}`);
    throw e;
  }
};

const token = (await (await fetch(`${WEB}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.PLATFORM_ADMIN_EMAIL, password: process.env.PLATFORM_ADMIN_PASSWORD }) })).json()).accessToken;
const call = async (method, path, body) => {
  const r = await fetch(`${WEB}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};
const prevSettings = await call('GET', '/platform/finance/settings');
const mail = async (match) => {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${process.env.PLATFORM_ADMIN_EMAIL}`)}`).then((x) => x.json());
    const found = (r.messages ?? []).filter((x) => x.Subject === match);
    if (found.length) return found;
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`No llegó el correo «${match}»`);
};

const browser = await chromium.launch();
page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-PE', timezoneId: 'America/Lima' })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const L = (l, scope = page) => scope.getByLabel(l, { exact: true });
const toast = (t) => page.getByText(t, { exact: true }).first().waitFor();
let tenantId;

try {
  await step('Empresa con su plan pagado (S/ 120 al mes)', async () => {
    tenantId = (await call('POST', '/platform/tenants', {
      idempotencyKey: randomUUID(), name: company, country: 'PE', currency: 'PEN', timezone: 'America/Lima', businessType: 'RETAIL', deploymentMode: 'SAAS',
      enabledModules: ['conversations', 'ai', 'catalog', 'orders'], planCode: 'PROFESSIONAL', endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      admin: { name: `Beto ${stamp}`, email: `beto-${stamp}@ferreteria.test` },
    })).tenant.id;
    await call('POST', `/platform/tenants/${tenantId}/payments`, { planCode: 'PROFESSIONAL', months: 1, amount: 120, currency: 'PEN', method: 'YAPE', reference: `YAPE-${stamp}` });
    await call('PUT', '/platform/finance/settings', { baseCurrency: 'PEN', rates: {} });
  });

  await step('Sin costos registrados el margen no se calcula y se dice qué falta', async () => {
    await page.goto(`${WEB}/login`);
    await L('Correo').fill(process.env.PLATFORM_ADMIN_EMAIL);
    await L('Contraseña').fill(process.env.PLATFORM_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL(/\/plataforma$/);
    await page.getByRole('navigation', { name: 'Menú principal' }).getByRole('link', { name: 'Rentabilidad' }).click();
    await page.getByText('Ingreso recurrente mensual').waitFor();
    await L('Buscar empresa').fill(company);
    const row = page.getByRole('row').filter({ hasText: company });
    await row.getByText(/S\/\s?120\.00/).waitFor();
    await row.getByText(/No se calcula: faltan \d+ dato\(s\)/).waitFor();
    await row.getByRole('link', { name: company }).click();
    await page.waitForURL(/\/plataforma\/rentabilidad\/[0-9a-f-]{36}/);
    await page.getByText('Último pago del plan, por mes').waitFor();
    const missing = page.getByRole('list', { name: 'Datos que faltan' });
    await missing.getByText(/^Costo de servidor: usa el servidor compartido/).waitFor();
    await missing.getByText(/^Costo de whatsapp: sin registrar/).waitFor();
    await page.screenshot({ path: `${SHOTS}/rentabilidad-faltan-datos.png`, fullPage: true });
  });

  await step('Registrar costos: con una partida en USD falta el tipo de cambio', async () => {
    const form = page.getByRole('form', { name: 'Registrar costo' });
    for (const [category, description, amount, currency] of [
      ['SERVER', 'Parte del servidor compartido', '30', 'PEN'], ['WHATSAPP', 'Usa su propia cuenta de Meta', '0', 'PEN'], ['STORAGE', 'Imágenes', '2', 'PEN'],
      ['EXTERNAL', 'Correo transaccional', '5', 'USD'], ['SUPPORT', 'Dos horas de soporte', '10', 'PEN'],
    ]) {
      await L('Concepto de costo', form).selectOption(category);
      await L('Descripción', form).fill(description);
      await L('Importe', form).fill(amount);
      await L('Moneda', form).fill(currency);
      await form.getByRole('button', { name: 'Registrar costo' }).click();
      await toast('Costo registrado');
      await page.getByText(new RegExp(`: ${description} · `)).waitFor();
    }
    await page.getByRole('list', { name: 'Datos que faltan' }).getByText('Tipo de cambio USD → PEN').waitFor();
    if (await page.getByRole('list', { name: 'Datos que faltan' }).getByText(/^Costo de/).count()) throw new Error('Aún falta algún costo');
  });

  await step('Con el tipo de cambio aparece el margen estimado: S/ 59.25 (49.4%)', async () => {
    await page.getByRole('link', { name: 'Rentabilidad' }).first().click();
    await L('Tipos de cambio').fill('USD=3.75');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await toast('Tipos de cambio guardados');
    await L('Buscar empresa').fill(company);
    const row = page.getByRole('row').filter({ hasText: company });
    // 120 − (30 + 0 + 2 + 5 × 3.75 + 10) = 59.25
    await row.getByText(/S\/\s?59\.25 \(49\.4%\)/).waitFor();
    await page.screenshot({ path: `${SHOTS}/rentabilidad-resumen.png`, fullPage: true });
    await row.getByRole('link', { name: company }).click();
    await page.getByText(/Ingreso S\/\s?120\.00 − costos S\/\s?60\.75/).waitFor();
  });

  await step('Presupuesto de costos totales superado: alerta por correo una sola vez', async () => {
    const form = page.getByRole('form', { name: 'Presupuesto de costos totales' });
    await L('Monto (costos totales)', form).fill('50');
    await form.getByRole('button', { name: 'Guardar presupuesto' }).click();
    await toast('Presupuesto de costos totales guardado');
    await page.getByRole('form', { name: 'Presupuesto de costos totales' }).getByText('Superado').waitFor();
    await call('POST', '/platform/finance/alerts/check');
    await call('POST', '/platform/finance/alerts/check');
    const sent = await mail(`${company}: se superó el presupuesto de costos totales`);
    if (sent.length !== 1) throw new Error(`Se enviaron ${sent.length} alertas`);
    await page.reload();
    await page.getByText(/· Total · superado · 60\.75 de 50\.00 PEN/).waitFor();
    await page.screenshot({ path: `${SHOTS}/rentabilidad-detalle.png`, fullPage: true });
  });

  await step('Terminar una partida conserva el historial', async () => {
    await page.getByRole('button', { name: 'Terminar Dos horas de soporte' }).click();
    await toast('Partida terminada hoy');
    await page.getByText(/Desde \d{4}-\d{2}-\d{2} hasta \d{4}-\d{2}-\d{2}/).waitFor();
  });

  if (errors.length) throw new Error(`Errores de JavaScript en la página: ${errors.join(' | ')}`);
} finally {
  await call('PUT', '/platform/finance/settings', { baseCurrency: prevSettings.baseCurrency, rates: prevSettings.rates }).catch((e) => console.log(`No se restauraron los tipos de cambio: ${e.message}`));
  await browser.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} pasos correctos`);
  process.exitCode = ok === results.length && !errors.length ? 0 : 1;
}
