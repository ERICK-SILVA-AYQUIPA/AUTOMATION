/**
 * Centro de APIs (ADR 046) de punta a punta en navegador real: la plataforma
 * conecta Claude, lee sus modelos, pone precio y lo asigna a una empresa; la
 * empresa ve qué IA usa, la prueba, conversa con el precio real del catálogo,
 * conecta su propia clave de OpenAI y deja de usarla. Errores de clave visibles
 * y ninguna clave completa en pantalla.
 *
 * Sin claves reales, el script levanta en el puerto 4997 el servidor local de
 * apps/api/test/fake-ai-providers.ts (responde como Anthropic, OpenAI, DeepSeek
 * y Gemini). La API debe arrancarse apuntando a él (solo en desarrollo/pruebas):
 *
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:4997/anthropic OPENAI_BASE_URL=http://127.0.0.1:4997/openai/v1 \
 *   DEEPSEEK_BASE_URL=http://127.0.0.1:4997/deepseek node dist/main.js   (y dist/worker.js)
 *   WEB_URL=http://localhost:3000 MAILPIT_URL=http://localhost:8025 \
 *   PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... node e2e/api-center.mjs
 *
 * La prueba con claves reales se hace desde «Plataforma → Centro de APIs → Probar».
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { startFakeAiProviders } from '../../api/test/fake-ai-providers.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR ?? 'e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });
if (!process.env.PLATFORM_ADMIN_EMAIL || !process.env.MAILPIT_URL) throw new Error('Faltan PLATFORM_ADMIN_EMAIL/PLATFORM_ADMIN_PASSWORD y MAILPIT_URL');
const stamp = Date.now().toString(36);
const email = `apis-${stamp}@example.com`;
const company = `Bodega APIs ${stamp}`;
const password = 'ClaveSegura123';
const CLAUDE_KEY = `sk-ant-local-${stamp}-buena-a1b2c3d4`;
const CLAUDE_BAD = `sk-ant-local-${stamp}-bad-00000000`;
const OPENAI_KEY = `sk-proj-local-${stamp}-buena-z9y8`;
const OPENAI_NOPERM = `sk-proj-local-${stamp}-noperm-0000`;

const fake = await startFakeAiProviders(Number(process.env.FAKE_AI_PORT ?? 4997));

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
    await current?.screenshot({ path: `${SHOTS}/api-center-fallo.png`, fullPage: true }).catch(() => undefined);
    if (consoleErrors.length) console.log(`  Consola: ${consoleErrors.slice(0, 3).join(' | ').slice(0, 800)}`);
    console.log(`✗ ${name}\n  ${e.message.split('\n').slice(0, 3).join('\n  ')}`);
    throw e;
  }
};
async function linkFor(to, path) {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`).then((x) => x.json());
    const id = r.messages?.[0]?.ID;
    if (id) {
      const msg = await fetch(`${process.env.MAILPIT_URL}/api/v1/message/${id}`).then((x) => x.json());
      const link = new RegExp(`https?://\\S+${path}\\?token=[^\\s"<]+`).exec(msg.Text)?.[0];
      if (link) return link;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No se encontró el enlace ${path} para ${to}`);
}
/** Ninguna clave completa puede aparecer en el HTML de la página */
async function noFullKeys(p) {
  const html = await p.content();
  for (const k of [CLAUDE_KEY, CLAUDE_BAD, OPENAI_KEY, OPENAI_NOPERM]) if (html.includes(k)) throw new Error('Una clave completa aparece en la página');
}

const browser = await chromium.launch();
const newPage = async () => {
  const p = await (await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'es-PE', timezoneId: 'America/Lima' })).newPage();
  p.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && consoleErrors.push(m.text()));
  p.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message));
  return p;
};
const page = await newPage();
const admin = await newPage();
const L = (p, l) => p.getByLabel(l, { exact: true });
const aiCard = () => page.locator('div.rounded-xl').filter({ hasText: 'Proveedor del asistente' }).last();
async function chat(text) {
  await page.goto(`${WEB}/asistente`);
  await page.getByLabel('Mensaje de prueba').fill(text);
  await page.getByRole('button', { name: 'Enviar' }).click();
}

