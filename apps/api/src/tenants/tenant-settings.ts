import { z } from 'zod';
import { weeklyHoursSchema } from '../ai/ai-profile.js';

/**
 * Reglas de operación de cada empresa (ADR 043). Las fija la plantilla del
 * sector al instalarla y la empresa las personaliza después en Configuración.
 * Ningún valor comercial (capacidad, pedido mínimo) se inventa: si la empresa
 * no lo define, queda en null y la función que lo necesita lo indica.
 */
export const tenantSettingsSchema = z
  .object({
    catalog: z
      .object({
        /** Cómo se llama el catálogo en el menú y en el asistente (Productos, Menú, Servicios…) */
        label: z.string().trim().min(2).max(30),
        /** Valor inicial de «controla stock» en productos nuevos */
        trackStockDefault: z.boolean(),
        /** Muestra y aplica precios por volumen */
        volumePricing: z.boolean(),
        /** Los productos tienen duración (servicios reservables) */
        durations: z.boolean(),
      })
      .strict(),
    orders: z
      .object({
        /** Importe mínimo del pedido; null = sin mínimo */
        minAmount: z.number().min(0).max(1_000_000).nullable(),
      })
      .strict(),
    customers: z.object({ businessFields: z.boolean() }).strict(),
    reservations: z
      .object({
        /** MESA: por personas; CITA: un servicio por cliente */
        kind: z.enum(['TABLE', 'APPOINTMENT']),
        /** Intervalo entre horarios ofrecidos */
        slotMinutes: z.number().int().min(10).max(240),
        /** Duración de una reserva de mesa o de una cita sin servicio con duración */
        durationMinutes: z.number().int().min(10).max(720),
        /** Personas (mesa) o citas simultáneas (cita). null = sin configurar: no se aceptan reservas */
        capacity: z.number().int().min(1).max(5000).nullable(),
        maxPartySize: z.number().int().min(1).max(500),
        /** Antelación mínima y máxima */
        minNoticeMinutes: z.number().int().min(0).max(10_080),
        maxDaysAhead: z.number().int().min(1).max(365),
        /** null = sin horario: no se aceptan reservas */
        hours: weeklyHoursSchema.nullable(),
        /** true: las del asistente quedan pendientes hasta que el equipo las confirma */
        requireConfirmation: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

export const DEFAULT_SETTINGS: TenantSettings = {
  catalog: { label: 'Productos', trackStockDefault: true, volumePricing: false, durations: false },
  orders: { minAmount: null },
  customers: { businessFields: false },
  reservations: { kind: 'TABLE', slotMinutes: 30, durationMinutes: 90, capacity: null, maxPartySize: 20, minNoticeMinutes: 60, maxDaysAhead: 30, hours: null, requireConfirmation: true },
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Combina por sección: lo de `patch` manda campo a campo. */
export function mergeSettings(base: unknown, patch: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(isObject(base) ? base : {}) };
  for (const [k, v] of Object.entries(isObject(patch) ? patch : {})) out[k] = isObject(out[k]) && isObject(v) ? { ...(out[k] as object), ...v } : v;
  return out;
}

/** Lo guardado sobre los valores por defecto; una sección inválida vuelve a su valor por defecto. */
export function readSettings(stored: unknown): TenantSettings {
  const merged = mergeSettings(DEFAULT_SETTINGS, stored);
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof TenantSettings)[]) {
    const r = tenantSettingsSchema.shape[key].safeParse(merged[key]);
    if (r.success) out[key] = r.data;
  }
  return out as TenantSettings;
}

/** Cambios parciales desde el panel: secciones y campos opcionales */
export const settingsPatchSchema = z
  .object({
    catalog: tenantSettingsSchema.shape.catalog.partial().optional(),
    orders: tenantSettingsSchema.shape.orders.partial().optional(),
    customers: tenantSettingsSchema.shape.customers.partial().optional(),
    reservations: tenantSettingsSchema.shape.reservations.partial().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nada que actualizar');
