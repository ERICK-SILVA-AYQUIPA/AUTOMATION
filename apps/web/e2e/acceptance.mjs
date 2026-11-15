/**
 * Escenario de aceptación de la ampliación (§16) en navegador real, dos veces
 * (dos empresas) con el mismo código y sin compartir datos ni credenciales:
 *
 *   visitante en la página comercial → agente comercial → solicitud → asistente
 *   «Nueva venta e instalación» → cotización real → aceptación del cliente →
 *   pago informado y validado → orden de instalación → empresa → instalación
 *   automática → API del proveedor (servidor local con los formatos de Hetzner,
 *   puerto 4996) → servidor → agente real (infrastructure/kit/agente.sh con
 *   Docker y el sistema sustituidos) → paquete de entrega → monitoreo.
 *
 * Lo que necesita servicios reales queda indicado como pendiente al final y no
 * se da por probado: WhatsApp (Meta), Gemini, DNS y HTTPS reales, y por lo tanto
 * las pruebas desde afuera, el correo de acceso y la entrega.
 *
 * La IA del agente comercial es el servidor local de apps/api/test/fake-ai-providers.ts
 * (puerto 4997; la API debe apuntar a él, como en commercial.mjs). La API y el
 * worker deben tener HETZNER_API_BASE_URL=http://127.0.0.1:4996/v1 y
 * PROVISIONING_IMAGES_DIR (ver orchestrator.mjs). Al terminar cancela ambas
 * instalaciones eliminando sus servidores y deja la configuración como estaba.
 *
 *   WEB_URL=http://localhost:3000 MAILPIT_URL=http://localhost:8025 \
 *   PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... node e2e/acceptance.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { startFakeHetzner } = await import('../../api/test/fake-hetzner.ts');
const { startFakeAiProviders } = await import('../../api/test/fake-ai-providers.ts');
const { runAgent } = await import('../../api/test/agent-harness.ts');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API = process.env.API_URL ?? 'http://localhost:4000';
const SHOTS = process.env.SHOTS_DIR ?? 'e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });
if (!process.env.PLATFORM_ADMIN_EMAIL || !process.env.MAILPIT_URL) throw new Error('Faltan PLATFORM_ADMIN_EMAIL/PLATFORM_ADMIN_PASSWORD y MAILPIT_URL');
const stamp = Date.now().toString(36);
const label = `Hetzner aceptación ${stamp}`;
const fakeHetzner = await startFakeHetzner(4996);
const fakeAi = await startFakeAiProviders(Number(process.env.FAKE_AI_PORT ?? 4997));

const results = [];
const consoleErrors = [];
let current;
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message.split('\n')[0] });
    await current?.screenshot({ path: `${SHOTS}/aceptacion-fallo.png`, fullPage: true }).catch(() => undefined);
    if (consoleErrors.length) console.log(`  Consola: ${consoleErrors.slice(0, 3).join(' | ').slice(0, 800)}`);
    console.log(`✗ ${name}\n  ${e.message.split('\n').slice(0, 3).join('\n  ')}`);
    throw e;
  }
};
const L = (scope, l) => scope.getByLabel(l, { exact: true });

// Sesión del administrador por API: solo para preparar la configuración y restaurarla al final
const token = (await (await fetch(`${WEB}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.PLATFORM_ADMIN_EMAIL, password: process.env.PLATFORM_ADMIN_PASSWORD }) })).json()).accessToken;
const call = async (method, path, body) => {
  const r = await fetch(`${WEB}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};
const mail = async (to, subject) => {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`).then((x) => x.json());
    const m = (r.messages ?? []).find((x) => x.Subject.includes(subject));
    if (m) return m;
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`No llegó a ${to} el correo «${subject}»`);
};

const omit = (o, ...keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const commercialBefore = await call('GET', '/platform/commercial');
const settingsBefore = await call('GET', '/platform/commerce/settings');
const created = { credentialId: null, house: null, items: [], methodId: null, providerId: null, runs: [] };

const browser = await chromium.launch();
const newPage = async (w = 1440) => {
  const p = await (await browser.newContext({ viewport: { width: w, height: 900 }, locale: 'es-PE', timezoneId: 'America/Lima' })).newPage();
  p.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && consoleErrors.push(m.text()));
  p.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message));
  return p;
};

const companies = [
  { key: 'A', person: 'Ana Quispe', company: `Bodega Ana ${stamp}`, email: `ana-${stamp}@aceptacion.test`, domain: `ventas-ana-${stamp}.aceptacion.test`, smtpPassword: `smtp-ana-${stamp}` },
  { key: 'B', person: 'Beto Rojas', company: `Ferretería Beto ${stamp}`, email: `beto-${stamp}@aceptacion.test`, domain: `ventas-beto-${stamp}.aceptacion.test`, smtpPassword: `smtp-beto-${stamp}` },
];

try {
  await step('Preparación: página comercial publicada con su agente, emisor, contrato, método de pago, catálogo y proveedor', async () => {
    const house = commercialBefore.tenants[0];
    if (!house) throw new Error('No hay empresas para usar como empresa interna');
    created.house = house;
    const c = await call('POST', '/platform/api-center/credentials', { provider: 'anthropic', label: `Claude aceptación ${stamp}`, fields: { apiKey: `sk-ant-local-${stamp}-aceptacion-01` } });
    created.credentialId = c.id;
    await call('POST', `/platform/api-center/credentials/${c.id}/models/refresh`);
    await call('PUT', `/platform/api-center/tenants/${house.id}/ai/COMMERCIAL`, { credentialId: c.id, model: 'claude-prueba-chica' });
    await call('PUT', '/platform/commercial', { ...omit(commercialBefore, 'agent', 'tenants', 'publishedAt', 'updatedAt'), published: true, headline: `Vende por WhatsApp con tu catálogo real ${stamp}`, subheadline: 'Atiende, cotiza y registra pedidos con IA.', chatEnabled: true, agentName: 'Sofía', houseTenantId: house.id });
    await call('PUT', '/platform/commerce/settings', { ...omit(settingsBefore, 'contactEmail'), legalName: `Soluciones de Prueba ${stamp} S.A.C.`, taxId: '20123456789', address: 'Av. Siempre Viva 123, Lima', taxName: 'IGV', taxRate: '18', pricesIncludeTax: true, quoteTerms: 'Precios en soles. La mensualidad se paga por adelantado.' });
    if (!(await call('GET', '/platform/commerce/contracts')).length) await call('POST', '/platform/commerce/contracts', { title: 'Contrato de servicio', body: 'Contrato de servicio de prueba. Cláusula 1: objeto. Cláusula 2: pagos. Cláusula 3: soporte y renovación.' });
    created.methodId = (await call('POST', '/platform/commerce/payment-methods', { kind: 'YAPE', name: `Yape aceptación ${stamp}`, instructions: 'Yape al 999 888 777 a nombre de Soluciones de Prueba', countries: ['pe'], currencies: ['PEN'] })).id;
    for (const it of [
      { code: `PLAN-DED-${stamp}`, name: `Plan Profesional dedicado ${stamp}`, kind: 'PLAN', billing: 'MONTHLY', unitPrice: '399', currency: 'PEN', planCode: 'PROFESSIONAL', unit: 'mes' },
      { code: `INST-DED-${stamp}`, name: `Instalación en servidor dedicado ${stamp}`, kind: 'SETUP', billing: 'ONE_TIME', unitPrice: '1500', currency: 'PEN' },
    ]) created.items.push((await call('POST', '/platform/commerce/items', it)).id);
    created.providerId = (await call('POST', '/platform/infra/providers', { kind: 'HETZNER', token: `${'A'.repeat(60)}okok`, label, monthlyBudget: '100.00', maxServers: 20, allowedLocations: [], allowedServerTypes: [], defaultImage: 'ubuntu-24.04', sshSourceCidrs: [] })).id;
    const keys = await call('GET', '/platform/infra/ssh-keys');
    if (!keys.some((k) => k.isActive)) await call('POST', '/platform/infra/ssh-keys', { name: `Laptop ${stamp}`, publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq1bU3nqUuU9lF2m6fKcWQ9Qm9w2iXz7m0rA3S2bKpX admin@laptop' });
  });

  const admin = await newPage();
  current = admin;
  await admin.goto(`${WEB}/login`);
  await L(admin, 'Correo').fill(process.env.PLATFORM_ADMIN_EMAIL);
  await L(admin, 'Contraseña').fill(process.env.PLATFORM_ADMIN_PASSWORD);
  await admin.getByRole('button', { name: 'Entrar' }).click();
  await admin.waitForURL(/\/plataforma$/);
  const wizardAt = async (url, n, title) => {
    await admin.goto(url);
    await admin.getByText(`Paso ${n} de 12`, { exact: true }).waitFor({ timeout: 20_000 });
    const cur = admin.getByRole('list', { name: 'Pasos de la venta' }).locator('li[aria-current="step"]');
    await cur.getByRole('heading', { name: `Paso ${n}: ${title}` }).waitFor();
    return cur;
  };

  for (const co of companies) {
    let wizardUrl;
    let quoteCode;
    let proposalUrl;
    let paymentId;
    let runUrl;
    let serverIp;

    await step(`${co.key} · 1-4. Un negocio visita la página, consulta al agente comercial y pide una propuesta`, async () => {
      const visitor = await newPage(1280);
      current = visitor;
      await visitor.goto(`${WEB}/`);
      await visitor.getByRole('heading', { name: `Vende por WhatsApp con tu catálogo real ${stamp}`, level: 1 }).waitFor({ timeout: 15_000 });
      await visitor.getByRole('button', { name: 'Chatear con Sofía' }).click();
      const chat = visitor.getByRole('dialog', { name: 'Chat con Sofía' });
      await L(chat, 'Mensaje para el asesor').fill('¿qué planes tienen para vender por WhatsApp?');
      await chat.getByRole('button', { name: 'Enviar mensaje' }).click();
      await chat.getByText(/^Agente: /).first().waitFor({ timeout: 20_000 });
      await chat.getByRole('button', { name: 'Cerrar chat' }).click();
      await visitor.getByRole('button', { name: 'Es mi sector' }).first().click();
      const form = visitor.getByRole('form', { name: 'Formulario de contacto' });
      await L(form, 'Nombre').fill(co.person);
      await L(form, 'Empresa').fill(co.company);
      await L(form, 'Correo').fill(co.email);
      await L(form, 'Cuéntanos tu necesidad').fill('Queremos nuestro propio servidor con catálogo y pedidos por WhatsApp. Envíennos una propuesta.');
      await form.getByLabel('Acepto que usen estos datos para responder esta solicitud.').check();
      await form.getByRole('button', { name: 'Enviar solicitud' }).click();
      await visitor.getByRole('status').filter({ hasText: 'Recibimos tu solicitud.' }).waitFor();
      await visitor.screenshot({ path: `${SHOTS}/aceptacion-${co.key}-pagina.png` });
      await visitor.context().close();
      current = admin;
    });

    await step(`${co.key} · Asistente «Nueva venta e instalación»: paso 1 encuentra al cliente; pasos 2-4 en su ficha`, async () => {
      await admin.goto(`${WEB}/plataforma`);
      await admin.getByRole('link', { name: 'Nueva venta e instalación' }).first().click();
      await admin.waitForURL(/\/plataforma\/venta$/);
      await L(admin, 'Buscar prospecto').fill(co.email);
      await admin.getByRole('list', { name: 'Prospectos encontrados' }).getByRole('button', { name: new RegExp(co.company) }).click();
      await admin.waitForURL(/\/plataforma\/venta\/[0-9a-f-]{36}$/);
      wizardUrl = admin.url();
      const cur = await wizardAt(wizardUrl, 2, 'Seleccionar producto y plan');
      await cur.getByRole('link', { name: 'Elegir plan' }).click();
      await admin.waitForURL(/\/plataforma\/ventas\/[0-9a-f-]{36}$/);
      await admin.getByRole('button', { name: 'Editar' }).click();
      await L(admin, 'Modalidad de interés').selectOption('DEDICATED');
      await L(admin, 'Plan de interés').selectOption('PROFESSIONAL');
      for (const m of ['Productos y categorías', 'Pedidos', 'Automatizaciones']) await admin.getByLabel(m, { exact: true }).check();
      await admin.getByRole('button', { name: 'Guardar cambios' }).click();
      await admin.getByRole('button', { name: 'Editar' }).waitFor();
      await wizardAt(wizardUrl, 5, 'Generar cotización');
    });

    await step(`${co.key} · 5. El sistema genera una propuesta real con el catálogo y se envía al cliente`, async () => {
      const cur = admin.getByRole('list', { name: 'Pasos de la venta' }).locator('li[aria-current="step"]');
      await cur.getByRole('link', { name: 'Nueva cotización' }).click();
      await admin.waitForURL(/\/plataforma\/cotizaciones\/nueva\?lead=/);
      if ((await L(admin, 'Modalidad de instalación').inputValue()) !== 'DEDICATED') throw new Error('La cotización no tomó la modalidad');
      for (const name of [`Plan Profesional dedicado ${stamp}`, `Instalación en servidor dedicado ${stamp}`]) {
        const opt = await L(admin, 'Agregar del catálogo').locator('option', { hasText: name }).innerText();
        await L(admin, 'Agregar del catálogo').selectOption({ label: opt });
        await admin.getByRole('button', { name: 'Agregar', exact: true }).click();
      }
      await admin.getByRole('button', { name: 'Crear borrador' }).click();
      await admin.waitForURL(/\/plataforma\/cotizaciones\/[0-9a-f-]{36}$/);
      quoteCode = (await admin.getByRole('heading', { name: /^COT-\d{5} · / }).innerText()).split(' · ')[0];
      await admin.getByText('Pago inicial: S/ 1,899.00').waitFor();
      await admin.getByRole('button', { name: 'Enviar al cliente' }).click();
      await admin.getByRole('dialog').getByRole('button', { name: 'Enviar', exact: true }).click();
      proposalUrl = await L(admin, 'Enlace del cliente').inputValue();
      await admin.getByRole('button', { name: 'Listo' }).click();
      await mail(co.email, `Propuesta ${quoteCode}`);
      await wizardAt(wizardUrl, 6, 'Confirmar contratación y pago');
    });

    await step(`${co.key} · 6-7. El cliente acepta e informa su pago; el equipo lo valida contra la cuenta`, async () => {
      const client = await newPage(390);
      current = client;
      await client.goto(proposalUrl);
      await client.getByRole('heading', { name: `Propuesta ${quoteCode}` }).waitFor();
      await client.getByLabel(/^Acepto la propuesta/).check();
      await client.getByRole('button', { name: 'Aceptar y continuar al pago' }).click();
      await client.waitForURL(/\/pago\/[0-9a-f-]{36}\?t=/);
      paymentId = /\/pago\/([0-9a-f-]{36})/.exec(client.url())[1];
      await L(client, 'Número de operación').fill(`OP${co.key}${stamp}`);
      await L(client, 'Nombre de quien pagó').fill(co.person);
      await client.getByRole('button', { name: 'Informar el pago' }).click();
      await client.getByText(/Recibimos los datos de tu pago/).waitFor();
      await client.context().close();
      current = admin;
      const cur = await wizardAt(wizardUrl, 6, 'Confirmar contratación y pago');
      await cur.getByText('Validar el comprobante contra la cuenta (el comprobante solo no prueba el pago)').waitFor();
      await cur.getByRole('link', { name: 'Validar pago' }).click();
      await admin.waitForURL(new RegExp(`/plataforma/cotizaciones/pagos/${paymentId}$`));
      await admin.getByRole('button', { name: 'Validar pago' }).click();
      const dlg = admin.getByRole('dialog');
      await dlg.getByLabel('Verifiqué el ingreso en la cuenta (no solo el comprobante)').check();
      await L(dlg, 'Importe recibido (PEN)').fill('1899.00');
      await dlg.getByRole('button', { name: 'Confirmar pago' }).click();
      await admin.getByText('Pago validado: se registró el ingreso y la orden de instalación', { exact: true }).first().waitFor();
    });

    await step(`${co.key} · 8. Hay orden de instalación; la empresa se crea con los datos contratados (dedicada)`, async () => {
      const cur = await wizardAt(wizardUrl, 7, 'Aprobar aprovisionamiento');
      await cur.getByText(/Orden de instalación OI-\d{5}/).waitFor();
      await cur.getByRole('link', { name: 'Convertir en empresa' }).click();
      await admin.waitForURL(/\/plataforma\/nueva\?lead=/);
      await admin.getByText(/Convirtiendo en cliente el prospecto P-\d{4,}/).waitFor();
      await admin.getByRole('button', { name: 'Siguiente' }).click();
      if ((await L(admin, 'Nombre comercial').inputValue()) !== co.company) throw new Error('No llegó el nombre de la empresa');
      await admin.getByRole('button', { name: 'Siguiente' }).click();
      if ((await L(admin, 'Modalidad').inputValue()) !== 'DEDICATED') throw new Error('No llegó la modalidad contratada');
      for (let i = 0; i < 3; i++) await admin.getByRole('button', { name: 'Siguiente' }).click();
      await admin.getByRole('button', { name: 'Crear empresa y enviar invitación' }).click();
      await admin.waitForURL(/\/plataforma\/ventas\/[0-9a-f-]{36}$/);
      await mail(co.email, 'Te invitaron a AI Sales Assistant');
    });

    await step(`${co.key} · 9-10. Se registra la instalación y, aprobado el gasto, la API del proveedor crea el servidor`, async () => {
      let cur = await wizardAt(wizardUrl, 7, 'Aprobar aprovisionamiento');
      await cur.getByRole('link', { name: 'Registrar instalación' }).click();
      await admin.waitForURL(/\/plataforma\/aprovisionamiento\?orden=/);
      const dlg = admin.getByRole('dialog');
      await dlg.getByText(`Empresa: ${co.company}`).waitFor({ timeout: 15_000 });
      await L(dlg, 'Proveedor').selectOption({ label });
      await L(dlg, 'Región').selectOption('fsn1');
      await L(dlg, 'Tamaño').selectOption('cx23');
      await L(dlg, 'Dominio del cliente').fill(co.domain);
      await L(dlg, 'Contacto de soporte').fill('soporte@plataforma.test · +51 900 000 000');
      await L(dlg, 'Servidor SMTP').fill('smtp.brevo.test');
      await L(dlg, 'Usuario SMTP').fill(co.email);
      await L(dlg, 'Contraseña SMTP').fill(co.smtpPassword);
      await L(dlg, 'Remitente').fill(`Ventas <no-reply@${co.domain}>`);
      await dlg.getByRole('button', { name: 'Registrar instalación' }).click();
      await admin.waitForURL(/\/plataforma\/aprovisionamiento\/[0-9a-f-]{36}$/);
      runUrl = admin.url();
      created.runs.push(runUrl.split('/').at(-1));
      await admin.getByText('El servidor espera tu aprobación', { exact: false }).waitFor({ timeout: 90_000 });
      cur = await wizardAt(wizardUrl, 8, 'Crear servidor o conectar servidor existente');
      await cur.getByRole('link', { name: 'Aprobar en Infraestructura' }).click();
      await admin.waitForURL(/\/plataforma\/infraestructura\?tab=solicitudes$/);
      const req = admin.locator('div.rounded-xl', { has: admin.getByText(co.domain, { exact: false }) }).filter({ has: admin.getByRole('button', { name: 'Aprobar y crear' }) }).last();
      const name = (await req.getByText(/#\d+ · aisa-/).first().textContent()).replace(/^#\d+ · /, '').trim();
      await req.getByRole('button', { name: 'Aprobar y crear' }).click();
      const ap = admin.getByRole('dialog');
      await L(ap, `Escribe el nombre del servidor (${name})`).fill(name);
      await ap.getByLabel('Autorizo este gasto mensual estimado').check();
      await ap.getByRole('button', { name: 'Aprobar y crear servidor' }).click();
      await admin.getByText(`Servidor ${name} creado`, { exact: true }).first().waitFor();
      await admin.goto(runUrl);
      await admin.getByRole('heading', { name: 'Apunta el dominio al servidor' }).waitFor({ timeout: 90_000 });
      serverIp = (await admin.locator('code').nth(1).textContent()).trim();
      cur = await wizardAt(wizardUrl, 9, 'Desplegar y configurar el sistema');
      await cur.getByText(`Registro DNS A: ${co.domain} → ${serverIp}`).waitFor({ timeout: 30_000 });
    });

    await step(`${co.key} · 11-12, 18, 20. El servidor se instala con su paquete de entrega y reporta al panel`, async () => {
      const create = fakeHetzner.calls.findLast((c) => c.method === 'POST' && c.path === '/servers' && String(c.body.name).includes(co.domain.split('.')[0]));
      const ud = String(create.body.user_data);
      if (ud.includes(co.smtpPassword)) throw new Error('El cloud-init lleva la contraseña SMTP');
      const runId = /RUN='([^']+)'/.exec(ud)[1];
      const boot = await (await fetch(`${API}/api/v1/public/provisioning/${runId}/bootstrap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: /printf '\{"token":"%s"\}' '([A-Za-z0-9_-]+)'/.exec(ud)[1] }) })).json();
      if (!boot.env) throw new Error(`Arranque rechazado: ${JSON.stringify(boot)}`);
      co.env = boot.env;
      co.runId = runId;
      const estado = execFileSync('node', ['../api/dist/cli.js', 'estado', '--sano', 'true'], { encoding: 'utf8' }).trim().split('\n').at(-1);
      const a = await runAgent({ env: boot.env, ip: serverIp, domain: co.domain, version: /APP_VERSION='([^']+)'/.exec(boot.env)[1], estado });
      if (a.code !== 0) throw new Error(`El agente terminó con ${a.code}:\n${a.log.split('\n').slice(-15).join('\n')}`);
      if (!a.envProduction.includes(`SMTP_PASSWORD=${co.smtpPassword}`) || companies.some((o) => o !== co && a.envProduction.includes(o.smtpPassword))) throw new Error('Credenciales SMTP mezcladas');
      await admin.goto(runUrl);
      await admin.getByRole('list', { name: 'Pasos de la instalación' }).locator('li[aria-current="step"]', { hasText: 'Ejecutando pruebas' }).waitFor({ timeout: 60_000 });
      for (const t of ['Paquete verificado, imágenes listas y configuración escrita', 'Migraciones aplicadas', 'respaldo diario', 'Primer reporte de la instalación']) await admin.getByText(t, { exact: false }).first().waitFor();
      await admin.getByRole('heading', { name: 'Puesta en marcha y monitoreo' }).waitFor();
      const cur = await wizardAt(wizardUrl, 10, 'Conectar WhatsApp y Gemini');
      await cur.getByText(/WhatsApp: pendiente/).waitFor();
      await admin.screenshot({ path: `${SHOTS}/aceptacion-${co.key}-asistente.png`, fullPage: true });
    });
  }

  await step('Dos empresas, dos instalaciones: servidores, tokens y credenciales separados', async () => {
    const [a, b] = companies;
    if (a.runId === b.runId) throw new Error('Misma instalación');
    const tok = (env, k) => new RegExp(`${k}='([^']+)'`).exec(env)[1];
    for (const k of ['AGENT_TOKEN', 'MONITOR_TOKEN', 'SMTP_PASSWORD', 'APP_DOMAIN']) if (tok(a.env, k) === tok(b.env, k)) throw new Error(`${k} compartido entre empresas`);
    // El token de una instalación no sirve para la otra
    const r1 = await fetch(`${API}/api/v1/public/provisioning/${a.runId}/report`, { method: 'POST', headers: { Authorization: `Bearer ${tok(b.env, 'AGENT_TOKEN')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ step: 'MIGRATING', state: 'progress', message: 'x' }) });
    const r2 = await fetch(`${API}/api/v1/public/provisioning/${b.runId}/heartbeat`, { method: 'POST', headers: { Authorization: `Bearer ${tok(a.env, 'MONITOR_TOKEN')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: '0.0.0', at: new Date().toISOString(), healthy: true, tenants: [] }) });
    if (r1.status !== 404 || r2.status !== 404) throw new Error(`Un token sirvió para otra instalación (${r1.status}, ${r2.status})`);
    const runs = await Promise.all([a, b].map((c) => call('GET', `/platform/provisioning/runs/${c.runId}`)));
    if (runs[0].server.id === runs[1].server.id || runs[0].installationOrder.tenant.id === runs[1].installationOrder.tenant.id) throw new Error('Servidor o empresa compartidos');
    await admin.goto(`${WEB}/plataforma/venta`);
    for (const c of companies) await admin.getByRole('list', { name: 'Ventas en curso' }).getByText(new RegExp(`${c.company}`)).waitFor();
    await admin.screenshot({ path: `${SHOTS}/aceptacion-ventas-en-curso.png`, fullPage: true });
  });

  if (consoleErrors.length) throw new Error(`Errores en la consola: ${consoleErrors.join(' | ').slice(0, 500)}`);
} finally {
  // Compensación: ninguna de las dos instalaciones deja servidores encendidos
  for (const id of created.runs) {
    try {
      const r = await call('GET', `/platform/provisioning/runs/${id}`);
      if (!['DELIVERED', 'CANCELLED'].includes(r.status)) await call('POST', `/platform/provisioning/runs/${id}/cancel`, { reason: 'Fin de la prueba de aceptación', ...(r.server && !r.server.deletedAt ? { releaseServer: { confirmName: r.server.name } } : {}) });
    } catch (e) {
      console.log(`  No se canceló la instalación ${id}: ${e.message}`);
    }
  }
  if (created.providerId) await call('POST', `/platform/infra/providers/${created.providerId}/disabled`, { disabled: true }).catch((e) => console.log(`  No se desactivó el proveedor: ${e.message}`));
  await call('PUT', '/platform/commercial', omit(commercialBefore, 'agent', 'tenants', 'publishedAt', 'updatedAt')).catch((e) => console.log(`  No se restauró la página: ${e.message}`));
  if (created.house) await call('DELETE', `/platform/api-center/tenants/${created.house.id}/ai/COMMERCIAL`).catch(() => undefined);
  if (created.credentialId) await call('DELETE', `/platform/api-center/credentials/${created.credentialId}`).catch(() => undefined);
  await call('PUT', '/platform/commerce/settings', omit(settingsBefore, 'contactEmail')).catch((e) => console.log(`  No se restauró la configuración: ${e.message}`));
  for (const id of created.items) {
    const it = (await call('GET', '/platform/commerce/items')).find((i) => i.id === id);
    await call('PUT', `/platform/commerce/items/${id}`, { ...omit(it, 'id', 'createdAt', 'updatedAt'), isActive: false }).catch(() => undefined);
  }
  if (created.methodId) {
    const m = (await call('GET', '/platform/commerce/payment-methods')).find((x) => x.id === created.methodId);
    await call('PUT', `/platform/commerce/payment-methods/${m.id}`, { ...omit(m, 'id', 'createdAt', 'updatedAt'), isActive: false }).catch(() => undefined);
  }
  await browser.close();
  await fakeHetzner.close();
  await fakeAi.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} pasos correctos`);
  console.log('Pendiente con servicios reales (no probado aquí): 12 y 15-16 dentro de un servidor real (importar la empresa, catálogo y automatizaciones; aquí Docker está sustituido), 13 WhatsApp (Meta), 14 Gemini, 17 pruebas desde afuera con DNS y HTTPS reales, 19 correo de acceso y entrega.');
  process.exitCode = results.every((r) => r.ok) && !consoleErrors.length ? 0 : 1;
}
