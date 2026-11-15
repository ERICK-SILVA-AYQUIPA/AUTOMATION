import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { setTestEnv, createTestApp, ownerClient, roleClient, resetDatabase, registerAndLogin } from './helpers.js';

setTestEnv();
process.env.THROTTLE_DISABLED = 'true';
const owner = ownerClient();
const DAY = 86_400_000;

/**
 * Centro comercial (ADR 047): prospectos, embudo con reglas, historial que solo
 * se anexa, validación administrativa del pago y conversión en empresa.
 */
describe('Centro comercial: CRM de prospectos', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let root: string;
  let rootId: string;
  let otherAdminId: string;
  let leadId: string;
  const R = () => ({ Authorization: `Bearer ${root}` });
  const base = '/api/v1/platform/sales';
  const lead = (over: Record<string, unknown> = {}) => ({
    name: 'Carlos Ríos', company: 'Ferretería Ríos', phone: '+51 987 654 321', email: 'Carlos@Rios.test', sector: 'RETAIL', need: 'Vender por WhatsApp sin perder pedidos',
    source: 'WEBSITE', estimatedBudget: '1500', budgetCurrency: 'PEN', interestMode: 'SAAS', interestPlan: 'PROFESSIONAL', interestModules: ['catalog', 'orders'],
    ...over,
  });

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
    const pw = await argon2.hash('RootClave123');
    rootId = (await owner.user.create({ data: { email: 'root@sales.test', name: 'Rosa Ventas', role: 'PLATFORM_ADMIN', emailVerifiedAt: new Date(), passwordHash: pw } })).id;
    otherAdminId = (await owner.user.create({ data: { email: 'luis@sales.test', name: 'Luis Ventas', role: 'PLATFORM_ADMIN', emailVerifiedAt: new Date(), passwordHash: pw } })).id;
    root = (await ctx.http().post('/api/v1/auth/login').send({ email: 'root@sales.test', password: 'RootClave123' }).expect(200)).body.accessToken;
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
  });

  it('registra un prospecto con todos sus datos, responsable por defecto e historial', async () => {
    const r = await ctx.http().post(`${base}/leads`).set(R()).send(lead({ nextAction: 'Llamar para agendar demo', nextActionAt: new Date(Date.now() + DAY).toISOString() })).expect(201);
    leadId = r.body.id;
    expect(r.body).toMatchObject({
      number: expect.any(Number), name: 'Carlos Ríos', company: 'Ferretería Ríos', phone: '+51987654321', email: 'carlos@rios.test', sector: 'RETAIL', source: 'WEBSITE',
      estimatedBudget: '1500', budgetCurrency: 'PEN', interestMode: 'SAAS', interestPlan: 'PROFESSIONAL', status: 'NEW', ownerId: rootId, owner: { name: 'Rosa Ventas' }, nextAction: 'Llamar para agendar demo',
    });
    const d = await ctx.http().get(`${base}/leads/${leadId}`).set(R()).expect(200);
    expect(d.body.activities.map((a: { type: string }) => a.type).sort()).toEqual(['CREATED', 'NEXT_ACTION_SET']);
    expect(d.body.activities[0].userName).toBe('Rosa Ventas');
    expect(await owner.auditLog.count({ where: { action: 'sales.lead_created', entityId: leadId } })).toBe(1);
  });

  it('valida los datos: sin teléfono ni correo no hay prospecto; detecta duplicados por correo o teléfono', async () => {
    const bad = await ctx.http().post(`${base}/leads`).set(R()).send(lead({ phone: null, email: null })).expect(400);
    expect(JSON.stringify(bad.body)).toContain('teléfono o un correo');
    await ctx.http().post(`${base}/leads`).set(R()).send(lead({ phone: 'abc', email: null })).expect(400);
    await ctx.http().post(`${base}/leads`).set(R()).send(lead({ nextAction: 'Llamar' })).expect(400);
    const dup = await ctx.http().post(`${base}/leads`).set(R()).send(lead({ email: 'otro@rios.test', phone: '51987654321' })).expect(409);
    expect(dup.body).toMatchObject({ code: 'DUPLICATE_LEAD', matches: [{ id: leadId, name: 'Carlos Ríos' }] });
    const dupMail = await ctx.http().post(`${base}/leads`).set(R()).send(lead({ email: 'CARLOS@rios.test', phone: null })).expect(409);
    expect(dupMail.body.matches[0].id).toBe(leadId);
    // Con confirmación explícita sí se registra (p. ej. otra sucursal del mismo cliente)
    await ctx.http().post(`${base}/leads`).set(R()).send(lead({ name: 'Ríos sucursal 2', phone: null, allowDuplicate: true })).expect(201);
  });

  it('el responsable solo puede ser personal activo de la plataforma (también lo exige la base)', async () => {
    const t = await registerAndLogin(ctx, { companyName: 'Tienda Ajena', email: 'admin@ajena.test' });
    const tenantUser = await owner.user.findFirstOrThrow({ where: { tenantId: t.tenantId } });
    const bad = await ctx.http().post(`${base}/leads/${leadId}/owner`).set(R()).send({ ownerId: tenantUser.id }).expect(400);
    expect(bad.body.code).toBe('INVALID_OWNER');
    await expect(owner.salesLead.update({ where: { id: leadId }, data: { ownerId: tenantUser.id } })).rejects.toThrow(/personal de la plataforma/);
    const ok = await ctx.http().post(`${base}/leads/${leadId}/owner`).set(R()).send({ ownerId: otherAdminId }).expect(200);
    expect(ok.body.owner.name).toBe('Luis Ventas');
    expect(ok.body.activities[0]).toMatchObject({ type: 'OWNER_CHANGED', metadata: { from: rootId, to: otherAdminId } });
    // Una empresa no ve nada del centro comercial
    await ctx.http().get(`${base}/leads`).set({ Authorization: `Bearer ${t.accessToken}` }).expect(403);
    await ctx.http().post(`${base}/leads`).set({ Authorization: `Bearer ${t.accessToken}` }).send(lead({ email: 'x@y.test' })).expect(403);
  });

  it('edita datos y registra qué cambió; notas, llamadas y próxima acción quedan en el historial', async () => {
    const u = await ctx.http().patch(`${base}/leads/${leadId}`).set(R()).send({ estimatedBudget: 2400, need: 'WhatsApp + inventario' }).expect(200);
    expect(u.body.estimatedBudget).toBe('2400');
    expect(u.body.activities[0]).toMatchObject({ type: 'UPDATED', metadata: { changes: { estimatedBudget: { from: '1500.00', to: '2400.00' }, need: { to: 'WhatsApp + inventario' } } } });
    await ctx.http().patch(`${base}/leads/${leadId}`).set(R()).send({ phone: null, email: null }).expect(400);
    await ctx.http().post(`${base}/leads/${leadId}/activities`).set(R()).send({ type: 'CALL', body: 'Le interesa el plan Profesional' }).expect(201);
    await ctx.http().post(`${base}/leads/${leadId}/activities`).set(R()).send({ type: 'STATUS_CHANGED', body: 'trampa' }).expect(400);
    const done = await ctx.http().post(`${base}/leads/${leadId}/next-action/done`).set(R()).send({ note: 'Demo agendada para el jueves' }).expect(200);
    expect(done.body).toMatchObject({ nextAction: null, nextActionAt: null });
    expect(done.body.activities[0]).toMatchObject({ type: 'NEXT_ACTION_DONE', body: 'Demo agendada para el jueves', metadata: { action: 'Llamar para agendar demo', late: false } });
    await ctx.http().post(`${base}/leads/${leadId}/next-action/done`).set(R()).send({}).expect(400);
    await ctx.http().put(`${base}/leads/${leadId}/next-action`).set(R()).send({ text: 'Enviar propuesta', dueAt: new Date(Date.now() - 3_600_000).toISOString() }).expect(200);
  });

  it('el historial no se puede cambiar ni borrar, ni siquiera con el rol de sistema; el rol de ejecución no ve nada', async () => {
    const a = await owner.salesActivity.findFirstOrThrow({ where: { leadId } });
    await expect(owner.salesActivity.update({ where: { id: a.id }, data: { body: 'otra cosa' } })).rejects.toThrow(/no se puede modificar/);
    await expect(owner.salesActivity.delete({ where: { id: a.id } })).rejects.toThrow(/no se puede modificar/);
    const runtime = roleClient('runtime');
    try {
      await expect(runtime.salesLead.count()).rejects.toThrow(/permission denied/);
      await expect(runtime.salesActivity.count()).rejects.toThrow(/permission denied/);
    } finally {
      await runtime.$disconnect();
    }
  });

  it('listas, filtros, vencidas y resumen del embudo', async () => {
    const overdue = await ctx.http().get(`${base}/leads?view=overdue`).set(R()).expect(200);
    expect(overdue.body.items.map((l: { id: string }) => l.id)).toEqual([leadId]);
    const byOwner = await ctx.http().get(`${base}/leads?ownerId=${otherAdminId}`).set(R()).expect(200);
    expect(byOwner.body.total).toBe(1);
    const n = (await owner.salesLead.findUniqueOrThrow({ where: { id: leadId } })).number;
    expect((await ctx.http().get(`${base}/leads?q=P-${n}`).set(R()).expect(200)).body.items[0].id).toBe(leadId);
    expect((await ctx.http().get(`${base}/leads?q=987 654`).set(R()).expect(200)).body.total).toBeGreaterThanOrEqual(1);
    const s = await ctx.http().get(`${base}/summary`).set(R()).expect(200);
    expect(s.body).toMatchObject({ open: 2, overdue: 1, unassigned: 0, closed90: { won: 0, lost: 0, winRate: null }, bySource: { WEBSITE: 2 } });
    expect(s.body.openBudget).toEqual([{ currency: 'PEN', amount: '3900.00' }]);
    const b = await ctx.http().get(`${base}/board`).set(R()).expect(200);
    expect(b.body).toHaveLength(11);
    expect(b.body.find((c: { status: string }) => c.status === 'NEW')).toMatchObject({ count: 2, manual: true, budget: [{ currency: 'PEN', amount: '3900.00' }] });
    expect(b.body.find((c: { status: string }) => c.status === 'PAYMENT_CONFIRMED').manual).toBe(false);
  });

  it('reglas del embudo: las etapas de pago, instalación y cliente no se mueven a mano; perder exige motivo', async () => {
    const mv = (status: string, extra: Record<string, unknown> = {}) => ctx.http().post(`${base}/leads/${leadId}/status`).set(R()).send({ status, ...extra });
    expect((await mv('PAYMENT_CONFIRMED').expect(400)).body.code).toBe('STATUS_NOT_MANUAL');
    expect((await mv('ACTIVE_CLIENT').expect(400)).body.code).toBe('STATUS_NOT_MANUAL');
    expect((await mv('INSTALLATION_PENDING').expect(400)).body.code).toBe('STATUS_NOT_MANUAL');
    for (const s of ['CONTACTED', 'QUALIFIED', 'DEMO_REQUESTED', 'QUOTE_SENT', 'NEGOTIATION']) await mv(s).expect(200);
    expect((await mv('LOST').expect(400)).body.code).toBe('LOST_REASON_REQUIRED');
    const lost = await mv('LOST', { lostReason: 'Eligió otra solución' }).expect(200);
    expect(lost.body).toMatchObject({ status: 'LOST', lostReason: 'Eligió otra solución' });
    // Se puede reabrir y el motivo se limpia
    const back = await mv('NEGOTIATION', { note: 'Volvió a escribir' }).expect(200);
    expect(back.body).toMatchObject({ status: 'NEGOTIATION', lostReason: null });
    expect(back.body.activities[0]).toMatchObject({ type: 'STATUS_CHANGED', body: 'Volvió a escribir', metadata: { from: 'LOST', to: 'NEGOTIATION' } });
    // Convertir sin pago confirmado no se permite
    expect((await ctx.http().get(`${base}/leads/${leadId}/conversion`).set(R()).expect(409)).body.code).toBe('LEAD_NOT_READY');
  });

  it('el pago solo se confirma con validación administrativa desde «Pendiente de pago»', async () => {
    const pay = (over: Record<string, unknown> = {}) => ctx.http().post(`${base}/leads/${leadId}/payment`).set(R()).send({ amount: '2400', currency: 'PEN', method: 'YAPE', reference: 'OP-778899', paidAt: new Date().toISOString(), verifiedInAccount: true, ...over });
    expect((await pay().expect(409)).body.code).toBe('NOT_PAYMENT_PENDING');
    await ctx.http().post(`${base}/leads/${leadId}/status`).set(R()).send({ status: 'PAYMENT_PENDING' }).expect(200);
    await pay({ verifiedInAccount: false }).expect(400);
    await pay({ amount: 0 }).expect(400);
    await pay({ reference: '' }).expect(400);
    await pay({ paidAt: new Date(Date.now() + DAY).toISOString() }).expect(400);
    const ok = await pay().expect(200);
    expect(ok.body.status).toBe('PAYMENT_CONFIRMED');
    expect(ok.body.activities.find((a: { type: string }) => a.type === 'PAYMENT_VALIDATED')).toMatchObject({ metadata: { amount: '2400.00', currency: 'PEN', method: 'YAPE', reference: 'OP-778899', verifiedInAccount: true }, userName: 'Rosa Ventas' });
    // Desde la fase C queda como orden pagada con su asiento de ingreso y su orden de instalación (ADR 049)
    const order = await owner.salesPaymentOrder.findFirstOrThrow({ where: { leadId }, include: { accounting: true, installation: true } });
    expect(order).toMatchObject({ status: 'PAID', currency: 'PEN', reference: 'OP-778899', method: 'YAPE' });
    expect(order.accounting).toMatchObject({ kind: 'INCOME', currency: 'PEN' });
    expect(order.accounting!.gross.toFixed(2)).toBe('2400.00');
    expect(order.installation).toMatchObject({ status: 'AUTHORIZED', tenantId: null });
    expect(await owner.auditLog.count({ where: { action: 'sales.payment_validated', entityId: leadId } })).toBe(1);
    // Ya confirmado: no vuelve atrás a mano
    expect((await ctx.http().post(`${base}/leads/${leadId}/status`).set(R()).send({ status: 'NEGOTIATION' }).expect(409)).body.code).toBe('PAYMENT_CONFIRMED_LOCKED');
  });

  it('se convierte en cliente con el asistente de alta y pasa a cliente activo al activar la empresa', async () => {
    const draft = await ctx.http().get(`${base}/leads/${leadId}/conversion`).set(R()).expect(200);
    expect(draft.body).toMatchObject({ leadId, name: 'Ferretería Ríos', adminName: 'Carlos Ríos', adminEmail: 'carlos@rios.test', templateKey: 'RETAIL', deploymentMode: 'SAAS', planCode: 'PROFESSIONAL' });
    const body = {
      idempotencyKey: randomUUID(), leadId, name: draft.body.name, country: 'PE', currency: 'PEN', timezone: 'America/Lima', businessType: 'RETAIL', deploymentMode: 'SAAS',
      enabledModules: ['conversations', 'ai', 'catalog', 'orders'], planCode: 'PROFESSIONAL', endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
      admin: { name: draft.body.adminName, email: draft.body.adminEmail }, templateKey: 'RETAIL',
    };
    // Un prospecto que no está listo bloquea el alta completa (no queda empresa a medias)
    const other = await ctx.http().post(`${base}/leads`).set(R()).send(lead({ name: 'Otro', email: 'otro@otro.test', phone: null })).expect(201);
    expect((await ctx.http().post('/api/v1/platform/tenants').set(R()).send({ ...body, idempotencyKey: randomUUID(), leadId: other.body.id, admin: { name: 'Otro', email: 'otro@otro.test' } }).expect(409)).body.code).toBe('LEAD_NOT_READY');
    expect(await owner.tenant.count({ where: { users: { some: { email: 'otro@otro.test' } } } })).toBe(0);

    const r = await ctx.http().post('/api/v1/platform/tenants').set(R()).send(body).expect(201);
    const tenantId = r.body.tenant.id;
    let l = await ctx.http().get(`${base}/leads/${leadId}`).set(R()).expect(200);
    expect(l.body).toMatchObject({ status: 'INSTALLATION_PENDING', tenantId, tenant: { name: 'Ferretería Ríos', status: 'ONBOARDING' }, convertedAt: expect.any(String) });
    expect(l.body.activities.map((a: { type: string }) => a.type)).toContain('CONVERTED');
    // No se puede convertir dos veces ni mover a mano
    expect((await ctx.http().post(`${base}/leads/${leadId}/status`).set(R()).send({ status: 'LOST', lostReason: 'x' }).expect(409)).body.code).toBe('LEAD_CONVERTED');
    expect((await ctx.http().get(`${base}/leads/${leadId}/conversion`).set(R()).expect(409)).body.code).toBe('LEAD_NOT_READY');

    // La empresa completa su puesta en marcha (como en provisioning.e2e-spec) y la plataforma la activa
    const admin = await owner.user.findFirstOrThrow({ where: { tenantId } });
    await owner.user.update({ where: { id: admin.id }, data: { status: 'ACTIVE', passwordHash: await argon2.hash('Clave12345'), emailVerifiedAt: new Date() } });
    await owner.whatsappNumber.create({ data: { tenantId, provider: 'CLOUD_API', displayPhone: '51900000999', phoneNumberId: '99900', webhookKey: 'wk-sales', status: 'CONNECTED', lastWebhookAt: new Date() } });
    const ob = await ctx.http().get(`/api/v1/platform/tenants/${tenantId}/onboarding`).set(R()).expect(200);
    expect(ob.body.canActivate).toBe(true);
    await ctx.http().post(`/api/v1/platform/tenants/${tenantId}/activate`).set(R()).expect(201);
    l = await ctx.http().get(`${base}/leads/${leadId}`).set(R()).expect(200);
    expect(l.body.status).toBe('ACTIVE_CLIENT');
    expect(l.body.activities[0]).toMatchObject({ type: 'STATUS_CHANGED', metadata: { from: 'INSTALLATION_PENDING', to: 'ACTIVE_CLIENT' } });
    const s = await ctx.http().get(`${base}/summary`).set(R()).expect(200);
    expect(s.body.closed90).toEqual({ won: 1, lost: 0, winRate: 100 });
    // La base tampoco deja un cliente activo sin empresa
    await expect(owner.salesLead.update({ where: { id: other.body.id }, data: { status: 'ACTIVE_CLIENT' } })).rejects.toThrow(/sales_leads_tenant_check/);
  });
});

