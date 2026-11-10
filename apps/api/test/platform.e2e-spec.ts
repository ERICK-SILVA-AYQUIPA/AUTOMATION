import argon2 from 'argon2';
import { setTestEnv, createTestApp, ownerClient, resetDatabase, registerAndLogin } from './helpers.js';

setTestEnv();
process.env.THROTTLE_DISABLED = 'true';

describe('Administrador general de plataforma', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const owner = ownerClient();
  let token: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
    await owner.user.create({
      data: { email: 'root@plataforma.test', name: 'Root', role: 'PLATFORM_ADMIN', emailVerifiedAt: new Date(), passwordHash: await argon2.hash('RootClave123') },
    });
    token = (await ctx.http().post('/api/v1/auth/login').send({ email: 'root@plataforma.test', password: 'RootClave123' }).expect(200)).body.accessToken;
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
  });

  it('lista empresas, cambia plan, ve métricas globales y suspende (bloqueando el acceso de la empresa)', async () => {
    const t = await registerAndLogin(ctx, { companyName: 'Cliente SaaS', email: 'admin@cliente.test' });
    const list = await ctx.http().get('/api/v1/platform/tenants?q=cliente').set(auth()).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].subscription.plan.code).toBe('BASIC');

    await ctx.http().patch(`/api/v1/platform/tenants/${t.tenantId}/plan`).set(auth()).send({ planCode: 'PROFESSIONAL' }).expect(200);
    const tenant = await ctx.http().get('/api/v1/tenant').set({ Authorization: `Bearer ${t.accessToken}` }).expect(200);
    expect(tenant.body.limits.maxUsers).toBe(10);

    const m = await ctx.http().get('/api/v1/platform/metrics').set(auth()).expect(200);
    expect(m.body.tenants).toEqual({ total: 1, active: 1, suspended: 0 });

    await ctx.http().patch(`/api/v1/platform/tenants/${t.tenantId}/status`).set(auth()).send({ status: 'SUSPENDED', reason: 'impago' }).expect(200);
    await ctx.http().get('/api/v1/tenant').set({ Authorization: `Bearer ${t.accessToken}` }).expect(403);
    await ctx.http().post('/api/v1/auth/login').send({ email: 'admin@cliente.test', password: 'ClaveSegura123' }).expect(403);
    expect(await owner.auditLog.count({ where: { action: 'platform.tenant_suspended' } })).toBe(1);
  });

  it('el administrador general no opera dentro de una empresa', async () => {
    await ctx.http().get('/api/v1/users').set(auth()).expect(403);
    await ctx.http().get('/api/v1/tenant').set(auth()).expect(403);
  });
});
