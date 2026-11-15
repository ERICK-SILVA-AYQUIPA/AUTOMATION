import argon2 from 'argon2';
import { setTestEnv, createTestApp, ownerClient, roleClient, resetDatabase, registerAndLogin } from './helpers.js';
import { startFakeAiProviders } from './fake-ai-providers.js';

setTestEnv();
const owner = ownerClient();

const PAGE = {
  published: true,
  headline: 'Vende por WhatsApp con tu catálogo real',
  subheadline: 'Atiende, cotiza y registra pedidos sin perder mensajes.',
  problems: [{ title: 'Mensajes sin responder', text: 'Los clientes escriben fuera de horario.' }],
  benefits: [{ title: 'Respuestas con stock real', text: 'El asistente consulta tu inventario.' }],
  faqs: [{ q: '¿Necesito la API oficial de WhatsApp?', a: 'Sí, se usa la API oficial de Meta.' }],
  testimonials: [],
  contactEmail: 'ventas@plataforma.test',
  contactWhatsapp: '+51 900 000 001',
  showPrices: false,
  chatEnabled: true,
  agentName: 'Sofía',
  agentInstructions: null,
};

/**
 * Fase B (ADR 048): página comercial pública y agente comercial, contra un
 * servidor local que responde como Anthropic (fake-ai-providers).
 */
