import argon2 from 'argon2';
import { RenewalsService } from '../src/support/renewals.service.js';
import { createTestApp, ownerClient, registerAndLogin, resetDatabase, roleClient, setTestEnv } from './helpers.js';

setTestEnv();
const owner = ownerClient();

/** Postventa (ADR 054): centro de soporte, encuesta de satisfacción y avisos de vencimiento */
describe('Postventa y soporte', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let root: string;
  let rootId: string;
  let a: Awaited<ReturnType<typeof registerAndLogin>>;
  let b: Awaited<ReturnType<typeof registerAndLogin>>;
  let ticketId: string;
  const R = () => ({ Authorization: `Bearer ${root}` });
  const A = () => ({ Authorization: `Bearer ${a.accessToken}` });
  const B = () => ({ Authorization: `Bearer ${b.accessToken}` });

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
    rootId = (await owner.user.create({ data: { email: 'root@soporte.test', name: 'Equipo Soporte', role: 'PLATFORM_ADMIN', emailVerifiedAt: new Date(), passwordHash: await argon2.hash('RootClave123') } })).id;
    root = (await ctx.http().post('/api/v1/auth/login').send({ email: 'root@soporte.test', password: 'RootClave123' }).expect(200)).body.accessToken;
    a = await registerAndLogin(ctx, { companyName: 'Bodega Ana', email: 'ana@soporte.test' });
    b = await registerAndLogin(ctx, { companyName: 'Ferretería Beto', email: 'beto@soporte.test' });
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
  });

  it('la empresa abre un caso; el equipo recibe el aviso y otra empresa no lo ve', async () => {
    expect((await ctx.http().get('/api/v1/support/info').set(A()).expect(200)).body).toMatchObject({ tickets: true, firstResponseHours: { URGENT: 2 } });
    await ctx.http().post('/api/v1/support/tickets').set(A()).send({ kind: 'INCIDENT', subject: 'x', body: 'y' }).expect(400);
    const t = await ctx.http().post('/api/v1/support/tickets').set(A()).send({ kind: 'INCIDENT', priority: 'HIGH', subject: 'El asistente no responde', body: 'Desde las 9 a. m. los clientes no reciben respuesta.' }).expect(201);
    ticketId = t.body.id;
    expect(t.body).toMatchObject({ status: 'OPEN', source: 'TENANT', number: expect.any(Number), messages: [{ authorKind: 'CLIENT', body: expect.stringContaining('9 a. m.') }] });
    expect(ctx.outbox.some((m) => m.to === 'root@soporte.test' && m.subject.startsWith('Nuevo caso SOP-') && m.text.includes(`/plataforma/soporte/${ticketId}`))).toBe(true);
    await ctx.http().get(`/api/v1/support/tickets/${ticketId}`).set(B()).expect(404);
    expect((await ctx.http().get('/api/v1/support/tickets').set(B()).expect(200)).body).toEqual([]);
    await ctx.http().post(`/api/v1/support/tickets/${ticketId}/messages`).set(B()).send({ body: 'intruso' }).expect(404);
    await ctx.http().get('/api/v1/platform/support/tickets').set(A()).expect(403);
  });

  it('el equipo responde, deja notas internas que la empresa nunca ve y mide la primera respuesta', async () => {
    const list = (await ctx.http().get('/api/v1/platform/support/tickets').query({ status: 'active' }).set(R()).expect(200)).body;
    expect(list).toEqual([expect.objectContaining({ id: ticketId, tenant: expect.objectContaining({ name: 'Bodega Ana' }), due: expect.objectContaining({ overdue: false }) })]);
    await ctx.http().post(`/api/v1/platform/support/tickets/${ticketId}/messages`).set(R()).send({ body: 'Revisar la clave de Gemini del cliente', internal: true }).expect(200);
    let t = (await ctx.http().get(`/api/v1/platform/support/tickets/${ticketId}`).set(R()).expect(200)).body;
    expect(t.firstResponseAt).toBeNull(); // una nota interna no es respuesta
    t = (await ctx.http().post(`/api/v1/platform/support/tickets/${ticketId}/messages`).set(R()).send({ body: '¿Nos confirmas si cambiaste la clave de IA ayer?' }).expect(200)).body;
    expect(t).toMatchObject({ status: 'IN_PROGRESS', firstResponseAt: expect.any(String), assignee: { id: rootId } });
    expect(ctx.outbox.some((m) => m.to === 'ana@soporte.test' && m.subject.startsWith('Respuesta a tu caso SOP-'))).toBe(true);
    const own = (await ctx.http().get(`/api/v1/support/tickets/${ticketId}`).set(A()).expect(200)).body;
    expect(own.messages.map((m: { body: string }) => m.body)).not.toContain('Revisar la clave de Gemini del cliente');
    expect(JSON.stringify(own)).not.toContain('internal');
    // También en la base: con el rol de ejecución, la empresa no lee notas internas ni casos ajenos
    const runtime = roleClient('runtime');
    const [mine, theirs] = await runtime.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${a.tenantId}, true)`;
      const m = await tx.supportMessage.findMany({ where: { ticketId } });
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${b.tenantId}, true)`;
      return [m, await tx.supportTicket.findMany()];
    });
    expect(mine.every((m) => !m.internal)).toBe(true);
    expect(mine).toHaveLength(2);
    expect(theirs).toHaveLength(0);
    await expect(runtime.subscriptionNotice.findMany()).rejects.toThrow();
    await runtime.$disconnect();
  });

  it('esperando al cliente, su respuesta lo reabre; resuelto, la encuesta lo cierra una sola vez', async () => {
    await ctx.http().patch(`/api/v1/platform/support/tickets/${ticketId}`).set(R()).send({ status: 'WAITING_CLIENT' }).expect(200);
    await ctx.http().post(`/api/v1/support/tickets/${ticketId}/rating`).set(A()).send({ rating: 5 }).expect(409);
    const re = (await ctx.http().post(`/api/v1/support/tickets/${ticketId}/messages`).set(A()).send({ body: 'Sí, la cambié ayer.' }).expect(200)).body;
    expect(re.status).toBe('OPEN');
    const solved = (await ctx.http().patch(`/api/v1/platform/support/tickets/${ticketId}`).set(R()).send({ status: 'RESOLVED' }).expect(200)).body;
    expect(solved).toMatchObject({ status: 'RESOLVED', resolvedAt: expect.any(String) });
    expect(ctx.outbox.some((m) => m.to === 'ana@soporte.test' && m.subject.startsWith('Resolvimos tu caso') && m.text.includes('califica'))).toBe(true);
    await ctx.http().post(`/api/v1/support/tickets/${ticketId}/rating`).set(A()).send({ rating: 6 }).expect(400);
    const rated = (await ctx.http().post(`/api/v1/support/tickets/${ticketId}/rating`).set(A()).send({ rating: 4, comment: 'Rápido' }).expect(200)).body;
    expect(rated).toMatchObject({ status: 'CLOSED', rating: 4, closedAt: expect.any(String) });
    expect((await ctx.http().post(`/api/v1/support/tickets/${ticketId}/rating`).set(A()).send({ rating: 1 }).expect(409)).body.code).toBe('NOT_RATABLE');
    expect((await ctx.http().post(`/api/v1/support/tickets/${ticketId}/messages`).set(A()).send({ body: 'otra' }).expect(409)).body.code).toBe('TICKET_CLOSED');
    expect((await ctx.http().get('/api/v1/platform/support/summary').set(R()).expect(200)).body).toMatchObject({ satisfaction: { average: 4, count: 1 } });
    // Historial: el mensaje no se puede reescribir
    const msg = await owner.supportMessage.findFirstOrThrow({ where: { ticketId } });
    await expect(owner.supportMessage.update({ where: { id: msg.id }, data: { body: 'cambiado' } })).rejects.toThrow();
  });

  it('el equipo registra casos por la empresa; una instalación independiente usa su contacto', async () => {
    const t = (await ctx.http().post('/api/v1/platform/support/tickets').set(R()).send({ tenantId: b.tenantId, kind: 'REQUEST', subject: 'Agregar un usuario', body: 'Nos llamó para agregar a su vendedor.' }).expect(201)).body;
    expect(t).toMatchObject({ source: 'PLATFORM', status: 'IN_PROGRESS', assignee: { id: rootId } });
    expect((await ctx.http().get('/api/v1/support/tickets').set(B()).expect(200)).body).toHaveLength(1);
    await owner.tenant.update({ where: { id: b.tenantId }, data: { deploymentMode: 'DEDICATED' } });
    expect((await ctx.http().get('/api/v1/support/info').set(B()).expect(200)).body.tickets).toBe(false);
    expect((await ctx.http().post('/api/v1/support/tickets').set(B()).send({ kind: 'QUESTION', subject: 'Consulta', body: 'Hola' }).expect(409)).body.code).toBe('SUPPORT_EXTERNAL');
  });

  it('avisos de vencimiento una sola vez por periodo y seguimiento en el centro comercial', async () => {
    await owner.subscription.update({ where: { tenantId: a.tenantId }, data: { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: new Date(Date.now() + 2 * 86_400_000) } });
    const lead = await owner.salesLead.create({ data: { name: 'Ana', company: 'Bodega Ana', email: 'ana@soporte.test', source: 'REFERRAL', status: 'ACTIVE_CLIENT', tenantId: a.tenantId } });
    const renewals = ctx.app.get(RenewalsService);
    const before = ctx.outbox.length;
    expect(await renewals.sendNotices()).toBeGreaterThanOrEqual(1);
    expect(await renewals.sendNotices()).toBe(0);
    expect((await ctx.http().post('/api/v1/platform/support/renewals/send').set(R()).expect(200)).body).toEqual({ sent: 0 });
    await ctx.http().post('/api/v1/platform/support/renewals/send').set(A()).expect(403);
    const sent = ctx.outbox.slice(before).filter((m) => m.to === 'ana@soporte.test');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/^Tu plan .* vence el \d{2}\/\d{2}\/\d{4}$/);
    expect(await owner.subscriptionNotice.findMany({ where: { tenantId: a.tenantId } })).toEqual([expect.objectContaining({ kind: 'D3', recipients: 1 })]);
    expect((await owner.salesLead.findUniqueOrThrow({ where: { id: lead.id } })).nextAction).toMatch(/^Renovación: vence el /);
    const list = (await ctx.http().get('/api/v1/platform/support/renewals').set(R()).expect(200)).body;
    expect(list.find((r: { tenantId: string }) => r.tenantId === a.tenantId)).toMatchObject({ access: { state: 'ACTIVE' }, notices: [expect.objectContaining({ kind: 'D3' })] });
  });
});
