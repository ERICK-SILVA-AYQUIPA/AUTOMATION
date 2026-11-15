/**
 * Centro comercial (ADR 047) de punta a punta en navegador real: registrar un
 * prospecto, detectar duplicados, moverlo por el embudo arrastrando, historial,
 * próxima acción vencida, validar el pago y convertirlo en cliente con el
 * asistente de alta (empresa creada en preparación e invitación enviada).
 *
 *   WEB_URL=http://localhost:3000 MAILPIT_URL=http://localhost:8025 \
 *   PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... node e2e/sales.mjs
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
const person = `Carla Prospecto ${stamp}`;
const company = `Bodega Prospecto ${stamp}`;
const email = `prospecto-${stamp}@example.com`;

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
    await page?.screenshot({ path: `${SHOTS}/ventas-fallo.png`, fullPage: true }).catch(() => undefined);
    if (consoleErrors.length) console.log(`  Consola: ${consoleErrors.slice(0, 3).join(' | ').slice(0, 800)}`);
    console.log(`✗ ${name}\n  ${e.message.split('\n').slice(0, 3).join('\n  ')}`);
    throw e;
  }
};
const L = (l, scope = page) => scope.getByLabel(l, { exact: true });
const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const column = (name) => page.getByRole('listitem', { name, exact: true });
const card = (scope = page) => scope.getByRole('button', { name: new RegExp(`^P-\\d{4,} ${person}$`) });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-PE', timezoneId: 'America/Lima' });
page = await ctx.newPage();
page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message));

try {
  await step('Registrar un prospecto con sus datos, responsable y próxima acción', async () => {
    await page.goto(`${WEB}/login`);
    await L('Correo').fill(process.env.PLATFORM_ADMIN_EMAIL);
    await L('Contraseña').fill(process.env.PLATFORM_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL(/\/plataforma$/);
    await page.getByRole('navigation', { name: 'Menú principal' }).getByRole('link', { name: 'Ventas' }).click();
    await page.waitForURL(/\/plataforma\/ventas$/);
    await page.getByRole('button', { name: 'Nuevo prospecto' }).click();
    const dlg = page.getByRole('dialog');
    await L('Nombre', dlg).fill(person);
    await L('Empresa', dlg).fill(company);
    await L('Teléfono', dlg).fill(`+51 9${String(Date.now()).slice(-8)}`);
    await L('Correo', dlg).fill(email);
    await L('Sector', dlg).selectOption('RETAIL');
    await L('Fuente de captación', dlg).selectOption('REFERRAL');
    await L('Presupuesto estimado', dlg).fill('1800');
    await L('Necesidad', dlg).fill('Atender pedidos por WhatsApp y controlar stock');
    await L('Modalidad de interés', dlg).selectOption('SAAS');
    await L('Plan de interés', dlg).selectOption('PROFESSIONAL');
    await dlg.getByLabel('Pedidos').check();
    await L('Próxima acción (opcional)', dlg).fill('Llamar para agendar demo');
    await L('Fecha de la próxima acción', dlg).fill(local(new Date(Date.now() - 2 * 3_600_000)));
    await dlg.getByRole('button', { name: 'Registrar prospecto' }).click();
    await page.waitForURL(/\/plataforma\/ventas\/[0-9a-f-]{36}$/);
    await page.getByRole('heading', { name: new RegExp(`^P-\\d{4,} · ${person}$`) }).waitFor();
    await page.getByText('Nuevo prospecto', { exact: true }).first().waitFor();
    await page.getByText(/^Vencida: /).waitFor();
    await page.getByLabel('Historial del prospecto').getByText('Prospecto registrado').waitFor();
    if ((await L('Responsable').locator('option:checked').innerText()) === 'Sin responsable') throw new Error('No se asignó responsable por defecto');
  });

  await step('Un segundo registro con el mismo correo avisa del duplicado y se puede registrar igual', async () => {
    await page.goto(`${WEB}/plataforma/ventas`);
    await page.getByRole('button', { name: 'Nuevo prospecto' }).click();
    const dlg = page.getByRole('dialog');
    await L('Nombre', dlg).fill(`${person} (sucursal)`);
    await L('Correo', dlg).fill(email.toUpperCase());
    await dlg.getByRole('button', { name: 'Registrar prospecto' }).click();
    await dlg.getByText('Ya hay un prospecto con ese correo o teléfono').waitFor();
    await dlg.getByRole('link', { name: new RegExp(person) }).waitFor();
    await dlg.getByRole('button', { name: 'Registrar de todos modos' }).click();
    await page.waitForURL(/\/plataforma\/ventas\/[0-9a-f-]{36}$/);
  });

  await step('Embudo: arrastrar entre etapas; las etapas del sistema no aceptan tarjetas; perder pide motivo', async () => {
    await page.goto(`${WEB}/plataforma/ventas`);
    await page.getByLabel('Buscar prospecto').fill(stamp);
    await card(column('Nuevo prospecto')).waitFor();
    await page.screenshot({ path: `${SHOTS}/ventas-embudo.png` });
    await card(column('Nuevo prospecto')).dragTo(column('Contactado'));
    await page.getByText(`${person}: Contactado`).waitFor();
    await card(column('Contactado')).waitFor();
    // «Cliente activo» no se mueve a mano
    await card(column('Contactado')).dragTo(column('Cliente activo'));
    await page.waitForTimeout(800);
    if (!(await card(column('Contactado')).count())) throw new Error('La tarjeta salió de «Contactado»');
    // La sucursal duplicada se marca como perdida desde su ficha (sin arrastrar)
    await column('Nuevo prospecto').getByRole('button', { name: new RegExp(`${person} \\(sucursal\\)$`) }).click();
    await page.waitForURL(/\/plataforma\/ventas\/[0-9a-f-]{36}$/);
    await L('Mover a').selectOption('LOST');
    await page.getByRole('button', { name: 'Cambiar etapa' }).click();
    const lost = page.getByRole('dialog');
    await lost.getByLabel('Motivo de la pérdida').fill('Duplicado: es la misma empresa');
    await lost.getByRole('button', { name: 'Marcar como perdido' }).click();
    await page.getByText('Duplicado: es la misma empresa').first().waitFor();
    await page.getByLabel('Historial del prospecto').getByText('Nuevo prospecto → Perdido').waitFor();
    await page.goto(`${WEB}/plataforma/ventas`);
    await page.getByLabel('Buscar prospecto').fill(stamp);
    await column('Perdido').getByRole('button', { name: new RegExp(`${person} \\(sucursal\\)$`) }).waitFor();
  });

  await step('Vencidas y lista con filtros', async () => {
    await page.getByRole('tab', { name: /^Vencidas/ }).click();
    await page.getByRole('link', { name: person, exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Lista' }).click();
    await page.getByLabel('Filtrar por etapa').selectOption('LOST');
    await page.getByRole('link', { name: `${person} (sucursal)` }).waitFor();
    if (await page.getByRole('link', { name: person, exact: true }).count()) throw new Error('El filtro de etapa no se aplicó');
    await page.screenshot({ path: `${SHOTS}/ventas-lista.png` });
  });

  await step('Ficha: llamada en el historial, acción hecha y paso a «Pendiente de pago»', async () => {
    await page.getByLabel('Filtrar por etapa').selectOption('');
    await page.getByRole('link', { name: person, exact: true }).click();
    await page.waitForURL(/\/plataforma\/ventas\/[0-9a-f-]{36}$/);
    await L('Tipo').selectOption('CALL');
    await L('Detalle').fill('Quiere empezar este mes con el plan Profesional');
    await page.getByRole('button', { name: 'Registrar', exact: true }).click();
    await page.getByLabel('Historial del prospecto').getByText('Quiere empezar este mes con el plan Profesional').waitFor();
    await L('Resultado de la acción').fill('Demo hecha, aceptó la propuesta');
    await page.getByRole('button', { name: 'Hecha' }).click();
    await page.getByLabel('Historial del prospecto').getByText(/Llamar para agendar demo \(con retraso\)/).waitFor();
    await L('Mover a').selectOption('PAYMENT_PENDING');
    await page.getByRole('button', { name: 'Cambiar etapa' }).click();
    await page.getByText('Etapa: Pendiente de pago').waitFor();
    await page.getByLabel('Historial del prospecto').getByText('Contactado → Pendiente de pago').waitFor();
  });

  await step('Validar el pago exige confirmar el ingreso en la cuenta', async () => {
    await page.getByRole('button', { name: 'Validar pago' }).click();
    const dlg = page.getByRole('dialog');
    await L('Número de operación', dlg).fill(`OP-${stamp}`);
    if (!(await dlg.getByRole('button', { name: 'Confirmar pago' }).isDisabled())) throw new Error('Se puede confirmar sin verificar el ingreso');
    await dlg.getByLabel('Verifiqué el ingreso en la cuenta (no solo el comprobante)').check();
    await dlg.getByRole('button', { name: 'Confirmar pago' }).click();
    await page.getByText('Pago validado: ya puedes convertirlo en cliente').waitFor();
    await page.getByLabel('Historial del prospecto').getByText(new RegExp(`operación OP-${stamp}.*ingreso verificado en la cuenta`)).waitFor();
    await page.getByRole('link', { name: 'Convertir en cliente' }).waitFor();
    await page.screenshot({ path: `${SHOTS}/ventas-ficha.png`, fullPage: true });
  });

  await step('Convertir en cliente: el alta llega con los datos del prospecto y crea la empresa en preparación', async () => {
    await page.getByRole('link', { name: 'Convertir en cliente' }).click();
    await page.waitForURL(/\/plataforma\/nueva\?lead=/);
    await page.getByText(/Convirtiendo en cliente el prospecto P-\d{4,}/).waitFor();
    if (!(await page.getByRole('radio', { name: /^Tienda/ }).isChecked())) throw new Error('No se preseleccionó la plantilla del sector');
    await page.getByRole('button', { name: 'Siguiente' }).click();
    if ((await L('Nombre comercial').inputValue()) !== company) throw new Error('No llegó el nombre de la empresa');
    for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'Siguiente' }).click();
    if ((await L('Plan').inputValue()) !== 'PROFESSIONAL') throw new Error('No llegó el plan de interés');
    await page.getByRole('button', { name: 'Siguiente' }).click();
    if ((await L('Correo del administrador').inputValue()) !== email) throw new Error('No llegó el correo del prospecto');
    await page.getByRole('button', { name: 'Siguiente' }).click();
    await page.getByRole('button', { name: 'Crear empresa y enviar invitación' }).click();
    await page.waitForURL(/\/plataforma\/ventas\/[0-9a-f-]{36}$/);
    await page.getByText('Instalación pendiente', { exact: true }).first().waitFor();
    await page.getByText(/En preparación: al activarla, el prospecto pasa a «Cliente activo»/).waitFor();
    await page.getByLabel('Historial del prospecto').getByText(new RegExp(`Empresa creada: ${company}`)).waitFor();
    if (await L('Mover a').count()) throw new Error('Un prospecto convertido se puede mover a mano');
    // Invitación real al correo del prospecto (Mailpit)
    let found = false;
    for (let i = 0; i < 20 && !found; i++) {
      const r = await fetch(`${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`).then((x) => x.json());
      found = (r.messages ?? []).length > 0;
      if (!found) await new Promise((res) => setTimeout(res, 300));
    }
    if (!found) throw new Error('No llegó la invitación al administrador');
    await page.screenshot({ path: `${SHOTS}/ventas-convertido.png`, fullPage: true });
  });

  await step('La empresa creada aparece en Empresas, en preparación', async () => {
    await page.getByRole('link', { name: 'Abrir la ficha de la empresa' }).click();
    await page.waitForURL(/\/plataforma\?empresa=/);
    await page.getByRole('dialog').getByText('En preparación').first().waitFor();
    if (await page.getByRole('navigation', { name: 'Menú principal' }).getByRole('link', { name: 'Ventas' }).getAttribute('aria-current')) throw new Error('El menú marca Ventas en Empresas');
  });

  if (consoleErrors.length) throw new Error(`Errores en la consola: ${consoleErrors.join(' | ').slice(0, 500)}`);
} finally {
  await browser.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} pasos correctos`);
  process.exitCode = results.every((r) => r.ok) && !consoleErrors.length ? 0 : 1;
}