describe('Página comercial y agente comercial', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let fake: Awaited<ReturnType<typeof startFakeAiProviders>>;
  let house: Awaited<ReturnType<typeof registerAndLogin>>;
  let other: Awaited<ReturnType<typeof registerAndLogin>>;
  let root: string;
  const R = () => ({ Authorization: `Bearer ${root}` });
  const save = (body: Record<string, unknown>) => ctx.http().put('/api/v1/platform/commercial').set(R()).send({ ...PAGE, houseTenantId: house.tenantId, ...body });

  beforeAll(async () => {
    fake = await startFakeAiProviders();
    process.env.ANTHROPIC_BASE_URL = fake.urls.anthropic;
    process.env.GEMINI_API_KEY = '';
    await resetDatabase(owner);
    ctx = await createTestApp();
    house = await registerAndLogin(ctx, { companyName: 'AI Sales (interna)', email: 'admin@casa.test' });
    other = await registerAndLogin(ctx, { companyName: 'Cliente cualquiera', email: 'admin@otro.test' });
    await owner.user.create({ data: { email: 'root@comercial.test', name: 'Root', role: 'PLATFORM_ADMIN', emailVerifiedAt: new Date(), passwordHash: await argon2.hash('RootClave123') } });
    root = (await ctx.http().post('/api/v1/auth/login').send({ email: 'root@comercial.test', password: 'RootClave123' }).expect(200)).body.accessToken;
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
    await fake.close();
  });

  it('sin publicar no hay página, ni formulario, ni chat', async () => {
    expect((await ctx.http().get('/api/v1/public/commercial').expect(404)).body.code).toBe('NOT_PUBLISHED');
    await ctx.http().post('/api/v1/public/leads').send({ name: 'Ana', email: 'ana@x.test', need: 'Quiero vender', intent: 'DEMO', acceptPrivacy: true, followUpConsent: false }).expect(404);
    await ctx.http().post('/api/v1/public/chat').expect(404);
    // Solo el personal de la plataforma configura la página
    await ctx.http().get('/api/v1/platform/commercial').set({ Authorization: `Bearer ${other.accessToken}` }).expect(403);
  });

  it('publicar exige titular; testimonios solo con fecha de autorización; se audita', async () => {
    const noHead = await save({ headline: '' }).expect(400);
    expect(JSON.stringify(noHead.body)).toMatch(/titular/);
    await save({ testimonials: [{ name: 'Rosa', quote: 'Muy útil' }] }).expect(400);
    const ok = await save({ testimonials: [{ name: 'Rosa Pérez', company: 'Bodega Rosa', quote: 'Respondemos de noche sin estar conectados.', authorizedAt: '2026-11-01' }] }).expect(200);
    expect(ok.body).toMatchObject({ published: true, headline: PAGE.headline, contactWhatsapp: '+51900000001', houseTenantId: house.tenantId });
    expect(ok.body.publishedAt).toBeTruthy();
    // Sin IA asignada al servicio comercial el agente no está disponible y lo dice
    expect(ok.body.agent).toMatchObject({ available: false, reason: expect.stringMatching(/servicio comercial/) });
    const audit = await owner.auditLog.findFirstOrThrow({ where: { action: 'commercial.settings_updated' }, orderBy: { createdAt: 'desc' } });
    expect(audit.metadata).toMatchObject({ published: true });
    // La base tampoco acepta publicar sin titular
    await expect(owner.$executeRaw`UPDATE commercial_settings SET headline = NULL`).rejects.toThrow(/commercial_settings_publish_check/);
    // El rol de ejecución de las empresas no ve esta tabla
    const runtime = roleClient('runtime');
    await expect(runtime.$queryRaw`SELECT * FROM commercial_settings`).rejects.toThrow(/permission denied/);
    await expect(runtime.$queryRaw`SELECT * FROM sales_chat_messages`).rejects.toThrow(/permission denied/);
    await runtime.$disconnect();
  });

  it('la página pública muestra datos reales: módulos, sectores, planes sin precio salvo que se publique', async () => {
    const r = await ctx.http().get('/api/v1/public/commercial').expect(200);
    expect(r.body.headline).toBe(PAGE.headline);
    expect(r.body.modules.map((m: { key: string }) => m.key)).toContain('conversations');
    expect(r.body.sectors.length).toBeGreaterThan(0);
    expect(r.body.plans.map((p: { code: string }) => p.code)).toEqual(['BASIC', 'PROFESSIONAL', 'ENTERPRISE']);
    expect(r.body.plans.every((p: { price: unknown }) => p.price === null)).toBe(true);
    expect(r.body.testimonials).toEqual([{ name: 'Rosa Pérez', company: 'Bodega Rosa', quote: 'Respondemos de noche sin estar conectados.' }]);
    expect(r.body.chat).toEqual({ available: false, agentName: 'Sofía' });
    // Nada interno sale a la página pública
    expect(JSON.stringify(r.body)).not.toMatch(new RegExp(`${house.tenantId}|agentInstructions|houseTenant`));
    await save({ showPrices: true }).expect(200);
    const p = await ctx.http().get('/api/v1/public/commercial').expect(200);
    expect(p.body.plans[0]).toMatchObject({ code: 'BASIC', price: { monthly: '29.00', currency: expect.any(String) } });
    await save({ showPrices: false }).expect(200);
  });

  it('formulario: valida, ignora bots, registra prospecto sin responsable con consentimiento y solicitud', async () => {
    const send = (b: Record<string, unknown>) => ctx.http().post('/api/v1/public/leads').send({ name: 'Carla Ruiz', company: 'Minimarket Carla', phone: '+51 987 111 222', need: 'Quiero atender pedidos por WhatsApp', sector: 'RETAIL', intent: 'DEMO', preferredTime: 'tardes', acceptPrivacy: true, followUpConsent: true, ...b });
    await send({ acceptPrivacy: false }).expect(400);
    await send({ phone: '', email: '' }).expect(400);
    await send({ website: 'http://spam.test' }).expect(200);
    expect(await owner.salesLead.count()).toBe(0);
    await send({}).expect(200);
    const lead = await owner.salesLead.findFirstOrThrow({ include: { activities: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
    expect(lead).toMatchObject({ name: 'Carla Ruiz', phone: '+51987111222', source: 'WEBSITE', status: 'DEMO_REQUESTED', ownerId: null, followUpConsent: true, followUpConsentSource: 'web' });
    expect(lead.nextAction).toMatch(/Confirmar demostración \(prefiere: tardes\)/);
    expect(lead.activities.map((a) => a.type)).toEqual(['CREATED', 'NEXT_ACTION_SET', 'NOTE', 'NEXT_ACTION_SET', 'STATUS_CHANGED']);
    // Mismo teléfono: completa y anota, no duplica ni pisa datos
    await send({ name: 'Otra persona', company: 'Otro nombre', intent: 'PROPOSAL', followUpConsent: false }).expect(200);
    const again = await owner.salesLead.findMany();
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ name: 'Carla Ruiz', company: 'Minimarket Carla', nextAction: 'Preparar y enviar propuesta', status: 'DEMO_REQUESTED', followUpConsent: true });
  });

  it('chat web: no inicia sin IA; con IA asignada registra al prospecto, la demo y la derivación', async () => {
    expect((await ctx.http().post('/api/v1/public/chat').expect(503)).body.code).toBe('AGENT_UNAVAILABLE');
    const cred = await ctx.http().post('/api/v1/platform/api-center/credentials').set(R()).send({ provider: 'anthropic', label: 'Claude comercial', fields: { apiKey: 'sk-ant-comercial-000000000000001' } }).expect(201);
    await ctx.http().post(`/api/v1/platform/api-center/credentials/${cred.body.id}/models/refresh`).set(R()).expect(200);
    await ctx.http().put(`/api/v1/platform/api-center/tenants/${house.tenantId}/ai/COMMERCIAL`).set(R()).send({ credentialId: cred.body.id, model: 'claude-prueba-chica' }).expect(200);
    expect((await ctx.http().get('/api/v1/platform/commercial').set(R()).expect(200)).body.agent).toMatchObject({ available: true });
    expect((await ctx.http().get('/api/v1/public/commercial').expect(200)).body.chat.available).toBe(true);

    const s = (await ctx.http().post('/api/v1/public/chat').expect(201)).body;
    expect(s).toMatchObject({ id: expect.any(String), token: expect.any(String), agentName: 'Sofía' });
    const say = (text: string, token = s.token) => ctx.http().post(`/api/v1/public/chat/${s.id}/messages`).send({ token, text });
    // Token ajeno: rechazado
    expect((await say('hola', 'x'.repeat(43)).expect(401)).body.code).toBe('CHAT_SESSION');

    const plans = await say('¿qué planes tienen?').expect(200);
    expect(plans.body.reply).toMatch(/Profesional/);
    expect(plans.body.reply).not.toMatch(/79/); // precio no publicado
    // Sin datos de contacto el agente no puede registrar la demo
    expect((await say('quiero una demo').expect(200)).body.reply).toMatch(/Primero registra/);
    const reg = await say('me llamo Diego Soto, diego@tienda.test, acepto que me contacten').expect(200);
    expect(reg.body).toMatchObject({ registered: true });
    await say('quiero una demo').expect(200);
    const hand = await say('quiero hablar con un vendedor').expect(200);
    expect(hand.body.handoff).toBe(true);

    const lead = await owner.salesLead.findFirstOrThrow({ where: { email: 'diego@tienda.test' }, include: { activities: true } });
    expect(lead).toMatchObject({ name: 'Diego Soto', source: 'WEBSITE', status: 'DEMO_REQUESTED', followUpConsent: true, ownerId: null });
    expect(lead.nextAction).toMatch(/^Atender: quiere contratar/);
    const session = await owner.salesChatSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(session).toMatchObject({ leadId: lead.id, messageCount: 5, handoffReason: 'quiere contratar' });
    // El token no se guarda en claro
    expect(session.tokenHash).not.toBe(s.token);
    expect(session.tokenHash).toHaveLength(64);
    // El consumo se registra en la empresa interna, servicio COMMERCIAL
    expect(await owner.aiUsageEvent.count({ where: { tenantId: house.tenantId, service: 'COMMERCIAL' } })).toBeGreaterThan(0);
    // El equipo ve la conversación en la ficha del prospecto
    const chats = await ctx.http().get(`/api/v1/platform/commercial/leads/${lead.id}/chats`).set(R()).expect(200);
    expect(chats.body[0].messages.length).toBe(10);
    expect(chats.body[0].messages[0]).toMatchObject({ role: 'VISITOR', text: '¿qué planes tienen?' });
  });

  it('prueba desde el panel: no registra nada', async () => {
    const before = await owner.salesLead.count();
    const r = await ctx.http().post('/api/v1/platform/commercial/agent/test').set(R()).send({ messages: [{ role: 'customer', text: 'me llamo Prueba Panel, prueba@panel.test, acepto' }] }).expect(200);
    expect(r.body.reply).toMatch(/Modo prueba/);
    expect(await owner.salesLead.count()).toBe(before);
  });

  it('límite de mensajes por conversación', async () => {
    const s = (await ctx.http().post('/api/v1/public/chat').expect(201)).body;
    await owner.salesChatSession.update({ where: { id: s.id }, data: { messageCount: 30 } });
    const r = await ctx.http().post(`/api/v1/public/chat/${s.id}/messages`).send({ token: s.token, text: 'hola' }).expect(409);
    expect(r.body.code).toBe('CHAT_LIMIT');
  });

  it('WhatsApp de la empresa interna: responde el agente comercial y registra al prospecto con su número', async () => {
    const { AssistantService } = await import('../src/ai/assistant.service.js');
    const assistant = ctx.app.get(AssistantService);
    const numberId = (await owner.whatsappNumber.create({ data: { tenantId: house.tenantId, provider: 'CLOUD_API', displayPhone: '51900000001', phoneNumberId: '55443322', webhookKey: 'wk-casa', status: 'CONNECTED' } })).id;
    const customerId = (await owner.customer.create({ data: { tenantId: house.tenantId, phone: '51955444333', waProfileName: 'Marco', source: 'whatsapp' } })).id;
    const conv = (await owner.conversation.create({ data: { tenantId: house.tenantId, customerId, whatsappNumberId: numberId, lastMessageAt: new Date() } })).id;
    const msg = async (text: string) => (await owner.message.create({ data: { tenantId: house.tenantId, conversationId: conv, direction: 'INBOUND', senderType: 'CUSTOMER', type: 'text', content: text, status: 'received' } })).id;

    const m1 = await msg('me llamo Marco Díaz, empresa Ferretería Marco. acepto');
    expect(await assistant.reply(house.tenantId, conv, m1)).toMatchObject({ outcome: 'sent', tools: ['registrar_prospecto'] });
    const lead = await owner.salesLead.findFirstOrThrow({ where: { phone: '+51955444333' } });
    expect(lead).toMatchObject({ name: 'Marco Díaz', company: 'Ferretería Marco', source: 'WHATSAPP', followUpConsent: true, followUpConsentSource: 'whatsapp' });

    // Pedir un vendedor pasa la conversación a la bandeja (atención humana) y queda como próxima acción
    const m2 = await msg('quiero hablar con un vendedor');
    expect(await assistant.reply(house.tenantId, conv, m2)).toMatchObject({ outcome: 'handoff', reason: 'quiere contratar' });
    expect(await owner.conversation.findUniqueOrThrow({ where: { id: conv } })).toMatchObject({ botStatus: 'PAUSED' });
    expect((await owner.salesLead.findUniqueOrThrow({ where: { id: lead.id } })).nextAction).toMatch(/^Atender/);

    // Las demás empresas siguen con su asistente: sin asignación ASSISTANT, no responde (no usa la IA comercial)
    const oc = (await owner.customer.create({ data: { tenantId: other.tenantId, phone: '51955000111', source: 'whatsapp' } })).id;
    const on = (await owner.whatsappNumber.create({ data: { tenantId: other.tenantId, provider: 'CLOUD_API', displayPhone: '51900000002', phoneNumberId: '55443323', webhookKey: 'wk-otro', status: 'CONNECTED' } })).id;
    const oconv = (await owner.conversation.create({ data: { tenantId: other.tenantId, customerId: oc, whatsappNumberId: on, lastMessageAt: new Date() } })).id;
    const om = (await owner.message.create({ data: { tenantId: other.tenantId, conversationId: oconv, direction: 'INBOUND', senderType: 'CUSTOMER', type: 'text', content: 'me llamo Intruso, acepto', status: 'received' } })).id;
    expect(await assistant.reply(other.tenantId, oconv, om)).toMatchObject({ outcome: 'skipped' });
    expect(await owner.salesLead.count({ where: { name: 'Intruso' } })).toBe(0);
  });
});
