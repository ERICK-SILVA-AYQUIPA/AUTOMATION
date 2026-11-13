import { z } from 'zod';
import type { GenerationParams } from '../providers/types.js';

/**
 * Perfiles de uso por servicio (ADR 046). El perfil fija los parámetros de
 * generación; el modelo lo elige siempre una persona entre los que devuelve el
 * proveedor (no hay modelos escritos en el código).
 *  - ECONOMY: respuestas cortas (menos tokens de salida).
 *  - ADVANCED: respuestas más largas.
 *  - CUSTOM: los parámetros que se indiquen.
 */
export const customParamsSchema = z
  .object({
    maxOutputTokens: z.number().int().min(256).max(16_000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    effort: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict();
export type CustomParams = z.infer<typeof customParamsSchema>;

export function paramsFor(profile: 'ECONOMY' | 'ADVANCED' | 'CUSTOM', custom: unknown): GenerationParams {
  if (profile === 'ECONOMY') return { maxOutputTokens: 1024 };
  if (profile === 'ADVANCED') return { maxOutputTokens: 4096 };
  const c = customParamsSchema.safeParse(custom ?? {});
  const p = c.success ? c.data : {};
  return { maxOutputTokens: p.maxOutputTokens ?? 2048, ...(p.temperature !== undefined ? { temperature: p.temperature } : {}), ...(p.effort ? { effort: p.effort } : {}) };
}
