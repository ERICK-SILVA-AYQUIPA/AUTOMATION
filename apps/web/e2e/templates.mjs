/**
 * Plantillas por sector (evolución, fase 7) en navegador real: alta de un
 * restaurante con su plantilla, menú sin stock, configuración de reservas,
 * reserva desde el panel con control de aforo, y cambio a la plantilla de
 * distribuidora con vista previa (solo lo marcado): clientes comerciales,
 * precios por volumen y pedido mínimo calculados por el backend.
 *
 *   MAILPIT_URL=http://localhost:8025 PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... node e2e/templates.mjs
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const SHOTS = process.env.SHOTS_DIR ?? 'e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);
const company = `Cevichería ${stamp}`;
const adminEmail = `resto-${stamp}@example.com`;
const password = 'ClaveSegura123';
const TZ = 'America/Lima';

/** Próximo día laborable (lunes a viernes) en Lima: el horario por defecto abre de 09:00 a 18:00 */
function nextWeekday() {
  for (let i = 1; i < 8; i++) {
    const d = new Date(Date.now() + i * 86_400_000);
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);
    if (!['Sat', 'Sun'].includes(wd)) return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }
  throw new Error('sin día laborable');
}
const day = nextWeekday();

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
    await shotPage?.screenshot({ path: `${SHOTS}/plantillas-fallo.png` }).catch(() => undefined);
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
const expectNone = async (loc, msg) => {
  if (await loc.count()) throw new Error(msg);
};

const browser = await chromium.launch();
const newPage = async () => {
  const p = await (await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'es-PE', timezoneId: TZ })).newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  return p;
};
const admin = await newPage();
const page = await newPage();
const L = (p, l) => p.getByLabel(l, { exact: true });
let tenantUrl = '';