try {
  await step('Empresa nueva: registro, verificación y producto Gaseosa Cola a S/ 3.50', async () => {
    current = page;
    await page.goto(`${WEB}/registro`);
    await L(page, 'Nombre del negocio').fill(company);
    await L(page, 'Tu nombre').fill('Ana Apis');
    await L(page, 'Correo').fill(email);
    await L(page, 'Contraseña').fill(password);
    await page.getByRole('button', { name: 'Crear cuenta' }).click();
    await page.getByText(/revisa tu correo/i).waitFor({ timeout: 10_000 });
    await page.goto((await linkFor(email, 'verificar-correo')).replace(/^https?:\/\/[^/]+/, WEB));
    await page.getByText(/verificado/i).first().waitFor({ timeout: 10_000 });
    await page.goto(`${WEB}/login?next=/productos/nuevo`);
    await L(page, 'Correo').fill(email);
    await L(page, 'Contraseña').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL(/\/productos\/nuevo$/);
    await L(page, 'Nombre').fill('Gaseosa Cola 500 ml');
    await L(page, 'SKU (código interno)').fill('GAS-500');
    await L(page, 'Precio de venta').fill('3.50');
    await page.getByRole('button', { name: 'Crear producto' }).click();
    await page.waitForURL(/\/productos\/[0-9a-f-]{36}$/);
  });

  await step('Plataforma: una clave de Claude rechazada se muestra como error y no se guarda', async () => {
    current = admin;
    await admin.goto(`${WEB}/login`);
    await L(admin, 'Correo').fill(process.env.PLATFORM_ADMIN_EMAIL);
    await L(admin, 'Contraseña').fill(process.env.PLATFORM_ADMIN_PASSWORD);
    await admin.getByRole('button', { name: 'Entrar' }).click();
    await admin.waitForURL(/\/plataforma$/);
    await admin.getByRole('tab', { name: 'Centro de APIs' }).click();
    await admin.getByRole('heading', { name: 'Integraciones disponibles' }).waitFor();
    await admin.getByRole('button', { name: 'Agregar proveedor' }).click();
    const dlg = admin.getByRole('dialog');
    await L(dlg, 'Proveedor').selectOption('anthropic');
    await L(dlg, 'Nombre (para reconocerla)').fill(`Claude plataforma ${stamp}`);
    await L(dlg, 'API Key').fill(CLAUDE_BAD);
    await dlg.getByRole('button', { name: 'Probar y guardar' }).click();
    await dlg.getByText(/no aceptó la credencial \(Error de autenticación\)/).waitFor();
    await dlg.getByText(/invalid x-api-key/).waitFor();
    await admin.screenshot({ path: `${SHOTS}/api-center-clave-rechazada.png` });
    if (await admin.getByText(`Claude plataforma ${stamp}`, { exact: true }).count()) throw new Error('Se guardó una clave rechazada');
  });

  await step('Plataforma: Claude con clave válida, prueba real y lectura de modelos', async () => {
    const dlg = admin.getByRole('dialog');
    await L(dlg, 'API Key').fill(CLAUDE_KEY);
    await dlg.getByRole('button', { name: 'Probar y guardar' }).click();
    await admin.getByText(new RegExp(`Anthropic Claude aceptó la credencial \\(…${CLAUDE_KEY.slice(-4)}\\)`)).waitFor();
    const row = admin.locator('tr').filter({ hasText: `Claude plataforma ${stamp}` });
    await row.getByText('Conectado', { exact: true }).waitFor();
    await row.getByText(`…${CLAUDE_KEY.slice(-4)}`).waitFor();
    if (!fake.calls.some((c) => c.provider === 'anthropic' && c.path === '/anthropic/v1/models' && c.key === CLAUDE_KEY)) throw new Error('No se probó la clave con el proveedor');
    await row.getByRole('button', { name: `Leer modelos de Claude plataforma ${stamp}` }).click();
    await admin.getByText('2 modelo(s) leídos del proveedor').waitFor();
    await admin.locator('tr').filter({ hasText: 'claude-prueba-chica' }).getByText('Proveedor (', { exact: false }).waitFor();
    await noFullKeys(admin);
  });

  await step('Plataforma: precio del modelo y asignación a la empresa', async () => {
    const mrow = admin.locator('tr').filter({ hasText: 'claude-prueba-chica' });
    await mrow.getByRole('button', { name: 'Precio' }).click();
    const pd = admin.getByRole('dialog');
    await L(pd, 'Entrada (por millón de tokens)').fill('1');
    await L(pd, 'Salida (por millón de tokens)').fill('5');
    await L(pd, 'Moneda').fill('USD');
    await pd.getByRole('button', { name: 'Guardar' }).click();
    await mrow.getByText('1 / 5 USD').waitFor();

    await admin.getByRole('button', { name: 'Asignar IA' }).click();
    const dlg = admin.getByRole('dialog');
    const tenantOpt = await L(dlg, 'Empresa').locator('option', { hasText: company }).getAttribute('value');
    await L(dlg, 'Empresa').selectOption(tenantOpt);
    const credOpt = L(dlg, 'Credencial').locator('option', { hasText: `Administrada · Claude plataforma ${stamp}` });
    await credOpt.waitFor({ state: 'attached' });
    await L(dlg, 'Credencial').selectOption(await credOpt.getAttribute('value'));
    await L(dlg, 'Modelo').selectOption('claude-prueba-chica');
    await dlg.getByRole('button', { name: 'Guardar' }).click();
    await admin.getByText('Asignación guardada. Pruébala con «Probar».').waitFor();
    const arow = admin.locator('tr').filter({ hasText: company }).filter({ hasText: 'Asistente de clientes' });
    await arow.getByText('claude-prueba-chica').waitFor();
    await arow.getByRole('button', { name: `Probar IA de ${company}` }).click();
    await admin.getByText(/Anthropic Claude \(credencial administrada\) · claude-prueba-chica: respondió «OK»/).waitFor();
    await admin.screenshot({ path: `${SHOTS}/api-center-plataforma.png`, fullPage: true });
  });

  await step('Empresa: ve la IA asignada, la prueba y el asistente responde con el precio real', async () => {
    current = page;
    await page.goto(`${WEB}/integraciones`);
    await aiCard().getByText('Anthropic Claude (credencial administrada) · claude-prueba-chica').waitFor();
    await aiCard().getByText(/^Administrada \(Claude plataforma/).waitFor();
    if (await aiCard().getByRole('button', { name: 'Dejar de usar mi clave' }).count()) throw new Error('La empresa puede quitar una asignación administrada');
    await aiCard().getByRole('button', { name: 'Probar IA' }).click();
    await page.getByText(/claude-prueba-chica: respondió «OK»/).waitFor();
    await chat('¿precio de la gaseosa?');
    await page.getByText(/Cuesta S\/ 3\.50? \(Claude\)/).waitFor({ timeout: 20_000 });
    await page.getByText('consultó el catálogo').waitFor();
    await page.getByText(/Proveedor: Anthropic Claude · modelo claude-prueba-chica/).waitFor();
    const call = fake.calls.filter((c) => c.provider === 'anthropic' && c.path === '/anthropic/v1/messages').at(-1);
    if (call?.key !== CLAUDE_KEY || call.body.model !== 'claude-prueba-chica') throw new Error('La conversación no usó la credencial y el modelo asignados');
  });

  await step('Empresa: el consumo queda registrado con su costo', async () => {
    await page.goto(`${WEB}/integraciones`);
    const usage = aiCard().locator('tr').filter({ hasText: 'claude-prueba-chica' });
    await usage.waitFor();
    if (!/USD/.test(await usage.innerText())) throw new Error(`Sin costo en el consumo: ${await usage.innerText()}`);
    await page.screenshot({ path: `${SHOTS}/api-center-empresa.png`, fullPage: true });
  });

  await step('Empresa: clave propia de OpenAI sin permisos se rechaza; la válida se conecta y se usa', async () => {
    await aiCard().getByRole('button', { name: 'Conectar clave' }).click();
    const dlg = page.getByRole('dialog');
    await L(dlg, 'Proveedor').selectOption('openai');
    await L(dlg, 'API Key').fill(OPENAI_NOPERM);
    await dlg.getByRole('button', { name: 'Probar y guardar' }).click();
    await dlg.getByText(/no aceptó la credencial \(Sin permisos\)/).waitFor();
    await L(dlg, 'API Key').fill(OPENAI_KEY);
    await dlg.getByRole('button', { name: 'Probar y guardar' }).click();
    await page.getByText(new RegExp(`OpenAI aceptó la credencial \\(…${OPENAI_KEY.slice(-4)}\\)`)).waitFor();
    await aiCard().getByRole('button', { name: 'Usar en el asistente' }).click();
    const ad = page.getByRole('dialog');
    await L(ad, 'Modelo').locator('option', { hasText: 'gpt-prueba-mini' }).waitFor({ state: 'attached' });
    await L(ad, 'Modelo').selectOption('gpt-prueba-mini');
    await ad.getByText('Reemplaza la configuración actual (anthropic)').waitFor();
    await ad.getByRole('button', { name: 'Guardar' }).click();
    await page.getByText('El asistente usará gpt-prueba-mini. Pruébalo con «Probar IA».').waitFor();
    await aiCard().getByText('OpenAI (clave propia) · gpt-prueba-mini').waitFor();
    await noFullKeys(page);
    await chat('¿precio de la gaseosa?');
    await page.getByText(/Cuesta S\/ 3\.50? \(OpenAI\)/).waitFor({ timeout: 20_000 });
    const call = fake.calls.filter((c) => c.provider === 'openai' && c.path.endsWith('/chat/completions')).at(-1);
    if (call?.key !== OPENAI_KEY || call.body.model !== 'gpt-prueba-mini') throw new Error('La conversación no usó la clave propia');
  });

  await step('Plataforma: ve la asignación propia sin ver la clave; desconectar Claude no afecta a la empresa', async () => {
    current = admin;
    await admin.reload();
    await admin.getByRole('tab', { name: 'Centro de APIs' }).click();
    const arow = admin.locator('tr').filter({ hasText: company }).filter({ hasText: 'Asistente de clientes' });
    await arow.getByText('gpt-prueba-mini').waitFor();
    await arow.getByText(/Clave propia · OpenAI/).waitFor();
    await noFullKeys(admin);
    const row = admin.locator('tr').filter({ hasText: `Claude plataforma ${stamp}` });
    await row.getByRole('button', { name: `Desconectar Claude plataforma ${stamp}` }).click();
    await admin.getByRole('dialog').getByRole('button', { name: 'Desconectar' }).click();
    await admin.getByText('Desconectada. 0 asignación(es) desactivada(s).').waitFor();
    await row.getByText('Desconectado', { exact: true }).waitFor();
    current = page;
    await page.goto(`${WEB}/integraciones`);
    await aiCard().getByText('OpenAI (clave propia) · gpt-prueba-mini').waitFor();
  });

  await step('Empresa: deja de usar su clave y vuelve a la IA de la plataforma', async () => {
    await aiCard().getByRole('button', { name: 'Dejar de usar mi clave' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Dejar de usarla' }).click();
    await page.getByText('El asistente ya no usa tu clave propia').waitFor();
    await aiCard().getByText(/\(clave del servidor\)|Sin proveedor de IA/).first().waitFor();
    await aiCard().getByText('OpenAI', { exact: false }).first().waitFor(); // la clave sigue guardada en la tabla
    await noFullKeys(page);
    await page.screenshot({ path: `${SHOTS}/api-center-sin-clave.png`, fullPage: true });
  });

  if (consoleErrors.length) throw new Error(`Errores en la consola: ${consoleErrors.join(' | ').slice(0, 500)}`);
} finally {
  await browser.close();
  await fake.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} pasos correctos`);
  process.exitCode = results.every((r) => r.ok) && !consoleErrors.length ? 0 : 1;
}
