import argon2 from 'argon2';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encrypt } from '../src/common/crypto/crypto.js';
import { DatabaseService } from '../src/database/database.service.js';
import { importDelivery } from '../src/deliveries/import.js';
import { APP_VERSION } from '../src/deliveries/version.js';
import { unzip } from '../src/deliveries/zip.js';
import { setTestEnv, createTestApp, ownerClient, resetDatabase, registerAndLogin } from './helpers.js';

setTestEnv();
const owner = ownerClient();
const GEMINI_SECRET = 'AIzaSy-clave-propia-de-la-empresa-0123456789';
const META_SECRET = 'app-secret-de-meta-0123456789abcdef';
const HOOK_SECRET = 'whsec_secreto-del-webhook-0123456789';

/** Respuesta binaria de supertest */
/** Cabecera y comentarios del .env de ejemplo */
const env0 = (t: string) => t.split('\n').filter((l) => l.startsWith('#')).join('\n');

const binary = (res: import('supertest').Response, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('Entrega de sistemas: paquete reproducible, sin secretos y solo para la plataforma', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let root: string;
  let shop: Awaited<ReturnType<typeof registerAndLogin>>;
  let saas: Awaited<ReturnType<typeof registerAndLogin>>;
  let deliveryId: string;
  let firstZip: Buffer;
  const R = () => ({ Authorization: `Bearer ${root}` });
  const download = (id: string) => ctx.http().get(`/api/v1/platform/deliveries/${id}/package`).set(R()).buffer(true).parse(binary);

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
    await owner.user.create({ data: { email: 'root@entregas.test', name: 'Root', role: 'PLATFORM_ADMIN', emailVerifiedAt: new Date(), passwordHash: await argon2.hash('RootClave123') } });
    root = (await ctx.http().post('/api/v1/auth/login').send({ email: 'root@entregas.test', password: 'RootClave123' }).expect(200)).body.accessToken;
    shop = await registerAndLogin(ctx, { companyName: 'Ferretería Andina', email: 'admin@entregas-a.test' });
    saas = await registerAndLogin(ctx, { companyName: 'Bodega SaaS', email: 'admin@entregas-b.test' });
    const key = process.env.DATA_ENCRYPTION_KEY!;
    // Credenciales reales guardadas (cifradas) que NUNCA deben viajar en el paquete
    await owner.tenantIntegration.create({ data: { tenantId: shop.tenantId, type: 'GEMINI', status: 'CONNECTED', secretsEnc: encrypt(GEMINI_SECRET, key), config: { hint: '…6789' } } });
    await owner.whatsappNumber.create({ data: { tenantId: shop.tenantId, provider: 'CLOUD_API', displayPhone: '51900000077', phoneNumberId: '7700', webhookKey: 'wk-entregas', status: 'CONNECTED', appSecretEnc: encrypt(META_SECRET, key), verifyTokenEnc: encrypt('verify-token-entregas', key) } });
    await owner.webhookEndpoint.create({ data: { tenantId: shop.tenantId, url: 'https://erp.ferreteria.test/hooks', events: ['order.created'], secretEnc: encrypt(HOOK_SECRET, key), secretHint: '…6789' } });
    await ctx.http().patch('/api/v1/tenant/settings').set({ Authorization: `Bearer ${shop.accessToken}` }).send({ catalog: { volumePricing: true }, orders: { minAmount: 150 } }).expect(200);
    await ctx.http().post('/api/v1/categories').set({ Authorization: `Bearer ${shop.accessToken}` }).send({ name: 'Herramientas' }).expect(201);
    await ctx.http().patch(`/api/v1/platform/tenants/${shop.tenantId}`).set(R()).send({ deploymentMode: 'DEDICATED' }).expect(200);
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
  });

  it('solo el administrador general prepara entregas; una instalación propia exige dominio', async () => {
    await ctx.http().get(`/api/v1/platform/tenants/${shop.tenantId}/deliveries`).set({ Authorization: `Bearer ${shop.accessToken}` }).expect(403);
    await ctx.http().post(`/api/v1/platform/tenants/${shop.tenantId}/deliveries`).set({ Authorization: `Bearer ${shop.accessToken}` }).send({ systemName: 'X', supportContact: 'soporte' }).expect(403);
    const r = await ctx.http().post(`/api/v1/platform/tenants/${shop.tenantId}/deliveries`).set(R()).send({ systemName: 'Ventas Andina', supportContact: 'soporte@plataforma.test · +51 900 000 000' }).expect(400);
    expect(r.body.code).toBe('DOMAIN_REQUIRED');
    const s = await ctx.http().post(`/api/v1/platform/tenants/${saas.tenantId}/deliveries`).set(R()).send({ systemName: 'Bodega', domain: 'bodega.test', supportContact: 'soporte@plataforma.test' }).expect(400);
    expect(s.body.code).toBe('DOMAIN_NOT_ALLOWED');
  });

  it('la entrega es una foto sin secretos: módulos, funciones, configuración, requisitos e integraciones pendientes', async () => {
    const r = await ctx.http().post(`/api/v1/platform/tenants/${shop.tenantId}/deliveries`).set(R()).send({ systemName: 'Ventas Andina', domain: 'ventas.andina.test', supportContact: 'soporte@plataforma.test · +51 900 000 000', notes: 'Atención de lunes a viernes' }).expect(201);
    deliveryId = r.body.id;
    const m = r.body.manifest;
    expect(r.body).toMatchObject({ number: 1, status: 'DRAFT', deploymentMode: 'DEDICATED', appVersion: APP_VERSION, domain: 'ventas.andina.test' });
    expect(m.system).toMatchObject({ deploymentMode: 'DEDICATED', panelUrl: 'https://ventas.andina.test' });
    expect(m.modules).toContain('orders');
    expect(m.plan.limits.maxUsers).toBeGreaterThan(0);
    expect(m.configuration.settings.orders.minAmount).toBe(150);
    expect(m.configuration.categories.map((c: { name: string }) => c.name)).toContain('Herramientas');
    expect(m.requirements.map((x: { key: string }) => x.key)).toEqual(expect.arrayContaining(['server', 'domain', 'smtp', 'images', 'whatsapp']));
    const wa = m.integrations.find((i: { key: string }) => i.key === 'whatsapp');
    expect(wa).toMatchObject({ pending: true });
    expect(wa.detail).toMatch(/no viajan en el paquete/);
    expect(m.initialAccess.admins[0]).toMatchObject({ email: 'admin@entregas-a.test', status: 'Recibirá una invitación al instalar' });
    const text = JSON.stringify(r.body);
    for (const s of [GEMINI_SECRET, META_SECRET, HOOK_SECRET, 'secretsEnc', 'appSecretEnc', 'passwordHash', process.env.JWT_SECRET!]) expect(text).not.toContain(s);
  });

  it('el ZIP trae manuales, kit de instalación y huellas; volver a descargarlo da los mismos bytes', async () => {
    const res = await download(deliveryId).expect(200);
    firstZip = res.body as Buffer;
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(new RegExp(`entrega-ferreteria-andina-1-v${APP_VERSION}\\.zip`));
    expect(res.headers['x-package-sha256']).toBe(createHash('sha256').update(firstZip).digest('hex'));
    const files = unzip(firstZip);
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining([
      'LEEME.md', 'entrega.json', 'SHA256SUMS', 'docs/manual-usuario.md', 'docs/manual-administracion.md', 'docs/guia-whatsapp.md', 'docs/guia-ia.md', 'docs/soporte.md', 'docs/instalacion.md',
      'instalacion/docker-compose.prod.yml', 'instalacion/.env.production.example', 'instalacion/instalar.sh', 'instalacion/salud.sh', 'instalacion/respaldo.sh',
      'instalacion/restaurar.sh', 'instalacion/registros.sh', 'instalacion/configuracion-cliente.json', 'instalacion/infrastructure/caddy/Caddyfile',
    ]));
    const file = (p: string) => files.find((f) => f.path === p)!;
    expect(file('instalacion/instalar.sh').mode & 0o111).toBeTruthy();
    expect(file('instalacion/actualizar.sh').mode & 0o111).toBeTruthy();
    // Huellas del kit para el actualizador: todos los archivos del kit salvo la configuración de la empresa
    const kitSums = file('instalacion/.kit-sha256').data.toString().trim().split('\n').map((l) => l.split('  ') as [string, string]);
    const kitFiles = paths.filter((p) => p.startsWith('instalacion/') && !['instalacion/.kit-sha256', 'instalacion/configuracion-cliente.json'].includes(p)).map((p) => p.slice(12)).sort();
    expect(kitSums.map(([, p]) => p).sort()).toEqual(kitFiles);
    for (const [h, p] of kitSums) expect(createHash('sha256').update(file(`instalacion/${p}`).data).digest('hex')).toBe(h);
    expect(env0(file('instalacion/.env.production.example').data.toString())).not.toMatch(/deploy\.sh/);
    const env = file('instalacion/.env.production.example').data.toString();
    expect(env).toMatch(/^APP_DOMAIN=ventas\.andina\.test$/m);
    expect(env).toMatch(new RegExp(`^APP_VERSION=${APP_VERSION.replace(/\./g, '\\.')}$`, 'm'));
    expect(env).toMatch(/^JWT_SECRET=__GENERATE__$/m);
    const readme = file('LEEME.md').data.toString();
    expect(readme).toContain('Ferretería Andina');
    expect(readme).toContain('Pedido mínimo: PEN 150.00');
    // Cada huella de SHA256SUMS corresponde a su archivo
    for (const line of file('SHA256SUMS').data.toString().trim().split('\n')) {
      const [sum, path] = line.split(/\s+/);
      expect(createHash('sha256').update(file(path!).data).digest('hex')).toBe(sum);
    }
    // Ningún secreto, ni de la empresa ni del servidor
    const all = Buffer.concat(files.map((f) => f.data)).toString('utf8');
    for (const s of [GEMINI_SECRET, META_SECRET, HOOK_SECRET, 'verify-token-entregas', process.env.JWT_SECRET!, process.env.DATA_ENCRYPTION_KEY!, process.env.APP_DB_SYSTEM_PASSWORD!]) expect(all).not.toContain(s);

    const d = (await ctx.http().get(`/api/v1/platform/deliveries/${deliveryId}`).set(R()).expect(200)).body;
    expect(d).toMatchObject({ status: 'GENERATED', packageSha256: res.headers['x-package-sha256'], packageBytes: firstZip.length });
    const again = await download(deliveryId).expect(200);
    expect((again.body as Buffer).equals(firstZip)).toBe(true);
  });

  it('una entrega generada no cambia; se marca entregada y queda en la auditoría', async () => {
    const r = await ctx.http().post(`/api/v1/platform/deliveries/${deliveryId}/refresh`).set(R()).expect(409);
    expect(r.body.code).toBe('DELIVERY_FROZEN');
    const d = await ctx.http().post(`/api/v1/platform/deliveries/${deliveryId}/delivered`).set(R()).expect(200);
    expect(d.body.status).toBe('DELIVERED');
    const actions = (await owner.auditLog.findMany({ where: { tenantId: shop.tenantId, entityType: 'delivery' }, select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['platform.delivery_prepared', 'platform.delivery_generated', 'platform.delivery_delivered']));
  });

  it('las empresas no pueden leer entregas ni siquiera directamente en la base de datos', async () => {
    const db = ctx.app.get(DatabaseService);
    await expect(db.tenant(shop.tenantId, (tx) => tx.delivery.findMany())).rejects.toThrow(/permission denied/i);
  });

  it('SaaS: solo documentación, sin kit de instalación', async () => {
    const r = await ctx.http().post(`/api/v1/platform/tenants/${saas.tenantId}/deliveries`).set(R()).send({ systemName: 'Bodega en línea', supportContact: 'soporte@plataforma.test' }).expect(201);
    const files = unzip((await download(r.body.id).expect(200)).body as Buffer).map((f) => f.path);
    expect(files).toContain('docs/guia-whatsapp.md');
    expect(files.some((p) => p.startsWith('instalacion/'))).toBe(false);
    expect(files).not.toContain('docs/instalacion.md');
  });

  it('la instalación independiente carga la configuración una sola vez y no pisa lo personalizado', async () => {
    const m = (await ctx.http().get(`/api/v1/platform/deliveries/${deliveryId}`).set(R()).expect(200)).body.manifest;
    // Simula otra instancia: otro id de entrega y otro correo de administrador (en esta base ya existe el original)
    m.deliveryId = randomUUID();
    m.initialAccess.admins[0].email = 'admin@andina-instancia.test';
    const file = join(mkdtempSync(join(tmpdir(), 'entrega-')), 'configuracion-cliente.json');
    writeFileSync(file, JSON.stringify(m));
    const first = await importDelivery(ctx.app, file);
    expect(first.status).toBe('created');
    const t = await owner.tenant.findUniqueOrThrow({ where: { id: first.tenantId } });
    const cats = await owner.category.findMany({ where: { tenantId: first.tenantId } });
    expect(t).toMatchObject({ name: 'Ferretería Andina', deploymentMode: 'DEDICATED', status: 'ONBOARDING' });
    expect((t.settings as { orders: { minAmount: number } }).orders.minAmount).toBe(150);
    expect(cats.map((c) => c.name)).toContain('Herramientas');
    expect(await owner.whatsappNumber.count({ where: { tenantId: first.tenantId } })).toBe(0);
    expect(await owner.tenantIntegration.count({ where: { tenantId: first.tenantId } })).toBe(0);
    // El cliente personaliza y se repite la instalación: no se toca nada
    await owner.tenant.update({ where: { id: first.tenantId }, data: { settings: { ...(t.settings as object), orders: { minAmount: 300 } } } });
    const plan = await owner.plan.findUniqueOrThrow({ where: { code: m.plan.code } });
    const adjusted = { ...(plan.limits as object), maxUsers: 99 };
    await owner.plan.update({ where: { id: plan.id }, data: { limits: adjusted } });
    const planAudits = () => owner.auditLog.count({ where: { action: 'platform.plan_updated', entityId: plan.id } });
    const auditsBefore = await planAudits();
    const second = await importDelivery(ctx.app, file);
    expect(second).toMatchObject({ status: 'already_imported', tenantId: first.tenantId });
    expect((await owner.plan.findUniqueOrThrow({ where: { id: plan.id } })).limits).toMatchObject({ maxUsers: 99 });
    expect(await planAudits()).toBe(auditsBefore);
    await owner.plan.update({ where: { id: plan.id }, data: { limits: plan.limits as object } });
    expect(((await owner.tenant.findUniqueOrThrow({ where: { id: first.tenantId } })).settings as { orders: { minAmount: number } }).orders.minAmount).toBe(300);
    // Otra versión de la aplicación: se rechaza
    writeFileSync(file, JSON.stringify({ ...m, appVersion: '0.0.0-otra' }));
    await expect(importDelivery(ctx.app, file)).rejects.toThrow(/versión 0\.0\.0-otra/);
  });
});
