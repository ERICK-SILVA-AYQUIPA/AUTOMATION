import argon2 from 'argon2';
import { createTestApp, ownerClient, registerAndLogin, resetDatabase, setTestEnv } from './helpers.js';

setTestEnv();
const owner = ownerClient();

/** Asistente «Nueva venta e instalación» (ADR 053): pasos calculados con datos reales */
describe('Nueva venta e instalación', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let root: string;
  const R = () => ({ Authorization: `Bearer ${root}` });
  const base = '/api/v1/platform/journey';

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
    await owner.user.create({ data: { email: 'root@viaje.test', name: 'Root', role: 'PLATFORM_ADMIN', emailVerifiedAt: new Date(), passwordHash: await argon2.hash('RootClave123') } });
    root = (await ctx.http().post('/api/v1/auth/login').send({ email: 'root@viaje.test', password: 'RootClave123' }).expect(200)).body.accessToken;
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
  });

  it('avanza con el prospecto, el pago y la empresa; solo para la plataforma', async () => {
    const lead = (await ctx.http().post('/api/v1/platform/sales/leads').set(R()).send({ name: 'Ana', company: 'Bodega Ana', email: 'ana@viaje.test', source: 'REFERRAL' }).expect(201)).body.id;
    let j = (await ctx.http().get(`${base}/${lead}`).set(R()).expect(200)).body;
    expect(j.steps).toHaveLength(12);
    expect(j.current).toBe(2);
    expect(j.steps.map((s: { state: string }) => s.state).slice(6)).toEqual(Array(6).fill('blocked'));

    await ctx.http().patch(`/api/v1/platform/sales/leads/${lead}`).set(R()).send({ interestPlan: 'PROFESSIONAL', interestMode: 'SAAS', interestModules: ['catalog', 'orders'] }).expect(200);
    j = (await ctx.http().get(`${base}/${lead}`).set(R()).expect(200)).body;
    expect(j.current).toBe(5);
    expect(j.steps[4].action.href).toBe(`/plataforma/cotizaciones/nueva?lead=${lead}`);
    // Calificado: aparece en ventas en curso
    await ctx.http().post(`/api/v1/platform/sales/leads/${lead}/status`).set(R()).send({ status: 'QUALIFIED' }).expect(200);
    expect((await ctx.http().get(base).set(R()).expect(200)).body).toEqual([expect.objectContaining({ leadId: lead, current: 5, total: 12, step: 'Generar cotización' })]);

    // Venta directa: pago validado en la cuenta → orden de instalación; falta convertir en empresa
    await ctx.http().post(`/api/v1/platform/sales/leads/${lead}/status`).set(R()).send({ status: 'PAYMENT_PENDING' }).expect(200);
    await ctx.http().post(`/api/v1/platform/sales/leads/${lead}/payment`).set(R()).send({ amount: '300', currency: 'PEN', method: 'BANK_TRANSFER', reference: 'TR-VIAJE', paidAt: new Date().toISOString(), verifiedInAccount: true }).expect(200);
    j = (await ctx.http().get(`${base}/${lead}`).set(R()).expect(200)).body;
    expect(j.steps[5].state).toBe('done');
    expect(j.steps[6].missing).toContain('Convertir el prospecto en empresa (asistente de alta)');
    expect(j.steps[6].action.href).toBe(`/plataforma/nueva?lead=${lead}`);
    expect(j.steps[7]).toMatchObject({ state: 'skipped' }); // SaaS: sin servidor

    // Ninguna empresa ve el asistente
    const shop = await registerAndLogin(ctx, { companyName: 'Otra', email: 'admin@viaje-otra.test' });
    await ctx.http().get(`${base}/${lead}`).set({ Authorization: `Bearer ${shop.accessToken}` }).expect(403);
    await ctx.http().get(base).set({ Authorization: `Bearer ${shop.accessToken}` }).expect(403);
    await ctx.http().get(`${base}/00000000-0000-7000-8000-000000000000`).set(R()).expect(404);
  });
});
