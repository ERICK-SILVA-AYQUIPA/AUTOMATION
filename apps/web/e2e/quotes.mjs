/**
 * Cotizaciones, contrato y pagos (ADR 049) de punta a punta en navegador real:
 * configurar emisor, impuesto, método de pago y contrato; catálogo; cotización
 * desde la ficha del prospecto; envío con enlace y correo; el cliente la ve, baja
 * el PDF, la acepta e informa su pago; el equipo valida el ingreso; quedan el
 * asiento y la orden de instalación.
 *
 * Restaura al final la configuración comercial que había y desactiva lo que creó
 * (las versiones del contrato no se borran: la base lo impide).
 *
 *   WEB_URL=http://localhost:3000 MAILPIT_URL=http://localhost:8025 \
 *   PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... node e2e/quotes.mjs
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR ?? 'e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });
if (!process.env.PLATFORM_ADMIN_EMAIL || !process.env.MAILPIT_URL) throw new Error('Faltan PLATFORM_ADMIN_EMAIL/PLATFORM_ADMIN_PASSWORD y MAILPIT_URL');
const stamp = Date.now().toString(36);
const person = `Rosa Cotiza ${stamp}`;
const email = `cotiza-${stamp}@example.com`;
const code = stamp.toUpperCase();

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
    await page?.screenshot({ path: `${SHOTS}/cotizaciones-fallo.png`, fullPage: true }).catch(() => undefined);
    if (consoleErrors.length) console.log(`  Consola: ${consoleErrors.slice(0, 3).join(' | ').slice(0, 800)}`);
    console.log(`✗ ${name}\n  ${e.message.split('\n').slice(0, 3).join('\n  ')}`);
    throw e;
  }
};
const L = (l, scope = page) => scope.getByLabel(l, { exact: true });
const toast = (t) => page.getByText(t, { exact: true }).first().waitFor();
const tab = (name) => page.getByRole('tab', { name, exact: true }).click();

// API con la sesión del administrador: solo para preparar el prospecto y restaurar al final
const token = (await (await fetch(`${WEB}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.PLATFORM_ADMIN_EMAIL, password: process.env.PLATFORM_ADMIN_PASSWORD }) })).json()).accessToken;
const call = async (method, path, body) => {
  const r = await fetch(`${WEB}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};
const { contactEmail: _c, ...prevSettings } = await call('GET', '/platform/commerce/settings');
const lead = await call('POST', '/platform/sales/leads', { name: person, company: `Minimarket ${stamp}`, email, phone: `+51 9${String(Date.now()).slice(-8)}`, source: 'REFERRAL', interestMode: 'SAAS', interestPlan: 'PROFESSIONAL', interestModules: ['orders'] });

const mail = async (subject) => {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`).then((x) => x.json());
    const m = (r.messages ?? []).find((x) => x.Subject.includes(subject));
    if (m) return m;
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`No llegó el correo «${subject}»`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-PE', timezoneId: 'America/Lima', acceptDownloads: true });
page = await ctx.newPage();
const watch = (p) => {
  p.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && consoleErrors.push(m.text()));
  p.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message));
};
watch(page);
let created = { methodId: null, items: [] };
let proposalUrl;
let paymentUrl;
let quoteCode;

try {
  await step('Configuración: emisor con IGV incluido, método de pago y una versión nueva del contrato', async () => {
    await page.goto(`${WEB}/login`);
    await L('Correo').fill(process.env.PLATFORM_ADMIN_EMAIL);
    await L('Contraseña').fill(process.env.PLATFORM_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL(/\/plataforma$/);
    await page.getByRole('navigation', { name: 'Menú principal' }).getByRole('link', { name: 'Cotizaciones y pagos' }).click();
    await page.waitForURL(/\/plataforma\/cotizaciones$/);
    await tab('Configuración');
    const f = page.getByRole('form', { name: 'Emisor e impuestos' });
    await L('Razón social', f).fill(`Soluciones de Prueba ${stamp} S.A.C.`);
    await L('RUC / ID fiscal', f).fill('20123456789');
    await L('Dirección', f).fill('Av. Siempre Viva 123, Lima');
    await L('Impuesto (nombre)', f).fill('IGV');
    await L('Tasa (%)', f).fill('18');
    await f.getByLabel('Los precios del catálogo ya incluyen el impuesto').check();
    await L('Condiciones generales', f).fill('Precios en soles. La mensualidad se paga por adelantado.');
    await f.getByRole('button', { name: 'Guardar' }).click();
    await toast('Configuración guardada');

    await page.getByRole('button', { name: 'Agregar', exact: true }).click();
    let dlg = page.getByRole('dialog');
    await L('Nombre visible', dlg).fill(`Yape prueba ${stamp}`);
    await L('Datos para pagar', dlg).fill('Yape al 999 888 777 a nombre de Soluciones de Prueba');
    await dlg.getByRole('button', { name: 'Guardar' }).click();
    await toast('Método de pago guardado');
    created.methodId = (await call('GET', '/platform/commerce/payment-methods')).find((m) => m.name === `Yape prueba ${stamp}`).id;

    await page.getByRole('button', { name: 'Nueva versión' }).click();
    const c = page.getByRole('form', { name: 'Nueva versión del contrato' });
    await L('Título', c).fill(`Contrato de servicio (prueba ${stamp})`);
    await L('Texto completo', c).fill('Texto de prueba del contrato de servicio. Cláusula 1: objeto. Cláusula 2: pagos. Cláusula 3: soporte.');
    await c.getByRole('button', { name: /^Registrar versión \d+$/ }).click();
    await page.getByText(/^Contrato versión \d+ registrado$/).waitFor();
    await page.getByText(`Contrato de servicio (prueba ${stamp})`, { exact: false }).first().waitFor();
    await page.screenshot({ path: `${SHOTS}/cotizaciones-configuracion.png`, fullPage: true });
  });

  await step('Catálogo: conceptos con precio mensual y de pago único', async () => {
    await tab('Catálogo');
    for (const it of [{ code: `PLAN-${code}`, name: `Plan Profesional ${stamp}`, kind: 'PLAN', billing: 'MONTHLY', price: '299' }, { code: `INST-${code}`, name: `Instalación ${stamp}`, kind: 'SETUP', billing: 'ONE_TIME', price: '1200' }]) {
      await page.getByRole('button', { name: 'Nuevo concepto' }).click();
      const dlg = page.getByRole('dialog');
      await L('Código', dlg).fill(it.code);
      await L('Nombre', dlg).fill(it.name);
      await L('Tipo', dlg).selectOption(it.kind);
      await L('Cobro', dlg).selectOption(it.billing);
      await L('Precio unitario', dlg).fill(it.price);
      if (it.kind === 'PLAN') await L('Plan del sistema', dlg).selectOption('PROFESSIONAL');
      await dlg.getByRole('button', { name: 'Guardar' }).click();
      await toast('Concepto agregado al catálogo');
      await page.getByRole('cell', { name: it.code }).waitFor();
    }
    created.items = (await call('GET', '/platform/commerce/items')).filter((i) => i.code.endsWith(code)).map((i) => i.id);
    if (created.items.length !== 2) throw new Error('No se guardaron los conceptos');
  });

  await step('Cotización desde la ficha del prospecto: catálogo + concepto libre, borrador con IGV y vista previa en PDF', async () => {
    await page.goto(`${WEB}/plataforma/ventas/${lead.id}`);
    await page.getByRole('link', { name: 'Nueva cotización' }).click();
    await page.waitForURL(/\/plataforma\/cotizaciones\/nueva\?lead=/);
    await page.getByRole('heading', { name: 'Nueva cotización' }).waitFor();
    if ((await L('Plan').inputValue()) !== 'PROFESSIONAL') throw new Error('No tomó el plan de interés del prospecto');
    if (!(await page.getByLabel('Pedidos').isChecked())) throw new Error('No tomó los módulos de interés');
    for (const name of [`Plan Profesional ${stamp}`, `Instalación ${stamp}`]) {
      const label = await L('Agregar del catálogo').locator('option', { hasText: name }).innerText();
      await L('Agregar del catálogo').selectOption({ label });
      await page.getByRole('button', { name: 'Agregar', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Concepto libre' }).click();
    await L('Descripción 3').fill('Capacitación al equipo (2 horas)');
    await L('Precio unitario 3').fill('150');
    await L('Usuarios').fill('3');
    await L('Integraciones').fill('WhatsApp Business (número del cliente)');
    await page.getByRole('button', { name: 'Crear borrador' }).click();
    await page.waitForURL(/\/plataforma\/cotizaciones\/[0-9a-f-]{36}$/);
    const h = await page.getByRole('heading', { name: /^COT-\d{5} · / }).innerText();
    quoteCode = h.split(' · ')[0];
    await page.getByText('Pago inicial: S/ 1,649.00').waitFor();
    await page.getByText(/Con IGV 18 % incluido: único S\/\s1,350\.00, mensual S\/\s299\.00\./).waitFor();
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Vista previa PDF' }).click();
    const file = await dl;
    if (file.suggestedFilename() !== `${quoteCode}.pdf`) throw new Error(`PDF con nombre ${file.suggestedFilename()}`);
    // Cambiar y guardar el borrador
    await L('Cantidad 3').fill('2');
    await page.getByText('Hay cambios sin guardar.').waitFor();
    await page.getByRole('button', { name: 'Guardar borrador' }).click();
    await toast('Borrador guardado');
    await page.getByText('Pago inicial: S/ 1,799.00').waitFor();
    await page.screenshot({ path: `${SHOTS}/cotizaciones-borrador.png`, fullPage: true });
  });

  await step('Enviar: queda congelada, el prospecto pasa a «Cotización enviada» y el cliente recibe el enlace', async () => {
    await page.getByRole('button', { name: 'Enviar al cliente' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Enviar', exact: true }).click();
    await toast('Enviada: el cliente recibió el enlace por correo');
    proposalUrl = await L('Enlace del cliente').inputValue();
    if (!/\/propuesta\/[0-9a-f-]{36}\?t=/.test(proposalUrl)) throw new Error(`Enlace inesperado: ${proposalUrl}`);
    await page.getByRole('button', { name: 'Listo' }).click();
    await page.getByText('Enviada', { exact: true }).first().waitFor();
    if (await page.getByRole('button', { name: 'Guardar borrador' }).count()) throw new Error('Una cotización enviada se puede editar');
    const m = await mail(`Propuesta ${quoteCode}`);
    const body = await fetch(`${process.env.MAILPIT_URL}/api/v1/message/${m.ID}`).then((x) => x.json());
    if (!body.Text.includes(new URL(proposalUrl).pathname)) throw new Error('El correo no trae el enlace de la propuesta');
    await page.goto(`${WEB}/plataforma/ventas/${lead.id}`);
    await page.getByText('Cotización enviada', { exact: true }).first().waitFor();
  });

  let client;
  await step('Cliente: un enlace alterado no abre nada; el bueno muestra la propuesta, el contrato y el PDF', async () => {
    const cctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'es-PE', timezoneId: 'America/Lima', acceptDownloads: true });
    client = await cctx.newPage();
    watch(client);
    await client.goto(proposalUrl.replace(/t=(.)/, (_, ch) => `t=${ch === 'a' ? 'b' : 'a'}`));
    await client.getByText(/El enlace no es válido o fue reemplazado/).waitFor();
    await client.goto(proposalUrl);
    await client.getByRole('heading', { name: `Propuesta ${quoteCode}` }).waitFor();
    await client.getByText('S/ 1,799.00').first().waitFor();
    await client.getByText(`Contrato: Contrato de servicio (prueba ${stamp})`, { exact: false }).click();
    await client.getByText('Cláusula 1: objeto', { exact: false }).waitFor();
    const pdf = await client.request.get(new URL(await client.getByRole('link', { name: 'Descargar PDF' }).getAttribute('href'), WEB).href);
    if (pdf.headers()['content-type'] !== 'application/pdf' || !(await pdf.body()).subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('El PDF del cliente no es un PDF');
    await client.screenshot({ path: `${SHOTS}/cotizaciones-propuesta-cliente.png`, fullPage: true });
  });

  await step('Cliente: acepta con su nombre y DNI, pasa a la orden de pago e informa su pago', async () => {
    await L('DNI / RUC (opcional)', client).fill('45678912');
    const accept = client.getByRole('button', { name: 'Aceptar y continuar al pago' });
    if (await accept.isEnabled()) throw new Error('Se puede aceptar sin marcar la casilla');
    await client.getByLabel(/^Acepto la propuesta/).check();
    await accept.click();
    await client.waitForURL(/\/pago\/[0-9a-f-]{36}\?t=/);
    paymentUrl = client.url();
    await client.getByRole('heading', { name: /^Orden de pago OP-\d{5}$/ }).waitFor();
    await client.getByText('Yape al 999 888 777', { exact: false }).waitFor();
    await mail('Orden de pago de la propuesta');
    await L('Número de operación', client).fill(`OP${stamp}`);
    await L('Nombre de quien pagó', client).fill(person);
    await client.getByRole('button', { name: 'Informar el pago' }).click();
    await client.getByText(/Recibimos los datos de tu pago/).waitFor();
    await client.screenshot({ path: `${SHOTS}/cotizaciones-pago-cliente.png`, fullPage: true });
  });

  await step('Equipo: el comprobante no basta; validar exige el importe exacto y confirmar el ingreso en la cuenta', async () => {
    await page.goto(`${WEB}/plataforma/cotizaciones?tab=pagos`);
    await page.getByRole('cell', { name: `Minimarket ${stamp}` }).waitFor();
    await page.getByRole('row', { name: new RegExp(`Minimarket ${stamp}`) }).getByRole('link').click();
    await page.waitForURL(/\/plataforma\/cotizaciones\/pagos\/[0-9a-f-]{36}$/);
    await page.getByText('Pago informado por el cliente').waitFor();
    await page.getByText('Comprobante por validar', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Validar pago' }).click();
    const dlg = page.getByRole('dialog');
    if ((await L('Número de operación', dlg).inputValue()) !== `OP${stamp}`) throw new Error('No precargó la operación informada');
    const confirm = dlg.getByRole('button', { name: 'Confirmar pago' });
    if (await confirm.isEnabled()) throw new Error('Se puede validar sin confirmar el ingreso');
    await dlg.getByLabel('Verifiqué el ingreso en la cuenta (no solo el comprobante)').check();
    await L('Importe recibido (PEN)', dlg).fill('1700');
    await confirm.click();
    await dlg.getByText(/no coincide con la orden \(1799\.00\)/).waitFor();
    await L('Importe recibido (PEN)', dlg).fill('1799.00');
    await confirm.click();
    await toast('Pago validado: se registró el ingreso y la orden de instalación');
    await page.getByText('Pagada', { exact: true }).first().waitFor();
    await page.getByText(/^Asiento AS-\d{5}: bruto S\/\s1,799\.00, impuesto S\/\s274\.42, neto S\/\s1,524\.58\.$/).waitFor();
    await page.getByText(/^Orden de instalación/).waitFor();
    await page.screenshot({ path: `${SHOTS}/cotizaciones-pago-validado.png`, fullPage: true });
  });

  await step('Ingresos con exportación, orden de instalación en curso y prospecto en «Pago confirmado»', async () => {
    await page.goto(`${WEB}/plataforma/cotizaciones?tab=ingresos`);
    await page.getByRole('row', { name: new RegExp(`Minimarket ${stamp}`) }).waitFor();
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Exportar CSV' }).click();
    if (!/^ingresos-\d{4}-\d{2}-\d{2}\.csv$/.test((await dl).suggestedFilename())) throw new Error('Nombre del CSV inesperado');
    await tab('Instalaciones');
    const card = page.locator('div', { has: page.getByRole('link', { name: `Minimarket ${stamp}` }) }).filter({ has: page.getByRole('button', { name: 'Marcar en curso' }) }).last();
    await card.getByRole('button', { name: 'Marcar en curso' }).click();
    await page.getByText(/^OI-\d{5}: en curso$/).waitFor();
    const running = page.locator('div', { has: page.getByRole('link', { name: `Minimarket ${stamp}` }) }).filter({ has: page.getByRole('button', { name: 'Marcar terminada' }) }).last();
    if (await running.getByRole('button', { name: 'Marcar terminada' }).isEnabled()) throw new Error('Se puede terminar la instalación sin empresa creada');
    await page.goto(`${WEB}/plataforma/ventas/${lead.id}`);
    await page.getByText('Pago confirmado', { exact: true }).first().waitFor();
    await page.getByRole('link', { name: new RegExp(`^${quoteCode}.*Aceptada$`) }).waitFor();
    await page.getByRole('link', { name: /^OP-\d{5}.*Pagada$/ }).waitFor();
    await page.getByRole('link', { name: 'Convertir en cliente' }).waitFor();
    await client.goto(paymentUrl);
    await client.getByText(/Recibimos y validamos tu pago/).waitFor();
  });

  if (consoleErrors.length) throw new Error(`Errores en la consola: ${consoleErrors.join(' | ').slice(0, 500)}`);
} finally {
  // Deja la configuración comercial como estaba y desactiva lo creado
  await call('PUT', '/platform/commerce/settings', prevSettings).catch((e) => console.log(`No se restauró la configuración: ${e.message}`));
  for (const id of created.items) {
    const it = (await call('GET', '/platform/commerce/items')).find((i) => i.id === id);
    const { id: _i, createdAt: _a, updatedAt: _u, ...rest } = it;
    await call('PUT', `/platform/commerce/items/${id}`, { ...rest, isActive: false }).catch(() => undefined);
  }
  if (created.methodId) {
    const m = (await call('GET', '/platform/commerce/payment-methods')).find((x) => x.id === created.methodId);
    const { id: _i, createdAt: _a, updatedAt: _u, ...rest } = m;
    await call('PUT', `/platform/commerce/payment-methods/${m.id}`, { ...rest, isActive: false }).catch(() => undefined);
  }
  await browser.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} pasos correctos`);
  process.exitCode = results.every((r) => r.ok) && !consoleErrors.length ? 0 : 1;
}
