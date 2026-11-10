import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTestEnv, createTestApp, ownerClient, resetDatabase, registerAndLogin, tokenFrom } from './helpers.js';

setTestEnv();
const owner = ownerClient();

/**
 * FASE 5: Chatwoot. Aquí Chatwoot se sustituye por un servidor HTTP local que
 * imita las rutas y respuestas observadas en Chatwoot v4.19.1 (ver
 * docs/integrations/chatwoot.md). La prueba con el Chatwoot real del
 * docker-compose está en apps/api/scripts/chatwoot-live.mjs.
 */
describe('Chatwoot: cuenta por empresa, espejo de mensajes y respuestas de agentes', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let fake: Server;
  const calls: { method: string; path: string; auth?: string; body: Record<string, unknown> | null }[] = [];
  let failInbox = false;
  let seq = 100;
  const INBOX_SECRET = 'cw-inbox-secret-abcdefghijklmnop';
  let a: Awaited<ReturnType<typeof registerAndLogin>>;
  let b: Awaited<ReturnType<typeof registerAndLogin>>;
  const H = () => ({ Authorization: `Bearer ${a.accessToken}` });
  let sync: import('../src/chatwoot/chatwoot-sync.service.js').ChatwootSyncService;
  let keyA: string;
  let conversationId: string;
  let inboundMessageId: string;

  const readBody = (req: IncomingMessage) => new Promise<string>((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };

  let failRemove = false;
  beforeAll(async () => {
    fake = createServer(async (req, res) => {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : null;
      const path = req.url!;
      calls.push({ method: req.method!, path, auth: req.headers.authorization, body });
      if (path === '/platform/api/v1/accounts' && req.method === 'POST') return json(res, 200, { id: 7, name: body.name });
      if (path === '/platform/api/v1/users' && req.method === 'POST') return json(res, 200, { id: ++seq, email: body.email });
      if (/^\/platform\/api\/v1\/accounts\/7\/account_users$/.test(path)) return req.method === 'DELETE' && failRemove ? json(res, 500, { error: 'boom' }) : json(res, 200, { id: 1 });
      if (/^\/platform\/api\/v1\/users\/\d+\/token$/.test(path)) return json(res, 200, { access_token: 'cw-bot-token' });
      if (/^\/platform\/api\/v1\/users\/\d+\/login$/.test(path)) return json(res, 200, { url: 'http://localhost:3100/app/login?sso_auth_token=x' });
      if (path === '/api/v1/accounts/7/inboxes' && req.method === 'POST') return failInbox ? json(res, 500, { error: 'boom' }) : json(res, 200, { id: 3, inbox_identifier: 'idf' });
      if (path === '/api/v1/accounts/7/inboxes/3') return json(res, 200, { id: 3, secret: INBOX_SECRET, inbox_identifier: 'idf' });
      if (path === '/api/v1/accounts/7/inbox_members') return json(res, 200, {});
      if (path === '/api/v1/accounts/7/contacts') return json(res, 200, { payload: { contact: { id: 55 }, contact_inbox: { source_id: 'src-55' } } });
      if (path === '/api/v1/accounts/7/conversations' && req.method === 'POST') return json(res, 200, { id: 900 });
      if (path === '/api/v1/accounts/7/conversations/900/messages' && req.method === 'POST') return json(res, 200, { id: ++seq });
      if (/^\/api\/v1\/accounts\/7\/conversations\/900\/messages\/\d+$/.test(path) && req.method === 'PATCH') return json(res, 200, {});
      json(res, 404, { error: 'unknown' });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    process.env.CHATWOOT_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    process.env.CHATWOOT_PLATFORM_TOKEN = 'platform-token-test';
    process.env.CHATWOOT_WEBHOOK_BASE_URL = 'http://host.docker.internal:4000';

    await resetDatabase(owner);
    ctx = await createTestApp();
    const { ChatwootSyncService } = await import('../src/chatwoot/chatwoot-sync.service.js');
    sync = ctx.app.get(ChatwootSyncService);
    a = await registerAndLogin(ctx, { companyName: 'Bodega A', email: 'a@cw.test' });
    b = await registerAndLogin(ctx, { companyName: 'Bodega B', email: 'b@cw.test' });

    // Conversación de WhatsApp de la empresa A con un mensaje reciente del cliente
    const n = await owner.whatsappNumber.create({ data: { tenantId: a.tenantId, provider: 'CLOUD_API', displayPhone: '51900000001', phoneNumberId: '1234567', webhookKey: 'wk-a-chatwoot-test', status: 'CONNECTED' } });
    const c = await owner.customer.create({ data: { tenantId: a.tenantId, phone: '51987000111', waProfileName: 'Carla', source: 'whatsapp' } });
    const conv = await owner.conversation.create({ data: { tenantId: a.tenantId, customerId: c.id, whatsappNumberId: n.id, lastMessageAt: new Date() } });
    conversationId = conv.id;
    inboundMessageId = (await owner.message.create({ data: { tenantId: a.tenantId, conversationId: conv.id, direction: 'INBOUND', senderType: 'CUSTOMER', type: 'text', content: 'Hola <b>¿tienen gaseosa?</b>', status: 'received' } })).id;
  });

  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
    fake.close();
  });

  const sign = (body: string, ts = Math.floor(Date.now() / 1000)) => ({
    'Content-Type': 'application/json',
    'X-Chatwoot-Timestamp': String(ts),
    'X-Chatwoot-Signature': `sha256=${createHmac('sha256', INBOX_SECRET).update(`${ts}.${body}`).digest('hex')}`,
  });
  const post = (key: string, payload: unknown, headers?: Record<string, string>) => {
    const body = JSON.stringify(payload);
    return ctx.http().post(`/api/v1/webhooks/chatwoot/${key}`).set(headers ?? sign(body)).send(body);
  };
  const agentReply = (id: number, extra: Record<string, unknown> = {}) => ({
    event: 'message_created', id, message_type: 'outgoing', private: false, content: 'Sí, a S/ 3.50', sender: { id: 501, type: 'user' }, conversation: { id: 900 }, ...extra,
  });

  it('un vendedor no puede activar la integración', async () => {
    await ctx.http().post('/api/v1/users').set(H()).send({ email: 'v@cw.test', name: 'Vendedor', role: 'SELLER' }).expect(201);
    const mail = ctx.outbox.filter((m) => m.to === 'v@cw.test').at(-1)!;
    await ctx.http().post('/api/v1/auth/accept-invitation').send({ token: tokenFrom(mail.text), password: 'Vendedor1234' }).expect(204);
    const login = await ctx.http().post('/api/v1/auth/login').send({ email: 'v@cw.test', password: 'Vendedor1234' }).expect(200);
    await ctx.http().post('/api/v1/integrations/chatwoot/connect').set({ Authorization: `Bearer ${login.body.accessToken}` }).expect(403);
  });

  it('si Chatwoot falla a mitad queda en ERROR y el reintento continúa sin crear otra cuenta', async () => {
    failInbox = true;
    const r = await ctx.http().post('/api/v1/integrations/chatwoot/connect').set(H()).expect(503);
    expect(r.body.code).toBe('CHATWOOT_ERROR');
    const i = await owner.tenantIntegration.findFirstOrThrow({ where: { tenantId: a.tenantId, type: 'CHATWOOT' } });
    expect(i.status).toBe('ERROR');
    expect(i.config).toMatchObject({ accountId: 7 });

    failInbox = false;
    const ok = await ctx.http().post('/api/v1/integrations/chatwoot/connect').set(H()).expect(201);
    expect(ok.body).toMatchObject({ status: 'CONNECTED', accountId: 7, inboxId: 3 });
    expect(calls.filter((c) => c.path === '/platform/api/v1/accounts')).toHaveLength(1);
    // Webhook del buzón con la clave propia de la empresa
    const inboxCall = calls.filter((c) => c.path === '/api/v1/accounts/7/inboxes' && c.method === 'POST').at(-1)!;
    const fresh = await owner.tenantIntegration.findFirstOrThrow({ where: { tenantId: a.tenantId, type: 'CHATWOOT' } });
    keyA = fresh.webhookKey!;
    expect((inboxCall.body!.channel as { webhook_url: string }).webhook_url).toBe(`http://host.docker.internal:4000/api/v1/webhooks/chatwoot/${keyA}`);
    // Secretos cifrados: ni el token ni el secreto aparecen en claro
    expect(fresh.secretsEnc).not.toContain('cw-bot-token');
    expect(fresh.secretsEnc).not.toContain(INBOX_SECRET);
    // Volver a conectar no repite nada
    const before = calls.length;
    await ctx.http().post('/api/v1/integrations/chatwoot/connect').set(H()).expect(201);
    expect(calls.length).toBe(before);
  });

  it('copia el mensaje del cliente: contacto, conversación y mensaje entrante (una sola vez)', async () => {
    expect(await sync.run('mirror', a.tenantId, inboundMessageId)).toMatch(/^mirrored/);
    const contact = calls.find((c) => c.path === '/api/v1/accounts/7/contacts')!;
    expect(contact.auth).toBe('Bearer cw-bot-token');
    expect(contact.body).toMatchObject({ inbox_id: 3, name: 'Carla', phone_number: '+51987000111' });
    const conv = calls.find((c) => c.path === '/api/v1/accounts/7/conversations')!;
    expect(conv.body).toMatchObject({ source_id: 'src-55', inbox_id: 3, contact_id: 55 });
    const msg = calls.filter((c) => c.path === '/api/v1/accounts/7/conversations/900/messages').at(-1)!;
    expect(msg.body).toEqual({ content: 'Hola <b>¿tienen gaseosa?</b>', message_type: 'incoming', private: false });
    expect((await owner.conversation.findUniqueOrThrow({ where: { id: conversationId } })).chatwootConversationId).toBe(900);
    expect(await sync.run('mirror', a.tenantId, inboundMessageId)).toMatch(/^skipped/);
  });

  it('respuesta de un agente en Chatwoot: se encola por WhatsApp, el bot se pausa y un aviso repetido no duplica', async () => {
    await post(keyA, agentReply(7001)).expect(200);
    await post(keyA, agentReply(7001)).expect(200);
    const outs = await owner.outboundMessage.findMany({ where: { tenantId: a.tenantId, idempotencyKey: 'chatwoot:7001' } });
    expect(outs).toHaveLength(1);
    const m = await owner.message.findFirstOrThrow({ where: { outboundId: outs[0]!.id } });
    expect(m).toMatchObject({ direction: 'OUTBOUND', senderType: 'AGENT', content: 'Sí, a S/ 3.50', chatwootMessageId: 7001, status: 'queued' });
    const conv = await owner.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conv.botStatus).toBe('PAUSED');
    expect(conv.handoffReason).toBe('agent_reply');
    // No se vuelve a copiar a Chatwoot (ya existe allí)
    expect(await sync.run('mirror', a.tenantId, m.id)).toMatch(/^skipped/);
  });

  it('se ignoran notas privadas, mensajes entrantes y los del usuario de integración', async () => {
    const before = await owner.outboundMessage.count();
    await post(keyA, agentReply(7002, { private: true })).expect(200);
    await post(keyA, agentReply(7003, { message_type: 'incoming', sender: { id: 55, type: 'contact' } })).expect(200);
    const i = await owner.tenantIntegration.findFirstOrThrow({ where: { tenantId: a.tenantId, type: 'CHATWOOT' } });
    const botUserId = (i.config as { botUserId: number }).botUserId;
    await post(keyA, agentReply(7004, { sender: { id: botUserId, type: 'user' } })).expect(200);
    expect(await owner.outboundMessage.count()).toBe(before);
  });

  it('firma inválida, marca de tiempo vieja o clave desconocida se rechazan', async () => {
    const body = JSON.stringify(agentReply(7005));
    await post(keyA, agentReply(7005), { ...sign(body), 'X-Chatwoot-Signature': 'sha256=' + 'a'.repeat(64) }).expect(401);
    await post(keyA, agentReply(7005), sign(body, Math.floor(Date.now() / 1000) - 3600)).expect(401);
    await post('clave-que-no-existe-123456', agentReply(7005)).expect(404);
    expect(await owner.outboundMessage.count({ where: { idempotencyKey: 'chatwoot:7005' } })).toBe(0);
  });

  it('fuera de la ventana de 24 h el mensaje del agente se marca como fallido en Chatwoot', async () => {
    await owner.message.updateMany({ where: { conversationId, direction: 'INBOUND' }, data: { createdAt: new Date(Date.now() - 3 * 86_400_000) } });
    await post(keyA, agentReply(7006)).expect(200);
    const patch = calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/messages/7006')).at(-1)!;
    expect(patch.body).toMatchObject({ status: 'failed' });
    expect(String(patch.body!.external_error)).toMatch(/24 horas/);
    await owner.message.updateMany({ where: { conversationId, direction: 'INBOUND' }, data: { createdAt: new Date() } });
  });

  it('el estado de entrega de WhatsApp se copia al mensaje de Chatwoot', async () => {
    const m = await owner.message.findFirstOrThrow({ where: { chatwootMessageId: 7001 } });
    await owner.message.update({ where: { id: m.id }, data: { status: 'read' } });
    expect(await sync.run('status', a.tenantId, m.id)).toBe('status: read');
    expect(calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/messages/7001')).at(-1)!.body).toEqual({ status: 'read' });
  });

  it('resolver la conversación en Chatwoot devuelve la atención al bot', async () => {
    await post(keyA, { event: 'conversation_status_changed', id: 900, status: 'resolved', meta: { assignee: { id: 501 } } }).expect(200);
    const conv = await owner.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conv).toMatchObject({ status: 'RESOLVED', botStatus: 'ACTIVE' });
    await post(keyA, { event: 'conversation_updated', id: 900, status: 'open', meta: { assignee: { id: 501 } } }).expect(200);
    expect((await owner.conversation.findUniqueOrThrow({ where: { id: conversationId } })).botStatus).toBe('PAUSED');
  });

  it('otra empresa no puede actuar sobre conversaciones ajenas con su propia clave', async () => {
    await owner.tenantIntegration.create({
      data: { tenantId: b.tenantId, type: 'CHATWOOT', status: 'CONNECTED', webhookKey: 'clave-empresa-b-0123456789', config: { accountId: 8, botUserId: 1, inboxId: 4 },
        secretsEnc: (await owner.tenantIntegration.findFirstOrThrow({ where: { tenantId: a.tenantId, type: 'CHATWOOT' } })).secretsEnc },
    });
    const r = await post('clave-empresa-b-0123456789', agentReply(7007)).expect(200);
    expect(r.body.result).toMatch(/desconocida/);
    expect(await owner.outboundMessage.count({ where: { idempotencyKey: 'chatwoot:7007' } })).toBe(0);
  });

  it('inicio de sesión único: crea el agente la primera vez y luego lo reutiliza', async () => {
    const r = await ctx.http().post('/api/v1/integrations/chatwoot/sso').set(H()).expect(201);
    expect(r.body.url).toMatch(/sso_auth_token/);
    const u = await owner.user.findUniqueOrThrow({ where: { id: a.userId } });
    expect(u.chatwootUserId).toBeGreaterThan(0);
    const role = calls.filter((c) => c.path === '/platform/api/v1/accounts/7/account_users').at(-1)!;
    expect(role.body).toEqual({ user_id: u.chatwootUserId, role: 'administrator' });
    expect(calls.filter((c) => c.path === '/api/v1/accounts/7/inbox_members').at(-1)!.body).toEqual({ inbox_id: 3, user_ids: [u.chatwootUserId] });
    const users = calls.filter((c) => c.path === '/platform/api/v1/users').length;
    await ctx.http().post('/api/v1/integrations/chatwoot/sso').set(H()).expect(201);
    expect(calls.filter((c) => c.path === '/platform/api/v1/users').length).toBe(users);
  });

  it('desactivar a un usuario le quita el acceso a Chatwoot; si Chatwoot falla se avisa y se puede repetir', async () => {
    const seller = await owner.user.create({ data: { tenantId: a.tenantId, email: 'vendedor@cw.test', name: 'Vendedor', role: 'SELLER', status: 'ACTIVE', chatwootUserId: 4242 } });
    const removals = () => calls.filter((c) => c.method === 'DELETE' && c.path === '/platform/api/v1/accounts/7/account_users');
    failRemove = true;
    const r = await ctx.http().patch(`/api/v1/users/${seller.id}`).set(H()).send({ status: 'DISABLED' }).expect(503);
    expect(r.body.message).toMatch(/no se pudo retirar el acceso a Chatwoot/);
    expect((await owner.user.findUniqueOrThrow({ where: { id: seller.id } })).chatwootUserId).toBe(4242);
    failRemove = false;
    await ctx.http().patch(`/api/v1/users/${seller.id}`).set(H()).send({ status: 'DISABLED' }).expect(200);
    expect(removals().at(-1)!.body).toEqual({ user_id: 4242 });
    expect((await owner.user.findUniqueOrThrow({ where: { id: seller.id } })).chatwootUserId).toBeNull();
    // Un cambio que no afecta al acceso no llama a Chatwoot
    const before = removals().length;
    await ctx.http().patch(`/api/v1/users/${seller.id}`).set(H()).send({ name: 'Vendedor 2' }).expect(200);
    expect(removals().length).toBe(before);
  });
});
