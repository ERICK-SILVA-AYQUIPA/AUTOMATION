import argon2 from 'argon2';
import { setTestEnv, createTestApp, ownerClient, resetDatabase, registerAndLogin, roleClient } from './helpers.js';

setTestEnv();
process.env.THROTTLE_DISABLED = 'true';
const owner = ownerClient();

describe('Núcleo multiempresa: avisos, bandeja, módulos, perfil y panel general', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerAndLogin>>;
  let b: Awaited<ReturnType<typeof registerAndLogin>>;
  let root: string;
  let conversationId: string;
  const HA = () => ({ Authorization: `Bearer ${a.accessToken}` });
  const HB = () => ({ Authorization: `Bearer ${b.accessToken}` });
  const R = () => ({ Authorization: `Bearer ${root}` });

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
    a = await registerAndLogin(ctx, { companyName: 'Empresa Núcleo A', email: 'admin@core-a.test' });
    b = await registerAndLogin(ctx, { companyName: 'Empresa Núcleo B', email: 'admin@core-b.test' });
    await owner.user.create({ data: { email: 'root@core.test', name: 'Root', role: 'PLATFORM_ADMIN', emailVerifiedAt: new Date(), passwordHash: await argon2.hash('RootClave123') } });
    root = (await ctx.http().post('/api/v1/auth/login').send({ email: 'root@core.test', password: 'RootClave123' }).expect(200)).body.accessToken;
    const n = await owner.whatsappNumber.create({ data: { tenantId: a.tenantId, provider: 'CLOUD_API', displayPhone: '51900000077', phoneNumberId: '7700', webhookKey: 'wk-core-a', status: 'CONNECTED' } });
    const c = await owner.customer.create({ data: { tenantId: a.tenantId, phone: '51987000333', source: 'whatsapp' } });
    conversationId = (await owner.conversation.create({ data: { tenantId: a.tenantId, customerId: c.id, whatsappNumberId: n.id, lastMessageAt: new Date() } })).id;
    await owner.message.create({ data: { tenantId: a.tenantId, conversationId, direction: 'INBOUND', senderType: 'CUSTOMER', type: 'text', content: 'hola', status: 'received' } });
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
  });

  it('avisos: la empresa ve los suyos (no los de otra), los marca leídos y cuenta los pendientes', async () => {
    await owner.notification.createMany({ data: [
      { tenantId: a.tenantId, type: 'handoff', title: 'Carla necesita atención', body: 'x', data: { conversationId } },
      { tenantId: a.tenantId, type: 'stock', title: 'Stock bajo', body: 'y' },
      { tenantId: b.tenantId, type: 'handoff', title: 'De otra empresa', body: 'z' },
    ] });
    const list = await ctx.http().get('/api/v1/notifications').set(HA()).expect(200);
    expect(list.body.unread).toBe(2);
    expect(list.body.items.map((n: { title: string }) => n.title)).not.toContain('De otra empresa');
    const other = await owner.notification.findFirstOrThrow({ where: { tenantId: b.tenantId } });
    await ctx.http().post(`/api/v1/notifications/${other.id}/read`).set(HA()).expect(404);
    await ctx.http().post(`/api/v1/notifications/${list.body.items[0].id}/read`).set(HA()).expect(204);
    expect((await ctx.http().get('/api/v1/notifications?unread=true').set(HA()).expect(200)).body.unread).toBe(1);
    await ctx.http().post('/api/v1/notifications/read-all').set(HA()).expect(204);
    expect((await ctx.http().get('/api/v1/notifications').set(HA()).expect(200)).body.unread).toBe(0);
    expect((await owner.notification.findUniqueOrThrow({ where: { id: other.id } })).readAt).toBeNull();
  });

  it('responder desde el panel pausa la IA y asigna la conversación; se puede reactivar y cerrar', async () => {
    await ctx.http().post(`/api/v1/conversations/${conversationId}/messages`).set(HA()).send({ text: 'Hola, te atiendo yo', idempotencyKey: 'core-test-0001' }).expect(201);
    let c = await owner.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(c).toMatchObject({ botStatus: 'PAUSED', handoffReason: 'agent_reply', assignedUserId: a.userId });

    const r = await ctx.http().patch(`/api/v1/conversations/${conversationId}`).set(HA()).send({ botStatus: 'ACTIVE' }).expect(200);
    expect(r.body).toMatchObject({ botStatus: 'ACTIVE', handoffReason: null });
    await ctx.http().patch(`/api/v1/conversations/${conversationId}`).set(HA()).send({ botStatus: 'PAUSED' }).expect(200);
    await ctx.http().patch(`/api/v1/conversations/${conversationId}`).set(HA()).send({ status: 'RESOLVED' }).expect(200);
    c = await owner.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(c).toMatchObject({ status: 'RESOLVED', botStatus: 'ACTIVE' });
    await ctx.http().patch(`/api/v1/conversations/${conversationId}`).set(HA()).send({ status: 'OPEN' }).expect(200);
    expect(await owner.auditLog.count({ where: { tenantId: a.tenantId, action: 'conversation.updated' } })).toBe(4);
  });

  it('etiquetas, filtros, notas internas y asignación (solo a usuarios activos de la misma empresa)', async () => {
    await ctx.http().patch(`/api/v1/conversations/${conversationId}`).set(HA()).send({ tags: ['Mayorista', 'urgente', 'mayorista'] }).expect(200);
    expect((await owner.conversation.findUniqueOrThrow({ where: { id: conversationId } })).tags).toEqual(['mayorista', 'urgente']);
    expect((await ctx.http().get('/api/v1/conversations?tag=urgente').set(HA()).expect(200)).body.total).toBe(1);
    expect((await ctx.http().get('/api/v1/conversations?tag=otra').set(HA()).expect(200)).body.total).toBe(0);

    await ctx.http().post(`/api/v1/conversations/${conversationId}/notes`).set(HA()).send({ body: 'Cliente frecuente, ofrecer delivery' }).expect(201);
    const detail = await ctx.http().get(`/api/v1/conversations/${conversationId}`).set(HA()).expect(200);
    expect(detail.body.notes).toHaveLength(1);
    // El nombre del autor llega en "people" para que un agente sin users:read lo vea
    expect(detail.body.people[detail.body.notes[0].authorId]).toEqual(expect.any(String));
    expect(detail.body.messages.map((m: { content: string }) => m.content)).not.toContain('Cliente frecuente, ofrecer delivery');

    // Otra empresa no puede ver, anotar ni asignar
    await ctx.http().get(`/api/v1/conversations/${conversationId}`).set(HB()).expect(404);
    await ctx.http().post(`/api/v1/conversations/${conversationId}/notes`).set(HB()).send({ body: 'intrusa' }).expect(404);
    await ctx.http().patch(`/api/v1/conversations/${conversationId}`).set(HB()).send({ status: 'RESOLVED' }).expect(404);
    await ctx.http().patch(`/api/v1/conversations/${conversationId}`).set(HA()).send({ assignedUserId: b.userId }).expect(400);
    expect((await ctx.http().get('/api/v1/conversations?view=mine').set(HA()).expect(200)).body.total).toBe(1);

    // RLS: las notas no se pueden editar ni borrar con el rol de ejecución
    const runtime = roleClient('runtime');
    try {
      const del = runtime.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${a.tenantId}, true)`;
        return tx.conversationNote.deleteMany({});
      });
      await expect(del).rejects.toThrow(/permission denied/i);
    } finally {
      await runtime.$disconnect();
    }
  });

  it('módulos: un módulo apagado por la plataforma responde 403 MODULE_DISABLED', async () => {
    await ctx.http().get('/api/v1/orders').set(HB()).expect(200);
    await ctx.http().patch(`/api/v1/platform/tenants/${b.tenantId}`).set(R()).send({ enabledModules: ['conversations', 'catalog', 'customers'] }).expect(200);
    const r = await ctx.http().get('/api/v1/orders').set(HB()).expect(403);
    expect(r.body.code).toBe('MODULE_DISABLED');
    // La web filtra el menú con estos módulos
    expect((await ctx.http().get('/api/v1/auth/me').set(HB()).expect(200)).body.tenant.enabledModules).toEqual(['conversations', 'catalog', 'customers']);
    await ctx.http().get('/api/v1/ai/settings').set(HB()).expect(403);
    await ctx.http().get('/api/v1/products').set(HB()).expect(200);
    await ctx.http().patch(`/api/v1/platform/tenants/${b.tenantId}`).set(R()).send({ enabledModules: ['bitcoin'] }).expect(400);
  });

  it('perfil de empresa: la empresa edita sus datos y RUC válido, pero no su dominio ni sus módulos', async () => {
    const r = await ctx.http().patch('/api/v1/tenant').set(HA())
      .send({ legalName: 'Inversiones Núcleo S.A.C.', taxId: '20123456789', country: 'PE', businessType: 'RESTAURANT', brandColor: '#4f46e5', customDomain: 'robado.com', enabledModules: ['orders'] }).expect(200);
    expect(r.body).toMatchObject({ legalName: 'Inversiones Núcleo S.A.C.', taxId: '20123456789', businessType: 'RESTAURANT', brandColor: '#4f46e5', customDomain: null });
    expect(r.body.enabledModules).toContain('ai');
    await ctx.http().patch('/api/v1/tenant').set(HA()).send({ country: 'PE', taxId: '123' }).expect(400);
    await ctx.http().patch('/api/v1/tenant').set(HA()).send({ brandColor: 'red' }).expect(400);
    await ctx.http().patch('/api/v1/tenant').set(HA()).send({ logoUrl: 'http://inseguro.test/logo.png' }).expect(400);

    // RLS + privilegios: el rol de ejecución no puede cambiar el dominio ni con SQL directo
    const runtime = roleClient('runtime');
    try {
      const upd = runtime.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${a.tenantId}, true)`;
        return tx.tenant.update({ where: { id: a.tenantId }, data: { customDomain: 'x.com' } });
      });
      await expect(upd).rejects.toThrow(/permission denied/i);
    } finally {
      await runtime.$disconnect();
    }
  });

  it('panel general: dominio único, planes editables en soles y métricas con el estado real', async () => {
    await ctx.http().patch(`/api/v1/platform/tenants/${a.tenantId}`).set(R()).send({ customDomain: 'ventas.empresa-a.pe', deploymentMode: 'DEDICATED' }).expect(200);
    await ctx.http().patch(`/api/v1/platform/tenants/${b.tenantId}`).set(R()).send({ customDomain: 'VENTAS.empresa-a.pe' }).expect(400);
    await ctx.http().patch(`/api/v1/platform/tenants/${b.tenantId}`).set(HA()).send({ customDomain: 'x.pe' }).expect(403);

    const plan = await ctx.http().patch('/api/v1/platform/plans/BASIC').set(R()).send({ priceMonthly: 59.9, currency: 'PEN' }).expect(200);
    expect(plan.body).toMatchObject({ currency: 'PEN', priceMonthly: '59.9' });
    await ctx.http().patch('/api/v1/platform/plans/BASIC').set(R()).send({ limits: { maxUsers: 0 } }).expect(400);
    await ctx.http().patch('/api/v1/platform/plans/BASIC').set(HA()).send({ priceMonthly: 1 }).expect(403);
    expect(await owner.auditLog.count({ where: { action: 'platform.plan_updated' } })).toBe(1);

    // B vencida: su estado guardado sigue siendo TRIALING, pero cuenta como vencida
    const past = new Date(Date.now() - 1000);
    await owner.subscription.update({ where: { tenantId: b.tenantId }, data: { trialEndsAt: past, currentPeriodEnd: past } });
    await ctx.http().post(`/api/v1/platform/tenants/${a.tenantId}/payments`).set(R()).send({ planCode: 'BASIC', months: 1, amount: 59.9, method: 'YAPE' }).expect(201);
    const m = await ctx.http().get('/api/v1/platform/metrics').set(R()).expect(200);
    expect(m.body.subscriptions).toMatchObject({ ACTIVE: 1, EXPIRED: 1, TRIAL: 0 });
    expect(m.body.pendingRenewals).toBe(1);
    expect(m.body.revenue.thisMonth).toEqual([{ currency: 'PEN', amount: '59.90', payments: 1 }]);
    expect(m.body.last30Days.messages).toBeGreaterThanOrEqual(2);

    const d = await ctx.http().get(`/api/v1/platform/tenants/${a.tenantId}`).set(R()).expect(200);
    expect(d.body).toMatchObject({ customDomain: 'ventas.empresa-a.pe', deploymentMode: 'DEDICATED', subscription: { access: { state: 'ACTIVE' } } });
    expect(d.body.whatsappNumbers).toHaveLength(1);
    expect(d.body.users[0].email).toBe('admin@core-a.test');
  });
});
