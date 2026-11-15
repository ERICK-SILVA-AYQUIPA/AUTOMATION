/** Rentabilidad por instalación (ADR 055): tipos y formato compartidos */
export interface Money { amount: number; currency: string }
export type Category = 'SERVER' | 'AI' | 'WHATSAPP' | 'STORAGE' | 'EXTERNAL' | 'SUPPORT';
export interface Margin { currency: string; revenue: number | null; costs: number | null; value: number | null; pct: number | null; missing: string[] }

export const CATEGORY: Record<Category, string> = { SERVER: 'Servidor', AI: 'IA', WHATSAPP: 'WhatsApp', STORAGE: 'Almacenamiento', EXTERNAL: 'Servicios externos', SUPPORT: 'Soporte' };

export const fmt = (m: Money | null | undefined) =>
  m ? new Intl.NumberFormat('es-PE', { style: 'currency', currency: m.currency, maximumFractionDigits: 2 }).format(m.amount) : '—';
export const fmtAll = (list: Money[]) => (list.length ? list.map(fmt).join(' + ') : '—');

export const thisPeriod = () => {
  const lima = new Date(Date.now() - 5 * 3_600_000);
  return `${lima.getUTCFullYear()}-${String(lima.getUTCMonth() + 1).padStart(2, '0')}`;
};
