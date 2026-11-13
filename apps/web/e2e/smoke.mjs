/**
 * Prueba de humo en navegador real (Chromium + Playwright) contra la web y la API
 * en ejecución. Recorre el flujo principal de la FASE 3 con datos que crea ella
 * misma (empresa nueva con correo único), así que no toca datos existentes.
 *
 *   WEB_URL=http://localhost:3000 API_LOG=/ruta/api.log node e2e/smoke.mjs
 *
 * Sin SMTP configurado, la API registra el enlace de verificación en su log
 * (solo fuera de producción); API_LOG apunta a ese fichero. Con Mailpit se
 * lee de su API (MAILPIT_URL=http://localhost:8025).
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR ?? 'e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);
const email = `smoke-${stamp}@example.com`;
const password = 'ClaveSegura123';
const seller = `vendedor-${stamp}@example.com`;
const results = [];
const step = async (name, fn) => {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message.split('\n')[0] });
    console.log(`✗ ${name}\n  ${e.message.split('\n').slice(0, 3).join('\n  ')}`);
    throw e;
  }
};

async function linkFor(to, path) {
  for (let i = 0; i < 20; i++) {
    if (process.env.MAILPIT_URL) {
      const r = await fetch(`${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`).then((x) => x.json());
      const id = r.messages?.[0]?.ID;
      if (id) {
        const m = await fetch(`${process.env.MAILPIT_URL}/api/v1/message/${id}`).then((x) => x.json());
        const link = new RegExp(`https?://\\S+${path}\\?token=[^\\s"<]+`).exec(m.Text)?.[0];
        if (link) return link;
      }
    } else {
      const log = readFileSync(process.env.API_LOG, 'utf8');
      const idx = log.lastIndexOf(to);
      const link = idx >= 0 ? new RegExp(`https?://\\S+?${path}\\?token=[A-Za-z0-9%_-]+`).exec(log.slice(idx))?.[0] : null;
      if (link) return link;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No se encontró el enlace ${path} para ${to}`);
}

// Prueba contra el despliegue de producción local (dominio de prueba y certificado de Caddy):
// RESOLVE_HOST="MAP aisa.test 127.0.0.1" IGNORE_HTTPS_ERRORS=1
const browser = await chromium.launch(process.env.RESOLVE_HOST ? { args: [`--host-resolver-rules=${process.env.RESOLVE_HOST}`, "--no-proxy-server"] } : {});
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: "es-PE", timezoneId: "America/Lima", acceptDownloads: true, ignoreHTTPSErrors: !!process.env.IGNORE_HTTPS_ERRORS });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(e.message));
const label = (l) => page.getByLabel(l, { exact: true });

try {
  await step('Registro de empresa', async () => {
    await page.goto(`${WEB}/registro`);
    await label('Nombre del negocio').fill(`Bodega Smoke ${stamp}`);
    await label('Tu nombre').fill('Rosa Prueba');
    await label('Correo').fill(email);
    await label('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Crear cuenta' }).click();
    await page.getByText(/revisa tu correo|te enviamos/i).first().waitFor({ timeout: 10_000 });
  });

  await step('Verificación de correo con el enlace recibido', async () => {
    const link = (await linkFor(email, 'verificar-correo')).replace(/^https?:\/\/[^/]+/, WEB);
    await page.goto(link);
    await page.getByText(/verificado|confirmado/i).first().waitFor({ timeout: 10_000 });
  });

  await step('Ruta protegida sin sesión redirige al login', async () => {
    await page.goto(`${WEB}/productos`);
    await page.waitForURL(/\/login\?next=%2Fproductos/);
  });

  await step('Inicio de sesión y vuelta a la ruta pedida', async () => {
    await label('Correo').fill(email);
    await label('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL(/\/productos$/);
    await page.getByText('Aún no tienes productos').waitFor();
  });

  await step('Crear categoría', async () => {
    await page.getByRole('link', { name: 'Categorías' }).click();
    await page.getByRole('button', { name: 'Nueva categoría' }).first().click();
    await label('Nombre').fill('Bebidas');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await page.getByRole('cell', { name: 'Bebidas', exact: true }).waitFor();
  });

  await step('Crear producto con stock inicial', async () => {
    await page.goto(`${WEB}/productos/nuevo`);
    await label('Nombre').fill('Gaseosa Cola 500 ml');
    await label('SKU (código interno)').fill('GAS-500');
    await page.getByLabel('Código de barras (opcional)').fill('7750182000017');
    await label('Precio de venta').fill('3.50');
    await page.getByLabel('Categoría').selectOption({ label: 'Bebidas' });
    await page.getByLabel('Stock mínimo (alerta)').fill('5');
    await page.getByLabel('Stock inicial (opcional)').fill('20');
    await page.getByRole('button', { name: 'Crear producto' }).click();
    await page.waitForURL(/\/productos\/[0-9a-f-]{36}$/);
    await page.getByText('Stock total 20').waitFor();
  });

  await step('Crear producto con variantes', async () => {
    await page.goto(`${WEB}/productos/nuevo`);
    await label('Nombre').fill('Polo básico');
    await label('SKU (código interno)').fill('POLO');
    await label('Precio de venta').fill('25');
    await page.getByText('Este producto tiene variantes').click();
    await page.getByPlaceholder('Rojo / M').fill('Rojo / M');
    await page.getByRole('textbox', { name: 'SKU', exact: true }).fill('POLO-R-M');
    await page.getByPlaceholder('Color: Rojo, Talla: M').fill('Color: Rojo, Talla: M');
    await page.getByRole('button', { name: 'Crear producto' }).click();
    await page.waitForURL(/\/productos\/[0-9a-f-]{36}$/);
    await page.getByRole('cell', { name: /Rojo \/ M/ }).waitFor();
  });

  await step('Buscar en el catálogo y filtrar por categoría', async () => {
    await page.goto(`${WEB}/productos`);
    await page.getByLabel('Buscar productos').fill('gaseosa');
    await page.getByRole('link', { name: 'Gaseosa Cola 500 ml' }).waitFor();
    await page.getByRole('link', { name: 'Polo básico' }).waitFor({ state: 'detached' });
    await page.screenshot({ path: `${SHOTS}/productos.png` });
  });

  await step('Registrar entrada de inventario', async () => {
    await page.goto(`${WEB}/inventario`);
    await page.getByRole('button', { name: 'Registrar movimiento' }).click();
    await page.getByLabel('Buscar producto').fill('GAS-500');
    await page.getByRole('button', { name: /Gaseosa Cola 500 ml/ }).click();
    await page.getByLabel('Cantidad').fill('10');
    await page.getByLabel('Motivo').fill('Factura 001-123');
    await page.getByRole('button', { name: 'Registrar', exact: true }).click();
    await page.getByText(/Stock actual: 30/).waitFor();
    await page.getByRole('cell', { name: 'Factura 001-123', exact: true }).waitFor();
  });

  let orderUrl = '';
  await step('Crear pedido confirmado (descuenta stock)', async () => {
    await page.goto(`${WEB}/pedidos/nuevo`);
    await page.getByLabel('Buscar producto').fill('Gaseosa');
    await page.getByRole('button', { name: /Gaseosa Cola 500 ml/ }).click();
    await page.getByLabel('Más').click();
    await page.getByLabel('Más').click();
    await page.getByLabel('Teléfono (con código de país)').fill('51987654321');
    await page.getByLabel('Nombre', { exact: true }).fill('Juan Cliente');
    await page.getByText('S/ 10.50').first().waitFor();
    await page.getByRole('button', { name: 'Crear y confirmar' }).click();
    await page.waitForURL(/\/pedidos\/[0-9a-f-]{36}$/);
    orderUrl = page.url();
    await page.getByText('Confirmado').first().waitFor();
    await page.screenshot({ path: `${SHOTS}/pedido.png` });
  });

  await step('El stock bajó a 27 y el movimiento enlaza al pedido', async () => {
    await page.goto(`${WEB}/productos?lowStock=false`);
    await page.getByLabel('Buscar productos').fill('GAS-500');
    await page.getByRole('row', { name: /Gaseosa Cola 500 ml/ }).getByText('27').waitFor();
    await page.goto(`${WEB}/inventario`);
    await page.getByRole('cell', { name: /Pedido #1/ }).waitFor();
  });

  await step('Panel muestra la venta del día', async () => {
    await page.goto(`${WEB}/inicio`);
    await page.getByText('Ventas de hoy').waitFor();
    await page.getByText('S/ 10.50').first().waitFor();
    await page.getByRole('cell', { name: 'Gaseosa Cola 500 ml', exact: true }).waitFor();
    // La barra del día existe y tiene altura (recharts la anima al entrar)
    await page.waitForFunction(() => [...document.querySelectorAll('.recharts-bar-rectangle path')].some((p) => p.getBoundingClientRect().height > 10));
    await page.screenshot({ path: `${SHOTS}/inicio.png` });
  });

  await step('Reportes: el CSV de ventas trae el pedido confirmado de hoy', async () => {
    await page.goto(`${WEB}/reportes`);
    const card = page.getByRole('heading', { name: 'Ventas por día' }).locator('xpath=ancestor::*[.//button][1]');
    const [dl] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: 'Descargar' }).click()]);
    const csv = readFileSync(await dl.path(), 'utf8');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
    const row = csv.split(/\r?\n/).find((l) => l.startsWith(today));
    if (!row || !/10[.,]50/.test(row)) throw new Error(`El reporte no trae la venta de hoy: ${csv.slice(0, 300)}`);
  });

  await step('Anular pedido devuelve el stock', async () => {
    await page.goto(orderUrl);
    await page.getByRole('button', { name: 'Anular' }).click();
    await page.getByRole('button', { name: 'Anular pedido' }).click();
    await page.getByText('Anulado').first().waitFor();
    await page.goto(`${WEB}/productos`);
    await page.getByLabel('Buscar productos').fill('GAS-500');
    await page.getByRole('row', { name: /Gaseosa Cola 500 ml/ }).getByText('30').waitFor();
  });

  await step('Cliente creado con su historial de pedidos', async () => {
    await page.goto(`${WEB}/clientes`);
    await page.getByRole('link', { name: 'Juan Cliente' }).click();
    await page.getByRole('link', { name: '#1' }).waitFor();
  });

  await step('Invitar usuario vendedor', async () => {
    await page.goto(`${WEB}/usuarios`);
    await page.getByRole('button', { name: 'Invitar usuario' }).click();
    await page.getByLabel('Correo').fill(seller);
    await label('Nombre').fill('Pedro Vendedor');
    await page.getByLabel('Rol').selectOption('SELLER');
    await page.getByRole('button', { name: 'Enviar invitación' }).click();
    await page.getByRole('cell', { name: /^Pedro Vendedor/ }).getByText('Invitado').or(page.getByText('Invitado')).first().waitFor();
  });

  await step('Configuración: plan, uso y sesiones', async () => {
    await page.goto(`${WEB}/configuracion`);
    await page.getByText(/Plan /).first().waitFor();
    await page.getByRole('progressbar', { name: 'Usuarios' }).waitFor();
    await page.getByText('Esta sesión').waitFor();
  });

  await step('Búsqueda global', async () => {
    await page.goto(`${WEB}/inicio`);
    await page.getByText('Ventas de hoy').waitFor();
    await page.keyboard.press('Control+k');
    if (!(await page.getByLabel('Búsqueda global').evaluate((el) => el === document.activeElement))) throw new Error('Ctrl+K no enfocó la búsqueda');
    await page.keyboard.type('Gaseosa');
    await page.getByRole('button', { name: /Gaseosa Cola 500 ml · GAS-500/ }).click();
    await page.waitForURL(/\/productos\/[0-9a-f-]{36}$/);
  });

  await step('Modo oscuro', async () => {
    // El botón alterna sistema → claro → oscuro
    for (let i = 0; i < 3 && !(await page.evaluate(() => document.documentElement.classList.contains('dark'))); i++) {
      await page.getByRole('button', { name: /Cambiar tema/ }).click();
    }
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    await page.reload();
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    await page.screenshot({ path: `${SHOTS}/inicio-oscuro.png` });
  });

  await step('Vista móvil con menú desplegable', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${WEB}/pedidos`);
    await page.getByRole('button', { name: 'Abrir menú' }).click();
    await page.getByRole('link', { name: 'Inventario' }).last().waitFor();
    await page.screenshot({ path: `${SHOTS}/movil-menu.png` });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) throw new Error('Hay scroll horizontal en móvil');
  });

  await step('Cerrar sesión', async () => {
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto(`${WEB}/inicio`);
    await page.getByRole('button', { name: /Cerrar sesión/i }).first().click();
    await page.waitForURL(/\/login/);
    await page.goto(`${WEB}/inicio`);
    await page.waitForURL(/\/login/);
  });

  await step('Vendedor acepta la invitación y ve permisos reducidos', async () => {
    const link = (await linkFor(seller, 'aceptar-invitacion')).replace(/^https?:\/\/[^/]+/, WEB);
    await page.goto(link);
    await label('Contraseña').fill(password);
    await label('Repite la contraseña').fill(password);
    await page.getByRole('button', { name: 'Guardar' }).click();
    await page.waitForURL(/\/login/);
    await label('Correo').fill(seller);
    await label('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL(/\/inicio/);
    await page.goto(`${WEB}/productos`);
    await page.getByRole('link', { name: 'Gaseosa Cola 500 ml' }).waitFor();
    if (await page.getByRole('button', { name: 'Importar' }).count()) throw new Error('El vendedor ve "Importar"');
    if (await page.getByRole('link', { name: 'Usuarios' }).count()) throw new Error('El vendedor ve el menú Usuarios');
    await page.goto(`${WEB}/usuarios`);
    await page.getByText('Sin acceso').waitFor();
    await page.goto(`${WEB}/pedidos/nuevo`);
    await page.getByRole('button', { name: 'Crear y confirmar' }).waitFor();
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await page.waitForURL(/\/login/);
  });

  if (process.env.PLATFORM_ADMIN_EMAIL && process.env.PLATFORM_ADMIN_PASSWORD) {
    await step('Administrador general suspende y reactiva la empresa', async () => {
      await label('Correo').fill(process.env.PLATFORM_ADMIN_EMAIL);
      await label('Contraseña').fill(process.env.PLATFORM_ADMIN_PASSWORD);
      await page.getByRole('button', { name: 'Entrar' }).click();
      await page.waitForURL(/\/plataforma/);
      await page.getByLabel('Buscar empresa').fill(stamp);
      const row = page.getByRole('row', { name: new RegExp(`Bodega Smoke ${stamp}`) });
      await row.getByRole('button', { name: 'Suspender' }).click();
      await page.getByRole('button', { name: 'Suspender', exact: true }).last().click();
      await row.getByText('Suspendida').waitFor();
      await page.screenshot({ path: `${SHOTS}/plataforma.png` });
      // Con la empresa suspendida, su administrador no puede entrar
      const r = await page.request.post(`${WEB}/api/v1/auth/login`, { data: { email, password } });
      if (r.status() !== 403) throw new Error(`Login con empresa suspendida devolvió ${r.status()}`);
      await row.getByRole('button', { name: 'Reactivar' }).click();
      await row.getByText('Activa', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Cerrar sesión' }).click();
      await page.waitForURL(/\/login/);
    });
  }

  if (consoleErrors.length) {
    console.log('\nErrores de consola del navegador:');
    for (const e of [...new Set(consoleErrors)]) console.log('  -', e.slice(0, 200));
  }
} finally {
  await browser.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} pasos correctos`);
  if (ok !== results.length) process.exitCode = 1;
}
