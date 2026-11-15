/**
 * Página comercial y agente comercial (ADR 048) en navegador real:
 * la plataforma escribe y publica la página, prueba el agente desde el panel;
 * un visitante sin sesión ve la página, elige su sector, deja una solicitud de
 * demostración y conversa con el agente, que lo registra en el centro comercial.
 * Al terminar deja la configuración como estaba (página sin publicar).
 *
 * El agente usa la IA asignada al servicio COMMERCIAL de la empresa interna; sin
 * claves reales, el script levanta en el puerto 4997 el servidor local de
 * apps/api/test/fake-ai-providers.ts (la API debe apuntar a él, ver api-center.mjs).
 *
 *   WEB_URL=http://localhost:3000 MAILPIT_URL=http://localhost:8025 \
 *   PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... node e2e/commercial.mjs
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
const headline = `Vende por WhatsApp con tu catálogo real ${stamp}`;
const formEmail = `form-${stamp}@example.com`;
const chatEmail = `chat-${stamp}@example.com`;
const chatName = 'Lucía Web';

const fake = await startFakeAiProviders(Number(process.env.FAKE_AI_PORT ?? 4997));

// API como la plataforma (solo para preparar la IA y restaurar al final)
const token = (await (await fetch(`${WEB}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.PLATFORM_ADMIN_EMAIL, password: process.env.PLATFORM_ADMIN_PASSWORD }) })).json()).accessToken;
async function call(method, path, body) {
  const r = await fetch(`${WEB}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

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
    await current?.screenshot({ path: `${SHOTS}/comercial-fallo.png`, fullPage: true }).catch(() => undefined);
    if (consoleErrors.length) console.log(`  Consola: ${consoleErrors.slice(0, 3).join(' | ').slice(0, 800)}`);
    console.log(`✗ ${name}\n  ${e.message.split('\n').slice(0, 3).join('\n  ')}`);
    throw e;
  }
};

const browser = await chromium.launch();
const newPage = async (w = 1360) => {
  const p = await (await browser.newContext({ viewport: { width: w, height: 900 }, locale: 'es-PE', timezoneId: 'America/Lima' })).newPage();
  p.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && consoleErrors.push(m.text()));
  p.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message));
  return p;
};
const L = (p, l) => p.getByLabel(l, { exact: true });
const before = await call('GET', '/platform/commercial');
let house;
let credentialId;

try {
  await step('Preparación: IA asignada al servicio «Agente comercial» de una empresa interna', async () => {
    house = before.tenants[0];
    if (!house) throw new Error('No hay empresas para usar como empresa interna');
    const c = await call('POST', '/platform/api-center/credentials', { provider: 'anthropic', label: `Claude comercial ${stamp}`, fields: { apiKey: `sk-ant-local-${stamp}-comercial-01` } });
    credentialId = c.id;
    await call('POST', `/platform/api-center/credentials/${c.id}/models/refresh`);
    await call('PUT', `/platform/api-center/tenants/${house.id}/ai/COMMERCIAL`, { credentialId: c.id, model: 'claude-prueba-chica' });
  });

  const admin = await newPage();
  await step('Plataforma: publicar exige titular; se escribe y publica la página con el chat', async () => {
    current = admin;
    await admin.goto(`${WEB}/login`);
    await L(admin, 'Correo').fill(process.env.PLATFORM_ADMIN_EMAIL);
    await L(admin, 'Contraseña').fill(process.env.PLATFORM_ADMIN_PASSWORD);
    await admin.getByRole('button', { name: 'Entrar' }).click();
    await admin.waitForURL(/\/plataforma$/);
    await admin.getByRole('navigation', { name: 'Menú principal' }).getByRole('link', { name: 'Página comercial' }).click();
    await admin.waitForURL(/\/plataforma\/comercial$/);
    await admin.getByRole('heading', { name: 'Página comercial', level: 1 }).waitFor();
    await L(admin, 'Titular').fill('');
    await admin.getByLabel('Publicar la página en la dirección principal').check();
    await admin.getByRole('button', { name: 'Guardar' }).click();
    await admin.getByText('Para publicar la página escribe el titular').first().waitFor();

    await L(admin, 'Titular').fill(headline);
    await L(admin, 'Bajada').fill('Responde con precios y stock reales, registra pedidos y pasa a una persona cuando hace falta.');
    await L(admin, 'WhatsApp de contacto').fill('+51 900 000 001');
    const problems = admin.locator('div.rounded-xl').filter({ has: admin.getByRole('heading', { name: 'Problemas que resuelve' }) });
    await problems.getByRole('button', { name: 'Agregar' }).click();
    await L(admin, 'Problemas que resuelve: título 1').fill('Mensajes sin responder');
    await L(admin, 'Problemas que resuelve: texto 1').fill('Los clientes escriben fuera de horario y se van.');
    await admin.getByRole('button', { name: 'Agregar pregunta' }).click();
    await L(admin, 'Pregunta 1').fill('¿Usa la API oficial de WhatsApp?');
    await L(admin, 'Respuesta 1').fill('Sí, la API oficial de WhatsApp Business de Meta.');
    await L(admin, 'Empresa interna').selectOption(house.id);
    await admin.getByLabel('Mostrar el chat en la página').check();
    await L(admin, 'Nombre del agente').fill('Sofía');
    await admin.getByRole('button', { name: 'Guardar' }).click();
    await admin.getByText('Página guardada y publicada').waitFor();
    await admin.getByText('Publicada', { exact: true }).waitFor();
    await admin.getByRole('status').filter({ hasText: 'Disponible' }).waitFor();
    await admin.screenshot({ path: `${SHOTS}/comercial-editor.png`, fullPage: true });
  });

  await step('Plataforma: probar el agente desde el panel (consulta los planes reales, no registra nada)', async () => {
    await L(admin, 'Mensaje de prueba').fill('¿qué planes tienen?');
    await admin.getByRole('button', { name: 'Enviar prueba' }).click();
    const box = admin.getByLabel('Conversación de prueba');
    await box.getByText(/^Agente: .*planes/).waitFor({ timeout: 15_000 });
    await box.getByText('Herramientas: ver_planes').waitFor();
  });

  const visitor = await newPage(1280);
  await step('Visitante: ve la página pública con datos reales y sin testimonios inventados', async () => {
    current = visitor;
    await visitor.goto(`${WEB}/`);
    await visitor.getByRole('heading', { name: headline, level: 1 }).waitFor({ timeout: 15_000 });
    await visitor.getByRole('heading', { name: 'Funciones' }).waitFor();
    await visitor.getByRole('heading', { name: 'Conversaciones de WhatsApp' }).waitFor();
    await visitor.getByText('Precio en la propuesta').first().waitFor();
    await visitor.getByText('Mensajes sin responder').waitFor();
    if (await visitor.getByRole('heading', { name: 'Lo que dicen nuestros clientes' }).count()) throw new Error('Aparece una sección de testimonios sin testimonios');
    await visitor.getByText('¿Usa la API oficial de WhatsApp?').click();
    await visitor.getByText('Sí, la API oficial de WhatsApp Business de Meta.').waitFor();
    await visitor.screenshot({ path: `${SHOTS}/comercial-pagina.png`, fullPage: true });
  });

  await step('Visitante: elige su sector y pide una demostración con el formulario', async () => {
    await visitor.getByRole('button', { name: 'Es mi sector' }).first().click();
    const form = visitor.getByRole('form', { name: 'Formulario de contacto' });
    if (!(await L(form, 'Sector').inputValue())) throw new Error('No quedó elegido el sector');
    await L(form, 'Nombre').fill('Pedro Formulario');
    await L(form, 'Empresa').fill(`Minimarket ${stamp}`);
    await L(form, 'Correo').fill(formEmail);
    await L(form, 'Cuéntanos tu necesidad').fill('Atendemos pedidos por WhatsApp y se nos pierden mensajes.');
    await L(form, '¿Cuándo prefieres la demostración?').fill('martes por la tarde');
    await form.getByRole('button', { name: 'Enviar solicitud' }).click();
    await form.getByText('Debes aceptar el uso de tus datos para responder la solicitud').waitFor();
    await form.getByLabel('Acepto que usen estos datos para responder esta solicitud.').check();
    await form.getByLabel(/Acepto que me contacten después/).check();
    await form.getByRole('button', { name: 'Enviar solicitud' }).click();
    await visitor.getByRole('status').filter({ hasText: 'Recibimos tu solicitud.' }).waitFor();
  });

  await step('Visitante: conversa con el agente; lo registra y anota la demostración', async () => {
    await visitor.getByRole('button', { name: 'Chatear con Sofía' }).click();
    const chat = visitor.getByRole('dialog', { name: 'Chat con Sofía' });
    const say = async (t, n) => {
      await L(chat, 'Mensaje para el asesor').fill(t);
      await chat.getByRole('button', { name: 'Enviar mensaje' }).click();
      await chat.getByText(/^Agente: /).nth(n).waitFor({ timeout: 15_000 });
    };
    await say(`me llamo ${chatName}, ${chatEmail}, acepto que me contacten`, 0);
    await chat.getByText(/"ok":true/).first().waitFor();
    await say('quiero una demo', 1);
    await visitor.screenshot({ path: `${SHOTS}/comercial-chat.png` });
  });

  await step('Plataforma: ambos prospectos llegan sin responsable, con consentimiento, solicitud e historial del chat', async () => {
    current = admin;
    await admin.goto(`${WEB}/plataforma/ventas`);
    await admin.getByRole('tab', { name: 'Lista' }).click();
    await admin.getByLabel('Buscar prospecto').fill(formEmail);
    // La búsqueda filtra con una pequeña espera: hasta que quede solo el de este recorrido
    await admin.getByRole('link', { name: 'Pedro Formulario', exact: true }).nth(1).waitFor({ state: 'detached' });
    await admin.getByRole('link', { name: 'Pedro Formulario', exact: true }).click();
    await admin.waitForURL(/\/plataforma\/ventas\/[0-9a-f-]{36}$/);
    await admin.getByText('Demostración solicitada').first().waitFor();
    await admin.getByText(/Confirmar demostración \(prefiere: martes por la tarde\)/).first().waitFor();
    await admin.getByText(/^Sí \(página web/).waitFor();

    await admin.goto(`${WEB}/plataforma/ventas`);
    await admin.getByRole('tab', { name: 'Lista' }).click();
    await admin.getByLabel('Buscar prospecto').fill(chatEmail);
    await admin.getByRole('link', { name: chatName, exact: true }).nth(1).waitFor({ state: 'detached' });
    await admin.getByRole('link', { name: chatName, exact: true }).click();
    await admin.waitForURL(/\/plataforma\/ventas\/[0-9a-f-]{36}$/);
    await admin.getByText('Demostración solicitada').first().waitFor();
    await admin.getByRole('heading', { name: 'Chat de la página web' }).waitFor();
    const msgs = admin.getByRole('list', { name: 'Mensajes del chat web' });
    await msgs.getByText('quiero una demo').waitFor();
    await msgs.getByText(/solicitar_demostracion/).waitFor();
    await admin.screenshot({ path: `${SHOTS}/comercial-prospecto.png`, fullPage: true });
  });
} finally {
  // Deja la configuración como estaba: sin publicar si no lo estaba, sin la IA de prueba
  const { agent: _a, tenants: _t, publishedAt: _p, updatedAt: _u, ...prev } = before;
  await call('PUT', '/platform/commercial', prev).catch((e) => console.log(`  No se restauró la página: ${e.message}`));
  if (house) await call('DELETE', `/platform/api-center/tenants/${house.id}/ai/COMMERCIAL`).catch(() => undefined);
  if (credentialId) await call('DELETE', `/platform/api-center/credentials/${credentialId}`).catch((e) => console.log(`  No se borró la credencial: ${e.message}`));
  await browser.close();
  await fake.close();
}

if (!before.published) {
  await step('Sin publicar, la dirección principal vuelve a llevar al panel', async () => {
    const r = await fetch(`${WEB}/api/v1/public/commercial`);
    if (r.status !== 404) throw new Error(`La página sigue publicada (${r.status})`);
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} pasos correctos`);
if (consoleErrors.length) console.log(`Errores de consola: ${consoleErrors.length}\n  ${consoleErrors.slice(0, 5).join('\n  ')}`);
process.exit(failed.length || consoleErrors.length ? 1 : 0);
