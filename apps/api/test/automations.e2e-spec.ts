import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTestEnv, createTestApp, ownerClient, resetDatabase, registerAndLogin } from './helpers.js';

setTestEnv();
const owner = ownerClient();

/**
 * Puente hacia n8n (FASE 4, flujos 3, 4 y 7). n8n se sustituye por un servidor
 * HTTP local que registra lo que recibe; la prueba con el n8n real del
 * docker-compose está en services/n8n/README.md (prueba manual verificada).
 */
describe('Automatizaciones: bandeja de salida hacia n8n y API interna', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let fake: Server;
  const received: { path: string; token?: string; body: Record<string, unknown> }[] = [];
  let respondStatus = 200;
  let a: Awaited<ReturnType<typeof registerAndLogin>>;
  let b: Awaited<ReturnType<typeof registerAndLogin>>;
  const H = () => ({ Authorization: `Bearer ${a.accessToken}` });
  let dispatcher: import('../src/automations/automation-dispatcher.js').AutomationDispatcher;
  let token: string;
  let variantId: string;

  const readBody = (req: IncomingMessage) => new Promise<string>((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });

  beforeAll(async () => {
    fake = createServer(async (req, res) => {
      const body = await readBody(req);
      received.push({ path: req.url!, token: req.headers['x-internal-token'] as string | undefined, body: JSON.parse(body) });
      res.statusCode = respondStatus;
      res.end('{}');
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    process.env.N8N_WEBHOOK_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/webhook`;
    token = process.env.N8N_INTERNAL_TOKEN ?? '';
    expect(token.length).toBeGreaterThanOrEqual(32);

    await resetDatabase(owner);
    ctx = await createTestApp();
    const { AutomationDispatcher } = await import('../src/automations/automation-dispatcher.js');
    const { AutomationEvents } = await import('../src/automations/automation-events.service.js');
    const { DatabaseService } = await import('../src/database/database.service.js');
    const { ENV } = await import('../src/config/env.js');
    const { OutboundService } = await import('../src/messaging/outbound.service.js');
    // El despachador vive en el worker; aquí se instancia sin temporizador y se llama a tick()
    dispatcher = new AutomationDispatcher(ctx.app.get(ENV), ctx.app.get(DatabaseService), ctx.app.get(AutomationEvents), ctx.app.get(OutboundService));

    a = await registerAndLogin(ctx, { companyName: 'Bodega A', email: 'a@auto.test' });
    b = await registerAndLogin(ctx, { companyName: 'Bodega B', email: 'b@auto.test' });
    const p = await ctx.http().post('/api/v1/products').set(H()).send({ sku: 'GAS-500', name: 'Gaseosa 500 ml', salePrice: '3.50', minStock: 5 }).expect(201);
    variantId = p.body.variants[0].id;
    await ctx.http().post('/api/v1/inventory/movements').set(H()).send({ variantId, type: 'PURCHASE_IN', quantity: 8, reason: 'Compra' }).expect(201);
  });

  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
    fake.close();
  });

  it('flujo 4: cruzar el stock mínimo registra un evento (una sola vez) y se entrega a n8n con el token', async () => {
    await ctx.http().post('/api/v1/inventory/movements').set(H()).send({ variantId, type: 'ADJUSTMENT', quantity: -4, reason: 'Merma' }).expect(201);
    // Seguir por debajo del mínimo no repite la alerta
    await ctx.http().post('/api/v1/inventory/movements').set(H()).send({ variantId, type: 'ADJUSTMENT', quantity: -1, reason: 'Merma' }).expect(201);
    const evs = await owner.automationEvent.findMany({ where: { tenantId: a.tenantId, key: 'LOW_STOCK_ALERT' } });
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toMatchObject({ productName: 'Gaseosa 500 ml', sku: 'GAS-500', stock: 4, minStock: 5 });

    expect(await dispatcher.tick()).toBe(1);
    const got = received.find((r) => r.body.eventId === evs[0]!.id)!;
    expect(got.path).toBe('/webhook/aisa-stock-bajo');
    expect(got.token).toBe(token);
    expect(got.body).toMatchObject({ tenantId: a.tenantId, tenantName: 'Bodega A', key: 'LOW_STOCK_ALERT', attempt: 1 });
    expect(String(got.body.callbackUrl)).toMatch(/\/api\/v1\/internal\/notify$/);
    const after = await owner.automationEvent.findUniqueOrThrow({ where: { id: evs[0]!.id } });
    expect(after.status).toBe('SENT');
    // Ya entregado: no se vuelve a enviar
    expect(await dispatcher.tick()).toBe(0);
  });

  it('flujo 3: un pedido nuevo genera su evento con el detalle', async () => {
    await ctx.http().post('/api/v1/orders').set(H()).send({ customer: { phone: '51987000222', name: 'Carla' }, items: [{ variantId, quantity: 2 }] }).expect(201);
    const ev = await owner.automationEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, key: 'NEW_ORDER_NOTIFICATION' } });
    expect(ev.payload).toMatchObject({ number: 1, channel: 'MANUAL', total: '7.00', customerName: 'Carla', items: [{ name: 'Gaseosa 500 ml', quantity: 2 }] });
  });

  it('una automatización desactivada por la empresa no genera eventos', async () => {
    await owner.automation.upsert({ where: { tenantId_key: { tenantId: a.tenantId, key: 'NEW_ORDER_NOTIFICATION' } }, create: { tenantId: a.tenantId, key: 'NEW_ORDER_NOTIFICATION', isEnabled: false }, update: { isEnabled: false } });
    const before = await owner.automationEvent.count({ where: { key: 'NEW_ORDER_NOTIFICATION' } });
    await ctx.http().post('/api/v1/orders').set(H()).send({ customer: { phone: '51987000223' }, items: [{ variantId, quantity: 1 }] }).expect(201);
    expect(await owner.automationEvent.count({ where: { key: 'NEW_ORDER_NOTIFICATION' } })).toBe(before);
  });

  it('flujo 7: si n8n falla se reintenta con espera; agotados los intentos queda FAILED y se avisa en el panel', async () => {
    const pending = await owner.automationEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, key: 'NEW_ORDER_NOTIFICATION', status: 'PENDING' } });
    respondStatus = 500;
    await dispatcher.tick();
    let ev = await owner.automationEvent.findUniqueOrThrow({ where: { id: pending.id } });
    expect(ev).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(ev.lastError).toMatch(/n8n respondió 500/);
    expect(ev.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    // Antes de su hora no se reintenta
    expect(await dispatcher.tick()).toBe(0);

    await owner.automationEvent.update({ where: { id: pending.id }, data: { attempts: 7, nextAttemptAt: new Date(0) } });
    await dispatcher.tick();
    ev = await owner.automationEvent.findUniqueOrThrow({ where: { id: pending.id } });
    expect(ev).toMatchObject({ status: 'FAILED', attempts: 8 });
    const n = await owner.notification.findFirstOrThrow({ where: { tenantId: a.tenantId, type: 'automation.failed' } });
    expect(n.data).toMatchObject({ eventId: pending.id });
    respondStatus = 200;
  });

  it('la API interna exige el token antes de mirar el cuerpo', async () => {
    await ctx.http().post('/api/v1/internal/notify').send({}).expect(403);
    await ctx.http().post('/api/v1/internal/notify').set('X-Internal-Token', 'x'.repeat(token.length)).send({}).expect(403);
    // Un usuario autenticado de la empresa tampoco puede usarla
    await ctx.http().post('/api/v1/internal/notify').set(H()).send({}).expect(403);
  });

  it('notify envía el correo a los administradores de la empresa del evento, una sola vez', async () => {
    const ev = await owner.automationEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, key: 'LOW_STOCK_ALERT' } });
    const before = ctx.outbox.length;
    const body = { eventId: ev.id, subject: 'Stock bajo: Gaseosa 500 ml', text: 'Quedan 4 unidades.' };
    const r = await ctx.http().post('/api/v1/internal/notify').set('X-Internal-Token', token).send(body).expect(200);
    expect(r.body).toEqual({ delivered: 1, duplicate: false });
    const sent = ctx.outbox.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'a@auto.test', subject: 'Stock bajo: Gaseosa 500 ml' });
    // n8n reintenta: no se duplica
    const again = await ctx.http().post('/api/v1/internal/notify').set('X-Internal-Token', token).send(body).expect(200);
    expect(again.body).toEqual({ delivered: 0, duplicate: true });
    expect(ctx.outbox.length).toBe(before + 1);
    // Nunca a otra empresa
    expect(sent.some((m) => m.to === 'b@auto.test')).toBe(false);
    await ctx.http().post('/api/v1/internal/notify').set('X-Internal-Token', token).send({ ...body, eventId: '01900000-0000-7000-8000-000000000000' }).expect(404);
  });

  it('RLS: otra empresa no ve los eventos ajenos', async () => {
    const { DatabaseService } = await import('../src/database/database.service.js');
    const db = ctx.app.get(DatabaseService);
    expect(await db.tenant(b.tenantId, (tx) => tx.automationEvent.count())).toBe(0);
    expect(await db.tenant(a.tenantId, (tx) => tx.automationEvent.count())).toBeGreaterThan(0);
  });

  it('solo direcciones privadas o locales cuentan como red interna', async () => {
    const { isPrivateAddress } = await import('../src/automations/internal.controller.js');
    for (const ip of ['127.0.0.1', '::1', '::ffff:172.18.0.5', '10.1.2.3', '192.168.1.10', 'fd12:3456::1']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '::ffff:200.48.1.1', '2001:db8::1', undefined, 'nada']) expect(isPrivateAddress(ip)).toBe(false);
  });
});
