/**
 * Entrega de sistemas (evolución, fase 8) en navegador real: la plataforma
 * prepara la entrega de una instancia dedicada, revisa requisitos y
 * pendientes, descarga el ZIP (huella SHA-256 igual a la mostrada, sin
 * secretos, instalador ejecutable), lo vuelve a descargar idéntico y lo marca
 * como entregado.
 *
 *   PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... node e2e/deliveries.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR ?? 'e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);
const company = `Ferretería ${stamp}`;
const domain = `ventas-${stamp}.cliente.test`;
const work = mkdtempSync(join(tmpdir(), 'entrega-e2e-'));

const results = [];
const errors = [];
let shot;
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    await shot?.screenshot({ path: `${SHOTS}/entregas-fallo.png` }).catch(() => undefined);
    console.log(`✗ ${name}\n  ${e.message.split('\n').slice(0, 3).join('\n  ')}`);
    throw e;
  }
};

// Empresa dedicada creada por la API de la plataforma (el alta en navegador ya la prueba provisioning.mjs)
const login = await fetch(`${WEB}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.PLATFORM_ADMIN_EMAIL, password: process.env.PLATFORM_ADMIN_PASSWORD }) }).then((r) => r.json());
const created = await fetch(`${WEB}/api/v1/platform/tenants`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` },
  body: JSON.stringify({
    idempotencyKey: randomUUID(), name: company, legalName: null, taxId: null, country: 'PE', currency: 'PEN', timezone: 'America/Lima', address: null, phone: null,
    contactEmail: null, businessType: 'RETAIL', logoUrl: null, brandColor: null, customDomain: domain, deploymentMode: 'DEDICATED',
    enabledModules: ['conversations', 'ai', 'catalog', 'inventory', 'orders', 'customers', 'reports'], templateKey: 'RETAIL', planCode: 'PROFESSIONAL',
    endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), admin: { name: 'Ana Ferretería', email: `ferre-${stamp}@example.com` },
  }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
if (created.status !== 201) throw new Error(`No se pudo crear la empresa: ${JSON.stringify(created.body)}`);
const tenantId = created.body.tenant.id;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'es-PE', timezoneId: 'America/Lima', acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
shot = page;
const L = (l) => page.getByLabel(l, { exact: true });

async function downloadPackage(card, name) {
  const [dl] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name }).click()]);
  const file = join(work, `${randomUUID()}-${dl.suggestedFilename()}`);
  await dl.saveAs(file);
  return { file, name: dl.suggestedFilename(), bytes: readFileSync(file) };
}

try {
  let first;
  await step('Preparar la entrega: requisitos, pendientes y acceso inicial a la vista', async () => {
    await page.goto(`${WEB}/login`);
    await L('Correo').fill(process.env.PLATFORM_ADMIN_EMAIL);
    await L('Contraseña').fill(process.env.PLATFORM_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL(/\/plataforma$/);
    await page.goto(`${WEB}/plataforma?empresa=${tenantId}`);
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('heading', { name: 'Entrega del sistema' }).waitFor();
    if ((await dlg.getByLabel('Dominio de la instalación').inputValue()) !== domain) throw new Error('No propone el dominio de la empresa');
    await dlg.getByLabel('Contacto de soporte').fill('soporte@plataforma.test · WhatsApp +51 900 000 000');
    await dlg.getByRole('button', { name: 'Preparar entrega' }).click();
    await page.getByText(/Entrega n\.º 1 preparada/).waitFor();
    await dlg.getByText('Servidor Linux con Docker').waitFor();
    await dlg.getByText(/WhatsApp Business \(Cloud API\): Sin números conectados/).waitFor();
    await dlg.getByText(`ferre-${stamp}@example.com · Recibirá una invitación al instalar`).waitFor();
    await dlg.getByRole('heading', { name: 'Entrega del sistema' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/entregas-preparada.png` });
  });

  await step('Generar y descargar el ZIP: huella igual a la mostrada, instalador ejecutable y sin secretos', async () => {
    const dlg = page.getByRole('dialog');
    const item = dlg.getByRole('listitem').filter({ hasText: '#1 ·' });
    first = await downloadPackage(item, 'Generar paquete');
    if (!first.name.startsWith(`entrega-`) || !first.name.endsWith('-1-v0.8.0.zip')) throw new Error(`Nombre inesperado: ${first.name}`);
    const sha = createHash('sha256').update(first.bytes).digest('hex');
    await item.getByText(`SHA-256 ${sha}`).waitFor();
    await item.getByText('Paquete generado').waitFor();
    const out = join(work, 'x');
    execFileSync('unzip', ['-q', first.file, '-d', out]);
    execFileSync('sha256sum', ['-c', '--quiet', 'SHA256SUMS'], { cwd: out });
    if (!(statSync(join(out, 'instalacion/instalar.sh')).mode & 0o111)) throw new Error('instalar.sh no es ejecutable');
    const env = readFileSync(join(out, 'instalacion/.env.production.example'), 'utf8');
    if (!env.includes(`APP_DOMAIN=${domain}`) || !/^JWT_SECRET=__GENERATE__$/m.test(env)) throw new Error('El .env de ejemplo no es el esperado');
    const all = execFileSync('cat', execFileSync('find', [out, '-type', 'f']).toString().trim().split('\n')).toString();
    for (const s of [process.env.JWT_SECRET, process.env.DATA_ENCRYPTION_KEY, process.env.APP_DB_SYSTEM_PASSWORD, process.env.PLATFORM_ADMIN_PASSWORD].filter(Boolean)) {
      if (all.includes(s)) throw new Error('El paquete contiene un secreto del servidor');
    }
    // --verificar no instala nada: sin .env.production se detiene con error y no crea el archivo
    const r = spawnSync('bash', [join(out, 'instalacion/instalar.sh'), '--verificar'], { encoding: 'utf8' });
    if (r.status !== 1 || !r.stdout.includes('Falta .env.production') || !r.stdout.includes('No se instala nada')) throw new Error(`instalar.sh --verificar inesperado (${r.status}): ${r.stdout.slice(-400)}`);
    if (existsSync(join(out, 'instalacion/.env.production'))) throw new Error('--verificar creó .env.production');
  });

  await step('Volver a descargar da exactamente los mismos bytes; se marca entregada', async () => {
    const dlg = page.getByRole('dialog');
    const item = dlg.getByRole('listitem').filter({ hasText: '#1 ·' });
    const again = await downloadPackage(item, 'Descargar');
    if (!again.bytes.equals(first.bytes)) throw new Error('El paquete no es reproducible');
    await item.getByRole('button', { name: 'Marcar entregada' }).click();
    await page.getByText('Entrega n.º 1 marcada como entregada').waitFor();
    await item.getByText('Entregada', { exact: true }).waitFor();
    await page.screenshot({ path: `${SHOTS}/entregas-entregada.png` });
  });
} catch {
  /* el paso ya informó */
} finally {
  await browser.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} pasos correctos${errors.length ? ` · errores de página: ${errors.join(' | ')}` : ''}`);
  process.exit(ok === results.length && results.length === 3 && !errors.length ? 0 : 1);
}
