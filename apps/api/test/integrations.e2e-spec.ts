import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import argon2 from 'argon2';
import { setTestEnv, createTestApp, ownerClient, roleClient, resetDatabase, registerAndLogin } from './helpers.js';

setTestEnv();
// Los receptores de prueba escuchan en 127.0.0.1: en producción esto está prohibido (env.ts)
process.env.WEBHOOKS_ALLOW_PRIVATE_NETWORK = 'true';
const owner = ownerClient();

const PLATFORM_KEY = 'clave-plataforma-gemini-0001';
const OWN_KEY = 'AIzaPropiaDeLaEmpresa_1234567890';
const readBody = (req: IncomingMessage) => new Promise<string>((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });

describe('Integraciones centralizadas: webhooks firmados, clave propia de Gemini y comprobaciones', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let gemini: Server;
  let receiver: Server;
  let receiverUrl: string;
  const geminiCalls: { method: string; url: string; key: string | undefined }[] = [];
  const received: { headers: IncomingMessage['headers']; body: string }[] = [];
  let receiverStatus = 200;
  let a: Awaited<ReturnType<typeof registerAndLogin>>;
  let b: Awaited<ReturnType<typeof registerAndLogin>>;
  let rootToken: string;
  let dispatcher: import('../src/webhooks/webhook-dispatcher.js').WebhookDispatcher;
  const H = () => ({ Authorization: `Bearer ${a.accessToken}` });
  const HB = () => ({ Authorization: `Bearer ${b.accessToken}` });
  const R = () => ({ Authorization: `Bearer ${rootToken}` });

  beforeAll(async () => {
    // Gemini simulado: models.get valida la clave; generateContent responde texto
    gemini = createServer(async (req, res) => {
      await readBody(req);
      const key = req.headers['x-goog-api-key'] as string | undefined;
      geminiCalls.push({ method: req.method!, url: req.url!, key });
      res.setHeader('Content-Type', 'application/json');
      if (key !== PLATFORM_KEY && key !== OWN_KEY) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }));
      }
      if (req.method === 'GET') return res.end(JSON.stringify({ name: 'models/gemini-modelo-prueba' }));
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hola, ¿en qué te ayudo?' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }));
    });
    await new Promise<void>((r) => gemini.listen(0, '127.0.0.1', r));
    // Receptor de webhooks de un cliente
    receiver = createServer(async (req, res) => {
      received.push({ headers: req.headers, body: await readBody(req) });
      res.statusCode = receiverStatus;
      res.end(receiverStatus === 200 ? 'ok' : 'error interno del receptor');
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks/aisa`;
    process.env.GEMINI_API_KEY = PLATFORM_KEY;
    process.env.GEMINI_MODEL = 'gemini-modelo-prueba';
    process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(gemini.address() as AddressInfo).port}`;

    await resetDatabase(owner);
    ctx = await createTestApp();
    const { WebhookDispatcher } = await import('../src/webhooks/webhook-dispatcher.js');
    const { WebhookSender } = await import('../src/webhooks/webhook-sender.js');
    const { DatabaseService } = await import('../src/database/database.service.js');
    // Mismo código que el worker, sin el temporizador
    dispatcher = new WebhookDispatcher(ctx.app.get(DatabaseService), ctx.app.get(WebhookSender));
    a = await registerAndLogin(ctx, { companyName: 'Tienda Webhooks', email: 'admin@int-a.test' });
    b = await registerAndLogin(ctx, { companyName: 'Otra Tienda', email: 'admin@int-b.test' });
    await owner.user.create({ data: { email: 'root@int.test', name: 'Root', role: 'PLATFORM_ADMIN', emailVerifiedAt: new Date(), passwordHash: await argon2.hash('RootClave123') } });
    rootToken = (await ctx.http().post('/api/v1/auth/login').send({ email: 'root@int.test', password: 'RootClave123' }).expect(200)).body.accessToken;
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
    await new Promise((r) => gemini.close(r));
    await new Promise((r) => receiver.close(r));
  });

  const verify = (secret: string, r: { headers: IncomingMessage['headers']; body: string }) => {
    const [t, v1] = String(r.headers['x-aisa-signature']).split(',').map((x) => x.split('=')[1]);
    return createHmac('sha256', secret).update(`${t}.${r.body}`).digest('hex') === v1 && Math.abs(Date.now() / 1000 - Number(t)) < 300;
  };

  let secret: string;
  let endpointId: string;

  it('crea un webhook: valida la URL y muestra el secreto una sola vez', async () => {
    await ctx.http().post('/api/v1/integrations/webhooks').set(H()).send({ url: 'ftp://x.test/a', events: ['order.created'] }).expect(400);
    await ctx.http().post('/api/v1/integrations/webhooks').set(H()).send({ url: 'https://user:pw@x.test/a', events: ['order.created'] }).expect(400);
    await ctx.http().post('/api/v1/integrations/webhooks').set(H()).send({ url: receiverUrl, events: ['no.existe'] }).expect(400);
    const r = await ctx.http().post('/api/v1/integrations/webhooks').set(H()).send({ url: receiverUrl, description: 'ERP', events: ['order.created', 'order.status_changed'] }).expect(201);
    expect(r.body.secret).toMatch(/^whsec_/);
    expect(r.body.secretEnc).toBeUndefined();
    expect(r.body.secretHint).toBe(`…${r.body.secret.slice(-4)}`);
    secret = r.body.secret;
    endpointId = r.body.id;
    const list = await ctx.http().get('/api/v1/integrations/webhooks').set(H()).expect(200);
    expect(Object.keys(list.body.events)).toEqual(['order.created', 'order.status_changed', 'stock.low', 'conversation.handoff']);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(secret);
    // Cifrado en la base de datos
    const row = await owner.webhookEndpoint.findUniqueOrThrow({ where: { id: endpointId } });
    expect(row.secretEnc).not.toContain(secret);
    // La otra empresa no lo ve ni lo toca
    expect((await ctx.http().get('/api/v1/integrations/webhooks').set(HB()).expect(200)).body.items).toEqual([]);
    await ctx.http().patch(`/api/v1/integrations/webhooks/${endpointId}`).set(HB()).send({ isActive: false }).expect(404);
    await ctx.http().delete(`/api/v1/integrations/webhooks/${endpointId}`).set(HB()).expect(404);
    await ctx.http().get(`/api/v1/integrations/webhooks/${endpointId}/deliveries`).set(HB()).expect(200).then((x) => expect(x.body.items).toEqual([]));
  });

  it('un pedido genera la entrega; el worker la envía firmada y solo a la empresa dueña', async () => {
    const p = await ctx.http().post('/api/v1/products').set(H()).send({ sku: 'WH-1', name: 'Arroz 5 kg', salePrice: '25.00', initialStock: 10 }).expect(201);
    const o = await ctx.http().post('/api/v1/orders').set(H()).send({ customer: { phone: '51911100400' }, items: [{ variantId: p.body.variants[0].id, quantity: 2 }], confirm: false }).expect(201);
    // Pedido de la otra empresa: no debe llegar a este receptor
    const pb = await ctx.http().post('/api/v1/products').set(HB()).send({ sku: 'WH-B', name: 'Azúcar', salePrice: '4.00', initialStock: 10 }).expect(201);
    await ctx.http().post('/api/v1/orders').set(HB()).send({ customer: { phone: '51911100401' }, items: [{ variantId: pb.body.variants[0].id, quantity: 1 }] }).expect(201);

    expect(await owner.webhookDelivery.count()).toBe(1);
    received.length = 0;
    expect(await dispatcher.tick()).toBe(1);
    expect(received).toHaveLength(1);
    const msg = received[0]!;
    expect(msg.headers['x-aisa-event']).toBe('order.created');
    expect(verify(secret, msg)).toBe(true);
    expect(verify('whsec_otro', msg)).toBe(false);
    const body = JSON.parse(msg.body);
    expect(body).toMatchObject({ event: 'order.created', tenantId: a.tenantId, data: { orderId: o.body.id, number: o.body.number } });
    expect(body.id).toBe(msg.headers['x-aisa-delivery']);
    expect(body.data.items[0]).toMatchObject({ sku: 'WH-1', quantity: 2, unitPrice: '25.00' });
    const d = await owner.webhookDelivery.findFirstOrThrow({ where: { endpointId } });
    expect(d).toMatchObject({ status: 'SENT', attempts: 1, responseStatus: 200 });
    expect(await dispatcher.tick()).toBe(0);

    // Cambio de estado
    await ctx.http().patch(`/api/v1/orders/${o.body.id}/status`).set(H()).send({ status: 'CONFIRMED' }).expect(200);
    received.length = 0;
    await dispatcher.tick();
    expect(JSON.parse(received[0]!.body)).toMatchObject({ event: 'order.status_changed', data: { orderId: o.body.id, from: 'PENDING', to: 'CONFIRMED' } });
  });

  it('reintenta con espera creciente, marca FALLIDA al agotar intentos, avisa una vez y se puede reencolar', async () => {
    receiverStatus = 500;
    const p = await ctx.http().post('/api/v1/products').set(H()).send({ sku: 'WH-2', name: 'Aceite', salePrice: '9.00', initialStock: 10 }).expect(201);
    await ctx.http().post('/api/v1/orders').set(H()).send({ customer: { phone: '51911100402' }, items: [{ variantId: p.body.variants[0].id, quantity: 1 }], confirm: false }).expect(201);
    const pending = await owner.webhookDelivery.findFirstOrThrow({ where: { status: 'PENDING' } });
    await dispatcher.tick();
    let d = await owner.webhookDelivery.findUniqueOrThrow({ where: { id: pending.id } });
    expect(d).toMatchObject({ status: 'PENDING', attempts: 1, responseStatus: 500 });
    expect(d.lastError).toContain('Respondió 500');
    const wait = (d.nextAttemptAt.getTime() - Date.now()) / 1000;
    expect(wait).toBeGreaterThan(20);
    expect(wait).toBeLessThan(40);
    // Simula el paso del tiempo hasta agotar los intentos
    for (let i = 2; i <= 6; i++) {
      await owner.webhookDelivery.update({ where: { id: pending.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await dispatcher.tick();
    }
    d = await owner.webhookDelivery.findUniqueOrThrow({ where: { id: pending.id } });
    expect(d).toMatchObject({ status: 'FAILED', attempts: 6 });
    const endpoint = await owner.webhookEndpoint.findUniqueOrThrow({ where: { id: endpointId } });
    expect(endpoint).toMatchObject({ lastStatus: 500 });
    expect(await owner.notification.count({ where: { tenantId: a.tenantId, type: 'webhook.failed' } })).toBe(1);

    // La otra empresa no puede reencolarla; la dueña sí
    await ctx.http().post(`/api/v1/integrations/webhooks/deliveries/${pending.id}/retry`).set(HB()).expect(404);
    receiverStatus = 200;
    await ctx.http().post(`/api/v1/integrations/webhooks/deliveries/${pending.id}/retry`).set(H()).expect(200);
    await ctx.http().post(`/api/v1/integrations/webhooks/deliveries/${pending.id}/retry`).set(H()).expect(404); // ya no está fallida
    await dispatcher.tick();
    expect(await owner.webhookDelivery.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: 'SENT', attempts: 1 });
    const overview = await ctx.http().get('/api/v1/integrations').set(H()).expect(200);
    // Ya no hay URL con error, pero sí la entrega fallida pasada no cuenta (se reenvió)
    expect(overview.body.find((x: { key: string }) => x.key === 'webhooks').status).toBe('connected');
  });

  it('«Probar» envía un ping firmado al momento; rotar el secreto invalida el anterior', async () => {
    received.length = 0;
    const t = await ctx.http().post(`/api/v1/integrations/webhooks/${endpointId}/test`).set(H()).expect(200);
    expect(t.body).toMatchObject({ ok: true, status: 200 });
    expect(received[0]!.headers['x-aisa-event']).toBe('ping');
    expect(verify(secret, received[0]!)).toBe(true);
    const rot = await ctx.http().post(`/api/v1/integrations/webhooks/${endpointId}/rotate-secret`).set(H()).expect(200);
    received.length = 0;
    await ctx.http().post(`/api/v1/integrations/webhooks/${endpointId}/test`).set(H()).expect(200);
    expect(verify(secret, received[0]!)).toBe(false);
    expect(verify(rot.body.secret, received[0]!)).toBe(true);
    secret = rot.body.secret;
    // Un ping fallido no se reintenta ni genera aviso
    receiverStatus = 503;
    const bad = await ctx.http().post(`/api/v1/integrations/webhooks/${endpointId}/test`).set(H()).expect(200);
    expect(bad.body).toMatchObject({ ok: false, status: 503 });
    const ping = await owner.webhookDelivery.findFirstOrThrow({ where: { event: 'ping', status: 'FAILED' } });
    await ctx.http().post(`/api/v1/integrations/webhooks/deliveries/${ping.id}/retry`).set(H()).expect(404);
    receiverStatus = 200;
    // Botón «Probar» del resumen: registra la comprobación
    const all = await ctx.http().post('/api/v1/integrations/webhooks/test').set(H()).expect(200);
    expect(all.body).toMatchObject({ ok: true, detail: '1 URL(s) respondieron 2xx' });
    const hist = await ctx.http().get('/api/v1/integrations/checks?service=webhooks').set(H()).expect(200);
    expect(hist.body[0]).toMatchObject({ service: 'webhooks', ok: true });
  });

  it('límite de 5 URLs y borrado', async () => {
    for (let i = 0; i < 4; i++) await ctx.http().post('/api/v1/integrations/webhooks').set(H()).send({ url: `${receiverUrl}?n=${i}`, events: ['stock.low'] }).expect(201);
    await ctx.http().post('/api/v1/integrations/webhooks').set(H()).send({ url: receiverUrl, events: ['stock.low'] }).expect(403);
    const list = await ctx.http().get('/api/v1/integrations/webhooks').set(H()).expect(200);
    for (const e of list.body.items.filter((x: { id: string }) => x.id !== endpointId)) await ctx.http().delete(`/api/v1/integrations/webhooks/${e.id}`).set(H()).expect(204);
    expect(await owner.webhookEndpoint.count({ where: { tenantId: a.tenantId } })).toBe(1);
  });

  it('clave propia de Gemini: se valida con Google, se guarda cifrada y el asistente la usa', async () => {
    let ov = await ctx.http().get('/api/v1/integrations').set(H()).expect(200);
    expect(ov.body.map((x: { key: string }) => x.key)).toEqual(['whatsapp', 'ai', 'email', 'automations', 'chatwoot', 'webhooks', 'payments']);
    expect(ov.body.find((x: { key: string }) => x.key === 'ai')).toMatchObject({ status: 'connected', ownKey: null, detail: 'Usa la clave de la plataforma' });

    const bad = await ctx.http().put('/api/v1/integrations/ai/key').set(H()).send({ apiKey: 'AIzaClaveQueNoExiste_00000000' }).expect(400);
    expect(bad.body.code).toBe('INVALID_KEY');
    expect(bad.body.message).toContain('API key not valid');
    expect(await owner.tenantIntegration.count({ where: { tenantId: a.tenantId, type: 'GEMINI' } })).toBe(0);
    await ctx.http().put('/api/v1/integrations/ai/key').set(H()).send({ apiKey: 'corta' }).expect(400);

    const ok = await ctx.http().put('/api/v1/integrations/ai/key').set(H()).send({ apiKey: OWN_KEY }).expect(200);
    expect(ok.body).toMatchObject({ status: 'CONNECTED', hint: '…7890' });
    const row = await owner.tenantIntegration.findFirstOrThrow({ where: { tenantId: a.tenantId, type: 'GEMINI' } });
    expect(row.secretsEnc).not.toContain(OWN_KEY);
    expect(await owner.auditLog.count({ where: { tenantId: a.tenantId, action: 'integration.gemini_key_set' } })).toBe(1);
    ov = await ctx.http().get('/api/v1/integrations').set(H()).expect(200);
    expect(JSON.stringify(ov.body)).not.toContain(OWN_KEY);
    expect(ov.body.find((x: { key: string }) => x.key === 'ai')).toMatchObject({ status: 'connected', ownKey: { hint: '…7890', status: 'CONNECTED' } });
    const settings = await ctx.http().get('/api/v1/ai/settings').set(H()).expect(200);
    expect(settings.body.provider).toMatchObject({ configured: true, source: 'tenant' });

    // El asistente de esta empresa usa su clave; la otra sigue con la de la plataforma
    geminiCalls.length = 0;
    await ctx.http().post('/api/v1/ai/test').set(H()).send({ target: 'draft', messages: [{ role: 'customer', text: 'hola' }] }).expect(200);
    await ctx.http().post('/api/v1/ai/test').set(HB()).send({ target: 'draft', messages: [{ role: 'customer', text: 'hola' }] }).expect(200);
    expect(geminiCalls.filter((c) => c.method === 'POST').map((c) => c.key)).toEqual([OWN_KEY, PLATFORM_KEY]);

    const test = await ctx.http().post('/api/v1/integrations/ai/test').set(H()).expect(200);
    expect(test.body).toMatchObject({ ok: true });
    expect(test.body.detail).toContain('Clave propia');

    await ctx.http().delete('/api/v1/integrations/ai/key').set(H()).expect(204);
    geminiCalls.length = 0;
    await ctx.http().post('/api/v1/ai/test').set(H()).send({ target: 'draft', messages: [{ role: 'customer', text: 'hola' }] }).expect(200);
    expect(geminiCalls.at(-1)!.key).toBe(PLATFORM_KEY);
  });

  it('prueba de correo y del número: la primera envía de verdad, la segunda indica que falta configurarlo', async () => {
    const before = ctx.outbox.length;
    const r = await ctx.http().post('/api/v1/integrations/email/test').set(H()).expect(200);
    expect(r.body).toMatchObject({ ok: true });
    expect(ctx.outbox.slice(before)).toEqual([expect.objectContaining({ to: 'admin@int-a.test', subject: 'Correo de prueba de AI Sales Assistant' })]);
    const wa = await ctx.http().post('/api/v1/integrations/whatsapp/test').set(H()).expect(200);
    expect(wa.body).toMatchObject({ ok: false, detail: 'Sin números de WhatsApp Cloud API' });
    await ctx.http().post('/api/v1/integrations/payments/test').set(H()).expect(400);
    const errors = await ctx.http().get('/api/v1/integrations/checks?ok=false').set(H()).expect(200);
    expect(errors.body.map((c: { service: string }) => c.service)).toContain('whatsapp');
    // Historial aislado por empresa
    expect((await ctx.http().get('/api/v1/integrations/checks').set(HB()).expect(200)).body).toEqual([]);
  });

  it('el historial de comprobaciones solo se inserta: la app no puede editarlo ni borrarlo, y RLS lo aísla', async () => {
    const runtime = roleClient('runtime');
    try {
      const rows = await runtime.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${b.tenantId}, true)`;
        return tx.integrationCheck.count();
      });
      expect(rows).toBe(0);
      await expect(runtime.$executeRawUnsafe('UPDATE integration_checks SET ok = true')).rejects.toThrow(/permission denied/);
      await expect(runtime.$executeRawUnsafe('DELETE FROM integration_checks')).rejects.toThrow(/permission denied/);
      await expect(runtime.$executeRawUnsafe('UPDATE webhook_deliveries SET payload = \'{}\'::jsonb')).rejects.toThrow(/permission denied/);
    } finally {
      await runtime.$disconnect();
    }
  });

  it('panel general: estado del servidor y prueba real de Gemini (solo administrador general)', async () => {
    await ctx.http().get('/api/v1/platform/integrations').set(H()).expect(403);
    await ctx.http().post('/api/v1/platform/integrations/gemini/test').set(H()).expect(403);
    const t = await ctx.http().post('/api/v1/platform/integrations/gemini/test').set(R()).expect(200);
    expect(t.body).toMatchObject({ ok: true });
    const db = await ctx.http().post('/api/v1/platform/integrations/database/test').set(R()).expect(200);
    expect(db.body.ok).toBe(true);
    const ov = await ctx.http().get('/api/v1/platform/integrations').set(R()).expect(200);
    const svc = (k: string) => ov.body.services.find((s: { key: string }) => s.key === k);
    expect(svc('gemini')).toMatchObject({ configured: true, lastCheck: { ok: true } });
    expect(svc('database').lastCheck.ok).toBe(true);
    expect(ov.body.payments.provider).toBeNull();
    expect(ov.body.last7Days.failedWebhooks).toBeGreaterThanOrEqual(1); // el ping fallido
    expect(JSON.stringify(ov.body)).not.toContain(PLATFORM_KEY);
    expect(await owner.auditLog.count({ where: { action: 'platform.integration_tested' } })).toBe(2);
  });
});