try {
  await step('Plataforma: alta con la plantilla Restaurante (módulos y tipo de negocio se preparan solos)', async () => {
    shotPage = admin;
    await admin.goto(`${WEB}/login`);
    await L(admin, 'Correo').fill(process.env.PLATFORM_ADMIN_EMAIL);
    await L(admin, 'Contraseña').fill(process.env.PLATFORM_ADMIN_PASSWORD);
    await admin.getByRole('button', { name: 'Entrar' }).click();
    await admin.waitForURL(/\/plataforma$/);
    await admin.getByRole('link', { name: 'Nueva empresa' }).click();
    await admin.getByRole('radio', { name: /^Restaurante/ }).check();
    const cats = admin.getByRole('checkbox', { name: /Crear categorías sugeridas/ });
    if (!(await cats.isChecked())) throw new Error('Las categorías sugeridas deberían venir marcadas');
    await admin.screenshot({ path: `${SHOTS}/plantillas-sector.png` });
    await admin.getByRole('button', { name: 'Siguiente' }).click();
    await L(admin, 'Nombre comercial').fill(company);
    if ((await L(admin, 'Tipo de negocio').inputValue()) !== 'RESTAURANT') throw new Error('La plantilla no fijó el tipo de negocio');
    await admin.getByRole('button', { name: 'Siguiente' }).click();
    if (!(await admin.getByLabel('Reservas y citas').isChecked())) throw new Error('Reservas debería venir activo');
    if (await admin.getByLabel('Inventario').isChecked()) throw new Error('Un restaurante no usa inventario por defecto');
    await admin.getByRole('button', { name: 'Siguiente' }).click();
    await admin.getByRole('button', { name: 'Siguiente' }).click();
    await L(admin, 'Nombre del administrador').fill('Rosa Resto');
    await L(admin, 'Correo del administrador').fill(adminEmail);
    await admin.getByRole('button', { name: 'Siguiente' }).click();
    await admin.getByText('Restaurante (con categorías sugeridas)').waitFor();
    await admin.getByRole('button', { name: 'Crear empresa y enviar invitación' }).click();
    await admin.waitForURL(/\/plataforma\?empresa=[0-9a-f-]{36}$/);
    tenantUrl = admin.url();
    const dlg = admin.getByRole('dialog');
    await dlg.getByRole('heading', { name: 'Plantilla del sector' }).waitFor();
    await dlg.getByText('Aplicada: Restaurante v1').waitFor();
  });

  await step('El restaurante entra: menú con su nombre, reservas pendientes de configurar y categorías creadas', async () => {
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
    const nav = page.getByRole('navigation', { name: 'Menú principal' });
    await nav.getByRole('link', { name: 'Menú', exact: true }).waitFor();
    await nav.getByRole('link', { name: 'Reservas' }).waitFor();
    await expectNone(nav.getByRole('link', { name: 'Inventario' }), 'Se muestra Inventario en un restaurante');
    await page.goto(`${WEB}/categorias`);
    await page.getByText('Platos de fondo').waitFor();
    await page.goto(`${WEB}/reservas`);
    await page.getByText('Falta configurar las reservas').waitFor();
    await expectNone(page.getByRole('button', { name: 'Nueva reserva' }), 'Permite reservar sin horario ni aforo');
  });

  await step('Configuración › Operación: aforo y horario de reservas (valores de la empresa, no inventados)', async () => {
    await page.getByRole('link', { name: 'Configurar ahora' }).click();
    await page.waitForURL(/\/configuracion/);
    await page.getByText('Plantilla: Restaurante').waitFor();
    if ((await L(page, 'Nombre en el menú').inputValue()) !== 'Menú') throw new Error('No se ve el nombre del catálogo de la plantilla');
    await L(page, 'Aforo (personas a la vez)').fill('10');
    await page.getByRole('checkbox', { name: 'Horario de reservas' }).check();
    await page.getByRole('button', { name: 'Guardar operación' }).click();
    await page.getByText('Reglas de operación guardadas').waitFor();
    await page.locator('#operacion').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/plantillas-operacion.png`, fullPage: true });
  });

  await step('Menú: un plato nuevo no controla stock por defecto', async () => {
    await page.goto(`${WEB}/productos/nuevo`);
    const track = page.getByRole('checkbox', { name: /^Controla stock/ });
    if (await track.isChecked()) throw new Error('El plato vino con control de stock');
    await expectNone(L(page, 'Stock inicial (opcional)'), 'Pide stock inicial para un plato');
    await L(page, 'Nombre').fill('Ceviche clásico');
    await L(page, 'SKU (código interno)').fill(`CEV-${stamp}`);
    await L(page, 'Precio de venta').fill('35');
    await page.getByRole('button', { name: 'Crear producto' }).click();
    await page.waitForURL(/\/productos\/[0-9a-f-]{36}$/);
    await page.getByText('No controla stock').first().waitFor();
  });

  await step('Reservas: horarios libres, reserva desde el panel y el aforo baja; luego se marca atendida', async () => {
    await page.goto(`${WEB}/reservas`);
    await L(page, 'Día').fill(day);
    const free = page.getByRole('list', { name: 'Horarios libres' });
    await free.getByRole('listitem').filter({ hasText: '12:00' }).filter({ hasText: '10 libres' }).waitFor();
    await page.getByRole('button', { name: 'Nueva reserva' }).click();
    const dlg = page.getByRole('dialog');
    await L(dlg, 'Teléfono del cliente').fill('51987111222');
    await L(dlg, 'Nombre').fill('Lucía Mesa');
    await L(dlg, 'Personas').fill('4');
    if ((await L(dlg, 'Fecha').inputValue()) !== day) throw new Error('El diálogo no tomó el día elegido');
    await dlg.locator('option[value="12:00"]').waitFor({ state: 'attached' });
    await L(dlg, 'Hora').selectOption('12:00');
    await dlg.getByRole('button', { name: 'Registrar' }).click();
    await page.getByText(/Reserva #1 registrada/).waitFor();
    const row = page.getByRole('row').filter({ hasText: 'Lucía Mesa' });
    await row.getByText('Confirmada').waitFor();
    await row.getByText('12:00–13:30').waitFor();
    await free.getByRole('listitem').filter({ hasText: '12:00' }).filter({ hasText: '6 libres' }).waitFor();
    await page.screenshot({ path: `${SHOTS}/plantillas-reservas.png`, fullPage: true });
    await row.getByRole('button', { name: 'Atendida' }).click();
    await row.getByText('Atendida').waitFor();
    await row.getByRole('link', { name: 'Lucía Mesa' }).click();
    await page.waitForURL(/\/clientes\/[0-9a-f-]{36}$/);
    await page.getByRole('heading', { name: 'Reservas' }).waitFor();
    await page.getByRole('row').filter({ hasText: '#1' }).filter({ hasText: '4 personas' }).getByText('Atendida').waitFor();
  });

  await step('Plataforma: vista previa de la plantilla Distribuidora y aplicar solo lo marcado (sin tocar el asistente)', async () => {
    shotPage = admin;
    await admin.goto(tenantUrl);
    const dlg = admin.getByRole('dialog');
    await dlg.getByLabel('Plantilla', { exact: true }).selectOption('DISTRIBUTOR');
    await dlg.getByText('catalog.volumePricing').waitFor();
    await dlg.getByText('PENDING_ORDER_REMINDER').first().waitFor();
    await dlg.getByRole('checkbox', { name: /^Asistente IA · Va al borrador/ }).uncheck();
    await admin.screenshot({ path: `${SHOTS}/plantillas-vista-previa.png` });
    await dlg.getByRole('button', { name: 'Aplicar lo marcado' }).click();
    await admin.getByText('Plantilla «Distribuidora» aplicada').waitFor();
    await dlg.getByText('Aplicada: Distribuidora v1').waitFor();
    // Lo no marcado sigue pendiente en la vista previa
    await dlg.getByText('qualifyingQuestions').waitFor();
  });

  let customerUrl = '';
  await step('Distribuidora: menú actualizado, pedido mínimo y cliente comercial con razón social', async () => {
    shotPage = page;
    await page.goto(`${WEB}/configuracion`);
    const nav = page.getByRole('navigation', { name: 'Menú principal' });
    await nav.getByRole('link', { name: 'Catálogo mayorista' }).waitFor();
    await nav.getByRole('link', { name: 'Inventario' }).waitFor();
    await expectNone(nav.getByRole('link', { name: 'Reservas' }), 'Reservas sigue en el menú de la distribuidora');
    await page.getByText('Plantilla: Distribuidora').waitFor();
    await L(page, 'Pedido mínimo (PEN)').fill('100');
    await page.getByRole('button', { name: 'Guardar operación' }).click();
    await page.getByText('Reglas de operación guardadas').waitFor();
    await page.goto(`${WEB}/clientes`);
    await page.getByRole('button', { name: 'Nuevo cliente' }).click();
    const dlg = page.getByRole('dialog');
    await L(dlg, 'Tipo de cliente').selectOption('BUSINESS');
    await L(dlg, 'Razón social').fill(`Bodega Central ${stamp} S.A.C.`);
    await L(dlg, 'Persona de contacto').fill('Jorge Compras');
    await L(dlg, 'Teléfono WhatsApp').fill('51987333444');
    await L(dlg, 'Documento (DNI/RUC)').fill('20512345678');
    await dlg.getByRole('button', { name: 'Guardar' }).click();
    await page.waitForURL(/\/clientes\/[0-9a-f-]{36}$/);
    customerUrl = page.url();
    await page.getByRole('heading', { name: `Bodega Central ${stamp} S.A.C.` }).waitFor();
    await page.getByText('Cliente comercial').waitFor();
  });

  await step('Precio por volumen y pedido mínimo en el pedido; el total lo confirma el backend', async () => {
    await page.goto(`${WEB}/productos/nuevo`);
    if (!(await page.getByRole('checkbox', { name: /^Controla stock/ }).isChecked())) throw new Error('La distribuidora debería controlar stock');
    await L(page, 'Nombre').fill(`Aceite 1L ${stamp}`);
    await L(page, 'SKU (código interno)').fill(`ACE-${stamp}`);
    await L(page, 'Precio de venta').fill('10');
    await page.getByRole('button', { name: 'Añadir tramo' }).click();
    await L(page, 'Desde (unidades) 1').fill('12');
    await L(page, 'Precio unitario 1').fill('8');
    await L(page, 'Stock inicial (opcional)').fill('100');
    await page.getByRole('button', { name: 'Crear producto' }).click();
    await page.waitForURL(/\/productos\/[0-9a-f-]{36}$/);
    await page.goto(customerUrl);
    await page.getByRole('link', { name: 'Nuevo pedido' }).click();
    await page.waitForURL(/\/pedidos\/nuevo/);
    await page.getByLabel('Buscar producto').fill(`Aceite 1L ${stamp}`);
    await page.getByRole('button', { name: new RegExp(`Aceite 1L ${stamp}`) }).click();
    const qty = page.getByLabel(`Cantidad de Aceite 1L ${stamp}`);
    await qty.fill('5');
    await page.getByText('El pedido mínimo es S/ 100.00.').waitFor();
    if (!(await page.getByRole('button', { name: 'Crear y confirmar' }).isDisabled())) throw new Error('Permite enviar bajo el mínimo');
    await qty.fill('15');
    await page.getByText('(precio por volumen)').waitFor();
    await page.getByText('S/ 120.00').first().waitFor();
    await page.screenshot({ path: `${SHOTS}/plantillas-pedido-volumen.png`, fullPage: true });
    await page.getByRole('button', { name: 'Crear y confirmar' }).click();
    await page.waitForURL(/\/pedidos\/[0-9a-f-]{36}$/);
    await page.getByText('S/ 120.00').first().waitFor();
    await page.getByText('S/ 8.00').first().waitFor();
    await page.goto(customerUrl);
    await page.getByRole('heading', { name: 'Lo que más compra' }).waitFor();
    await page.getByRole('row').filter({ hasText: `Aceite 1L ${stamp}` }).filter({ hasText: '15' }).first().waitFor();
  });
} catch {
  /* el paso ya informó */
} finally {
  await browser.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} pasos correctos${errors.length ? ` · errores de página: ${errors.join(' | ')}` : ''}`);
  process.exit(ok === results.length && results.length === 8 && !errors.length ? 0 : 1);
}
