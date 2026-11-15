import { budgetLevel, convert, currentPeriod, manualFor, margin, periodRange, serverCost, type CostLine } from './profitability.js';

const known = (category: CostLine['category'], amount = 0, currency = 'PEN'): CostLine => ({ category, measured: [], manual: amount ? [{ amount, currency }] : [], known: true, note: '' });

describe('Rentabilidad (ADR 055)', () => {
  it('periodos en hora de Lima', () => {
    expect(periodRange('2026-11')).toEqual({ start: new Date('2026-11-01T05:00:00Z'), end: new Date('2026-12-01T05:00:00Z') });
    expect(periodRange('2026-12').end).toEqual(new Date('2027-01-01T05:00:00Z'));
    expect(() => periodRange('2026-13')).toThrow();
    expect(currentPeriod(new Date('2026-12-01T03:00:00Z'))).toBe('2026-11'); // aún es 30 de noviembre en Lima
  });

  it('servidor: horas encendido × precio por hora, con el tope mensual; sin precio no se inventa', () => {
    const range = periodRange('2026-11');
    const s = { priceHourly: 0.01, priceMonthly: 5, currency: 'EUR', providerCreatedAt: new Date('2026-11-10T05:00:00Z'), deletedAt: new Date('2026-11-11T05:00:00Z') };
    expect(serverCost(s, range)).toEqual({ amount: 0.24, currency: 'EUR' });
    expect(serverCost({ ...s, deletedAt: null }, range, new Date('2026-12-15T00:00:00Z'))).toEqual({ amount: 5, currency: 'EUR' });
    expect(serverCost({ ...s, priceHourly: null }, range)).toBeNull();
    expect(serverCost({ ...s, providerCreatedAt: new Date('2026-12-02T00:00:00Z'), deletedAt: null }, range, new Date('2026-12-15T00:00:00Z'))!.amount).toBe(0);
  });

  it('partidas manuales: mensuales vigentes y únicas del mes', () => {
    const d = (s: string) => new Date(`${s}T00:00:00Z`);
    const items = [
      { id: 'a', category: 'SUPPORT', amount: 50, currency: 'PEN', cycle: 'MONTHLY', startsOn: d('2026-10-01'), endsOn: null },
      { id: 'b', category: 'EXTERNAL', amount: 40, currency: 'PEN', cycle: 'ONE_TIME', startsOn: d('2026-11-30'), endsOn: null },
      { id: 'c', category: 'STORAGE', amount: 9, currency: 'PEN', cycle: 'MONTHLY', startsOn: d('2026-08-01'), endsOn: d('2026-10-31') },
      { id: 'd', category: 'EXTERNAL', amount: 40, currency: 'PEN', cycle: 'ONE_TIME', startsOn: d('2026-12-01'), endsOn: null },
    ];
    expect(manualFor(items, periodRange('2026-11')).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('el margen solo se calcula con todos los costos y tipos de cambio', () => {
    const all = [known('SERVER', 20), known('AI'), known('WHATSAPP'), known('STORAGE'), known('EXTERNAL', 10), known('SUPPORT', 30)];
    expect(margin({ base: 'PEN', rates: {}, mrr: { amount: 200, currency: 'PEN' }, costs: all })).toMatchObject({ value: 140, pct: 70, missing: [] });
    // Falta un costo: no hay margen y se dice cuál
    const partial = all.map((c) => (c.category === 'WHATSAPP' ? { ...c, known: false, note: 'sin registrar' } : c));
    expect(margin({ base: 'PEN', rates: {}, mrr: { amount: 200, currency: 'PEN' }, costs: partial })).toMatchObject({ value: null, missing: ['Costo de whatsapp: sin registrar'] });
    // Moneda sin tipo de cambio
    const eur = all.map((c) => (c.category === 'SERVER' ? { ...c, manual: [{ amount: 5, currency: 'EUR' }] } : c));
    expect(margin({ base: 'PEN', rates: {}, mrr: { amount: 200, currency: 'PEN' }, costs: eur }).missing).toEqual(['Tipo de cambio EUR → PEN']);
    expect(margin({ base: 'PEN', rates: { EUR: 4 }, mrr: { amount: 200, currency: 'PEN' }, costs: eur })).toMatchObject({ value: 140, costs: 60 });
    // Sin precio de venta
    expect(margin({ base: 'PEN', rates: {}, mrr: null, costs: all }).value).toBeNull();
    expect(convert([{ amount: 1, currency: 'USD' }], 'PEN', {})).toBeNull();
  });

  it('niveles de alerta del presupuesto', () => {
    expect(budgetLevel(79, 100, 80)).toBeNull();
    expect(budgetLevel(80, 100, 80)).toBe('WARN');
    expect(budgetLevel(100, 100, 80)).toBe('EXCEEDED');
  });
});
