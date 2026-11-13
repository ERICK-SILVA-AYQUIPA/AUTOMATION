import argon2 from 'argon2';
import { DatabaseService } from '../src/database/database.service.js';
import { APP_VERSION } from '../src/deliveries/version.js';
import { SystemService } from '../src/system/system.service.js';
import { setTestEnv, createTestApp, ownerClient, resetDatabase, registerAndLogin } from './helpers.js';

setTestEnv();
const owner = ownerClient();

describe('Actualizaciones: versión, migraciones e historial solo para la plataforma', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let root: string;
  let shop: Awaited<ReturnType<typeof registerAndLogin>>;
  const R = () => ({ Authorization: `Bearer ${root}` });

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
    await owner.user.create({ data: { email: 'root@sistema.test', name: 'Root', role: 'PLATFORM_ADMIN', emailVerifiedAt: new Date(), passwordHash: await argon2.hash('RootClave123') } });
    root = (await ctx.http().post('/api/v1/auth/login').send({ email: 'root@sistema.test', password: 'RootClave123' }).expect(200)).body.accessToken;
    shop = await registerAndLogin(ctx, { companyName: 'Tienda Versiones', email: 'admin@sistema-a.test' });
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
  });

  it('muestra la versión instalada y las migraciones reales; las empresas no tienen acceso', async () => {
    await ctx.http().get('/api/v1/platform/system').set({ Authorization: `Bearer ${shop.accessToken}` }).expect(403);
    const s = (await ctx.http().get('/api/v1/platform/system').set(R()).expect(200)).body;
    const applied = await owner.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    expect(s.version).toBe(APP_VERSION);
    expect(s.migrations.applied).toBe(Number(applied[0]!.n));
    expect(s.migrations.last.name).toBe('20261116090100_migrations_read_grant');
    expect(s.migrations.failed).toEqual([]);
    expect(s.updates).toEqual([]);
  });

  it('registra el resultado de cada actualización con las migraciones que aplicó', async () => {
    const svc = ctx.app.get(SystemService);
    // Las migraciones de la base de pruebas terminaron antes de ahora: una actualización que empieza ahora no aplicó ninguna
    const now = await svc.record({ fromVersion: '0.8.0', toVersion: '0.9.0', status: 'SUCCEEDED', startedAt: new Date(), backupPath: '/opt/aisa/respaldos/x', detail: 'prueba' });
    expect(now.migrations).toEqual([]);
    const all = await svc.record({ fromVersion: '0.8.0', toVersion: '0.9.0', status: 'SUCCEEDED', startedAt: new Date('2000-01-01T00:00:00Z') });
    expect((all.migrations as string[]).length).toBeGreaterThan(10);
    expect(all.migrations).toContain('20261116090000_system_updates');
    const rolled = await svc.record({ fromVersion: '0.9.0', toVersion: '0.10.0', status: 'ROLLED_BACK', startedAt: new Date(Date.now() - 60_000), detail: 'la salud falló' });
    expect(rolled.migrations).toEqual([]);
    const s = (await ctx.http().get('/api/v1/platform/system').set(R()).expect(200)).body;
    expect(s.updates.map((u: { status: string }) => u.status)).toEqual(['ROLLED_BACK', 'SUCCEEDED', 'SUCCEEDED']);
    await expect(svc.record({ fromVersion: 'latest', toVersion: '0.9.0', status: 'SUCCEEDED', startedAt: new Date() } as never)).rejects.toThrow();
  });

  it('avisa de instalaciones independientes entregadas con una versión anterior', async () => {
    await ctx.http().patch(`/api/v1/platform/tenants/${shop.tenantId}`).set(R()).send({ deploymentMode: 'DEDICATED' }).expect(200);
    await owner.delivery.create({
      data: { tenantId: shop.tenantId, number: 1, systemName: 'Tienda Versiones', deploymentMode: 'DEDICATED', appVersion: '0.0.1', domain: 'ventas.tienda.test', supportContact: 'soporte@x.test', manifest: {}, status: 'DELIVERED', packageSha256: 'a'.repeat(64), generatedAt: new Date(), deliveredAt: new Date() },
    });
    const s = (await ctx.http().get('/api/v1/platform/system').set(R()).expect(200)).body;
    expect(s.installationsBehind).toEqual([expect.objectContaining({ tenantId: shop.tenantId, tenant: 'Tienda Versiones', version: '0.0.1', number: 1 })]);
  });

  it('el rol de las empresas no puede leer ni escribir el historial', async () => {
    const db = ctx.app.get(DatabaseService);
    await expect(db.tenant(shop.tenantId, (tx) => tx.systemUpdate.findMany())).rejects.toThrow(/permission denied/i);
  });
});
