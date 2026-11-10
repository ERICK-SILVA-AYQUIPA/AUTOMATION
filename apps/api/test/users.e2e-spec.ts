import { setTestEnv, createTestApp, ownerClient, resetDatabase, tokenFrom, registerAndLogin } from './helpers.js';

setTestEnv();
process.env.THROTTLE_DISABLED = 'true';

describe('Usuarios y roles (caso 2: crear usuario)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const owner = ownerClient();
  let admin: Awaited<ReturnType<typeof registerAndLogin>>;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
    admin = await registerAndLogin(ctx, { companyName: 'Tienda Uno', email: 'admin@uno.test' });
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
  });

  it('el administrador invita a un vendedor, este acepta y puede iniciar sesión', async () => {
    const inv = await ctx.http().post('/api/v1/users').set(auth(admin.accessToken)).send({ email: 'Vende@Uno.test', name: 'Vendedor', role: 'SELLER' }).expect(201);
    expect(inv.body).toMatchObject({ email: 'vende@uno.test', role: 'SELLER', status: 'INVITED' });
    expect(inv.body.passwordHash).toBeUndefined();

    const mail = ctx.outbox.filter((m) => m.to === 'vende@uno.test').at(-1)!;
    await ctx.http().post('/api/v1/auth/accept-invitation').send({ token: tokenFrom(mail.text), password: 'Vendedor1234' }).expect(204);
    const login = await ctx.http().post('/api/v1/auth/login').send({ email: 'vende@uno.test', password: 'Vendedor1234' }).expect(200);
    const me = await ctx.http().get('/api/v1/auth/me').set(auth(login.body.accessToken)).expect(200);
    expect(me.body.role).toBe('SELLER');
    expect(me.body.tenantId).toBe(admin.tenantId);
    expect(me.body.permissions).toContain('orders:write');
    expect(me.body.permissions).not.toContain('users:manage');

    // El vendedor NO puede gestionar usuarios ni configurar la empresa
    await ctx.http().post('/api/v1/users').set(auth(login.body.accessToken)).send({ email: 'x@uno.test', name: 'X', role: 'SELLER' }).expect(403);
    await ctx.http().get('/api/v1/users').set(auth(login.body.accessToken)).expect(403);
    await ctx.http().patch('/api/v1/tenant').set(auth(login.body.accessToken)).send({ name: 'Hack' }).expect(403);

    const audit = await owner.auditLog.findMany({ where: { tenantId: admin.tenantId, action: { in: ['user.invited', 'user.invitation_accepted'] } } });
    expect(audit).toHaveLength(2);
  });

  it('no permite un rol de plataforma ni superar el límite de usuarios del plan', async () => {
    await ctx.http().post('/api/v1/users').set(auth(admin.accessToken)).send({ email: 'p@uno.test', name: 'P', role: 'PLATFORM_ADMIN' }).expect(400);
    // Plan BÁSICO de prueba: máximo 3 usuarios (admin + vendedor + 1)
    await ctx.http().post('/api/v1/users').set(auth(admin.accessToken)).send({ email: 's@uno.test', name: 'Supervisor', role: 'SUPERVISOR' }).expect(201);
    const r = await ctx.http().post('/api/v1/users').set(auth(admin.accessToken)).send({ email: 'extra@uno.test', name: 'Extra', role: 'SELLER' }).expect(403);
    expect(r.body.code).toBe('PLAN_LIMIT_REACHED');
  });

  it('desactivar a un usuario revoca sus sesiones al instante', async () => {
    const login = await ctx.http().post('/api/v1/auth/login').send({ email: 'vende@uno.test', password: 'Vendedor1234' }).expect(200);
    const users = await ctx.http().get('/api/v1/users').set(auth(admin.accessToken)).expect(200);
    const seller = users.body.find((u: { email: string }) => u.email === 'vende@uno.test');
    await ctx.http().patch(`/api/v1/users/${seller.id}`).set(auth(admin.accessToken)).send({ status: 'DISABLED' }).expect(200);
    await ctx.http().get('/api/v1/auth/me').set(auth(login.body.accessToken)).expect(401);
    await ctx.http().post('/api/v1/auth/login').send({ email: 'vende@uno.test', password: 'Vendedor1234' }).expect(403);
  });

  it('el administrador no puede cambiar su propio rol', async () => {
    await ctx.http().patch(`/api/v1/users/${admin.userId}`).set(auth(admin.accessToken)).send({ role: 'SELLER' }).expect(400);
  });
});
