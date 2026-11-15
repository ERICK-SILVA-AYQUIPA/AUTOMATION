/**
 * Importes en céntimos enteros (sin errores de coma flotante). El redondeo es
 * «mitad hacia arriba», igual que round() de PostgreSQL para importes positivos,
 * que es lo que comprueba la base en cada línea.
 */
export const cents = (v: string | number | { toString(): string }) => Math.round(Number(v.toString()) * 100);
export const fromCents = (c: number) => (c / 100).toFixed(2);

/** Total de una línea: cantidad (2 decimales) × precio unitario */
export function lineTotal(quantity: string | number, unitPrice: string | number) {
  return Math.round((cents(quantity) * cents(unitPrice)) / 100);
}

export interface TaxConfig { name: string | null; rate: string | number | null; included: boolean }

/** Impuesto sobre un subtotal: incluido en los precios o agregado encima */
export function applyTax(subtotal: number, t: TaxConfig): { tax: number; total: number } {
  if (!t.name || t.rate == null) return { tax: 0, total: subtotal };
  const r = cents(t.rate); // 18.00 % → 1800
  if (t.included) {
    const net = Math.round((subtotal * 10_000) / (10_000 + r));
    return { tax: subtotal - net, total: subtotal };
  }
  const tax = Math.round((subtotal * r) / 10_000);
  return { tax, total: subtotal + tax };
}

export function quoteTotals(lines: { billing: 'ONE_TIME' | 'MONTHLY'; quantity: string | number; unitPrice: string | number }[], t: TaxConfig) {
  let one = 0;
  let month = 0;
  for (const l of lines) {
    const v = lineTotal(l.quantity, l.unitPrice);
    if (l.billing === 'ONE_TIME') one += v;
    else month += v;
  }
  const a = applyTax(one, t);
  const b = applyTax(month, t);
  return { subtotalOneTime: one, subtotalMonthly: month, taxOneTime: a.tax, taxMonthly: b.tax, totalOneTime: a.total, totalMonthly: b.total };
}
