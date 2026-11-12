import argon2 from 'argon2';
import { setTestEnv, createTestApp, ownerClient, resetDatabase, registerAndLogin, roleClient } from './helpers.js';

setTestEnv();
process.env.THROTTLE_DISABLED = 'true';
process.env.BILLING_GRACE_DAYS = '3';

const DAY = 86_400_000;

describe('Cobro manual: prueba, vencimiento en solo lectura y pagos', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const owner = ownerClient();
  let root: string;
  const asRoot = () => ({ Authorization: `Bearer ${root}` });

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
    await owner.user.create({
      data: { email: 'root@plataforma.test', name: 'Root', role: 'PLATFORM_ADMIN', emailVerifiedAt: new Date(), passwordHash: await argon2.hash('RootClave123') },
    });
    root = (await ctx.http().post('/api/v1/auth/login').send({ email: 'root@plataforma.test', password: 'RootClave123' }).expect(200)).body.accessToken;
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
  });

  const expire = (tenantId: string, data: object) => owner.subscription.update({ where: { tenantId }, data });

  it('una empresa nueva está en prueba y lo ve en /auth/me y /tenant', async () => {
    const t = await registerAndLogin(ctx, { companyName: 'Prueba Vigente', email: 'a@vigente.test' });
    const me = await ctx.http().get('/api/v1/auth/me').set({ Authorization: `Bearer ${t.accessToken}` }).expect(200);
    expect(me.body.tenant.subscription.access).toMatchObject({ state: 'TRIAL', readOnly: false, daysLeft: 14 });
    const tenant = await ctx.http().get('/api/v1/tenant').set({ Authorization: `Bearer ${t.accessToken}` }).expect(200);
    expect(tenant.body.subscription.access.state).toBe('TRIAL');
  });

  it('al vencer la prueba la cuenta queda en solo lectura (402), sin perder la sesión ni los datos', async () => {
    const t = await registerAndLogin(ctx, { companyName: 'Prueba Vencida', email: 'a@vencida.test' });
    const h = { Authorization: `Bearer ${t.accessToken}` };
    await ctx.http().post('/api/v1/categories').set(h).send({ name: 'Antes de vencer' }).expect(201);

    const past = new Date(Date.now() - 1000);
    await expire(t.tenantId, { trialEndsAt: past, currentPeriodEnd: past });

    const blocked = await ctx.http().post('/api/v1/categories').set(h).send({ name: 'Después' }).expect(402);
    expect(blocked.body).toMatchObject({ code: 'SUBSCRIPTION_EXPIRED', access: { state: 'EXPIRED', readOnly: true } });
    await ctx.http().patch('/api/v1/tenant').set(h).send({ name: 'Otro nombre' }).expect(402);

    // Lecturas, perfil y sesión siguen funcionando
    const cats = await ctx.http().get('/api/v1/categories').set(h).expect(200);
    expect(JSON.stringify(cats.body)).toContain('Antes de vencer');
    await ctx.http().get('/api/v1/tenant').set(h).expect(200);
    const me = await ctx.http().get('/api/v1/auth/me').set(h).expect(200);
    expect(me.body.tenant.subscription.access.state).toBe('EXPIRED');
    const sessions = await ctx.http().get('/api/v1/auth/sessions').set(h).expect(200);
    expect(sessions.body.length).toBeGreaterThan(0);
  });

  it('el administrador general registra un pago: activa el plan, quita el bloqueo y deja rastro', async () => {
    const t = await registerAndLogin(ctx, { companyName: 'Paga Yape', email: 'a@yape.test' });
    const h = { Authorization: `Bearer ${t.accessToken}` };
    const past = new Date(Date.now() - DAY);
    await expire(t.tenantId, { trialEndsAt: past, currentPeriodEnd: past });
    await ctx.http().post('/api/v1/categories').set(h).send({ name: 'X' }).expect(402);

    // La empresa no puede registrarse pagos a sí misma
    await ctx.http().post(`/api/v1/platform/tenants/${t.tenantId}/payments`).set(h).send({ planCode: 'ENTERPRISE', months: 12, amount: 0, method: 'YAPE' }).expect(403);

    const before = Date.now();
    const r = await ctx.http().post(`/api/v1/platform/tenants/${t.tenantId}/payments`).set(asRoot())
      .send({ planCode: 'PROFESSIONAL', months: 1, amount: 79, currency: 'PEN', method: 'YAPE', reference: 'OP-123456' }).expect(201);
    expect(r.body.subscription).toMatchObject({ status: 'ACTIVE', plan: { code: 'PROFESSIONAL' }, access: { state: 'ACTIVE', readOnly: false } });
    const end = new Date(r.body.subscription.currentPeriodEnd).getTime();
    expect(end - before).toBeGreaterThan(27 * DAY);
    expect(end - before).toBeLessThan(32 * DAY);

    await ctx.http().post('/api/v1/categories').set(h).send({ name: 'Ya pagó' }).expect(201);
    const tenant = await ctx.http().get('/api/v1/tenant').set(h).expect(200);
    expect(tenant.body.limits.maxUsers).toBe(10);

    // Un segundo pago con el periodo vigente se suma a continuación
    const r2 = await ctx.http().post(`/api/v1/platform/tenants/${t.tenantId}/payments`).set(asRoot())
      .send({ planCode: 'PROFESSIONAL', months: 2, amount: 158, method: 'BANK_TRANSFER' }).expect(201);
    expect(r2.body.payment.periodStart).toBe(new Date(end).toISOString());
    expect(new Date(r2.body.subscription.currentPeriodEnd).getTime()).toBeGreaterThan(end + 58 * DAY);

    const list = await ctx.http().get(`/api/v1/platform/tenants/${t.tenantId}/payments`).set(asRoot()).expect(200);
    expect(list.body).toHaveLength(2);
    const own = await ctx.http().get('/api/v1/tenant/payments').set(h).expect(200);
    expect(own.body.map((p: { reference: string | null }) => p.reference)).toContain('OP-123456');
    expect(await owner.auditLog.count({ where: { tenantId: t.tenantId, action: 'platform.payment_recorded' } })).toBe(2);
  });

  it('valida el pago: meses fuera de rango, importe negativo, fecha futura y empresa inexistente', async () => {
    const t = await registerAndLogin(ctx, { companyName: 'Validaciones', email: 'a@valida.test' });
    const url = `/api/v1/platform/tenants/${t.tenantId}/payments`;
    await ctx.http().post(url).set(asRoot()).send({ planCode: 'BASIC', months: 0, amount: 29, method: 'YAPE' }).expect(400);
    await ctx.http().post(url).set(asRoot()).send({ planCode: 'BASIC', months: 1, amount: -1, method: 'YAPE' }).expect(400);
    await ctx.http().post(url).set(asRoot()).send({ planCode: 'BASIC', months: 1, amount: 29, method: 'BITCOIN' }).expect(400);
    await ctx.http().post(url).set(asRoot()).send({ planCode: 'BASIC', months: 1, amount: 29, method: 'YAPE', paidAt: new Date(Date.now() + 2 * DAY).toISOString() }).expect(400);
    await ctx.http().post('/api/v1/platform/tenants/00000000-0000-7000-8000-000000000000/payments').set(asRoot()).send({ planCode: 'BASIC', months: 1, amount: 29, method: 'YAPE' }).expect(404);
    expect(await owner.payment.count({ where: { tenantId: t.tenantId } })).toBe(0);
  });

  it('periodo pagado vencido: gracia de 3 días operativa, después solo lectura', async () => {
    const t = await registerAndLogin(ctx, { companyName: 'Gracia', email: 'a@gracia.test' });
    const h = { Authorization: `Bearer ${t.accessToken}` };
    await expire(t.tenantId, { status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() - 2 * DAY) });
    const me = await ctx.http().get('/api/v1/auth/me').set(h).expect(200);
    expect(me.body.tenant.subscription.access).toMatchObject({ state: 'GRACE', readOnly: false, daysLeft: 1 });
    await ctx.http().post('/api/v1/categories').set(h).send({ name: 'En gracia' }).expect(201);

    await expire(t.tenantId, { currentPeriodEnd: new Date(Date.now() - 4 * DAY) });
    await ctx.http().post('/api/v1/categories').set(h).send({ name: 'Tras la gracia' }).expect(402);
  });

  it('cancelar la suscripción deja la cuenta en solo lectura de inmediato', async () => {
    const t = await registerAndLogin(ctx, { companyName: 'Cancelada', email: 'a@cancelada.test' });
    const h = { Authorization: `Bearer ${t.accessToken}` };
    await ctx.http().post(`/api/v1/platform/tenants/${t.tenantId}/cancel-subscription`).set(asRoot()).send({ reason: 'pidió la baja' }).expect(201);
    const r = await ctx.http().post('/api/v1/categories').set(h).send({ name: 'X' }).expect(402);
    expect(r.body.access.state).toBe('CANCELED');
    await ctx.http().get('/api/v1/tenant').set(h).expect(200);
    const list = await ctx.http().get('/api/v1/platform/tenants?q=cancelada').set(asRoot()).expect(200);
    expect(list.body.items[0].subscription.access.state).toBe('CANCELED');
  });

  it('el rol de ejecución no puede escribir pagos ni ver los de otra empresa (RLS)', async () => {
    const a = await registerAndLogin(ctx, { companyName: 'RLS A', email: 'a@rlsa.test' });
    const b = await registerAndLogin(ctx, { companyName: 'RLS B', email: 'a@rlsb.test' });
    await ctx.http().post(`/api/v1/platform/tenants/${b.tenantId}/payments`).set(asRoot()).send({ planCode: 'BASIC', months: 1, amount: 29, method: 'CASH' }).expect(201);
    const app = roleClient('runtime');
    try {
      const seen = await app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${a.tenantId}, true)`;
        return tx.payment.count();
      });
      expect(seen).toBe(0);
      const plan = await owner.plan.findUniqueOrThrow({ where: { code: 'ENTERPRISE' } });
      await expect(
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${a.tenantId}, true)`;
          return tx.payment.create({ data: { tenantId: a.tenantId, planId: plan.id, amount: 0, currency: 'PEN', months: 12, method: 'OTHER', paidAt: new Date(), periodStart: new Date(), periodEnd: new Date(Date.now() + DAY) } });
        }),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await app.$disconnect();
    }
  });
});
