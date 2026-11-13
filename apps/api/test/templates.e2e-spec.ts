import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { setTestEnv, createTestApp, ownerClient, resetDatabase, registerAndLogin } from './helpers.js';

setTestEnv();
process.env.THROTTLE_DISABLED = 'true';
const owner = ownerClient();
const DAY = 86_400_000;
/** Fecha local de Lima dentro de `days` días */
const limaDate = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date(Date.now() + days * DAY));
const ALL_DAYS = (open: string, close: string) => Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ open, close }]]));

describe('Plantillas por sector: reglas, precios por volumen, productos sin stock y reservas', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let root: string;
  let shop: Awaited<ReturnType<typeof registerAndLogin>>;
  let resto: Awaited<ReturnType<typeof registerAndLogin>>;
  const R = () => ({ Authorization: `Bearer ${root}` });
  const HS = () => ({ Authorization: `Bearer ${shop.accessToken}` });
  const HR = () => ({ Authorization: `Bearer ${resto.accessToken}` });

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
    await owner.user.create({ data: { email: 'root@tpl.test', name: 'Root', role: 'PLATFORM_ADMIN', emailVerifiedAt: new Date(), passwordHash: await argon2.hash('RootClave123') } });
    root = (await ctx.http().post('/api/v1/auth/login').send({ email: 'root@tpl.test', password: 'RootClave123' }).expect(200)).body.accessToken;
    shop = await registerAndLogin(ctx, { companyName: 'Mayorista Sur', email: 'admin@tpl-shop.test' });
    resto = await registerAndLogin(ctx, { companyName: 'Cevichería Norte', email: 'admin@tpl-resto.test' });
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
  });

  it('el catálogo de plantillas solo lo ve la plataforma', async () => {
    const r = await ctx.http().get('/api/v1/platform/templates').set(R()).expect(200);
    expect(r.body.map((t: { key: string }) => t.key)).toEqual(['RETAIL', 'RESTAURANT', 'DISTRIBUTOR', 'SERVICES']);
    expect(r.body.find((t: { key: string }) => t.key === 'RESTAURANT').modules).toContain('reservations');
    await ctx.http().get('/api/v1/platform/templates').set(HS()).expect(403);
  });

  it('alta con plantilla de restaurante: reglas, automatizaciones, asistente y categorías listas', async () => {
    const r = await ctx.http().post('/api/v1/platform/tenants').set(R()).send({
      idempotencyKey: randomUUID(), name: 'Restaurante Plantilla', country: 'PE', currency: 'PEN', timezone: 'America/Lima', businessType: 'OTHER',
      deploymentMode: 'SAAS', enabledModules: ['conversations', 'ai', 'catalog', 'orders', 'customers', 'reports', 'automations', 'reservations'],
      templateKey: 'RESTAURANT', templateCategories: true,
      planCode: 'BASIC', endsAt: new Date(Date.now() + 30 * DAY).toISOString(), admin: { name: 'Rosa', email: 'rosa@tpl-alta.test' },
    }).expect(201);
    const id = r.body.tenant.id;
    const t = await owner.tenant.findUniqueOrThrow({ where: { id } });
    expect(t).toMatchObject({ templateKey: 'RESTAURANT', templateVersion: 1, businessType: 'RESTAURANT' });
    expect(t.settings).toMatchObject({ catalog: { label: 'Menú', trackStockDefault: false }, reservations: { kind: 'TABLE', capacity: null, hours: null } });
    const autos = await owner.automation.findMany({ where: { tenantId: id }, select: { key: true, isEnabled: true } });
    expect(Object.fromEntries(autos.map((a) => [a.key, a.isEnabled]))).toMatchObject({ RESERVATION_REMINDER: true, LOW_STOCK_ALERT: false, NEW_ORDER_NOTIFICATION: true });
    // Empresa nueva: el asistente queda publicado (no había nada que pisar)
    const ai = await owner.aiSettings.findUniqueOrThrow({ where: { tenantId: id } });
    expect(ai.profile).toMatchObject({ qualifyingQuestions: ['¿Es para delivery, para recoger o para comer en el local?'] });
    expect(ai.draft).toBeNull();
    expect((await owner.category.findMany({ where: { tenantId: id }, orderBy: { name: 'asc' } })).map((c) => c.name)).toEqual(['Bebidas', 'Entradas', 'Platos de fondo', 'Postres']);
    // Capacidad y horario no se inventan: la lista de puesta en marcha lo pide
    const ob = await ctx.http().get(`/api/v1/platform/tenants/${id}/onboarding`).set(R()).expect(200);
    expect(ob.body.tasks.find((x: { key: string }) => x.key === 'reservations')).toMatchObject({ done: false, required: false });
    expect(ob.body.tasks.find((x: { key: string }) => x.key === 'catalog').label).toBe('Menú: al menos uno activo');
  });

  it('vista previa: muestra qué cambia y qué no se puede aplicar; aplicar solo toca lo elegido', async () => {
    const pv = await ctx.http().get(`/api/v1/platform/tenants/${shop.tenantId}/template?key=DISTRIBUTOR`).set(R()).expect(200);
    const fields = pv.body.changes.map((c: { section: string; field: string }) => `${c.section}:${c.field}`);
    expect(fields).toEqual(expect.arrayContaining(['settings:businessType', 'settings:catalog.volumePricing', 'settings:customers.businessFields', 'settings:catalog.label', 'ai:qualifyingQuestions']));
    // El plan de prueba no incluye las automatizaciones avanzadas
    expect(pv.body.blocked).toEqual([expect.objectContaining({ field: 'PENDING_ORDER_REMINDER', note: 'El plan de la empresa no la incluye' })]);
    await ctx.http().get(`/api/v1/platform/tenants/${shop.tenantId}/template?key=OTRO`).set(R()).expect(400);

    const published = (await owner.aiSettings.findUniqueOrThrow({ where: { tenantId: shop.tenantId } })).profile;
    const ap = await ctx.http().post(`/api/v1/platform/tenants/${shop.tenantId}/template`).set(R()).send({ key: 'DISTRIBUTOR', sections: ['settings', 'ai'] }).expect(201);
    expect(ap.body.applied.every((c: { section: string }) => ['settings', 'ai'].includes(c.section))).toBe(true);
    const t = await owner.tenant.findUniqueOrThrow({ where: { id: shop.tenantId } });
    expect(t).toMatchObject({ templateKey: 'DISTRIBUTOR', businessType: 'DISTRIBUTOR', settings: { catalog: { volumePricing: true, label: 'Catálogo mayorista' }, customers: { businessFields: true } } });
    // Los módulos no se tocaron y el asistente va al borrador (lo publicado sigue igual)
    expect(t.enabledModules).not.toContain('reservations');
    const ai = await owner.aiSettings.findUniqueOrThrow({ where: { tenantId: shop.tenantId } });
    expect(ai.profile).toEqual(published);
    expect(ai.draft).toMatchObject({ qualifyingQuestions: ['¿Qué cantidades necesitas aproximadamente?'] });
    expect(await owner.auditLog.count({ where: { tenantId: shop.tenantId, action: 'platform.template_applied' } })).toBe(1);
    await ctx.http().post(`/api/v1/platform/tenants/${shop.tenantId}/template`).set(HS()).send({ key: 'RETAIL', sections: ['settings'] }).expect(403);
  });

  it('la empresa personaliza sus reglas después; lo inválido se rechaza', async () => {
    const bad = await ctx.http().patch('/api/v1/tenant/settings').set(HS()).send({ orders: { minAmount: -1 } }).expect(400);
    expect(bad.body.code ?? bad.body.message).toBeTruthy();
    await ctx.http().patch('/api/v1/tenant/settings').set(HS()).send({ catalog: { inventado: true } }).expect(400);
    const r = await ctx.http().patch('/api/v1/tenant/settings').set(HS()).send({ orders: { minAmount: 50 } }).expect(200);
    expect(r.body.settings).toMatchObject({ orders: { minAmount: 50 }, catalog: { volumePricing: true } });
    const g = await ctx.http().get('/api/v1/tenant/settings').set(HS()).expect(200);
    expect(g.body.template).toMatchObject({ key: 'DISTRIBUTOR', name: 'Distribuidora', version: 1, latestVersion: 1 });
    const me = await ctx.http().get('/api/v1/auth/me').set(HS()).expect(200);
    expect(me.body.tenant.settings.catalog.label).toBe('Catálogo mayorista');
  });

  it('precios por volumen y pedido mínimo: el backend calcula el precio según la cantidad', async () => {
    await ctx.http().post('/api/v1/products').set(HS()).send({ sku: 'ARZ-1', name: 'Arroz saco', salePrice: '5.00', priceTiers: [{ minQty: 10, unitPrice: '5.50' }] }).expect(400);
    await ctx.http().post('/api/v1/products').set(HS()).send({ sku: 'ARZ-1', name: 'Arroz saco', salePrice: '5.00', priceTiers: [{ minQty: 50, unitPrice: '4.00' }, { minQty: 10, unitPrice: '4.50' }] }).expect(400);
    const p = await ctx.http().post('/api/v1/products').set(HS()).send({ sku: 'ARZ-1', name: 'Arroz saco', salePrice: '5.00', initialStock: 500, priceTiers: [{ minQty: 10, unitPrice: '4.50' }, { minQty: 50, unitPrice: '4.00' }] }).expect(201);
    expect(p.body.trackStock).toBe(true);
    const variantId = p.body.variants[0].id;
    const order = (q: number) => ctx.http().post('/api/v1/orders').set(HS()).send({ customer: { phone: '51911222333' }, items: [{ variantId, quantity: q }], confirm: false });
    const small = await order(5);
    expect(small.status).toBe(409);
    expect(small.body.code).toBe('ORDER_MINIMUM');
    const mid = await order(12);
    expect(mid.status).toBe(201);
    expect(mid.body.items[0].unitPrice).toBe('4.5');
    expect(mid.body.total).toBe('54');
    const big = await order(60);
    expect(big.body.items[0].unitPrice).toBe('4');
    // Sin la regla de la empresa, se cobra el precio normal
    await ctx.http().patch('/api/v1/tenant/settings').set(HS()).send({ catalog: { volumePricing: false }, orders: { minAmount: null } }).expect(200);
    expect((await order(12)).body.items[0].unitPrice).toBe('5');
    await ctx.http().patch('/api/v1/tenant/settings').set(HS()).send({ catalog: { volumePricing: true } }).expect(200);
  });

  it('cliente comercial con razón social e historial de compras', async () => {
    await ctx.http().post('/api/v1/customers').set(HS()).send({ phone: '51911222444', customerType: 'BUSINESS' }).expect(400);
    const c = await ctx.http().post('/api/v1/customers').set(HS()).send({ phone: '51911222444', customerType: 'BUSINESS', businessName: 'Bodega El Sol S.A.C.', documentId: '20123456789' }).expect(201);
    const list = await ctx.http().get('/api/v1/customers?q=El Sol&type=BUSINESS').set(HS()).expect(200);
    expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([c.body.id]);
    const variant = await owner.productVariant.findFirstOrThrow({ where: { tenantId: shop.tenantId, sku: 'ARZ-1' } });
    await ctx.http().post('/api/v1/orders').set(HS()).send({ customerId: c.body.id, items: [{ variantId: variant.id, quantity: 20 }] }).expect(201);
    const d = await ctx.http().get(`/api/v1/customers/${c.body.id}`).set(HS()).expect(200);
    expect(d.body.topProducts).toEqual([{ name: 'Arroz saco', quantity: 20, total: '90' }]);
    expect(d.body.stats).toMatchObject({ orders: 1, totalSpent: '90' });
  });

  describe('restaurante: menú sin stock y reservas', () => {
    let dishVariant: string;

    beforeAll(async () => {
      await ctx.http().post(`/api/v1/platform/tenants/${resto.tenantId}/template`).set(R()).send({ key: 'RESTAURANT', sections: ['modules', 'settings', 'automations', 'categories'] }).expect(201);
    });

    it('los platos no llevan stock: se venden sin inventario y no admiten movimientos', async () => {
      await ctx.http().post('/api/v1/products').set(HR()).send({ sku: 'CEV-1', name: 'Ceviche clásico', salePrice: '35.00', initialStock: 10 }).expect(400);
      const p = await ctx.http().post('/api/v1/products').set(HR()).send({ sku: 'CEV-1', name: 'Ceviche clásico', salePrice: '35.00', minStock: 5 }).expect(201);
      expect(p.body).toMatchObject({ trackStock: false, minStock: 0 });
      dishVariant = p.body.variants[0].id;
      const o = await ctx.http().post('/api/v1/orders').set(HR()).send({ customer: { phone: '51922333444' }, items: [{ variantId: dishVariant, quantity: 3 }] }).expect(201);
      expect(o.body.status).toBe('CONFIRMED');
      expect(await owner.inventoryMovement.count({ where: { tenantId: resto.tenantId } })).toBe(0);
      await ctx.http().patch(`/api/v1/orders/${o.body.id}/status`).set(HR()).send({ status: 'CANCELLED' }).expect(200);
      expect(await owner.inventoryMovement.count({ where: { tenantId: resto.tenantId } })).toBe(0);
      // El panel filtra los servicios/platos (sin stock) para reservar citas
      const onlyDishes = await ctx.http().get('/api/v1/products?trackStock=false').set(HR()).expect(200);
      expect(onlyDishes.body.items.map((x: { sku: string }) => x.sku)).toEqual(['CEV-1']);
      expect((await ctx.http().get('/api/v1/products?trackStock=true').set(HR()).expect(200)).body.total).toBe(0);
    });

    it('sin horario ni capacidad no se aceptan reservas', async () => {
      const a = await ctx.http().get(`/api/v1/reservations/availability?date=${limaDate(1)}&partySize=2`).set(HR()).expect(200);
      expect(a.body).toMatchObject({ slots: [], reason: 'La empresa aún no configuró el horario de reservas' });
      const r = await ctx.http().post('/api/v1/reservations').set(HR()).send({ customer: { phone: '51922333555' }, date: limaDate(1), time: '20:00', partySize: 2 }).expect(409);
      expect(r.body.code).toBe('RESERVATIONS_NOT_CONFIGURED');
      // Otra empresa sin el módulo
      expect((await ctx.http().get('/api/v1/reservations').set(HS()).expect(403)).body.code).toBe('MODULE_DISABLED');
    });

    it('horarios libres y cupo: nunca se pasa de la capacidad, ni con reservas simultáneas', async () => {
      await ctx.http().patch('/api/v1/tenant/settings').set(HR()).send({ reservations: { hours: ALL_DAYS('12:00', '22:00'), capacity: 10 } }).expect(200);
      const day = limaDate(2);
      const a = await ctx.http().get(`/api/v1/reservations/availability?date=${day}&partySize=2`).set(HR()).expect(200);
      // Reservas de 90 min cada 30 min: la última empieza 20:30
      expect(a.body.slots.map((s: { time: string }) => s.time)).toEqual(['12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30']);

      const r1 = await ctx.http().post('/api/v1/reservations').set(HR()).send({ customer: { phone: '51922333555', name: 'Luis' }, date: day, time: '20:00', partySize: 4 }).expect(201);
      expect(r1.body).toMatchObject({ status: 'CONFIRMED', partySize: 4, channel: 'MANUAL', number: 1 });
      await ctx.http().post('/api/v1/reservations').set(HR()).send({ customer: { phone: '51922333556' }, date: day, time: '20:30', partySize: 6 }).expect(201);
      const full = await ctx.http().post('/api/v1/reservations').set(HR()).send({ customer: { phone: '51922333557' }, date: day, time: '20:00', partySize: 1 }).expect(409);
      expect(full.body.code).toBe('SLOT_FULL');
      const after = await ctx.http().get(`/api/v1/reservations/availability?date=${day}&partySize=1`).set(HR()).expect(200);
      expect(after.body.slots.map((s: { time: string }) => s.time)).not.toContain('20:00');
      expect(after.body.slots.find((s: { time: string }) => s.time === '18:30')).toMatchObject({ remaining: 10 }); // termina 20:00, justo cuando empieza la otra
      expect(after.body.slots.find((s: { time: string }) => s.time === '19:00')).toMatchObject({ remaining: 6 });

      const out = await ctx.http().post('/api/v1/reservations').set(HR()).send({ customer: { phone: '51922333557' }, date: day, time: '21:00', partySize: 2 }).expect(409);
      expect(out.body.code).toBe('OUTSIDE_HOURS');
      await ctx.http().post('/api/v1/reservations').set(HR()).send({ customer: { phone: '51922333557' }, date: day, time: '13:00', partySize: 30 }).expect(409);

      // Cinco reservas de 3 personas a la vez para un cupo de 10: entran exactamente 3
      const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => ctx.http().post('/api/v1/reservations').set(HR()).send({ customer: { phone: `5192233360${i}` }, date: day, time: '13:00', partySize: 3 })));
      expect(rs.filter((x) => x.status === 201)).toHaveLength(3);
      expect(rs.filter((x) => x.status === 409 && x.body.code === 'SLOT_FULL')).toHaveLength(2);

      const list = await ctx.http().get(`/api/v1/reservations?date=${day}`).set(HR()).expect(200);
      expect(list.body.total).toBe(5);
      expect((await ctx.http().get(`/api/v1/reservations?date=${day}`).set(HS()).expect(403)).body.code).toBe('MODULE_DISABLED');
    });

    it('estados de la reserva y aislamiento entre empresas', async () => {
      const r = await owner.reservation.findFirstOrThrow({ where: { tenantId: resto.tenantId, number: 1 } });
      await ctx.http().patch(`/api/v1/reservations/${r.id}/status`).set(HR()).send({ status: 'COMPLETED' }).expect(200);
      const bad = await ctx.http().patch(`/api/v1/reservations/${r.id}/status`).set(HR()).send({ status: 'CANCELLED' }).expect(409);
      expect(bad.body.code).toBe('INVALID_TRANSITION');
      // Otra empresa con el módulo encendido tampoco la ve
      await owner.tenant.update({ where: { id: shop.tenantId }, data: { enabledModules: { push: 'reservations' } } });
      await ctx.http().patch(`/api/v1/reservations/${r.id}/status`).set(HS()).send({ status: 'CANCELLED' }).expect(404);
      expect((await ctx.http().get('/api/v1/reservations').set(HS()).expect(200)).body.total).toBe(0);
      const del = await ctx.app.get((await import('../src/database/database.service.js')).DatabaseService).tenant(resto.tenantId, (tx) => tx.$executeRaw`DELETE FROM reservations`).catch((e: Error) => e.message);
      expect(String(del)).toMatch(/permission denied/);
    });

    it('el asistente consulta horarios y reserva desde WhatsApp: queda pendiente, avisa al equipo y no se duplica', async () => {
      const { runTool } = await import('../src/ai/ai-tools.js');
      const { DatabaseService } = await import('../src/database/database.service.js');
      const { OrdersService } = await import('../src/orders/orders.service.js');
      const { ReservationsService } = await import('../src/reservations/reservations.service.js');
      const db = ctx.app.get(DatabaseService);
      const n = await owner.whatsappNumber.create({ data: { tenantId: resto.tenantId, provider: 'CLOUD_API', displayPhone: '51900000077', phoneNumberId: '7700', webhookKey: 'wk-tpl-resto', status: 'CONNECTED' } });
      const customer = await owner.customer.create({ data: { tenantId: resto.tenantId, phone: '51987000777', waProfileName: 'Ana', source: 'whatsapp' } });
      const conv = await owner.conversation.create({ data: { tenantId: resto.tenantId, customerId: customer.id, whatsappNumberId: n.id, lastMessageAt: new Date() } });
      const msg = await owner.message.create({ data: { tenantId: resto.tenantId, conversationId: conv.id, direction: 'INBOUND', senderType: 'CUSTOMER', type: 'text', content: 'mesa para 2 mañana', status: 'received' } });
      const tc = {
        tenantId: resto.tenantId, currency: 'PEN', customerId: customer.id, conversationId: conv.id, triggerMessageId: msg.id,
        db: <T>(fn: (tx: import('../src/database/database.service.js').Tx) => Promise<T>) => db.tenant(resto.tenantId, fn),
        orders: ctx.app.get(OrdersService), reservations: ctx.app.get(ReservationsService),
        features: { orders: true, reservations: true, volumePricing: false, reservationKind: 'TABLE' as const, timezone: 'America/Lima' },
        requestHandoff: () => undefined,
      };
      const day = limaDate(3);
      const av = (await runTool(tc, 'consultar_disponibilidad', { fecha: day, personas: 2 })) as { horarios_libres: string[] };
      expect(av.horarios_libres).toContain('19:00');
      const r1 = (await runTool(tc, 'crear_reserva', { fecha: day, hora: '19:00', personas: 2 })) as Record<string, unknown>;
      expect(r1).toMatchObject({ estado: 'PENDING', hora: '19:00', nuevo: true });
      const r2 = (await runTool(tc, 'crear_reserva', { fecha: day, hora: '19:00', personas: 2 })) as Record<string, unknown>;
      expect(r2).toMatchObject({ numero: r1.numero, nuevo: false });
      expect(await owner.reservation.count({ where: { tenantId: resto.tenantId, conversationId: conv.id } })).toBe(1);
      expect(await owner.notification.count({ where: { tenantId: resto.tenantId, type: 'reservation.created' } })).toBe(1);
      // Fuera de horario: el asistente recibe el motivo para ofrecer otro horario
      const off = (await runTool(tc, 'crear_reserva', { fecha: day, hora: '23:30', personas: 2 })) as { error: string };
      expect(off.error).toMatch(/fuera del horario/);
      const mine = (await runTool(tc, 'ver_reservas_del_cliente', {})) as { reservas: { fecha: string; hora: string }[] };
      expect(mine.reservas).toEqual([expect.objectContaining({ fecha: day, hora: '19:00', personas: 2 })]);
      // Platos: disponibles sin stock
      const search = (await runTool(tc, 'buscar_productos', { consulta: 'ceviche' })) as { resultados: { sin_control_de_stock?: boolean; variantes: { disponible: boolean; unidades_disponibles?: number }[] }[] };
      expect(search.resultados[0]).toMatchObject({ sin_control_de_stock: true, variantes: [{ disponible: true }] });
      expect(search.resultados[0]!.variantes[0]!.unidades_disponibles).toBeUndefined();
    });

    it('recordatorio por WhatsApp antes de una reserva confirmada (una sola vez)', async () => {
      const { AutomationDispatcher } = await import('../src/automations/automation-dispatcher.js');
      const { ENV } = await import('../src/config/env.js');
      const { DatabaseService } = await import('../src/database/database.service.js');
      const { AutomationEvents } = await import('../src/automations/automation-events.service.js');
      const { OutboundService } = await import('../src/messaging/outbound.service.js');
      const dispatcher = new AutomationDispatcher(ctx.app.get(ENV), ctx.app.get(DatabaseService), ctx.app.get(AutomationEvents), ctx.app.get(OutboundService));
      const conv = await owner.conversation.findFirstOrThrow({ where: { tenantId: resto.tenantId } });
      const branch = await owner.branch.findFirstOrThrow({ where: { tenantId: resto.tenantId } });
      // Reserva hecha ayer para dentro de 2 horas
      const res = await owner.reservation.create({
        data: { tenantId: resto.tenantId, number: 99, customerId: conv.customerId, branchId: branch.id, conversationId: conv.id, startsAt: new Date(Date.now() + 2 * 3600_000), endsAt: new Date(Date.now() + 3.5 * 3600_000), partySize: 2, status: 'CONFIRMED', channel: 'WHATSAPP', createdAt: new Date(Date.now() - DAY) },
      });
      expect(await dispatcher.scheduleReservationReminders()).toBe(1);
      expect(await dispatcher.scheduleReservationReminders()).toBe(0);
      await dispatcher.tick();
      const ev = await owner.automationEvent.findFirstOrThrow({ where: { tenantId: resto.tenantId, key: 'RESERVATION_REMINDER' } });
      expect(ev).toMatchObject({ status: 'SENT', payload: expect.objectContaining({ reservationId: res.id }) });
      const out = await owner.message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'OUTBOUND' } });
      expect(out.senderType).toBe('SYSTEM');
      expect(out.content).toMatch(new RegExp(`^Hola Ana, te recordamos tu reserva #99 en Cevichería Norte hoy \\d{2}/\\d{2}/\\d{4} a las \\d{2}:\\d{2}\\.`));
    });
  });
});
