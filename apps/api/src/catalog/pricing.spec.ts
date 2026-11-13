import { Prisma } from '../generated/prisma/client.js';
import { assertTiersBelow, priceTiersSchema, readTiers, unitPriceFor } from './pricing.js';
import { localParts, weekdayOf, zonedToUtc } from '../common/time/zoned.js';

describe('precios por volumen', () => {
  const tiers = [{ minQty: 10, unitPrice: '4.50' }, { minQty: 50, unitPrice: '4.00' }];
  it('toma el tramo más alto alcanzado', () => {
    const base = new Prisma.Decimal('5.00');
    expect(unitPriceFor(base, tiers, 9).toString()).toBe('5');
    expect(unitPriceFor(base, tiers, 10).toString()).toBe('4.5');
    expect(unitPriceFor(base, tiers, 49).toString()).toBe('4.5');
    expect(unitPriceFor(base, tiers, 50).toString()).toBe('4');
  });
  it('exige cantidades crecientes, precios decrecientes y más baratos que el precio normal', () => {
    expect(priceTiersSchema.safeParse(tiers).success).toBe(true);
    expect(priceTiersSchema.safeParse([...tiers].reverse()).success).toBe(false);
    expect(priceTiersSchema.safeParse([{ minQty: 1, unitPrice: '4' }]).success).toBe(false);
    expect(assertTiersBelow('4.50', tiers)).toMatch(/menor/);
    expect(assertTiersBelow('5', tiers)).toBeNull();
    expect(readTiers('basura')).toEqual([]);
  });
});

describe('fechas en la zona de la empresa', () => {
  it('convierte hora local de Lima (UTC−5) y de Madrid con horario de verano', () => {
    expect(zonedToUtc('2026-11-20', '20:00', 'America/Lima').toISOString()).toBe('2026-11-21T01:00:00.000Z');
    expect(zonedToUtc('2026-07-01', '10:00', 'Europe/Madrid').toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(zonedToUtc('2026-12-01', '10:00', 'Europe/Madrid').toISOString()).toBe('2026-12-01T09:00:00.000Z');
    expect(localParts(new Date('2026-11-21T01:00:00Z'), 'America/Lima')).toMatchObject({ date: '2026-11-20', time: '20:00', weekday: 'fri' });
    expect(weekdayOf('2026-11-20')).toBe('fri');
  });
});
