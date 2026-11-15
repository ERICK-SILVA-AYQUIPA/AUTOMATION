import argon2 from 'argon2';
import { setTestEnv, createTestApp, ownerClient, roleClient, resetDatabase, registerAndLogin } from './helpers.js';

setTestEnv();
process.env.THROTTLE_DISABLED = 'true';
const owner = ownerClient();

const CONTRACT = 'Contrato de servicio de AI Sales Assistant. 1. Objeto: el servicio descrito en la propuesta aceptada. 2. Pago: la instalación empieza al validar el pago.';
const tokenOf = (path: string) => new URL(path, 'http://x').searchParams.get('t')!;
const idOf = (path: string) => new URL(path, 'http://x').pathname.split('/').pop()!;

/**
 * Fase C (ADR 049): catálogo con precios, cotización congelada al enviarse,
 * aceptación con versión del contrato, orden de pago, comprobante que no basta,
 * validación administrativa, asiento de ingreso y orden de instalación.
 */
describe('Cotizaciones, contratación y pagos', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let root: string;
  let leadId: string;
  const items: Record<string, string> = {};
  let quoteId: string;
  let quotePath: string;
  let orderPath: string;
  const R = () => ({ Authorization: `Bearer ${root}` });
  const base = '/api/v1/platform/commerce';
  const draft = (over: Record<string, unknown> = {}) => ({
    leadId, currency: 'PEN', country: 'PE', planCode: 'PROFESSIONAL', users: 5, modules: ['conversations', 'ai', 'catalog', 'orders'], deploymentMode: 'SAAS',
    initialSetup: 'Carga del catálogo y configuración del asistente', support: 'Lunes a sábado de 9 a 18 h', initialPayment: 'ONE_TIME_AND_FIRST_MONTH',
    lines: [
      { itemId: items.plan, kind: 'PLAN', billing: 'MONTHLY', description: 'Plan Profesional', quantity: 1, unitPrice: '79.00' },
      { itemId: items.users, kind: 'USERS', billing: 'MONTHLY', description: 'Usuarios adicionales', quantity: 2, unitPrice: '10.00' },
      { itemId: items.setup, kind: 'SETUP', billing: 'ONE_TIME', description: 'Instalación y configuración inicial', quantity: 1, unitPrice: '500.00' },
    ],
    ...over,
  });

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
    await owner.user.create({ data: { email: 'root@cot.test', name: 'Rosa Ventas', role: 'PLATFORM_ADMIN', emailVerifiedAt: new Date(), passwordHash: await argon2.hash('RootClave123') } });
    root = (await ctx.http().post('/api/v1/auth/login').send({ email: 'root@cot.test', password: 'RootClave123' }).expect(200)).body.accessToken;
    leadId = (await ctx.http().post('/api/v1/platform/sales/leads').set(R()).send({ name: 'Carla Ruiz', company: 'Minimarket Carla', email: 'carla@minimarket.test', phone: '+51987111222', source: 'WEBSITE' }).expect(201)).body.id;
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
  });

  it('catálogo editable; impuestos y emisor configurables; solo la plataforma', async () => {
    const t = await registerAndLogin(ctx, { companyName: 'Empresa cliente', email: 'admin@cliente.test' });
    await ctx.http().get(`${base}/items`).set({ Authorization: `Bearer ${t.accessToken}` }).expect(403);
    items.plan = (await ctx.http().post(`${base}/items`).set(R()).send({ code: 'plan-pro', name: 'Plan Profesional', kind: 'PLAN', billing: 'MONTHLY', unitPrice: '79', currency: 'pen', planCode: 'PROFESSIONAL', unit: 'mes' }).expect(201)).body.id;
    items.users = (await ctx.http().post(`${base}/items`).set(R()).send({ code: 'USER-EXTRA', name: 'Usuario adicional', kind: 'USERS', billing: 'MONTHLY', unitPrice: '10.00', currency: 'PEN' }).expect(201)).body.id;
    items.setup = (await ctx.http().post(`${base}/items`).set(R()).send({ code: 'SETUP', name: 'Instalación', kind: 'SETUP', billing: 'ONE_TIME', unitPrice: '500.00', currency: 'PEN' }).expect(201)).body.id;
    items.usd = (await ctx.http().post(`${base}/items`).set(R()).send({ code: 'SERVER-USD', name: 'Servidor dedicado', kind: 'SERVER', billing: 'MONTHLY', unitPrice: '25.00', currency: 'USD' }).expect(201)).body.id;
    expect((await ctx.http().post(`${base}/items`).set(R()).send({ code: 'PLAN-PRO', name: 'x', kind: 'PLAN', billing: 'MONTHLY', unitPrice: '1', currency: 'PEN' }).expect(409)).body.code).toBe('DUPLICATE_CODE');
    await ctx.http().post(`${base}/items`).set(R()).send({ code: 'NEG', name: 'x', kind: 'OTHER', billing: 'ONE_TIME', unitPrice: '-1', currency: 'PEN' }).expect(400);
    // Impuesto: nombre y tasa juntos
    await ctx.http().put(`${base}/settings`).set(R()).send({ taxName: 'IGV', taxRate: null, pricesIncludeTax: false, quoteValidityDays: 15 }).expect(400);
    const s = await ctx.http().put(`${base}/settings`).set(R()).send({ legalName: 'Mi Empresa S.A.C.', taxId: '20123456789', address: 'Av. Lima 123', taxName: 'IGV', taxRate: '18', pricesIncludeTax: false, quoteValidityDays: 10, quoteTerms: 'Precios en soles. La instalación toma hasta 5 días hábiles después de validar el pago.' }).expect(200);
    expect(s.body).toMatchObject({ legalName: 'Mi Empresa S.A.C.', taxName: 'IGV', taxRate: '18.00', quoteValidityDays: 10 });
  });

  it('borrador: totales calculados en el servidor con impuesto; monedas y conceptos validados', async () => {
    expect((await ctx.http().post(`${base}/quotes`).set(R()).send(draft({ lines: [{ itemId: items.usd, kind: 'SERVER', billing: 'MONTHLY', description: 'Servidor', quantity: 1, unitPrice: '25' }] })).expect(400)).body.code).toBe('CURRENCY_MISMATCH');
    await ctx.http().post(`${base}/quotes`).set(R()).send(draft({ lines: [] })).expect(400);
    const q = await ctx.http().post(`${base}/quotes`).set(R()).send(draft()).expect(201);
    quoteId = q.body.id;
    // Mensual 79 + 2×10 = 99 → IGV 17.82 → 116.82; único 500 → IGV 90 → 590; pago inicial 706.82
    expect(q.body).toMatchObject({ status: 'DRAFT', subtotalMonthly: '99', taxMonthly: '17.82', totalMonthly: '116.82', subtotalOneTime: '500', taxOneTime: '90', totalOneTime: '590', taxName: 'IGV', initialAmount: '706.82' });
    expect(q.body.lines.map((l: { total: string }) => l.total)).toEqual(['79', '20', '500']);
    // El equipo puede ajustar un precio en la cotización (negociación); queda en la línea
    const u = await ctx.http().put(`${base}/quotes/${quoteId}`).set(R()).send(draft({ lines: [...draft().lines, { kind: 'INTEGRATION', billing: 'ONE_TIME', description: 'Integración con su web', quantity: 1, unitPrice: '150.50' }] })).expect(200);
    expect(u.body).toMatchObject({ subtotalOneTime: '650.5', totalOneTime: '767.59' });
    // Un cambio de precio en el catálogo no toca el borrador ya armado
    await ctx.http().put(`${base}/items/${items.setup}`).set(R()).send({ code: 'SETUP', name: 'Instalación', kind: 'SETUP', billing: 'ONE_TIME', unitPrice: '600.00', currency: 'PEN' }).expect(200);
    expect((await ctx.http().get(`${base}/quotes/${quoteId}`).set(R()).expect(200)).body.lines[2].unitPrice).toBe('500');
  });

  it('enviar exige contrato, condiciones y emisor; al enviar se congela', async () => {
    expect((await ctx.http().post(`${base}/quotes/${quoteId}/send`).set(R()).expect(409)).body.code).toBe('NO_CONTRACT');
    await ctx.http().post(`${base}/contracts`).set(R()).send({ title: 'Contrato de servicio', body: 'muy corto' }).expect(400);
    const c = await ctx.http().post(`${base}/contracts`).set(R()).send({ title: 'Contrato de servicio', body: CONTRACT }).expect(201);
    expect(c.body.version).toBe(1);
    const sent = await ctx.http().post(`${base}/quotes/${quoteId}/send`).set(R()).expect(200);
    quotePath = sent.body.path;
    expect(quotePath).toMatch(new RegExp(`^/propuesta/${quoteId}\\?t=[\\w-]{40,}$`));
    const q = await ctx.http().get(`${base}/quotes/${quoteId}`).set(R()).expect(200);
    expect(q.body).toMatchObject({ status: 'SENT', contractVersion: { version: 1 }, issuer: { legalName: 'Mi Empresa S.A.C.', taxId: '20123456789' }, client: { name: 'Carla Ruiz', company: 'Minimarket Carla', country: 'PE' } });
    expect(q.body.accessTokenHash).toBeUndefined();
    expect((await owner.salesLead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe('QUOTE_SENT');
    // Congelada: ni la API ni la base permiten cambiarla
    expect((await ctx.http().put(`${base}/quotes/${quoteId}`).set(R()).send(draft()).expect(409)).body.code).toBe('QUOTE_FROZEN');
    await expect(owner.$executeRaw`UPDATE sales_quotes SET total_one_time = 1 WHERE id = ${quoteId}::uuid`).rejects.toThrow(/no se puede modificar/);
    await expect(owner.$executeRaw`DELETE FROM sales_quote_lines WHERE quote_id = ${quoteId}::uuid`).rejects.toThrow(/no se pueden cambiar/);
    await expect(owner.$executeRaw`UPDATE contract_versions SET body = 'otro'`).rejects.toThrow(/no se puede modificar/);
    // Nueva versión del contrato: la cotización enviada conserva la suya
    await ctx.http().post(`${base}/contracts`).set(R()).send({ title: 'Contrato de servicio', body: `${CONTRACT} 3. Cambio.` }).expect(201);
  });

  it('el cliente ve la propuesta y el PDF solo con su enlace', async () => {
    const t = tokenOf(quotePath);
    expect((await ctx.http().get(`/api/v1/public/quotes/${quoteId}`).query({ t: 'x'.repeat(43) }).expect(404)).body.code).toBe('QUOTE_LINK');
    const v = await ctx.http().get(`/api/v1/public/quotes/${quoteId}`).query({ t }).expect(200);
    expect(v.body).toMatchObject({ code: expect.stringMatching(/^COT-\d{5}$/), status: 'SENT', totalOneTime: '767.59', totalMonthly: '116.82', initialAmount: '884.41', contract: { version: 1, body: CONTRACT } });
    expect(JSON.stringify(v.body)).not.toMatch(new RegExp(leadId));
    const pdf = await ctx.http().get(`/api/v1/public/quotes/${quoteId}/pdf`).query({ t }).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((pdf.body as Buffer).length).toBeGreaterThan(2000);
  });

  it('aceptar registra quién, cuándo y qué contrato; genera la orden de pago; no se acepta dos veces', async () => {
    const t = tokenOf(quotePath);
    const accept = (b: Record<string, unknown>) => ctx.http().post(`/api/v1/public/quotes/${quoteId}/accept`).set('User-Agent', 'Navegador de prueba').send({ token: t, name: 'Carla Ruiz', document: '44556677', contractVersion: 1, accept: true, ...b });
    await accept({ accept: false }).expect(400);
    expect((await accept({ contractVersion: 2 }).expect(409)).body.code).toBe('CONTRACT_CHANGED');
    const ok = await accept({}).expect(200);
    orderPath = ok.body.paymentPath;
    expect(orderPath).toMatch(/^\/pago\/[0-9a-f-]{36}\?t=/);
    expect((await accept({}).expect(409)).body.code).toBe('QUOTE_CLOSED');
    const q = await owner.salesQuote.findUniqueOrThrow({ where: { id: quoteId } });
    expect(q).toMatchObject({ status: 'ACCEPTED', acceptedName: 'Carla Ruiz', acceptedDocument: '44556677', acceptedUserAgent: 'Navegador de prueba' });
    expect(q.acceptedIp).toBeTruthy();
    await expect(owner.$executeRaw`UPDATE sales_quotes SET accepted_name = 'Otra' WHERE id = ${quoteId}::uuid`).rejects.toThrow(/aceptación registrada/);
    const order = await owner.salesPaymentOrder.findUniqueOrThrow({ where: { id: idOf(orderPath) } });
    expect(order).toMatchObject({ status: 'PENDING', currency: 'PEN', country: 'PE', quoteId });
    expect(order.amount.toFixed(2)).toBe('884.41');
    expect((await owner.salesLead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe('PAYMENT_PENDING');
    // Una sola orden vigente por cotización (la base lo impide)
    await expect(owner.salesPaymentOrder.create({ data: { leadId, quoteId, concept: 'doble', amount: '1', currency: 'PEN' } })).rejects.toThrow();
    expect(await owner.auditLog.count({ where: { action: 'commercial.quote_accepted', entityId: quoteId } })).toBe(1);
  });

  it('el cliente ve solo los métodos de su país y moneda e informa el pago; el comprobante no confirma nada', async () => {
    const yape = (await ctx.http().post(`${base}/payment-methods`).set(R()).send({ kind: 'YAPE', name: 'Yape', instructions: 'Yapea al número que te indicó tu asesor y anota el número de operación.', countries: ['pe'], currencies: ['PEN'] }).expect(201)).body.id;
    await ctx.http().post(`${base}/payment-methods`).set(R()).send({ kind: 'BANK_TRANSFER', name: 'Transferencia en dólares', instructions: 'Cuenta en dólares: la indica tu asesor.', currencies: ['USD'] }).expect(201);
    await ctx.http().post(`${base}/payment-methods`).set(R()).send({ kind: 'BANK_TRANSFER', name: 'Transferencia Chile', instructions: 'Solo para Chile.', countries: ['CL'] }).expect(201);
    const id = idOf(orderPath);
    const t = tokenOf(orderPath);
    const v = await ctx.http().get(`/api/v1/public/payments/${id}`).query({ t }).expect(200);
    expect(v.body).toMatchObject({ amount: '884.41', currency: 'PEN', status: 'PENDING', quote: { code: expect.stringMatching(/^COT-/) } });
    expect(v.body.methods.map((m: { name: string }) => m.name)).toEqual(['Yape']);
    const other = (await owner.paymentMethodConfig.findFirstOrThrow({ where: { name: 'Transferencia Chile' } })).id;
    const proof = (b: Record<string, unknown>) => ctx.http().post(`/api/v1/public/payments/${id}/proof`).send({ token: t, methodId: yape, reference: '00123456', payer: 'Carla Ruiz', paidAt: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date()), amount: '884.41', ...b });
    expect((await proof({ methodId: other }).expect(400)).body.code).toBe('METHOD_NOT_ALLOWED');
    await proof({}).expect(200);
    const o = await owner.salesPaymentOrder.findUniqueOrThrow({ where: { id } });
    expect(o.status).toBe('PROOF_SUBMITTED');
    // Un comprobante no es un pago: ni asiento, ni instalación, ni etapa
    expect(await owner.accountingEntry.count()).toBe(0);
    expect(await owner.installationOrder.count()).toBe(0);
    const lead = await owner.salesLead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.status).toBe('PAYMENT_PENDING');
    expect(lead.nextAction).toMatch(/^Validar pago OP-\d{5} en la cuenta$/);
    // Ni la base acepta marcarla pagada sin validación
    await expect(owner.$executeRaw`UPDATE sales_payment_orders SET status = 'PAID' WHERE id = ${id}::uuid`).rejects.toThrow(/sales_payment_orders_paid_check/);
  });

  it('validación administrativa: importe exacto y declaración; asiento, instalación y etapa en una transacción', async () => {
    const id = idOf(orderPath);
    const validate = (b: Record<string, unknown>) => ctx.http().post(`${base}/payments/${id}/validate`).set(R()).send({ method: 'YAPE', reference: '00123456', paidAt: new Date().toISOString(), amount: '884.41', verifiedInAccount: true, ...b });
    await validate({ verifiedInAccount: false }).expect(400);
    expect((await validate({ amount: '884.40' }).expect(400)).body.code).toBe('AMOUNT_MISMATCH');
    await ctx.http().post(`${base}/payments/${id}/reject-proof`).set(R()).send({ reason: 'No aparece en la cuenta todavía' }).expect(200);
    expect((await owner.salesPaymentOrder.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
    const ok = await validate({}).expect(200);
    expect(ok.body).toMatchObject({ status: 'PAID', method: 'YAPE', reference: '00123456', installation: { status: 'AUTHORIZED' } });
    expect(ok.body.events.map((e: { type: string }) => e.type)).toEqual(['VALIDATED', 'PROOF_REJECTED', 'PROOF_SUBMITTED', 'CREATED']);
    expect((await validate({}).expect(409)).body.code).toBe('ORDER_PAID');
    const entry = await owner.accountingEntry.findFirstOrThrow({ where: { paymentOrderId: id } });
    expect([entry.gross.toFixed(2), entry.tax.toFixed(2), entry.net.toFixed(2), entry.kind, entry.method]).toEqual(['884.41', '134.91', '749.50', 'INCOME', 'YAPE']);
    const inst = await owner.installationOrder.findFirstOrThrow({ where: { paymentOrderId: id } });
    expect(inst).toMatchObject({ status: 'AUTHORIZED', planCode: 'PROFESSIONAL', deploymentMode: 'SAAS', users: 5, modules: ['conversations', 'ai', 'catalog', 'orders'], tenantId: null });
    expect((await owner.salesLead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe('PAYMENT_CONFIRMED');
    await expect(owner.$executeRaw`UPDATE accounting_entries SET gross = 1`).rejects.toThrow(/no se puede modificar/);
    await expect(owner.$executeRaw`DELETE FROM sales_payment_events`).rejects.toThrow(/no se puede modificar/);
    // Una orden pagada no se anula
    expect((await ctx.http().post(`${base}/payments/${id}/cancel`).set(R()).send({ reason: 'error' }).expect(409)).body.code).toBe('ORDER_PAID');
    // El asistente de alta toma lo contratado
    const conv = await ctx.http().get(`/api/v1/platform/sales/leads/${leadId}/conversion`).set(R()).expect(200);
    expect(conv.body).toMatchObject({ planCode: 'PROFESSIONAL', deploymentMode: 'SAAS', enabledModules: ['conversations', 'ai', 'catalog', 'orders'], installationOrderId: inst.id });
    // Libro de ingresos con totales y exportación
    const l = await ctx.http().get(`${base}/accounting`).set(R()).expect(200);
    expect(l.body.totals).toEqual([{ currency: 'PEN', count: 1, gross: '884.41', tax: '134.91', net: '749.50' }]);
    const csv = await ctx.http().get(`${base}/accounting/export`).set(R()).expect(200);
    expect(csv.text).toMatch(/AS-\d{5},\d{4}-\d{2}-\d{2},Minimarket Carla,OP-\d{5} · Propuesta COT-\d{5}: pago único y primera mensualidad,PEN,884.41,134.91,749.50,YAPE,00123456/);
  });

  it('pasarela oficial: confirmación idempotente y sin cobrar importes distintos', async () => {
    const { PaymentsService } = await import('../src/quotes/payments.service.js');
    const payments = ctx.app.get(PaymentsService);
    const lead2 = (await ctx.http().post('/api/v1/platform/sales/leads').set(R()).send({ name: 'Pedro Pasarela', email: 'pedro@pasarela.test', source: 'REFERRAL' }).expect(201)).body.id;
    const q = (await ctx.http().post(`${base}/quotes`).set(R()).send(draft({ leadId: lead2, initialPayment: 'ONE_TIME' })).expect(201)).body.id;
    const sent = await ctx.http().post(`${base}/quotes/${q}/send`).set(R()).expect(200);
    const order = (await ctx.http().post(`/api/v1/public/quotes/${q}/accept`).send({ token: tokenOf(sent.body.path), name: 'Pedro Pasarela', contractVersion: 2, accept: true }).expect(200)).body.paymentPath;
    const oid = idOf(order);
    expect(await payments.confirmFromGateway('pasarela-prueba', 'evt-1', { orderId: oid, amount: '1.00', currency: 'PEN', paymentId: 'pay-1', paidAt: new Date() })).toEqual({ duplicate: false, outcome: 'AMOUNT_MISMATCH' });
    expect((await owner.salesPaymentOrder.findUniqueOrThrow({ where: { id: oid } })).status).toBe('PENDING');
    const r1 = await payments.confirmFromGateway('pasarela-prueba', 'evt-2', { orderId: oid, amount: '590.00', currency: 'PEN', paymentId: 'pay-2', paidAt: new Date() });
    const r2 = await payments.confirmFromGateway('pasarela-prueba', 'evt-2', { orderId: oid, amount: '590.00', currency: 'PEN', paymentId: 'pay-2', paidAt: new Date() });
    expect(r1).toEqual({ duplicate: false, outcome: 'PAID' });
    expect(r2).toEqual({ duplicate: true, outcome: 'PAID' });
    expect(await owner.accountingEntry.count({ where: { paymentOrderId: oid } })).toBe(1);
    expect(await owner.installationOrder.count({ where: { paymentOrderId: oid } })).toBe(1);
    expect(await owner.salesPaymentOrder.findUniqueOrThrow({ where: { id: oid } })).toMatchObject({ status: 'PAID', gatewayProvider: 'pasarela-prueba', gatewayPaymentId: 'pay-2', validatedById: null });
  });

  it('rechazo, anulación y vencimiento; borradores borrables; el rol de ejecución no ve nada', async () => {
    const q = (await ctx.http().post(`${base}/quotes`).set(R()).send(draft()).expect(201)).body.id;
    await ctx.http().delete(`${base}/quotes/${q}`).set(R()).expect(204);
    const q2 = (await ctx.http().post(`${base}/quotes`).set(R()).send(draft()).expect(201)).body.id;
    const s2 = await ctx.http().post(`${base}/quotes/${q2}/send`).set(R()).expect(200);
    await ctx.http().delete(`${base}/quotes/${q2}`).set(R()).expect(409);
    await ctx.http().post(`/api/v1/public/quotes/${q2}/reject`).send({ token: tokenOf(s2.body.path), reason: 'Por ahora no' }).expect(200);
    expect((await owner.salesQuote.findUniqueOrThrow({ where: { id: q2 } })).status).toBe('REJECTED');
    expect((await owner.salesLead.findUniqueOrThrow({ where: { id: leadId } })).nextAction).toMatch(/^Contactar: rechazó la propuesta/);
    // Enlace nuevo: el anterior deja de servir
    const q3 = (await ctx.http().post(`${base}/quotes`).set(R()).send(draft()).expect(201)).body.id;
    const s3 = await ctx.http().post(`${base}/quotes/${q3}/send`).set(R()).expect(200);
    const l3 = await ctx.http().post(`${base}/quotes/${q3}/link`).set(R()).expect(200);
    await ctx.http().get(`/api/v1/public/quotes/${q3}`).query({ t: tokenOf(s3.body.path) }).expect(404);
    await ctx.http().get(`/api/v1/public/quotes/${q3}`).query({ t: tokenOf(l3.body.path) }).expect(200);
    // Vencida: se marca al consultarla y ya no se acepta
    // Simula el paso del tiempo (la vigencia no se puede cambiar por la API ni con el disparador activo)
    await owner.$transaction([owner.$executeRawUnsafe('ALTER TABLE sales_quotes DISABLE TRIGGER sales_quote_frozen'), owner.$executeRaw`UPDATE sales_quotes SET valid_until = CURRENT_DATE - 2 WHERE id = ${q3}::uuid`, owner.$executeRawUnsafe('ALTER TABLE sales_quotes ENABLE TRIGGER sales_quote_frozen')]);
    expect((await ctx.http().post(`/api/v1/public/quotes/${q3}/accept`).send({ token: tokenOf(l3.body.path), name: 'X', contractVersion: 2, accept: true }).expect(409)).body.code).toBe('QUOTE_EXPIRED');
    expect((await owner.salesQuote.findUniqueOrThrow({ where: { id: q3 } })).status).toBe('EXPIRED');
    const runtime = roleClient('runtime');
    for (const t of ['sales_quotes', 'sales_payment_orders', 'accounting_entries', 'installation_orders', 'payment_methods', 'commercial_items']) await expect(runtime.$queryRawUnsafe(`SELECT 1 FROM ${t}`)).rejects.toThrow(/permission denied/);
    await runtime.$disconnect();
  });
});
