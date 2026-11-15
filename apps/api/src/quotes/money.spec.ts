import { applyTax, lineTotal, quoteTotals } from './money.js';

describe('importes de cotizaciones', () => {
  it('línea: cantidad × precio con redondeo mitad hacia arriba', () => {
    expect(lineTotal('3', '49.90')).toBe(14970);
    expect(lineTotal('1.5', '0.33')).toBe(50); // 0.495 → 0.50
    expect(lineTotal('0.1', '0.1')).toBe(1); // 0.01
  });
  it('impuesto agregado o incluido', () => {
    expect(applyTax(10000, { name: null, rate: null, included: false })).toEqual({ tax: 0, total: 10000 });
    expect(applyTax(10000, { name: 'IGV', rate: '18.00', included: false })).toEqual({ tax: 1800, total: 11800 });
    expect(applyTax(11800, { name: 'IGV', rate: 18, included: true })).toEqual({ tax: 1800, total: 11800 });
  });
  it('totales por tipo de cobro', () => {
    const t = quoteTotals([{ billing: 'ONE_TIME', quantity: 1, unitPrice: '500.00' }, { billing: 'MONTHLY', quantity: 3, unitPrice: '20.00' }, { billing: 'MONTHLY', quantity: 1, unitPrice: '79.00' }], { name: 'IGV', rate: '18', included: false });
    expect(t).toEqual({ subtotalOneTime: 50000, subtotalMonthly: 13900, taxOneTime: 9000, taxMonthly: 2502, totalOneTime: 59000, totalMonthly: 16402 });
  });
});
