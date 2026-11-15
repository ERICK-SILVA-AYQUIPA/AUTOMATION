/**
 * Instalaciones automáticas (ADR 051) en navegador real. Arranca aquí mismo el
 * servidor local que responde como Hetzner (puerto 4996) y, cuando el servidor
 * «se crea», ejecuta el agente real (infrastructure/kit/agente.sh) contra la API
 * con Docker y el sistema sustituidos (apps/api/test/agent-harness.ts). La API y
 * el worker deben tener HETZNER_API_BASE_URL=http://127.0.0.1:4996/v1 y
 * PROVISIONING_IMAGES_DIR con un aisa-imagenes-<versión>.tar.gz y su .sha256.
 * El dominio de prueba no existe: la comprobación desde afuera falla y reintenta,
 * y la prueba termina cancelando y eliminando el servidor.
 *
 *   WEB_URL=http://localhost:3000 PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... node e2e/orchestrator.mjs
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { startFakeHetzner } = await import('../../api/test/fake-hetzner.ts');
const { runAgent } = await import('../../api/test/agent-harness.ts');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API = process.env.API_URL ?? 'http://localhost:4000';
const SHOTS = process.env.SHOTS_DIR ?? 'e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });
if (!process.env.PLATFORM_ADMIN_EMAIL) throw new Error('Faltan PLATFORM_ADMIN_EMAIL/PLATFORM_ADMIN_PASSWORD');
const stamp = Date.now().toString(36);
const company = `Distribuidora ${stamp}`;
const domain = `ventas-${stamp}.distribuidora.test`;
const label = `Hetzner orquestador ${stamp}`;
const fake = await startFakeHetzner(4996);

const results = [];
const consoleErrors = [];
let page;
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message.split('\n')[0] });
    await page?.screenshot({ path: `${SHOTS}/instalaciones-fallo.png`, fullPage: true }).catch(() => undefined);
    if (consoleErrors.length) console.log(`  Consola: ${consoleErrors.slice(0, 3).join(' | ').slice(0, 800)}`);
    console.log(`✗ ${name}\n  ${e.message.split('\n').slice(0, 3).join('\n  ')}`);
    throw e;
  }
};
const L = (l, scope = page) => scope.getByLabel(l, { exact: true });
const toast = (t) => page.getByText(t, { exact: true }).first().waitFor();
let token;
const call = async (method, path, body) => {
  const r = await fetch(`${WEB}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-PE', timezoneId: 'America/Lima' });
page = await ctx.newPage();
page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message));
let runUrl;
let providerId;

try {
  await step('Preparación por API: proveedor, clave SSH y una orden pagada convertida en empresa dedicada', async () => {
    token = (await (await fetch(`${WEB}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.PLATFORM_ADMIN_EMAIL, password: process.env.PLATFORM_ADMIN_PASSWORD }) })).json()).accessToken;
    providerId = (await call('POST', '/platform/infra/providers', { kind: 'HETZNER', token: `${'A'.repeat(60)}okok`, label, monthlyBudget: '50.00', maxServers: 20, allowedLocations: [], allowedServerTypes: [], defaultImage: 'ubuntu-24.04', sshSourceCidrs: [] })).id;
    const keys = await call('GET', '/platform/infra/ssh-keys');
    if (!keys.some((k) => k.isActive)) await call('POST', '/platform/infra/ssh-keys', { name: `Laptop ${stamp}`, publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq1bU3nqUuU9lF2m6fKcWQ9Qm9w2iXz7m0rA3S2bKpX admin@laptop' });
    const lead = (await call('POST', '/platform/sales/leads', { name: `Ana ${stamp}`, company, email: `ana-${stamp}@distribuidora.test`, source: 'REFERRAL' })).id;
    await call('POST', `/platform/sales/leads/${lead}/status`, { status: 'PAYMENT_PENDING' });
    await call('POST', `/platform/sales/leads/${lead}/payment`, { amount: '1500', currency: 'PEN', method: 'BANK_TRANSFER', reference: `TR-${stamp}`, paidAt: new Date().toISOString(), verifiedInAccount: true });
    await call('POST', '/platform/tenants', {
      idempotencyKey: randomUUID(), leadId: lead, name: company, country: 'PE', currency: 'PEN', timezone: 'America/Lima', businessType: 'RETAIL', deploymentMode: 'DEDICATED',
      enabledModules: ['conversations', 'ai', 'catalog', 'orders'], planCode: 'PROFESSIONAL', endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      admin: { name: `Ana ${stamp}`, email: `ana-${stamp}@distribuidora.test` }, templateKey: 'RETAIL',
    });
  });

  await step('Registrar la instalación: orden pagada, región y tamaño con precio, dominio y SMTP (contraseña oculta)', async () => {
    await page.goto(`${WEB}/login`);
    await L('Correo').fill(process.env.PLATFORM_ADMIN_EMAIL);
    await L('Contraseña').fill(process.env.PLATFORM_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL(/\/plataforma$/);
    await page.getByRole('navigation', { name: 'Menú principal' }).getByRole('link', { name: 'Instalaciones automáticas' }).click();
    await page.waitForURL(/\/plataforma\/aprovisionamiento$/);
    await page.getByRole('button', { name: 'Nueva instalación' }).click();
    const dlg = page.getByRole('dialog');
    const orderSel = L('Orden de instalación pagada', dlg);
    await orderSel.locator('option', { hasText: company }).waitFor({ state: 'attached' });
    await orderSel.selectOption(await orderSel.locator('option', { hasText: company }).getAttribute('value'));
    await L('Proveedor', dlg).selectOption({ label });
    await dlg.getByText(`Empresa: ${company}`).waitFor();
    await L('Región', dlg).selectOption('fsn1');
    await L('Tamaño', dlg).selectOption('cx23');
    await dlg.getByText(/Costo del servidor: EUR\s3\.79 por mes/).waitFor();
    await L('Dominio del cliente', dlg).fill(domain);
    await L('Contacto de soporte', dlg).fill('soporte@plataforma.test · +51 900 000 000');
    await L('Servidor SMTP', dlg).fill('smtp.brevo.test');
    await L('Usuario SMTP', dlg).fill('ventas@distribuidora.test');
    await L('Contraseña SMTP', dlg).fill('smtp-secreta-123');
    if ((await L('Contraseña SMTP', dlg).getAttribute('type')) !== 'password') throw new Error('La contraseña SMTP se ve en pantalla');
    await L('Remitente', dlg).fill('Ventas <no-reply@distribuidora.test>');
    await dlg.getByRole('button', { name: 'Registrar instalación' }).click();
    await page.waitForURL(/\/plataforma\/aprovisionamiento\/[0-9a-f-]{36}$/);
    runUrl = page.url();
    await page.getByRole('heading', { name: new RegExp(`Instalación #\\d+ · ${domain.replace(/\./g, '\\.')}`) }).waitFor();
    // El worker avanza solo: pago confirmado, preparación y pedido del servidor
    await page.getByText('El servidor espera tu aprobación', { exact: false }).waitFor({ timeout: 90_000 });
    if (await page.getByText('smtp-secreta-123').count()) throw new Error('La contraseña SMTP aparece en la página');
    await page.screenshot({ path: `${SHOTS}/instalaciones-espera-aprobacion.png`, fullPage: true });
  });

  let serverIp;
  await step('Aprobar el gasto en Infraestructura crea el servidor; la instalación lo ve encendido y pide el DNS', async () => {
    await page.getByRole('link', { name: 'Aprobar en Infraestructura' }).click();
    const req = page.locator('div.rounded-xl', { has: page.getByText(domain, { exact: false }) }).filter({ has: page.getByRole('button', { name: 'Aprobar y crear' }) }).last();
    const name = (await req.getByText(/#\d+ · aisa-/).first().textContent()).replace(/^#\d+ · /, '').trim();
    await req.getByRole('button', { name: 'Aprobar y crear' }).click();
    const dlg = page.getByRole('dialog');
    await L(`Escribe el nombre del servidor (${name})`, dlg).fill(name);
    await dlg.getByLabel('Autorizo este gasto mensual estimado').check();
    await dlg.getByRole('button', { name: 'Aprobar y crear servidor' }).click();
    await toast(`Servidor ${name} creado`);
    await page.goto(runUrl);
    await page.getByRole('heading', { name: 'Apunta el dominio al servidor' }).waitFor({ timeout: 90_000 });
    serverIp = (await page.locator('code').nth(1).textContent()).trim();
    if (!/^203\.0\.113\.\d+$/.test(serverIp)) throw new Error(`IP inesperada: ${serverIp}`);
    const create = fake.calls.findLast((c) => c.method === 'POST' && c.path === '/servers');
    if (!String(create.body.user_data).includes('/bootstrap') || String(create.body.user_data).includes('smtp-secreta-123')) throw new Error('cloud-init inesperado');
  });

  await step('El servidor nuevo (agente real) se instala e informa cada paso; la plataforma prueba desde afuera', async () => {
    const create = fake.calls.findLast((c) => c.method === 'POST' && c.path === '/servers');
    const ud = String(create.body.user_data);
    const runId = /RUN='([^']+)'/.exec(ud)[1];
    const bootToken = /printf '\{"token":"%s"\}' '([A-Za-z0-9_-]+)'/.exec(ud)[1];
    // Lo que hace cloud-init al arrancar
    const boot = await (await fetch(`${API}/api/v1/public/provisioning/${runId}/bootstrap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: bootToken }) })).json();
    if (!boot.env) throw new Error(`Arranque rechazado: ${JSON.stringify(boot)}`);
    const version = /APP_VERSION='([^']+)'/.exec(boot.env)[1];
    // «node dist/cli.js estado» de verdad (lo que el contenedor de la API calcula en el servidor)
    const estado = execFileSync('node', ['../api/dist/cli.js', 'estado', '--sano', 'true'], { encoding: 'utf8' }).trim().split('\n').at(-1);
    if (!estado.startsWith('{"version"')) throw new Error(`estado inesperado: ${estado.slice(0, 200)}`);
    const a = await runAgent({ env: boot.env, ip: serverIp, domain, version, estado });
    if (a.code !== 0) throw new Error(`El agente terminó con ${a.code}:\n${a.log.split('\n').slice(-15).join('\n')}`);
    await page.reload();
    const steps = page.getByRole('list', { name: 'Pasos de la instalación' });
    await steps.locator('li[aria-current="step"]', { hasText: 'Ejecutando pruebas' }).waitFor({ timeout: 60_000 });
    for (const t of ['Docker listo', 'Paquete verificado, imágenes listas y configuración escrita', 'Migraciones aplicadas', 'respaldo diario']) await page.getByText(t, { exact: false }).first().waitFor();
    // El dominio de prueba no existe: la comprobación falla y se reintenta con espera
    await page.getByText(/Intento \d+ de 40: .*no resuelve en DNS/).first().waitFor({ timeout: 90_000 });
    await page.screenshot({ path: `${SHOTS}/instalaciones-pruebas.png`, fullPage: true });
  });

  await step('La instalación reporta su salud y la puesta en marcha (WhatsApp, IA, correo, automatizaciones) al panel', async () => {
    const card = page.locator('div.rounded-xl', { has: page.getByRole('heading', { name: 'Puesta en marcha y monitoreo' }) });
    await card.getByText(/Último reporte .* · versión \d+\.\d+\.\d+ · servicios sanos/).waitFor();
    const ints = card.getByRole('list', { name: /^Integraciones de / }).first();
    for (const t of ['WhatsApp', 'IA (asistente)', 'Correo', 'Automatizaciones']) await ints.getByText(t, { exact: false }).first().waitFor();
    await card.getByRole('list', { name: /^Puesta en marcha de / }).first().waitFor();
    await page.getByText(/Primer reporte de la instalación: Versión/).first().waitFor();
    await card.screenshot({ path: `${SHOTS}/instalaciones-monitoreo.png` });
  });

  await step('Cancelar exige motivo y, para eliminar el servidor, escribir su nombre', async () => {
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    const dlg = page.getByRole('dialog');
    const go = dlg.getByRole('button', { name: 'Cancelar instalación' });
    await L('Motivo', dlg).fill('Fin de la prueba automática');
    const box = dlg.getByRole('checkbox');
    const server = (await dlg.getByText(/Eliminar también el servidor/).textContent()).match(/servidor (\S+)/)[1];
    await box.check();
    if (await go.isEnabled()) throw new Error('Se puede eliminar el servidor sin escribir su nombre');
    await L(`Escribe el nombre del servidor (${server})`, dlg).fill(server);
    await go.click();
    await toast('Instalación cancelada');
    await page.getByText('Cancelada: Fin de la prueba automática').first().waitFor();
    await page.getByText(`${server} · ${serverIp} (eliminado)`, { exact: false }).waitFor();
    await page.getByText('Monitoreo revocado', { exact: true }).waitFor();
    await page.screenshot({ path: `${SHOTS}/instalaciones-cancelada.png`, fullPage: true });
  });
} finally {
  try {
    if (providerId) await call('POST', `/platform/infra/providers/${providerId}/disabled`, { disabled: true });
  } catch (e) {
    console.log(`No se desactivó el proveedor de prueba: ${e.message}`);
  }
  await browser.close();
  await fake.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} pasos correctos`);
  process.exitCode = results.every((r) => r.ok) && !consoleErrors.length ? 0 : 1;
}
