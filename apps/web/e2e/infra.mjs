/**
 * Gestor de infraestructura (ADR 050) en navegador real, contra el servidor
 * local que responde como Hetzner Cloud (apps/api/test/fake-hetzner.ts, que
 * este script arranca en el puerto 4996; la API debe tener
 * HETZNER_API_BASE_URL=http://127.0.0.1:4996/v1). Nada real se crea.
 *
 *   WEB_URL=http://localhost:3000 PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... node e2e/infra.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR ?? 'e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });
if (!process.env.PLATFORM_ADMIN_EMAIL) throw new Error('Faltan PLATFORM_ADMIN_EMAIL/PLATFORM_ADMIN_PASSWORD');
const stamp = Date.now().toString(36);
const label = `Hetzner prueba ${stamp}`;
const serverName = `srv-${stamp}`;

const fakePath = fileURLToPath(new URL('../../api/test/fake-hetzner.ts', import.meta.url));
const fake = spawn(process.execPath, [fakePath, '4996'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => {
  fake.stdout.on('data', (d) => String(d).includes('Hetzner de prueba') && res());
  fake.on('exit', (c) => rej(new Error(`El Hetzner de prueba terminó (${c})`)));
});

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
    await page?.screenshot({ path: `${SHOTS}/infra-fallo.png`, fullPage: true }).catch(() => undefined);
    if (consoleErrors.length) console.log(`  Consola: ${consoleErrors.slice(0, 3).join(' | ').slice(0, 800)}`);
    console.log(`✗ ${name}\n  ${e.message.split('\n').slice(0, 3).join('\n  ')}`);
    throw e;
  }
};
const L = (l, scope = page) => scope.getByLabel(l, { exact: true });
const toast = (t) => page.getByText(t, { exact: true }).first().waitFor();
const tab = (name) => page.getByRole('tab', { name, exact: true }).click();
const card = () => page.locator('div.rounded-xl', { has: page.getByRole('heading', { name: label }) }).filter({ has: page.getByRole('button', { name: 'Probar conexión' }) }).last();

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-PE', timezoneId: 'America/Lima' });
page = await ctx.newPage();
page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message));

try {
  await step('Agregar Hetzner: un token rechazado no se guarda; el bueno se guarda sin volver a mostrarse', async () => {
    await page.goto(`${WEB}/login`);
    await L('Correo').fill(process.env.PLATFORM_ADMIN_EMAIL);
    await L('Contraseña').fill(process.env.PLATFORM_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL(/\/plataforma$/);
    await page.getByRole('navigation', { name: 'Menú principal' }).getByRole('link', { name: 'Infraestructura' }).click();
    await page.waitForURL(/\/plataforma\/infraestructura$/);
    await page.getByRole('button', { name: 'Agregar proveedor' }).click();
    const dlg = page.getByRole('dialog');
    await L('Token de API', dlg).fill(`bad${'x'.repeat(61)}`);
    await L('Nombre', dlg).fill(label);
    await L('Presupuesto mensual (sin impuestos)', dlg).fill('20');
    await L('Máximo de servidores', dlg).fill('3');
    await L('Direcciones con acceso SSH (CIDR)', dlg).fill('203.0.113.10/32');
    await dlg.getByRole('button', { name: 'Probar y guardar' }).click();
    await dlg.getByText('Hetzner rechazó el token (inválido o revocado)').waitFor();
    const token = `${'k'.repeat(60)}${stamp.slice(-4).padStart(4, '0')}`;
    await L('Token de API', dlg).fill(token);
    await dlg.getByRole('button', { name: 'Probar y guardar' }).click();
    await toast('Proveedor conectado: el token funcionó');
    await card().getByText('Conectado', { exact: true }).waitFor();
    if ((await page.content()).includes(token)) throw new Error('El token aparece en la página');
  });

  await step('Regiones y precios leídos del proveedor, con disponibilidad y tamaños retirados', async () => {
    await card().getByRole('button', { name: 'Regiones y precios' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('cell', { name: 'cx23' }).waitFor();
    await dlg.getByText(/fsn1: EUR\s3\.79/).first().waitFor();
    await dlg.getByText('Retirado', { exact: true }).waitFor();
    await page.screenshot({ path: `${SHOTS}/infra-catalogo.png`, fullPage: true });
    await dlg.getByRole('button', { name: 'Cerrar' }).click();
  });

  await step('Clave SSH: la privada se rechaza, la pública se registra', async () => {
    await tab('Claves SSH');
    const f = page.getByRole('form', { name: 'Agregar clave SSH' });
    await L('Nombre', f).fill(`Laptop ${stamp}`);
    await L('Clave pública', f).fill('-----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXk');
    await f.getByRole('button', { name: 'Agregar' }).click();
    await page.getByText(/Nunca la privada/).first().waitFor();
    // Clave pública válida y única para esta corrida
    const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.from(stamp.padEnd(32, 'z').slice(0, 32))]).toString('base64');
    await L('Clave pública', f).fill(`ssh-ed25519 ${blob} prueba@${stamp}`);
    await f.getByRole('button', { name: 'Agregar' }).click();
    await toast('Clave registrada');
    await page.getByText(`Laptop ${stamp}`).waitFor();
  });

  await step('Pedir un servidor: elige región y tamaño con precio; no se crea hasta aprobar', async () => {
    await tab('Solicitudes');
    await page.getByRole('button', { name: 'Pedir servidor' }).click();
    const dlg = page.getByRole('dialog');
    await L('Proveedor', dlg).selectOption({ label });
    await L('Para qué es', dlg).fill('Servidor de pruebas del gestor de infraestructura');
    await L('Nombre del servidor', dlg).fill(serverName);
    await L('Región', dlg).selectOption('fsn1');
    await L('Tamaño', dlg).selectOption('cx23');
    await dlg.getByText(/Costo: EUR\s3\.79 por mes/).waitFor();
    await dlg.getByRole('button', { name: 'Registrar solicitud' }).click();
    await toast('Solicitud registrada: falta aprobarla');
    await page.getByText(new RegExp(`#\\d+ · ${serverName}`)).waitFor();
  });

  await step('Aprobar exige escribir el nombre y autorizar el gasto; crea el servidor con firewall', async () => {
    const req = page.locator('div.rounded-xl', { has: page.getByText(new RegExp(`#\\d+ · ${serverName}`)) }).filter({ has: page.getByRole('button', { name: 'Aprobar y crear' }) }).last();
    await req.getByRole('button', { name: 'Aprobar y crear' }).click();
    const dlg = page.getByRole('dialog');
    const go = dlg.getByRole('button', { name: 'Aprobar y crear servidor' });
    await L(`Escribe el nombre del servidor (${serverName})`, dlg).fill(serverName);
    if (await go.isEnabled()) throw new Error('Se puede aprobar sin autorizar el gasto');
    await dlg.getByLabel('Autorizo este gasto mensual estimado').check();
    await go.click();
    await toast(`Servidor ${serverName} creado`);
    await tab('Servidores');
    const s = page.locator('div.rounded-xl', { has: page.getByText(serverName, { exact: true }) }).filter({ has: page.getByRole('button', { name: 'Actualizar' }) }).last();
    await s.getByRole('button', { name: 'Actualizar' }).click();
    await toast('Estado actualizado');
    await s.getByText('Encendido', { exact: true }).waitFor();
    await s.getByText(/203\.0\.113\./).waitFor();
    await page.screenshot({ path: `${SHOTS}/infra-servidor.png`, fullPage: true });
  });

  await step('Apagar, encender, consumo e historial', async () => {
    const s = () => page.locator('div.rounded-xl', { has: page.getByText(serverName, { exact: true }) }).filter({ has: page.getByRole('button', { name: 'Actualizar' }) }).last();
    await s().getByRole('button', { name: 'Apagar' }).click();
    await toast('Apagado');
    await s().getByText('Apagado', { exact: true }).waitFor();
    await s().getByRole('button', { name: 'Encender' }).click();
    await toast('Encendido');
    await s().getByRole('button', { name: 'Consumo e historial' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByText(/CPU promedio 16\.3 %, máximo 20\.0 %/).waitFor();
    await dlg.getByRole('list', { name: 'Operaciones del servidor' }).getByText('Servidor creado').waitFor();
    await dlg.getByRole('button', { name: 'Cerrar' }).click();
    await tab('Proveedores');
    await card().getByText(/EUR\s3\.79 \/ EUR\s20\.00/).waitFor();
  });

  await step('Eliminar exige el nombre escrito y un motivo; deja de contar en el presupuesto', async () => {
    await tab('Servidores');
    const s = page.locator('div.rounded-xl', { has: page.getByText(serverName, { exact: true }) }).filter({ has: page.getByRole('button', { name: 'Actualizar' }) }).last();
    await s.getByRole('button', { name: 'Eliminar' }).click();
    const dlg = page.getByRole('dialog');
    const go = dlg.getByRole('button', { name: 'Eliminar definitivamente' });
    await L(`Escribe el nombre (${serverName})`, dlg).fill(serverName);
    if (await go.isEnabled()) throw new Error('Se puede eliminar sin motivo');
    await L('Motivo', dlg).fill('Fin de la prueba automática');
    await go.click();
    await toast('Servidor eliminado');
    await page.getByLabel('Incluir eliminados').check();
    await page.locator('div.rounded-xl', { has: page.getByText(serverName, { exact: true }) }).getByText(/Eliminado .*: Fin de la prueba automática/).waitFor();
    await tab('Proveedores');
    await card().getByText(/EUR\s0\.00 \/ EUR\s20\.00/).waitFor();
  });

  if (consoleErrors.length) throw new Error(`Errores en la consola: ${consoleErrors.join(' | ').slice(0, 500)}`);
} finally {
  // Deja el proveedor de prueba desactivado (no hay borrado de proveedores)
  try {
    const t = (await (await fetch(`${WEB}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.PLATFORM_ADMIN_EMAIL, password: process.env.PLATFORM_ADMIN_PASSWORD }) })).json()).accessToken;
    const ps = await (await fetch(`${WEB}/api/v1/platform/infra/providers`, { headers: { Authorization: `Bearer ${t}` } })).json();
    for (const p of ps.filter((x) => x.label === label)) await fetch(`${WEB}/api/v1/platform/infra/providers/${p.id}/disabled`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ disabled: true }) });
  } catch (e) {
    console.log(`No se desactivó el proveedor de prueba: ${e.message}`);
  }
  await browser.close();
  fake.kill();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} pasos correctos`);
  process.exitCode = results.every((r) => r.ok) && !consoleErrors.length ? 0 : 1;
}
