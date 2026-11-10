import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTestEnv, createTestApp, ownerClient, resetDatabase, registerAndLogin, tokenFrom } from './helpers.js';

setTestEnv();
process.env.THROTTLE_DISABLED = 'true';

/**
 * WhatsApp Cloud API de punta a punta contra un servidor HTTP local que responde
 * como Graph API (formato de la documentación oficial). Así se prueban la firma,
 * el enrutado por empresa, la idempotencia, los reintentos y los estados sin
 * enviar mensajes reales. La prueba con Meta real requiere credenciales (README).
 */
interface GraphCall { method: string; path: string; auth: string | undefined; body: Record<string, unknown> | null }

describe('WhatsApp Cloud API', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const owner = ownerClient();
  let graph: Server;
  const calls: GraphCall[] = [];
  /** Respuesta del siguiente envío: null = éxito */
  let nextSendError: { status: number; code: number; message: string } | null = null;
  let a: Awaited<ReturnType<typeof registerAndLogin>>;
  let b: Awaited<ReturnType<typeof registerAndLogin>>;
  const HA = () => ({ Authorization: `Bearer ${a.accessToken}` });
  const HB = () => ({ Authorization: `Bearer ${b.accessToken}` });
  const APP_SECRET_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const APP_SECRET_B = 'ffeeddccbbaa99887766554433221100';
  const TOKEN_A = 'EAAG-token-de-prueba-empresa-a-0123456789';
  let numberA: { id: string; webhookUrl: string };
  let keyA: string;
  let keyB: string;
  let inbound: import('../src/messaging/inbound.service.js').InboundService;
  let outbound: import('../src/messaging/outbound.service.js').OutboundService;
  let wamidSeq = 0;

  const readBody = (req: IncomingMessage) => new Promise<string>((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });

  beforeAll(async () => {
    graph = createServer(async (req, res) => {
      const body = await readBody(req);
      const call: GraphCall = { method: req.method!, path: req.url!, auth: req.headers.authorization, body: body ? JSON.parse(body) : null };
      calls.push(call);
      res.setHeader('Content-Type', 'application/json');
      const valid = req.headers.authorization === `Bearer ${TOKEN_A}` || req.headers.authorization === 'Bearer EAAG-token-de-prueba-empresa-b-0123456789';
      if (!valid) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } }));
      }
      const m = /^\/v26\.0\/(\d+)(\/messages)?$/.exec(req.url!);
      if (req.method === 'GET' && m && !m[2]) return res.end(JSON.stringify({ id: m[1], display_phone_number: '+51 900 000 001', verified_name: 'Bodega Test', quality_rating: 'GREEN' }));
      if (req.method === 'POST' && m?.[2]) {
        if (nextSendError) {
          const e = nextSendError;
          nextSendError = null;
          res.statusCode = e.status;
          return res.end(JSON.stringify({ error: { message: e.message, code: e.code, error_data: { details: e.message } } }));
        }
        return res.end(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: call.body?.to, wa_id: call.body?.to }], messages: [{ id: `wamid.OUT${++wamidSeq}` }] }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'Unknown path', code: 100 } }));
    });
    await new Promise<void>((r) => graph.listen(0, '127.0.0.1', r));
    process.env.WHATSAPP_GRAPH_BASE_URL = `http://127.0.0.1:${(graph.address() as AddressInfo).port}`;
    process.env.WHATSAPP_GRAPH_API_VERSION = 'v26.0';

    await resetDatabase(owner);
    ctx = await createTestApp();
    a = await registerAndLogin(ctx, { companyName: 'Bodega A', email: 'a@wa.test' });
    b = await registerAndLogin(ctx, { companyName: 'Bodega B', email: 'b@wa.test' });
    const { InboundService } = await import('../src/messaging/inbound.service.js');
    const { OutboundService } = await import('../src/messaging/outbound.service.js');
    inbound = ctx.app.get(InboundService);
    outbound = ctx.app.get(OutboundService);
  });
  afterAll(async () => {
    const { Queues } = await import('../src/queues/queues.module.js');
    const q = ctx.app.get(Queues);
    await Promise.all([q.inbound.obliterate({ force: true }), q.outbound.obliterate({ force: true })]);
    await ctx.app.close();
    await owner.$disconnect();
    graph.close();
  });

  const sign = (body: string, secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const textMessage = (o: { phoneNumberId: string; wamid: string; from?: string; userId?: string; name?: string; text: string; ts?: number }) => ({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '51900000001', phone_number_id: o.phoneNumberId },
          contacts: [{ profile: { name: o.name ?? 'Cliente' }, ...(o.from ? { wa_id: o.from } : {}), ...(o.userId ? { user_id: o.userId } : {}) }],
          messages: [{ ...(o.from ? { from: o.from } : {}), ...(o.userId ? { from_user_id: o.userId } : {}), id: o.wamid, timestamp: String(o.ts ?? Math.floor(Date.now() / 1000)), type: 'text', text: { body: o.text } }],
        },
      }],
    }],
  });
  const statusEvent = (phoneNumberId: string, wamid: string, status: string, errors?: unknown[]) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '51900000001', phone_number_id: phoneNumberId }, statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '51987654321', ...(errors ? { errors } : {}) }] } }] }],
  });
  const post = (key: string, payload: unknown, secret: string) => {
    const raw = JSON.stringify(payload);
    return ctx.http().post(`/api/v1/webhooks/whatsapp/${key}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw, secret)).send(raw);
  };
  /** Procesa lo que el webhook dejó en inbound_events (lo que hace el worker) */
  const processPending = async () => {
    const evs = await owner.inboundEvent.findMany({ where: { status: 'RECEIVED' }, orderBy: { receivedAt: 'asc' } });
    const out = [];
    for (const e of evs) out.push(await inbound.processEvent(e.id));
    return out;
  };

  it('rechaza credenciales que Meta no acepta y no guarda nada', async () => {
    const r = await ctx.http().post('/api/v1/whatsapp/numbers').set(HA()).send({ phoneNumberId: '100000000001', accessToken: 'EAAG-token-invalido-000000000000', appSecret: APP_SECRET_A }).expect(400);
    expect(r.body.code).toBe('WHATSAPP_VERIFY_FAILED');
    expect(r.body.message).toContain('190');
    expect(await owner.whatsappNumber.count()).toBe(0);
  });

  it('registra un número verificado; los secretos quedan cifrados', async () => {
    const r = await ctx.http().post('/api/v1/whatsapp/numbers').set(HA()).send({ label: 'Ventas', phoneNumberId: '100000000001', wabaId: '200000000001', accessToken: TOKEN_A, appSecret: APP_SECRET_A }).expect(201);
    expect(r.body).toMatchObject({ status: 'CONNECTED', displayPhone: '51900000001', verifiedName: 'Bodega Test', hasAccessToken: true, hasAppSecret: true });
    expect(r.body).not.toHaveProperty('accessTokenEnc');
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: '/v26.0/100000000001', auth: `Bearer ${TOKEN_A}` });
    numberA = r.body;
    keyA = numberA.webhookUrl.split('/').pop()!;
    const row = await owner.whatsappNumber.findUniqueOrThrow({ where: { id: numberA.id } });
    expect(row.accessTokenEnc).not.toContain(TOKEN_A);
    expect(row.appSecretEnc).not.toContain(APP_SECRET_A);
  });

  it('respeta el límite de números del plan y la unicidad entre empresas', async () => {
    await ctx.http().post('/api/v1/whatsapp/numbers').set(HA()).send({ phoneNumberId: '100000000009', accessToken: TOKEN_A, appSecret: APP_SECRET_A }).expect(403);
    // Otra empresa no puede registrar el mismo phone_number_id
    await ctx.http().post('/api/v1/whatsapp/numbers').set(HB()).send({ phoneNumberId: '100000000001', accessToken: 'EAAG-token-de-prueba-empresa-b-0123456789', appSecret: APP_SECRET_B }).expect(409);
    const rb = await ctx.http().post('/api/v1/whatsapp/numbers').set(HB()).send({ phoneNumberId: '100000000002', accessToken: 'EAAG-token-de-prueba-empresa-b-0123456789', appSecret: APP_SECRET_B }).expect(201);
    keyB = rb.body.webhookUrl.split('/').pop()!;
    // B no ve el número de A
    const list = await ctx.http().get('/api/v1/whatsapp/numbers').set(HB()).expect(200);
    expect(list.body.map((n: { id: string }) => n.id)).not.toContain(numberA.id);
    await ctx.http().get(`/api/v1/whatsapp/numbers/${numberA.id}/webhook`).set(HB()).expect(404);
  });

  it('verificación del webhook: devuelve hub.challenge solo con el verify token correcto', async () => {
    const cfg = await ctx.http().get(`/api/v1/whatsapp/numbers/${numberA.id}/webhook`).set(HA()).expect(200);
    expect(cfg.body.verifyToken).toHaveLength(32);
    const ok = await ctx.http().get(`/api/v1/webhooks/whatsapp/${keyA}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': cfg.body.verifyToken, 'hub.challenge': '1158201444' }).expect(200);
    expect(ok.text).toBe('1158201444');
    await ctx.http().get(`/api/v1/webhooks/whatsapp/${keyA}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'otro', 'hub.challenge': '1' }).expect(403);
    await ctx.http().get('/api/v1/webhooks/whatsapp/clave-que-no-existe-123').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '1' }).expect(404);
  });

  it('rechaza webhooks sin firma o firmados con otro App Secret', async () => {
    const raw = JSON.stringify(textMessage({ phoneNumberId: '100000000001', wamid: 'wamid.IN-falso', from: '51987654321', text: 'hola' }));
    await ctx.http().post(`/api/v1/webhooks/whatsapp/${keyA}`).set('Content-Type', 'application/json').send(raw).expect(401);
    await post(keyA, JSON.parse(raw), APP_SECRET_B).expect(401);
    expect(await owner.inboundEvent.count()).toBe(0);
  });

  it('mensaje entrante: crea cliente, conversación y mensaje; los duplicados de Meta no se repiten', async () => {
    const payload = textMessage({ phoneNumberId: '100000000001', wamid: 'wamid.IN1', from: '51987654321', userId: 'PE.1234567890', name: 'Ana', text: '¿Tienen zapatillas talla 42?' });
    const r = await post(keyA, payload, APP_SECRET_A).expect(200);
    expect(r.text).toBe('EVENT_RECEIVED');
    await post(keyA, payload, APP_SECRET_A).expect(200); // reintento de Meta
    expect(await owner.inboundEvent.count()).toBe(1);
    const res = await processPending();
    expect(res[0]).toMatchObject({ outcome: 'processed', newConversation: true });
    const customer = await owner.customer.findFirstOrThrow({ where: { tenantId: a.tenantId } });
    expect(customer).toMatchObject({ phone: '51987654321', waUserId: 'PE.1234567890', waProfileName: 'Ana', name: null, source: 'whatsapp' });
    const msgs = await owner.message.findMany({ where: { tenantId: a.tenantId } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direction: 'INBOUND', content: '¿Tienen zapatillas talla 42?', providerMessageId: 'wamid.IN1' });
    expect(await owner.usageCounter.findFirst({ where: { tenantId: a.tenantId, metric: 'conversations' } })).toMatchObject({ value: 1 });
    // Procesar dos veces el mismo evento no duplica
    const ev = await owner.inboundEvent.findFirstOrThrow();
    expect(await inbound.processEvent(ev.id)).toMatchObject({ outcome: 'duplicate' });
  });

  it('cliente sin teléfono (solo BSUID) y luego con teléfono: es el mismo cliente', async () => {
    await post(keyA, textMessage({ phoneNumberId: '100000000001', wamid: 'wamid.IN2', userId: 'PE.999', name: 'Luis', text: 'hola' }), APP_SECRET_A).expect(200);
    await processPending();
    const c1 = await owner.customer.findFirstOrThrow({ where: { waUserId: 'PE.999' } });
    expect(c1.phone).toBeNull();
    await post(keyA, textMessage({ phoneNumberId: '100000000001', wamid: 'wamid.IN3', userId: 'PE.999', from: '51911111111', text: 'mi número' }), APP_SECRET_A).expect(200);
    await processPending();
    const all = await owner.customer.findMany({ where: { tenantId: a.tenantId, OR: [{ waUserId: 'PE.999' }, { phone: '51911111111' }] } });
    expect(all).toHaveLength(1);
    expect(all[0]!.phone).toBe('51911111111');
    expect(await owner.conversation.count({ where: { customerId: c1.id } })).toBe(1);
  });

  it('aislamiento: el webhook de B no puede inyectar mensajes del número de A', async () => {
    const before = await owner.inboundEvent.count();
    await post(keyB, textMessage({ phoneNumberId: '100000000001', wamid: 'wamid.ATTACK', from: '51900000099', text: 'pedido falso' }), APP_SECRET_B).expect(200);
    expect(await owner.inboundEvent.count()).toBe(before);
    expect(await owner.message.count({ where: { providerMessageId: 'wamid.ATTACK' } })).toBe(0);
  });

  let convId: string;
  it('respuesta de un agente: se encola, se envía por Graph y registra el wamid', async () => {
    const list = await ctx.http().get('/api/v1/conversations').set(HA()).expect(200);
    convId = list.body.items.find((c: { customer: { phone: string } }) => c.customer.phone === '51987654321').id;
    // B no ve conversaciones de A
    await ctx.http().get(`/api/v1/conversations/${convId}`).set(HB()).expect(404);
    const r = await ctx.http().post(`/api/v1/conversations/${convId}/messages`).set(HA()).send({ text: 'Sí, tenemos la talla 42 🙂', idempotencyKey: 'editor-0001' }).expect(201);
    const again = await ctx.http().post(`/api/v1/conversations/${convId}/messages`).set(HA()).send({ text: 'Sí, tenemos la talla 42 🙂', idempotencyKey: 'editor-0001' }).expect(201);
    expect(again.body).toMatchObject({ outboundId: r.body.outboundId, idempotentReplay: true });
    expect(await outbound.send(a.tenantId, r.body.outboundId)).toBe('sent');
    const sent = calls.filter((c) => c.method === 'POST').at(-1)!;
    expect(sent.path).toBe('/v26.0/100000000001/messages');
    expect(sent.body).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '51987654321', type: 'text', text: { preview_url: false, body: 'Sí, tenemos la talla 42 🙂' } });
    // Enviar de nuevo el mismo trabajo no repite el envío
    expect(await outbound.send(a.tenantId, r.body.outboundId)).toBe('skipped');
    const m = await owner.message.findFirstOrThrow({ where: { outboundId: r.body.outboundId } });
    expect(m).toMatchObject({ status: 'sent', providerMessageId: `wamid.OUT${wamidSeq}`, senderType: 'AGENT' });
  });

  it('estados de entrega: avanzan y nunca retroceden', async () => {
    const wamid = `wamid.OUT${wamidSeq}`;
    await post(keyA, statusEvent('100000000001', wamid, 'delivered'), APP_SECRET_A).expect(200);
    await post(keyA, statusEvent('100000000001', wamid, 'read'), APP_SECRET_A).expect(200);
    await post(keyA, statusEvent('100000000001', wamid, 'sent'), APP_SECRET_A).expect(200); // llega tarde
    await processPending();
    expect((await owner.message.findFirstOrThrow({ where: { providerMessageId: wamid } })).status).toBe('read');
  });

  it('cliente solo con BSUID: el envío usa "recipient" en lugar de "to"', async () => {
    await post(keyA, textMessage({ phoneNumberId: '100000000001', wamid: 'wamid.IN4', userId: 'PE.777', text: 'hola' }), APP_SECRET_A).expect(200);
    await processPending();
    const c = await owner.customer.findFirstOrThrow({ where: { waUserId: 'PE.777' } });
    const conv = await owner.conversation.findFirstOrThrow({ where: { customerId: c.id } });
    const r = await outbound.enqueueText({ tenantId: a.tenantId, conversationId: conv.id, text: 'Hola', sender: { type: 'BOT' }, idempotencyKey: 'bot-bsuid-1' });
    await outbound.send(a.tenantId, r.outbound.id);
    const body = calls.filter((x) => x.method === 'POST').at(-1)!.body!;
    expect(body.recipient).toBe('PE.777');
    expect(body).not.toHaveProperty('to');
  });

  it('errores: temporal se reintenta, definitivo marca fallo, token caducado avisa', async () => {
    const send = async (key: string) => (await outbound.enqueueText({ tenantId: a.tenantId, conversationId: convId, text: 'x', sender: { type: 'BOT' }, idempotencyKey: key })).outbound.id;

    nextSendError = { status: 400, code: 130429, message: 'Rate limit hit' };
    const t1 = await send('err-temporal');
    await expect(outbound.send(a.tenantId, t1)).rejects.toMatchObject({ retryable: true });
    expect(await owner.outboundMessage.findUniqueOrThrow({ where: { id: t1 } })).toMatchObject({ status: 'QUEUED', errorCode: 130429, attempts: 1 });
    expect(await outbound.send(a.tenantId, t1)).toBe('sent'); // el reintento funciona

    nextSendError = { status: 400, code: 131026, message: 'Message undeliverable' };
    const t2 = await send('err-definitivo');
    await expect(outbound.send(a.tenantId, t2)).rejects.toThrow('Message undeliverable');
    expect(await owner.message.findFirstOrThrow({ where: { outboundId: t2 } })).toMatchObject({ status: 'failed', errorCode: 131026 });

    nextSendError = { status: 401, code: 190, message: 'Error validating access token' };
    const t3 = await send('err-token');
    await expect(outbound.send(a.tenantId, t3)).rejects.toThrow();
    expect(await owner.whatsappNumber.findUniqueOrThrow({ where: { id: numberA.id } })).toMatchObject({ status: 'ERROR' });
    expect(await owner.notification.count({ where: { tenantId: a.tenantId, type: 'whatsapp.token_expired' } })).toBe(1);
  });

  it('fuera de la ventana de 24 h no se envía texto libre', async () => {
    const old = Math.floor(Date.now() / 1000) - 3 * 86_400;
    await post(keyA, textMessage({ phoneNumberId: '100000000001', wamid: 'wamid.OLD', from: '51922222222', text: 'antiguo', ts: old }), APP_SECRET_A).expect(200);
    await processPending();
    const c = await owner.customer.findFirstOrThrow({ where: { phone: '51922222222' } });
    const conv = await owner.conversation.findFirstOrThrow({ where: { customerId: c.id } });
    // La ventana se cuenta desde que recibimos el mensaje; simulamos que llegó hace 3 días
    await owner.message.updateMany({ where: { conversationId: conv.id }, data: { createdAt: new Date(old * 1000) } });
    const r = await ctx.http().post(`/api/v1/conversations/${conv.id}/messages`).set(HA()).send({ text: 'hola', idempotencyKey: 'late-0001' }).expect(400);
    expect(r.body.code).toBe('OUTSIDE_SERVICE_WINDOW');
  });

  it('un vendedor no puede gestionar números de WhatsApp', async () => {
    const inv = await ctx.http().post('/api/v1/users').set(HA()).send({ email: 'v@wa.test', name: 'Vendedor', role: 'SELLER' }).expect(201);
    expect(inv.body.status).toBe('INVITED');
    const mail = ctx.outbox.filter((m) => m.to === 'v@wa.test').at(-1)!;
    await ctx.http().post('/api/v1/auth/accept-invitation').send({ token: tokenFrom(mail.text), password: 'Vendedor1234' }).expect(204);
    const login = await ctx.http().post('/api/v1/auth/login').send({ email: 'v@wa.test', password: 'Vendedor1234' }).expect(200);
    const HV = { Authorization: `Bearer ${login.body.accessToken}` };
    const n = await owner.whatsappNumber.findFirstOrThrow({ where: { tenantId: a.tenantId } });
    await ctx.http().get('/api/v1/whatsapp/numbers').set(HV).expect(403);
    await ctx.http().get(`/api/v1/whatsapp/numbers/${n.id}/webhook`).set(HV).expect(403);
    await ctx.http().post('/api/v1/whatsapp/numbers').set(HV).send({}).expect(403);
    await ctx.http().patch(`/api/v1/whatsapp/numbers/${n.id}`).set(HV).send({ isActive: false }).expect(403);
    // Pero sí puede ver conversaciones de su empresa
    await ctx.http().get('/api/v1/conversations').set(HV).expect(200);
  });
});
