/**
 * Postventa (ADR 054) en navegador real: una empresa nueva abre un caso desde
 * Soporte; el equipo lo ve en su cola, deja una nota interna, responde y lo
 * resuelve; la empresa recibe los correos, no ve la nota interna, califica y el
 * caso se cierra. Después, su plan vence en 2 días: el panel de renovaciones
 * envía el aviso una sola vez.
 *
 *   MAILPIT_URL=http://localhost:8025 PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... node e2e/support.mjs
 *
 * Para simular el vencimiento cambia la fecha del periodo en la base de
 * desarrollo (docker compose exec postgres psql); nunca se ejecuta en producción.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR ?? 'e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });
if (!process.env.PLATFORM_ADMIN_EMAIL || !process.env.MAILPIT_URL) throw new Error('Faltan PLATFORM_ADMIN_EMAIL/PLATFORM_ADMIN_PASSWORD y MAILPIT_URL');
const stamp = Date.now().toString(36);
const company = `Bodega Soporte ${stamp}`;
const email = `soporte-${stamp}@example.com`;
const password = 'ClaveSegura123';
const subject = `El asistente no responde ${stamp}`;
const note = `Nota interna ${stamp}: revisar la clave de IA`;
const results = [];
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    await Promise.all([page, admin].map((p, i) => p?.screenshot({ path: `${SHOTS}/soporte-fallo-${i}.png`, fullPage: true }).catch(() => undefined)));
    console.log(`✗ ${name}\n  ${e.message.split('\n').slice(0, 3).join('\n  ')}`);
    throw e;
  }
};

function sql(query) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'postgres', 'sh', '-c', `psql -U "$POSTGRES_USER" -d "\${APP_DB_NAME:-ai_sales}" -tAc "$0"`, query], { cwd: '../..', encoding: 'utf8' }).trim();
}

async function mail(to, match) {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`).then((x) => x.json());
    const m = (r.messages ?? []).find((x) => match.test(x.Subject));
    if (m) return fetch(`${process.env.MAILPIT_URL}/api/v1/message/${m.ID}`).then((x) => x.json());
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`No llegó a ${to} el correo ${match}`);
}
const mails = async (to, match) => ((await fetch(`${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`).then((x) => x.json())).messages ?? []).filter((x) => match.test(x.Subject));

const browser = await chromium.launch();
const opts = { viewport: { width: 1360, height: 900 }, locale: 'es-PE', timezoneId: 'America/Lima' };
const page = await (await browser.newContext(opts)).newPage();
const admin = await (await browser.newContext(opts)).newPage();
const errors = [];
for (const p of [page, admin]) p.on('pageerror', (e) => errors.push(e.message));
const label = (p, l) => p.getByLabel(l, { exact: true });
let ticketUrl;

try {
  await step('La empresa abre un caso desde Soporte', async () => {
    await page.goto(`${WEB}/registro`);
    await label(page, 'Nombre del negocio').fill(company);
    await label(page, 'Tu nombre').fill('Rosa Soporte');
    await label(page, 'Correo').fill(email);
    await label(page, 'Contraseña').fill(password);
    await page.getByRole('button', { name: 'Crear cuenta' }).click();
    await page.getByText(/revisa tu correo|te enviamos/i).first().waitFor({ timeout: 10_000 });
    const verify = /https?:\/\/\S+verificar-correo\?token=[^\s"<]+/.exec((await mail(email, /./)).Text)[0];
    await page.goto(verify.replace(/^https?:\/\/[^/]+/, WEB));
    await page.getByText(/verificado|confirmado/i).first().waitFor({ timeout: 10_000 });
    await page.goto(`${WEB}/login`);
    await label(page, 'Correo').fill(email);
    await label(page, 'Contraseña').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL(/\/inicio$/);
    await page.getByRole('link', { name: 'Soporte', exact: true }).click();
    await page.getByText('Sin casos').waitFor();
    await page.getByText(/Plazos de primera respuesta: urgente 2 h/).waitFor();
    await page.getByRole('button', { name: 'Nuevo caso' }).click();
    const dlg = page.getByRole('dialog');
    await label(dlg, 'Tipo').selectOption('INCIDENT');
    await label(dlg, 'Prioridad').selectOption('HIGH');
    await dlg.getByText('Primera respuesta en 8 h como máximo').waitFor();
    await label(dlg, 'Asunto').fill(subject);
    await label(dlg, 'Detalle').fill('Desde las 9 a. m. los clientes no reciben respuesta en WhatsApp.');
    await page.screenshot({ path: `${SHOTS}/soporte-nuevo-caso.png` });
    await dlg.getByRole('button', { name: 'Enviar caso' }).click();
    await page.waitForURL(/\/soporte\/[0-9a-f-]{36}$/);
    ticketUrl = page.url();
    await page.getByRole('heading', { name: new RegExp(`SOP-\\d{5} · ${subject}`) }).waitFor();
    await page.getByText('Abierto', { exact: true }).waitFor();
  });

  await step('El equipo recibe el aviso y ve el caso en su cola', async () => {
    const m = await mail(process.env.PLATFORM_ADMIN_EMAIL, new RegExp(`Nuevo caso SOP-\\d{5}: ${subject}`));
    if (!m.Text.includes('/plataforma/soporte/')) throw new Error('El aviso no enlaza el caso');
    await admin.goto(`${WEB}/login`);
    await label(admin, 'Correo').fill(process.env.PLATFORM_ADMIN_EMAIL);
    await label(admin, 'Contraseña').fill(process.env.PLATFORM_ADMIN_PASSWORD);
    await admin.getByRole('button', { name: 'Entrar' }).click();
    await admin.waitForURL(/\/plataforma$/);
    await admin.getByRole('link', { name: 'Casos de soporte' }).click();
    await admin.getByText('Casos pendientes').waitFor();
    await admin.getByLabel('Buscar casos').fill(stamp);
    const row = admin.getByRole('row').filter({ hasText: subject });
    await row.getByText(company).waitFor();
    await row.getByText('Alta', { exact: true }).waitFor();
    await row.getByText('Sin asignar').waitFor();
    await row.getByText(/^Antes del /).waitFor();
    await admin.screenshot({ path: `${SHOTS}/soporte-cola.png` });
    await row.getByRole('link', { name: subject }).click();
    await admin.waitForURL(/\/plataforma\/soporte\/[0-9a-f-]{36}$/);
  });

  await step('Nota interna y respuesta: la primera respuesta queda registrada y el cliente recibe correo', async () => {
    await label(admin, 'Mensaje').fill(note);
    await admin.getByRole('button', { name: 'Guardar como nota interna' }).click();
    await admin.getByText('Nota interna guardada').waitFor();
    await admin.getByText('Nota interna: la empresa no la ve').waitFor();
    await admin.getByText(/^Antes del /).waitFor(); // una nota no cuenta como respuesta
    await label(admin, 'Mensaje').fill('¿Nos confirmas si cambiaste la clave de IA ayer?');
    await admin.getByRole('button', { name: 'Responder al cliente' }).click();
    await admin.getByText('Respuesta enviada al cliente').waitFor();
    await admin.getByText('En atención').first().waitFor();
    if (await admin.getByText(/^Antes del /).count()) throw new Error('No registró la primera respuesta');
    await mail(email, /^Respuesta a tu caso SOP-/);
    await admin.screenshot({ path: `${SHOTS}/soporte-atencion.png`, fullPage: true });
  });

  await step('La empresa ve la respuesta, nunca la nota interna, y contesta', async () => {
    await page.goto(ticketUrl);
    await page.getByText('¿Nos confirmas si cambiaste la clave de IA ayer?').waitFor();
    await page.getByText(/Equipo de soporte ·/).first().waitFor();
    if (await page.getByText(note).count()) throw new Error('La empresa ve la nota interna');
    await label(page, 'Responder').fill('Sí, la cambié ayer en la tarde.');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await page.getByText('Mensaje enviado').waitFor();
    await page.getByText('Sí, la cambié ayer en la tarde.').waitFor();
  });

  await step('El equipo lo resuelve y la empresa recibe la encuesta', async () => {
    await admin.reload();
    await admin.getByText('Sí, la cambié ayer en la tarde.').waitFor();
    await label(admin, 'Estado').selectOption('RESOLVED');
    await admin.getByText('Estado actualizado').waitFor();
    await admin.getByText('Estado: Resuelto').waitFor();
    const m = await mail(email, /^Resolvimos tu caso SOP-/);
    if (!m.Text.includes('califica')) throw new Error('El correo no pide calificar');
  });

  await step('La empresa califica (4 de 5) y el caso se cierra', async () => {
    await page.reload();
    await page.getByText('¿Cómo te atendimos?').waitFor();
    await page.getByRole('radio', { name: '4 de 5' }).click();
    await label(page, 'Comentario (opcional)').fill('Rápido y claro');
    await page.screenshot({ path: `${SHOTS}/soporte-encuesta.png`, fullPage: true });
    await page.getByRole('button', { name: 'Enviar calificación' }).click();
    await page.getByText('Gracias por tu calificación').waitFor();
    await page.getByText('Calificaste la atención con 4 de 5: “Rápido y claro”.').waitFor();
    await page.getByText(/El caso está cerrado/).waitFor();
    await admin.reload();
    await admin.getByText('4 / 5 · “Rápido y claro”').waitFor();
    if (!(await label(admin, 'Estado').isDisabled())) throw new Error('Cerrado debería bloquear los cambios');
  });

  await step('Su plan vence en 2 días: el panel de renovaciones envía el aviso una sola vez', async () => {
    sql(`UPDATE subscriptions SET status = 'ACTIVE', trial_ends_at = NULL, current_period_end = now() + interval '2 days' WHERE tenant_id = (SELECT tenant_id FROM users WHERE email = '${email}')`);
    await admin.goto(`${WEB}/plataforma/soporte?vista=renovaciones`);
    const row = admin.getByRole('row').filter({ hasText: company });
    await row.getByText('Al día').waitFor();
    await row.getByText('Ninguno aún').waitFor();
    await admin.getByRole('button', { name: 'Enviar avisos pendientes' }).click();
    await admin.getByText(/Avisos enviados a \d+ empresa\(s\)/).waitFor();
    await row.getByText(/3 días antes · .* · 1 destinatario\(s\)/).waitFor();
    const m = await mail(email, /vence el \d{2}\/\d{2}\/\d{4}$/);
    if (!m.Text.includes('/soporte')) throw new Error('El aviso no indica cómo renovar');
    await admin.screenshot({ path: `${SHOTS}/soporte-renovaciones.png`, fullPage: true });
    await admin.getByRole('button', { name: 'Enviar avisos pendientes' }).click();
    await admin.getByText(/No había avisos pendientes|Avisos enviados/).first().waitFor();
    if ((await mails(email, /vence el/)).length !== 1) throw new Error('El aviso se repitió');
  });

  if (errors.length) throw new Error(`Errores de JavaScript en la página: ${errors.join(' | ')}`);
} finally {
  await browser.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} pasos correctos`);
  process.exitCode = ok === results.length && !errors.length ? 0 : 1;
}
