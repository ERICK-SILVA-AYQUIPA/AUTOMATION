/**
 * Rentabilidad por instalación (ADR 055): cálculo puro, sin base de datos.
 *
 * Regla central (§13): el margen solo se calcula cuando se conocen TODOS los
 * costos y hay tipo de cambio para cada moneda; si falta algo, el margen es
 * null y se dice exactamente qué falta. Nada se rellena con supuestos.
 */
export type CostCategory = 'SERVER' | 'AI' | 'WHATSAPP' | 'STORAGE' | 'EXTERNAL' | 'SUPPORT';
export const CATEGORIES: CostCategory[] = ['SERVER', 'AI', 'WHATSAPP', 'STORAGE', 'EXTERNAL', 'SUPPORT'];
export const CATEGORY_LABEL: Record<CostCategory, string> = {
  SERVER: 'Servidor', AI: 'IA', WHATSAPP: 'WhatsApp', STORAGE: 'Almacenamiento', EXTERNAL: 'Servicios externos', SUPPORT: 'Soporte',
};

export interface Money { amount: number; currency: string }
export interface CostLine {
  category: CostCategory;
  /** Lo que el sistema midió (servidor por horas, IA por llamada) */
  measured: Money[];
  /** Lo que el equipo registró a mano para el periodo */
  manual: Money[];
  known: boolean;
  /** Por qué no se conoce, o de dónde sale el dato */
  note: string;
}

const HOUR = 3_600_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Mes `YYYY-MM` en hora de Lima (UTC-5, sin horario de verano) → [inicio, fin) */
export function periodRange(period: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error('Periodo inválido');
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return { start: new Date(Date.UTC(y, mo, 1, 5)), end: new Date(Date.UTC(y, mo + 1, 1, 5)) };
}

export function currentPeriod(now = new Date()) {
  const lima = new Date(now.getTime() - 5 * HOUR);
  return `${lima.getUTCFullYear()}-${String(lima.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Suma por moneda */
export function sum(items: Money[]): Money[] {
  const by = new Map<string, number>();
  for (const i of items) by.set(i.currency, (by.get(i.currency) ?? 0) + i.amount);
  return [...by].map(([currency, amount]) => ({ currency, amount: r4(amount) }));
}

/** Convierte a la moneda base con los tipos que definió el equipo; null si falta alguno */
export function convert(items: Money[], base: string, rates: Record<string, number>): number | null {
  let total = 0;
  for (const i of items) {
    if (i.currency === base) total += i.amount;
    else if (rates[i.currency] && rates[i.currency]! > 0) total += i.amount * rates[i.currency]!;
    else return null;
  }
  return r2(total);
}
export const missingRates = (items: Money[], base: string, rates: Record<string, number>) =>
  [...new Set(items.filter((i) => i.currency !== base && !(rates[i.currency]! > 0)).map((i) => i.currency))].sort();

/**
 * Costo de un servidor en el periodo: horas encendido × precio por hora, con el
 * tope mensual del proveedor (así factura Hetzner). Sin precio → null.
 */
export function serverCost(
  s: { priceHourly: number | null; priceMonthly: number | null; currency: string | null; providerCreatedAt: Date; deletedAt: Date | null },
  range: { start: Date; end: Date },
  now = new Date(),
): Money | null {
  if (s.priceHourly == null || !s.currency) return null;
  const from = Math.max(s.providerCreatedAt.getTime(), range.start.getTime());
  const to = Math.min((s.deletedAt ?? now).getTime(), range.end.getTime(), now.getTime());
  const hours = Math.max(0, Math.ceil((to - from) / HOUR));
  const cost = hours * s.priceHourly;
  return { amount: r4(s.priceMonthly != null ? Math.min(cost, s.priceMonthly) : cost), currency: s.currency };
}

/** Partidas manuales que corresponden al periodo: mensuales vigentes algún día y únicas que empiezan en él */
export function manualFor<T extends { category: string; amount: number; currency: string; cycle: string; startsOn: Date; endsOn: Date | null }>(items: T[], range: { start: Date; end: Date }): T[] {
  // Las fechas son días (DATE en UTC); se comparan contra el mes calendario
  const first = new Date(Date.UTC(range.start.getUTCFullYear(), range.start.getUTCMonth(), 1));
  const next = new Date(Date.UTC(range.start.getUTCFullYear(), range.start.getUTCMonth() + 1, 1));
  return items.filter((i) => (i.cycle === 'ONE_TIME'
    ? i.startsOn >= first && i.startsOn < next
    : i.startsOn < next && (!i.endsOn || i.endsOn >= first)));
}

export interface ProfitInput {
  base: string;
  rates: Record<string, number>;
  /** Ingreso recurrente mensual pactado (cotización aceptada o plan pagado); null si no hay precio */
  mrr: Money | null;
  costs: CostLine[];
}

export function margin(input: ProfitInput) {
  const missing: string[] = [];
  if (!input.mrr) missing.push('Precio de venta mensual (cotización aceptada o plan pagado)');
  for (const c of input.costs) if (!c.known) missing.push(`Costo de ${CATEGORY_LABEL[c.category].toLowerCase()}: ${c.note}`);
  const all = input.costs.flatMap((c) => [...c.measured, ...c.manual]);
  const rates = missingRates([...(input.mrr ? [input.mrr] : []), ...all], input.base, input.rates);
  if (rates.length) missing.push(`Tipo de cambio ${rates.join(', ')} → ${input.base}`);
  const costTotal = convert(all, input.base, input.rates);
  const revenue = input.mrr ? convert([input.mrr], input.base, input.rates) : null;
  if (missing.length || costTotal == null || revenue == null) {
    return { currency: input.base, revenue, costs: costTotal, value: null, pct: null, missing };
  }
  const value = r2(revenue - costTotal);
  return { currency: input.base, revenue, costs: costTotal, value, pct: revenue > 0 ? Math.round((value / revenue) * 1000) / 10 : null, missing };
}

/** Nivel de alerta de un presupuesto: WARN al llegar al umbral, EXCEEDED al pasarlo */
export function budgetLevel(spent: number, amount: number, thresholdPct: number): 'WARN' | 'EXCEEDED' | null {
  if (spent >= amount) return 'EXCEEDED';
  if (spent >= (amount * thresholdPct) / 100) return 'WARN';
  return null;
}
