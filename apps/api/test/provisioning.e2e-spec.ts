import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { setTestEnv, createTestApp, ownerClient, resetDatabase, registerAndLogin, tokenFrom } from './helpers.js';

setTestEnv();
process.env.THROTTLE_DISABLED = 'true';
// Con clave configurada, el asistente solo deja de responder por estar la empresa en preparación
process.env.GEMINI_API_KEY = 'clave-de-prueba-gemini';
const owner = ownerClient();
const DAY = 86_400_000;

describe('Alta de empresas desde la plataforma (asistente de alta)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let root: string;
  let tenantId: string;
  const R = () => ({ Authorization: `Bearer ${root}` });
  const key = randomUUID();
  const body = (over: Record<string, unknown> = {}) => ({
    idempotencyKey: key,
    name: 'Distribuidora Andina', legalName: 'Distribuidora Andina S.A.C.', taxId: '20601234567', country: 'PE', currency: 'PEN', timezone: 'America/Lima',
    address: 'Av. Arequipa 123, Lima', phone: '+51 1 555 0101', contactEmail: 'contacto@andina.test', businessType: 'DISTRIBUTOR',
    brandColor: '#0f766e', customDomain: 'ventas.andina.test', deploymentMode: 'DEDICATED',
    enabledModules: ['conversations', 'ai', 'catalog', 'inventory', 'orders', 'customers'],
    planCode: 'PROFESSIONAL', endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
    admin: { name: 'Marta Andina', email: 'Marta@Andina.test' },
    ...over,
  });

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
    await owner.user.create({ data: { email: 'root@prov.test', name: 'Root', role: 'PLATFORM_ADMIN', emailVerifiedAt: new Date(), passwordHash: await argon2.hash('RootClave123') } });
    root = (await ctx.http().post('/api/v1/auth/login').send({ email: 'root@prov.test', password: 'RootClave123' }).expect(200)).body.accessToken;
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
  });

  it('crea la empresa en preparación con su plan, periodo, módulos y administrador invitado', async () => {
    const r = await ctx.http().post('/api/v1/platform/tenants').set(R()).send(body()).expect(201);
    expect(r.body).toMatchObject({ created: true, invitation: { sent: true }, tenant: { name: 'Distribuidora Andina', status: 'ONBOARDING' } });
    tenantId = r.body.tenant.id;
    const t = await owner.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { subscription: { include: { plan: true } }, users: true, branches: true } });
    expect(t).toMatchObject({ legalName: 'Distribuidora Andina S.A.C.', taxId: '20601234567', customDomain: 'ventas.andina.test', deploymentMode: 'DEDICATED', activatedAt: null });
    expect(t.enabledModules).not.toContain('automations');
    expect(t.subscription).toMatchObject({ status: 'TRIALING', plan: { code: 'PROFESSIONAL' } });
    expect(t.users).toHaveLength(1);
    expect(t.users[0]).toMatchObject({ email: 'marta@andina.test', role: 'TENANT_ADMIN', status: 'INVITED', passwordHash: null });
    expect(t.branches).toHaveLength(1);
    expect(await owner.automation.count({ where: { tenantId } })).toBeGreaterThan(0);
    expect(ctx.outbox.filter((m) => m.to === 'marta@andina.test')).toHaveLength(1);
    expect(await owner.auditLog.count({ where: { tenantId, action: 'platform.tenant_provisioned' } })).toBe(1);
  });

  it('es idempotente: repetir el envío (también en paralelo) devuelve la misma empresa sin duplicar ni reenviar', async () => {
    const again = await Promise.all([1, 2, 3].map(() => ctx.http().post('/api/v1/platform/tenants').set(R()).send(body())));
    for (const r of again) expect(r.status).toBe(200);
    expect(new Set(again.map((r) => r.body.tenant.id))).toEqual(new Set([tenantId]));
    expect(await owner.tenant.count({ where: { name: 'Distribuidora Andina' } })).toBe(1);
    expect(ctx.outbox.filter((m) => m.to === 'marta@andina.test')).toHaveLength(1);

    // Altas nuevas simultáneas con la misma clave: una sola empresa
    const k2 = randomUUID();
    const rs = await Promise.all([1, 2, 3].map((i) => ctx.http().post('/api/v1/platform/tenants').set(R()).send(body({ idempotencyKey: k2, name: `Paralela ${i}`, customDomain: null, admin: { name: 'Paralela', email: 'paralela@andina.test' } }))));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.body.tenant?.id)).size).toBe(1);
    expect(await owner.tenant.count({ where: { provisioningKey: k2 } })).toBe(1);
  });

  it('valida RUC, fechas, correo y dominio; solo la plataforma puede dar de alta', async () => {
    const fresh = (o: Record<string, unknown>) => body({ idempotencyKey: randomUUID(), customDomain: null, admin: { name: 'Otro', email: `otro-${randomUUID()}@andina.test` }, ...o });
    await ctx.http().post('/api/v1/platform/tenants').set(R()).send(fresh({ taxId: '123' })).expect(400);
    await ctx.http().post('/api/v1/platform/tenants').set(R()).send(fresh({ endsAt: new Date(Date.now() - DAY).toISOString() })).expect(400);
    await ctx.http().post('/api/v1/platform/tenants').set(R()).send(fresh({ endsAt: new Date(Date.now() + 400 * DAY).toISOString() })).expect(400);
    await ctx.http().post('/api/v1/platform/tenants').set(R()).send(fresh({ enabledModules: [] })).expect(400);
    await ctx.http().post('/api/v1/platform/tenants').set(R()).send(fresh({ admin: { name: 'Marta', email: 'marta@andina.test' } })).expect(409);
    const d = await ctx.http().post('/api/v1/platform/tenants').set(R()).send(fresh({ customDomain: 'ventas.andina.test' })).expect(400);
    expect(d.body.message).toMatch(/dominio/);
    const other = await registerAndLogin(ctx, { companyName: 'Tienda Curiosa', email: 'admin@curiosa.test' });
    await ctx.http().post('/api/v1/platform/tenants').set({ Authorization: `Bearer ${other.accessToken}` }).send(fresh({})).expect(403);
    // El autorregistro sigue naciendo activo (modo SaaS) y suspenderla y reactivarla la deja activa
    expect(await owner.tenant.findUniqueOrThrow({ where: { id: other.tenantId } })).toMatchObject({ status: 'ACTIVE', activatedAt: expect.any(Date) });
    await ctx.http().patch(`/api/v1/platform/tenants/${other.tenantId}/status`).set(R()).send({ status: 'SUSPENDED' }).expect(200);
    expect((await ctx.http().patch(`/api/v1/platform/tenants/${other.tenantId}/status`).set(R()).send({ status: 'ACTIVE' }).expect(200)).body.status).toBe('ACTIVE');
  });

  it('si el correo falla, la empresa queda creada sin invitación vigente y se puede reenviar', async () => {
    const { MailService } = await import('../src/mail/mail.service.js');
    const spy = vi.spyOn(ctx.app.get(MailService), 'send').mockRejectedValueOnce(new Error('SMTP caído'));
    const r = await ctx.http().post('/api/v1/platform/tenants').set(R()).send(body({ idempotencyKey: randomUUID(), name: 'Sin Correo', customDomain: null, admin: { name: 'Luis', email: 'luis@sincorreo.test' } })).expect(201);
    spy.mockRestore();
    expect(r.body.invitation.sent).toBe(false);
    let ob = await ctx.http().get(`/api/v1/platform/tenants/${r.body.tenant.id}/onboarding`).set(R()).expect(200);
    expect(ob.body.tasks.find((t: { key: string }) => t.key === 'admin_invited').done).toBe(false);
    const re = await ctx.http().post(`/api/v1/platform/tenants/${r.body.tenant.id}/resend-invitation`).set(R()).expect(201);
    expect(re.body).toEqual([{ email: 'luis@sincorreo.test', sent: true }]);
    ob = await ctx.http().get(`/api/v1/platform/tenants/${r.body.tenant.id}/onboarding`).set(R()).expect(200);
    expect(ob.body.tasks.find((t: { key: string }) => t.key === 'admin_invited').done).toBe(true);
  });

  it('no se activa con tareas pendientes; el administrador entra, configura y la plataforma activa', async () => {
    const pending = await ctx.http().post(`/api/v1/platform/tenants/${tenantId}/activate`).set(R()).expect(409);
    expect(pending.body.code).toBe('ONBOARDING_INCOMPLETE');
    expect(pending.body.pending).toEqual(expect.arrayContaining(['El administrador creó su contraseña', 'WhatsApp: credenciales verificadas con Meta']));

    // El administrador acepta la invitación y entra aunque la empresa esté en preparación
    const mail = ctx.outbox.filter((m) => m.to === 'marta@andina.test').at(-1)!;
    await ctx.http().post('/api/v1/auth/accept-invitation').send({ token: tokenFrom(mail.text), password: 'Andina12345' }).expect(204);
    const login = await ctx.http().post('/api/v1/auth/login').send({ email: 'marta@andina.test', password: 'Andina12345' }).expect(200);
    const H = { Authorization: `Bearer ${login.body.accessToken}` };
    const me = await ctx.http().get('/api/v1/auth/me').set(H).expect(200);
    expect(me.body.tenant.status).toBe('ONBOARDING');
    await ctx.http().post('/api/v1/products').set(H).send({ sku: 'AGUA-1', name: 'Agua 1 L', salePrice: 2, initialStock: 10 }).expect(201);
    // La automatización no es un módulo de esta empresa
    expect((await ctx.http().get('/api/v1/automations').set(H)).status).not.toBe(200);

    // Mientras está en preparación el asistente no responde a clientes
    const n = await owner.whatsappNumber.create({ data: { tenantId, provider: 'CLOUD_API', displayPhone: '51900000123', phoneNumberId: '12300', webhookKey: 'wk-prov', status: 'CONNECTED' } });
    const c = await owner.customer.create({ data: { tenantId, phone: '51987000444', source: 'whatsapp' } });
    const conv = await owner.conversation.create({ data: { tenantId, customerId: c.id, whatsappNumberId: n.id, lastMessageAt: new Date() } });
    const msg = await owner.message.create({ data: { tenantId, conversationId: conv.id, direction: 'INBOUND', senderType: 'CUSTOMER', type: 'text', content: 'hola', status: 'received' } });
    const { AssistantService } = await import('../src/ai/assistant.service.js');
    expect(await ctx.app.get(AssistantService).reply(tenantId, conv.id, msg.id)).toEqual({ outcome: 'skipped', reason: 'empresa en preparación' });

    // Credenciales verificadas pero sin webhook: todavía no
    let ob = await ctx.http().get('/api/v1/tenant/onboarding').set(H).expect(200);
    expect(ob.body.canActivate).toBe(false);
    expect(ob.body.tasks.find((t: { key: string }) => t.key === 'whatsapp_webhook').done).toBe(false);
    await owner.whatsappNumber.update({ where: { id: n.id }, data: { lastWebhookAt: new Date() } });
    ob = await ctx.http().get(`/api/v1/platform/tenants/${tenantId}/onboarding`).set(R()).expect(200);
    expect(ob.body.canActivate).toBe(true);
    expect(ob.body.tasks.find((t: { key: string }) => t.key === 'catalog').done).toBe(true);

    const act = await ctx.http().post(`/api/v1/platform/tenants/${tenantId}/activate`).set(R()).expect(201);
    expect(act.body.status).toBe('ACTIVE');
    const t = await owner.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(t.activatedAt).toBeInstanceOf(Date);
    const notes = await ctx.http().get('/api/v1/notifications').set(H).expect(200);
    expect(notes.body.items.map((x: { type: string }) => x.type)).toContain('tenant.activated');
    await ctx.http().post(`/api/v1/platform/tenants/${tenantId}/activate`).set(R()).expect(400);
  });

  it('suspender y reactivar una empresa nunca activada la devuelve a preparación', async () => {
    const r = await ctx.http().post('/api/v1/platform/tenants').set(R()).send(body({ idempotencyKey: randomUUID(), name: 'Pendiente', customDomain: null, admin: { name: 'Ana', email: 'ana@pendiente.test' } })).expect(201);
    await ctx.http().patch(`/api/v1/platform/tenants/${r.body.tenant.id}/status`).set(R()).send({ status: 'SUSPENDED' }).expect(200);
    const back = await ctx.http().patch(`/api/v1/platform/tenants/${r.body.tenant.id}/status`).set(R()).send({ status: 'ACTIVE' }).expect(200);
    expect(back.body.status).toBe('ONBOARDING');
    const m = await ctx.http().get('/api/v1/platform/metrics').set(R()).expect(200);
    expect(m.body.tenants.onboarding).toBeGreaterThanOrEqual(2);
  });
});
