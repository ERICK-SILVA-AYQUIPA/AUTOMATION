import { useAuth } from './auth';
import type { TenantSettings } from './types';

/** Mismos valores por defecto que la API (tenants/tenant-settings.ts) */
export const DEFAULT_SETTINGS: TenantSettings = {
  catalog: { label: 'Productos', trackStockDefault: true, volumePricing: false, durations: false },
  orders: { minAmount: null },
  customers: { businessFields: false },
  reservations: { kind: 'TABLE', slotMinutes: 30, durationMinutes: 90, capacity: null, maxPartySize: 20, minNoticeMinutes: 60, maxDaysAhead: 30, hours: null, requireConfirmation: true },
};

/** Reglas de operación de la empresa del usuario (plantilla + personalización) */
export function useTenantSettings(): TenantSettings {
  const { me } = useAuth();
  return me?.tenant?.settings ?? DEFAULT_SETTINGS;
}
