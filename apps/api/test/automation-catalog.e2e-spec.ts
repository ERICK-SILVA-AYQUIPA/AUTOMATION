import argon2 from 'argon2';
import { setTestEnv, createTestApp, ownerClient, resetDatabase, registerAndLogin } from './helpers.js';

setTestEnv();
const owner = ownerClient();

/**
 * Catálogo de automatizaciones (ADR 040): configuración por empresa validada,
 * filtros, plan, versiones, historial con reintento y las dos automatizaciones
 * que ejecuta el backend (estado del pedido al cliente y recordatorio).
 */
describe('Automatizaciones: catálogo, configuración e historial', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerAndLogin>>;
  let b: Awaited<ReturnType<typeof registerAndLogin>>;
  let sellerToken: string;
  let dispatcher: import('../src/automations/automation-dispatcher.js').AutomationDispatcher;
  let variantId: string;
  let conversationId: string;
  let customerId: string;
  const H = () => ({ Authorization: `Bearer ${a.accessToken}` });
  const HB = () => ({ Authorization: `Bearer ${b.accessToken}` });
  const item = (list: { key: string }[], key: string) => list.find((i) => i.key === key) as Record<string, unknown> & { key: string };

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
    const { AutomationDispatcher } = await import('../src/automations/automation-dispatcher.js');
    const { AutomationEvents } = await import('../src/automations/automation-events.service.js');
    const { DatabaseService } = await import('../src/database/database.service.js');
    const { OutboundService } = await import('../src/messaging/outbound.service.js');
    const { ENV } = await import('../src/config/env.js');
    dispatcher = new AutomationDispatcher(ctx.app.get(ENV), ctx.app.get(DatabaseService), ctx.app.get(AutomationEvents), ctx.app.get(OutboundService));

    a = await registerAndLogin(ctx, { companyName: 'Tienda Catálogo', email: 'a@cat-auto.test' });
    b = await registerAndLogin(ctx, { companyName: 'Otra Tienda', email: 'b@cat-auto.test' });
    await owner.user.create({ data: { tenantId: a.tenantId, email: 'v@cat-auto.test', name: 'Vendedor', role: 'SELLER', status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: await argon2.hash('ClaveSegura123') } });
    sellerToken = (await ctx.http().post('/api/v1/auth/login').send({ email: 'v@cat-auto.test', password: 'ClaveSegura123' }).expect(200)).body.accessToken;

    const p = await ctx.http().post('/api/v1/products').set(H()).send({ sku: 'CAT-1', name: 'Café 250 g', salePrice: '20.00' }).expect(201);
    variantId = p.body.variants[0].id;
    await ctx.http().post('/api/v1/inventory/movements').set(H()).send({ variantId, type: 'PURCHASE_IN', quantity: 100, reason: 'Compra' }).expect(201);

    const n = await owner.whatsappNumber.create({ data: { tenantId: a.tenantId, provider: 'CLOUD_API', displayPhone: '51900000088', phoneNumberId: '8800', webhookKey: 'wk-cat-auto', status: 'CONNECTED' } });
    customerId = (await owner.customer.create({ data: { tenantId: a.tenantId, phone: '51911100200', name: 'Lucía' } })).id;
    conversationId = (await owner.conversation.create({ data: { tenantId: a.tenantId, customerId, whatsappNumberId: n.id, lastMessageAt: new Date() } })).id;
    await owner.message.create({ data: { tenantId: a.tenantId, conversationId, direction: 'INBOUND', senderType: 'CUSTOMER', type: 'text', content: 'hola', status: 'received' } });
  });

  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
  });

  it('una empresa nueva nace con el estado inicial del catálogo y en su última versión', async () => {
    const r = await ctx.http().get('/api/v1/automations').set(H()).expect(200);
    expect(r.body.items).toHaveLength(6);
    expect(item(r.body.items, 'NEW_ORDER_NOTIFICATION')).toMatchObject({ enabled: true, executor: 'n8n', version: 2, updateAvailable: false, config: { channels: ['WHATSAPP', 'MANUAL'], minTotal: 0 } });
    expect(item(r.body.items, 'HANDOFF_NOTIFICATION')).toMatchObject({ enabled: false });
    // El plan de prueba no incluye las automatizaciones avanzadas
    expect(item(r.body.items, 'ORDER_STATUS_NOTIFICATION')).toMatchObject({ enabled: false, executor: 'backend', audience: 'cliente', featureAvailable: false });
  });

  it('solo el administrador gestiona automatizaciones', async () => {
    await ctx.http().get('/api/v1/automations').set({ Authorization: `Bearer ${sellerToken}` }).expect(403);
    await ctx.http().patch('/api/v1/automations/NEW_ORDER_NOTIFICATION').set({ Authorization: `Bearer ${sellerToken}` }).send({ enabled: false }).expect(403);
  });

  it('la configuración se valida con el catálogo y filtra qué pedidos generan aviso', async () => {
    const bad = await ctx.http().patch('/api/v1/automations/NEW_ORDER_NOTIFICATION').set(H()).send({ config: { minTotal: -5 } }).expect(409);
    expect(bad.body.code).toBe('INVALID_CONFIG');
    await ctx.http().patch('/api/v1/automations/NEW_ORDER_NOTIFICATION').set(H()).send({ config: { channels: [] } }).expect(409);
    await ctx.http().patch('/api/v1/automations/NEW_ORDER_NOTIFICATION').set(H()).send({ config: { extra: 1 } }).expect(409);

    const ok = await ctx.http().patch('/api/v1/automations/NEW_ORDER_NOTIFICATION').set(H()).send({ config: { minTotal: 50 } }).expect(200);
    expect(ok.body.config).toEqual({ channels: ['WHATSAPP', 'MANUAL'], minTotal: 50 });
    const count = () => owner.automationEvent.count({ where: { tenantId: a.tenantId, key: 'NEW_ORDER_NOTIFICATION' } });
    const before = await count();
    await ctx.http().post('/api/v1/orders').set(H()).send({ customer: { phone: '51911100300' }, items: [{ variantId, quantity: 1 }] }).expect(201); // 20 < 50
    expect(await count()).toBe(before);
    await ctx.http().post('/api/v1/orders').set(H()).send({ customer: { phone: '51911100300' }, items: [{ variantId, quantity: 3 }] }).expect(201); // 60
    expect(await count()).toBe(before + 1);

    await ctx.http().patch('/api/v1/automations/NEW_ORDER_NOTIFICATION').set(H()).send({ config: { channels: ['WHATSAPP'], minTotal: 0 } }).expect(200);
    await ctx.http().post('/api/v1/orders').set(H()).send({ customer: { phone: '51911100300' }, items: [{ variantId, quantity: 3 }] }).expect(201);
    expect(await count()).toBe(before + 1);
    const audit = await owner.auditLog.findFirst({ where: { tenantId: a.tenantId, action: 'automation.updated' }, orderBy: { createdAt: 'desc' } });
    expect(audit?.metadata).toMatchObject({ key: 'NEW_ORDER_NOTIFICATION', config: { channels: ['WHATSAPP'], minTotal: 0 } });
  });

  it('una versión nueva del catálogo no se aplica sola y conserva lo personalizado', async () => {
    await owner.automation.update({ where: { tenantId_key: { tenantId: a.tenantId, key: 'NEW_ORDER_NOTIFICATION' } }, data: { version: 1, config: { channels: ['WHATSAPP'], minTotal: 0, obsoleto: true } } });
    let r = await ctx.http().get('/api/v1/automations').set(H()).expect(200);
    expect(item(r.body.items, 'NEW_ORDER_NOTIFICATION')).toMatchObject({ version: 1, latestVersion: 2, updateAvailable: true, pendingChanges: [{ version: 2 }] });
    const up = await ctx.http().post('/api/v1/automations/NEW_ORDER_NOTIFICATION/upgrade').set(H()).expect(201);
    expect(up.body).toEqual({ key: 'NEW_ORDER_NOTIFICATION', version: 2, upgraded: true });
    const row = await owner.automation.findUniqueOrThrow({ where: { tenantId_key: { tenantId: a.tenantId, key: 'NEW_ORDER_NOTIFICATION' } } });
    expect(row.config).toEqual({ channels: ['WHATSAPP'], minTotal: 0 });
    r = await ctx.http().get('/api/v1/automations').set(H()).expect(200);
    expect(item(r.body.items, 'NEW_ORDER_NOTIFICATION')).toMatchObject({ updateAvailable: false, pendingChanges: [] });
  });

  it('las automatizaciones avanzadas exigen un plan que las incluya', async () => {
    const r = await ctx.http().patch('/api/v1/automations/ORDER_STATUS_NOTIFICATION').set(H()).send({ enabled: true }).expect(403);
    expect(r.body.code).toBe('PLAN_FEATURE');
    // Se pasa la empresa A a un plan con la función (solo en la base de pruebas)
    const ent = await owner.plan.findUniqueOrThrow({ where: { code: 'ENTERPRISE' } });
    await owner.plan.update({ where: { id: ent.id }, data: { limits: { ...(ent.limits as object), features: ['advanced_automations'] } } });
    await owner.subscription.update({ where: { tenantId: a.tenantId }, data: { planId: ent.id } });
    await ctx.http().patch('/api/v1/automations/ORDER_STATUS_NOTIFICATION').set(H()).send({ enabled: true, config: { statuses: ['CONFIRMED'], templates: { CONFIRMED: 'Hola {cliente}, tu pedido #{numero} de {empresa} quedó confirmado ({total}).' } } }).expect(200);
    await ctx.http().patch('/api/v1/automations/PENDING_ORDER_REMINDER').set(H()).send({ enabled: true, config: { hours: 2 } }).expect(200);
    // La otra empresa sigue sin poder
    await ctx.http().patch('/api/v1/automations/ORDER_STATUS_NOTIFICATION').set(HB()).send({ enabled: true }).expect(403);
  });

  it('estado del pedido al cliente: solo pedidos de WhatsApp y con el texto de la empresa', async () => {
    // Pedido del panel: no tiene conversación, no se registra nada
    const manual = await ctx.http().post('/api/v1/orders').set(H()).send({ customer: { phone: '51911100400' }, items: [{ variantId, quantity: 1 }] }).expect(201);
    await ctx.http().patch(`/api/v1/orders/${manual.body.id}/status`).set(H()).send({ status: 'CONFIRMED' }).expect(200);
    expect(await owner.automationEvent.count({ where: { tenantId: a.tenantId, key: 'ORDER_STATUS_NOTIFICATION' } })).toBe(0);

    // Pedido que llegó por WhatsApp (lo crea el asistente con su conversación)
    const { OrdersService } = await import('../src/orders/orders.service.js');
    const orders = ctx.app.get(OrdersService);
    const { order } = await orders.create({ tenantId: a.tenantId, userId: null }, { customerId, items: [{ variantId, quantity: 2 }], channel: 'WHATSAPP', conversationId, confirm: false });
    await ctx.http().patch(`/api/v1/orders/${order.id}/status`).set(H()).send({ status: 'CONFIRMED' }).expect(200);
    const ev = await owner.automationEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, key: 'ORDER_STATUS_NOTIFICATION' } });
    expect(ev.payload).toMatchObject({ orderId: order.id, status: 'CONFIRMED', viaWhatsapp: true });

    await dispatcher.tick();
    expect((await owner.automationEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('SENT');
    const msg = await owner.message.findFirstOrThrow({ where: { conversationId, direction: 'OUTBOUND' } });
    expect(msg.senderType).toBe('SYSTEM');
    expect(msg.content?.replace(/\s/g, ' ')).toBe(`Hola Lucía, tu pedido #${order.number} de Tienda Catálogo quedó confirmado (S/ 40.00).`);
    // Un estado no elegido no avisa
    await ctx.http().patch(`/api/v1/orders/${order.id}/status`).set(H()).send({ status: 'PREPARING' }).expect(200);
    expect(await owner.automationEvent.count({ where: { tenantId: a.tenantId, key: 'ORDER_STATUS_NOTIFICATION' } })).toBe(1);
  });

  it('fuera de la ventana de 24 h de WhatsApp el aviso queda omitido con el motivo, sin reintentos', async () => {
    await owner.message.updateMany({ where: { conversationId, direction: 'INBOUND' }, data: { createdAt: new Date(Date.now() - 25 * 3600 * 1000) } });
    const { OrdersService } = await import('../src/orders/orders.service.js');
    const { order } = await ctx.app.get(OrdersService).create({ tenantId: a.tenantId, userId: null }, { customerId, items: [{ variantId, quantity: 1 }], channel: 'WHATSAPP', conversationId, confirm: false });
    await ctx.http().patch(`/api/v1/orders/${order.id}/status`).set(H()).send({ status: 'CONFIRMED' }).expect(200);
    await dispatcher.tick();
    const ev = await owner.automationEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, key: 'ORDER_STATUS_NOTIFICATION', payload: { path: ['orderId'], equals: order.id } } });
    expect(ev.status).toBe('SKIPPED');
    expect(ev.lastError).toMatch(/24 horas/);
  });

  it('recordatorio de pedidos pendientes: uno por pedido y solo mientras siga pendiente', async () => {
    const o = await ctx.http().post('/api/v1/orders').set(H()).send({ customer: { phone: '51911100500' }, items: [{ variantId, quantity: 1 }], confirm: false }).expect(201);
    await owner.order.update({ where: { id: o.body.id }, data: { createdAt: new Date(Date.now() - 3 * 3600 * 1000) } });
    // Pedido de la otra empresa igual de antiguo: B no tiene la automatización ni el plan
    const pb = await ctx.http().post('/api/v1/products').set(HB()).send({ sku: 'B-1', name: 'Té', salePrice: '5.00' }).expect(201);
    await ctx.http().post('/api/v1/inventory/movements').set(HB()).send({ variantId: pb.body.variants[0].id, type: 'PURCHASE_IN', quantity: 5, reason: 'Compra' }).expect(201);
    const ob = await ctx.http().post('/api/v1/orders').set(HB()).send({ customer: { phone: '51911100600' }, items: [{ variantId: pb.body.variants[0].id, quantity: 1 }], confirm: false }).expect(201);
    await owner.order.update({ where: { id: ob.body.id }, data: { createdAt: new Date(Date.now() - 30 * 3600 * 1000) } });

    expect(await dispatcher.scheduleReminders()).toBe(1);
    expect(await dispatcher.scheduleReminders()).toBe(0);
    expect(await owner.automationEvent.count({ where: { tenantId: b.tenantId, key: 'PENDING_ORDER_REMINDER' } })).toBe(0);
    await dispatcher.tick();
    const n = await owner.notification.findFirstOrThrow({ where: { tenantId: a.tenantId, type: 'order.pending' } });
    expect(n.data).toEqual({ orderId: o.body.id });
    expect(n.body).toMatch(/más de 2 h/);
  });

  it('historial con filtros y reintento manual de un evento fallido u omitido', async () => {
    const skipped = await owner.automationEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, status: 'SKIPPED', key: 'ORDER_STATUS_NOTIFICATION' } });
    const h = await ctx.http().get('/api/v1/automations/events?status=SKIPPED').set(H()).expect(200);
    expect(h.body.items.map((i: { id: string }) => i.id)).toContain(skipped.id);
    expect(h.body.items.every((i: { status: string }) => i.status === 'SKIPPED')).toBe(true);
    expect(h.body.items[0].name).toBeTruthy();

    // La otra empresa no lo ve ni lo puede reintentar
    const hb = await ctx.http().get('/api/v1/automations/events').set(HB()).expect(200);
    expect(hb.body.items.some((i: { id: string }) => i.id === skipped.id)).toBe(false);
    await ctx.http().post(`/api/v1/automations/events/${skipped.id}/retry`).set(HB()).expect(404);

    // El cliente volvió a escribir: el reintento ahora sí se entrega
    await owner.message.create({ data: { tenantId: a.tenantId, conversationId, direction: 'INBOUND', senderType: 'CUSTOMER', type: 'text', content: '¿y mi pedido?', status: 'received' } });
    const r = await ctx.http().post(`/api/v1/automations/events/${skipped.id}/retry`).set(H()).expect(201);
    expect(r.body).toEqual({ id: skipped.id, status: 'PENDING' });
    await ctx.http().post(`/api/v1/automations/events/${skipped.id}/retry`).set(H()).expect(409);
    await dispatcher.tick();
    const after = await owner.automationEvent.findUniqueOrThrow({ where: { id: skipped.id } });
    expect(after).toMatchObject({ status: 'SENT', retriedById: a.userId, attempts: 1 });
    await ctx.http().post(`/api/v1/automations/events/${skipped.id}/retry`).set(H()).expect(409);

    const list = await ctx.http().get('/api/v1/automations').set(H()).expect(200);
    expect(item(list.body.items, 'ORDER_STATUS_NOTIFICATION').stats30d).toMatchObject({ SENT: 2 });
  });

  it('derivación a una persona: con la automatización activa queda registrado el aviso al equipo', async () => {
    await ctx.http().patch('/api/v1/automations/HANDOFF_NOTIFICATION').set(H()).send({ enabled: true }).expect(200);
    const { AssistantService } = await import('../src/ai/assistant.service.js');
    await ctx.app.get(AssistantService).handoff(a.tenantId, conversationId, 'pide hablar con una persona');
    const ev = await owner.automationEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, key: 'HANDOFF_NOTIFICATION' } });
    expect(ev.payload).toMatchObject({ conversationId, customerName: 'Lucía', reason: 'pide hablar con una persona' });
  });

  it('la empresa no puede borrar ni alterar el contenido de su historial', async () => {
    const { roleClient } = await import('./helpers.js');
    const runtime = roleClient('runtime');
    try {
      await expect(runtime.$executeRawUnsafe('DELETE FROM automation_events')).rejects.toThrow(/permission denied/);
      await expect(runtime.$executeRawUnsafe(`UPDATE automation_events SET payload = '{}'`)).rejects.toThrow(/permission denied/);
      await expect(runtime.$executeRawUnsafe('DELETE FROM automations')).rejects.toThrow(/permission denied/);
    } finally {
      await runtime.$disconnect();
    }
  });
});
