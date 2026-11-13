import { setTestEnv, createTestApp, ownerClient, resetDatabase, tokenFrom, registerAndLogin } from './helpers.js';

setTestEnv();
process.env.THROTTLE_DISABLED = 'true';

describe('Autenticación (caso 1: registrar empresa)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const owner = ownerClient();

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
  });

  it('registra una empresa con su administrador, suscripción de prueba, sucursal y configuración', async () => {
    const res = await ctx
      .http()
      .post('/api/v1/auth/register')
      .send({ companyName: 'Zapatería Ñandú', adminName: 'Ana', email: 'Ana@Zapateria.test', password: 'ClaveSegura123' })
      .expect(201);
    expect(res.body.tenantSlug).toBe('zapateria-nandu');

    const tenant = await owner.tenant.findUniqueOrThrow({
      where: { id: res.body.tenantId },
      include: { subscription: { include: { plan: true } }, users: true, branches: true },
    });
    expect(tenant.subscription?.status).toBe('TRIALING');
    expect(tenant.subscription?.plan.code).toBe('BASIC');
    expect(tenant.users).toHaveLength(1);
    expect(tenant.users[0]).toMatchObject({ email: 'ana@zapateria.test', role: 'TENANT_ADMIN', emailVerifiedAt: null });
    expect(tenant.users[0]!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(tenant.branches.filter((b) => b.isDefault)).toHaveLength(1);
    expect(await owner.aiSettings.count({ where: { tenantId: tenant.id } })).toBe(1);
    expect(await owner.automation.count({ where: { tenantId: tenant.id } })).toBe(7);

    const mail = ctx.outbox.find((m) => m.to === 'ana@zapateria.test');
    expect(mail?.subject).toMatch(/Confirma tu correo/);
  });

  it('rechaza correo duplicado y datos inválidos', async () => {
    await ctx.http().post('/api/v1/auth/register').send({ companyName: 'Otra', adminName: 'Xavier', email: 'ana@zapateria.test', password: 'ClaveSegura123' }).expect(409);
    const bad = await ctx.http().post('/api/v1/auth/register').send({ companyName: 'O', adminName: 'X', email: 'no-es-correo', password: 'corta' }).expect(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
    expect(bad.body.errors.map((e: { path: string }) => e.path)).toEqual(expect.arrayContaining(['companyName', 'email', 'password']));
  });

  it('no permite iniciar sesión sin verificar el correo; tras verificar sí', async () => {
    const login = () => ctx.http().post('/api/v1/auth/login').send({ email: 'ana@zapateria.test', password: 'ClaveSegura123' });
    const r1 = await login().expect(403);
    expect(r1.body.code).toBe('EMAIL_NOT_VERIFIED');
    const token = tokenFrom(ctx.outbox.find((m) => m.to === 'ana@zapateria.test')!.text);
    await ctx.http().post('/api/v1/auth/verify-email').send({ token }).expect(204);
    await ctx.http().post('/api/v1/auth/verify-email').send({ token }).expect(400); // un solo uso
    const r2 = await login().expect(200);
    expect(r2.body.accessToken).toBeTruthy();
    const cookies = r2.headers['set-cookie'] as unknown as string[];
    expect(cookies.find((c) => c.startsWith('aisa_rt='))).toMatch(/HttpOnly/);
  });

  it('contraseña incorrecta: 401 genérico y bloqueo tras 5 intentos', async () => {
    const { userId } = await registerAndLogin(ctx, { companyName: 'Bloqueo SA', email: 'lock@test.test' });
    for (let i = 0; i < 5; i++) {
      await ctx.http().post('/api/v1/auth/login').send({ email: 'lock@test.test', password: 'Incorrecta999' }).expect(401);
    }
    await ctx.http().post('/api/v1/auth/login').send({ email: 'lock@test.test', password: 'ClaveSegura123' }).expect(403);
    const u = await owner.user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    // correo inexistente: misma respuesta que contraseña incorrecta
    const r = await ctx.http().post('/api/v1/auth/login').send({ email: 'nadie@test.test', password: 'Incorrecta999' }).expect(401);
    expect(r.body.message).toBe('Correo o contraseña incorrectos');
  });

  it('refresh rota el token, exige CSRF y detecta reutilización revocando la familia', async () => {
    const { cookies, accessToken } = await registerAndLogin(ctx, { companyName: 'Rotación SA', email: 'rot@test.test' });
    const rt = cookies.find((c) => c.startsWith('aisa_rt='))!.split(';')[0]!;
    const csrfCookie = cookies.find((c) => c.startsWith('aisa_csrf='))!.split(';')[0]!;
    const csrf = csrfCookie.split('=')[1]!;

    await ctx.http().post('/api/v1/auth/refresh').set('Cookie', [rt, csrfCookie]).expect(403); // sin cabecera CSRF
    const r1 = await ctx.http().post('/api/v1/auth/refresh').set('Cookie', [rt, csrfCookie]).set('X-CSRF-Token', csrf).expect(200);
    expect(r1.body.accessToken).not.toBe(accessToken);

    // Reutilizar el refresh token viejo => 401 y TODA la familia revocada
    await ctx.http().post('/api/v1/auth/refresh').set('Cookie', [rt, csrfCookie]).set('X-CSRF-Token', csrf).expect(401);
    await ctx.http().get('/api/v1/auth/me').set('Authorization', `Bearer ${r1.body.accessToken}`).expect(401);
  });

  it('logout revoca la sesión y el access token deja de servir', async () => {
    const { cookies, accessToken } = await registerAndLogin(ctx, { companyName: 'Salida SA', email: 'out@test.test' });
    const jar = cookies.map((c) => c.split(';')[0]!);
    const csrf = jar.find((c) => c.startsWith('aisa_csrf='))!.split('=')[1]!;
    await ctx.http().get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
    await ctx.http().post('/api/v1/auth/logout').set('Cookie', jar).set('X-CSRF-Token', csrf).expect(204);
    await ctx.http().get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
  });

  it('recuperación de contraseña: correo, cambio, cierre de sesiones', async () => {
    const { accessToken } = await registerAndLogin(ctx, { companyName: 'Olvido SA', email: 'forgot@test.test' });
    await ctx.http().post('/api/v1/auth/forgot-password').send({ email: 'forgot@test.test' }).expect(202);
    await ctx.http().post('/api/v1/auth/forgot-password').send({ email: 'noexiste@test.test' }).expect(202); // no revela
    const mail = ctx.outbox.filter((m) => m.to === 'forgot@test.test').at(-1)!;
    expect(mail.subject).toMatch(/Restablecer/);
    await ctx.http().post('/api/v1/auth/reset-password').send({ token: tokenFrom(mail.text), password: 'NuevaClave456' }).expect(204);
    await ctx.http().get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
    await ctx.http().post('/api/v1/auth/login').send({ email: 'forgot@test.test', password: 'ClaveSegura123' }).expect(401);
    await ctx.http().post('/api/v1/auth/login').send({ email: 'forgot@test.test', password: 'NuevaClave456' }).expect(200);
  });

  it('rechaza tokens manipulados', async () => {
    const { accessToken } = await registerAndLogin(ctx, { companyName: 'Firma SA', email: 'sig@test.test' });
    const [h, p] = accessToken.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    payload.role = 'PLATFORM_ADMIN';
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.firmafalsa`;
    await ctx.http().get('/api/v1/auth/me').set('Authorization', `Bearer ${forged}`).expect(401);
  });
});
