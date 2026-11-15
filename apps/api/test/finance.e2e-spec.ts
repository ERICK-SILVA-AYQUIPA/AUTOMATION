import argon2 from 'argon2';
import { FinanceService } from '../src/finance/finance.service.js';
import { currentPeriod } from '../src/finance/profitability.js';
import { createTestApp, ownerClient, registerAndLogin, resetDatabase, roleClient, setTestEnv } from './helpers.js';

setTestEnv();
const owner = ownerClient();

/** Rentabilidad por instalación, presupuestos y alertas de consumo (ADR 055) */
describe('Rentabilidad', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let root: string;
  let a: Awaited<ReturnType<typeof registerAndLogin>>;
  const R = () => ({ Authorization: `Bearer ${root}` });
  const A = () => ({ Authorization: `Bearer ${a.accessToken}` });
  const today = new Date().toISOString().slice(0, 10);
  const report = async () => (await ctx.http().get(`/api/v1/platform/finance/tenants/${a.tenantId}`).set(R()).expect(200)).body;

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
    await owner.user.create({ data: { email: 'root@finanzas.test', name: 'Finanzas', role: 'PLATFORM_ADMIN', emailVerifiedAt: new Date(), passwordHash: await argon2.hash('RootClave123') } });
    root = (await ctx.http().post('/api/v1/auth/login').send({ email: 'root@finanzas.test', password: 'RootClave123' }).expect(200)).body.accessToken;
    a = await registerAndLogin(ctx, { companyName: 'Bodega Ana', email: 'ana@finanzas.test' });
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
  });

  it('sin precio ni costos no hay margen: dice qué falta', async () => {
    const r = await report();
    expect(r).toMatchObject({ period: currentPeriod(), mrr: null, mrrNote: 'En prueba: aún no paga', margin: { value: null } });
    expect(r.margin.missing[0]).toMatch(/^Precio de venta/);
    expect(r.costs.find((c: { category: string }) => c.category === 'SERVER')).toMatchObject({ known: false, note: expect.stringContaining('servidor compartido') });
    expect(r.costs.find((c: { category: string }) => c.category === 'AI')).toMatchObject({ known: true, measured: [] });
    await ctx.http().get(`/api/v1/platform/finance/tenants/${a.tenantId}`).set(A()).expect(403);
    await ctx.http().get('/api/v1/platform/finance').query({ period: '2026-13' }).set(R()).expect(400);
  });

  it('con el pago del plan, costos medidos y registrados y tipo de cambio, calcula el margen', async () => {
    const sub = await owner.subscription.findUniqueOrThrow({ where: { tenantId: a.tenantId } });
    const start = new Date(Date.now() - 86_400_000);
    const end = new Date(Date.now() + 29 * 86_400_000);
    await owner.subscription.update({ where: { tenantId: a.tenantId }, data: { status: 'ACTIVE', trialEndsAt: null, currentPeriodStart: start, currentPeriodEnd: end } });
    await owner.payment.create({ data: { tenantId: a.tenantId, planId: sub.planId, amount: 300, currency: 'PEN', months: 3, method: 'YAPE', paidAt: new Date(), periodStart: start, periodEnd: end } });
    // IA: una llamada con precio (USD) y otra con un modelo sin precio; la clave propia del cliente no cuenta
    await owner.aiUsageEvent.createMany({ data: [
      { tenantId: a.tenantId, service: 'ASSISTANT', provider: 'gemini', model: 'm', mode: 'SERVER', inputTokens: 10, outputTokens: 5, cost: 2, costCurrency: 'USD', ok: true },
      { tenantId: a.tenantId, service: 'ASSISTANT', provider: 'gemini', model: 'x', mode: 'MANAGED', inputTokens: 10, outputTokens: 5, cost: null, ok: true },
      { tenantId: a.tenantId, service: 'ASSISTANT', provider: 'openai', model: 'o', mode: 'OWN', inputTokens: 10, outputTokens: 5, cost: 99, costCurrency: 'USD', ok: true },
    ] });
    await ctx.http().post(`/api/v1/platform/finance/tenants/${a.tenantId}/costs`).set(R()).send({ category: 'OTRO', description: 'x', amount: '1', currency: 'PEN', cycle: 'MONTHLY', startsOn: today }).expect(400);
    await ctx.http().post(`/api/v1/platform/finance/tenants/${a.tenantId}/costs`).set(R()).send({ category: 'SUPPORT', description: 'x', amount: '-1', currency: 'PEN', cycle: 'MONTHLY', startsOn: today }).expect(400);
    for (const [category, amount, currency] of [['SERVER', '20', 'PEN'], ['WHATSAPP', '0', 'PEN'], ['STORAGE', '2', 'PEN'], ['EXTERNAL', '3', 'EUR'], ['SUPPORT', '15', 'PEN']]) {
      await ctx.http().post(`/api/v1/platform/finance/tenants/${a.tenantId}/costs`).set(R()).send({ category, description: `Partida ${category}`, amount, currency, cycle: 'MONTHLY', startsOn: today }).expect(201);
    }
    let r = await report();
    expect(r.mrr).toEqual({ amount: 100, currency: 'PEN', source: 'payment' });
    expect(r.costs.find((c: { category: string }) => c.category === 'AI')).toMatchObject({ known: false, measured: [{ amount: 2, currency: 'USD' }], note: expect.stringMatching(/^1 llamada\(s\) con un modelo sin precio/) });
    expect(r.margin.value).toBeNull();
    expect(r.margin.missing).toEqual([expect.stringMatching(/^Costo de ia: 1 llamada/), 'Tipo de cambio EUR, USD → PEN']);
    // Se registra el costo de esa llamada a mano y se definen los tipos de cambio
    await owner.aiUsageEvent.updateMany({ where: { tenantId: a.tenantId, cost: null }, data: { cost: 0, costCurrency: 'USD' } });
    await ctx.http().put('/api/v1/platform/finance/settings').set(R()).send({ baseCurrency: 'PEN', rates: { USD: 0 } }).expect(400);
    await ctx.http().put('/api/v1/platform/finance/settings').set(R()).send({ baseCurrency: 'PEN', rates: { USD: 3.75, EUR: 4 } }).expect(200);
    r = await report();
    // 100 − (20 + 2×3.75 + 0 + 2 + 3×4 + 15) = 43.5
    expect(r.margin).toMatchObject({ value: 43.5, revenue: 100, costs: 56.5, pct: 43.5, missing: [] });
    const all = (await ctx.http().get('/api/v1/platform/finance').set(R()).expect(200)).body;
    expect(all.totals).toMatchObject({ mrr: { base: 100 }, margin: { known: 1, value: 43.5, negative: 0 } });
  });

  it('partidas que terminan no cuentan después; nadie más ve los costos', async () => {
    const item = await owner.tenantCostItem.findFirstOrThrow({ where: { tenantId: a.tenantId, category: 'SUPPORT' } });
    await ctx.http().patch(`/api/v1/platform/finance/tenants/${a.tenantId}/costs/${item.id}`).set(R()).send({ endsOn: '2000-01-01' }).expect(404);
    await ctx.http().patch(`/api/v1/platform/finance/tenants/${a.tenantId}/costs/${item.id}`).set(R()).send({ endsOn: today }).expect(200);
    expect((await report()).margin.value).toBe(43.5); // sigue vigente este mes
    const runtime = roleClient('runtime');
    await expect(runtime.tenantCostItem.findMany()).rejects.toThrow();
    await expect(runtime.financeSettings.findMany()).rejects.toThrow();
    await runtime.$disconnect();
  });

  it('presupuesto de IA: alerta al umbral y al superarlo, una vez por mes', async () => {
    await ctx.http().put(`/api/v1/platform/finance/tenants/${a.tenantId}/budgets/AI`).set(R()).send({ amount: '0', currency: 'PEN' }).expect(400);
    await ctx.http().put(`/api/v1/platform/finance/tenants/${a.tenantId}/budgets/AI`).set(R()).send({ amount: '9', currency: 'PEN', thresholdPct: 80 }).expect(200);
    let r = await report();
    expect(r.budgets).toEqual([expect.objectContaining({ scope: 'AI', spent: 7.5, level: 'WARN' })]);
    const finance = ctx.app.get(FinanceService);
    const before = ctx.outbox.length;
    expect(await finance.checkBudgets()).toBe(1);
    expect(await finance.checkBudgets()).toBe(0);
    expect(ctx.outbox.slice(before)).toEqual([expect.objectContaining({ to: 'root@finanzas.test', subject: 'Bodega Ana: IA al 80% del presupuesto' })]);
    // Más consumo: se supera
    await owner.aiUsageEvent.create({ data: { tenantId: a.tenantId, service: 'ASSISTANT', provider: 'gemini', model: 'm', mode: 'SERVER', cost: 1, costCurrency: 'USD', ok: true } });
    expect((await ctx.http().post('/api/v1/platform/finance/alerts/check').set(R()).expect(200)).body).toEqual({ sent: 1 });
    expect((await ctx.http().post('/api/v1/platform/finance/alerts/check').set(R()).expect(200)).body).toEqual({ sent: 0 });
    expect(ctx.outbox.at(-1)!.subject).toBe('Bodega Ana: se superó el presupuesto de IA');
    r = await report();
    expect(r.alerts.map((x: { level: string }) => x.level).sort()).toEqual(['EXCEEDED', 'WARN']);
    // Presupuesto en otra moneda: se convierte con los tipos definidos
    await ctx.http().put(`/api/v1/platform/finance/tenants/${a.tenantId}/budgets/TOTAL`).set(R()).send({ amount: '100', currency: 'USD' }).expect(200);
    expect((await report()).budgets.find((b: { scope: string }) => b.scope === 'TOTAL')).toMatchObject({ currency: 'USD', level: null, spent: expect.closeTo(16.07, 2) });
    await ctx.http().delete(`/api/v1/platform/finance/tenants/${a.tenantId}/budgets/TOTAL`).set(R()).expect(200);
    await ctx.http().delete(`/api/v1/platform/finance/tenants/${a.tenantId}/budgets/TOTAL`).set(R()).expect(404);
  });
});
