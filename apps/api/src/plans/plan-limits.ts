import { z } from 'zod';
import { ForbiddenException } from '@nestjs/common';
import type { Tx } from '../database/database.service.js';

export const planLimitsSchema = z.object({
  maxUsers: z.number().int().positive(),
  maxWhatsappNumbers: z.number().int().positive(),
  maxConversationsPerMonth: z.number().int().positive(),
  maxProducts: z.number().int().positive(),
  maxBranches: z.number().int().positive(),
  features: z.array(z.string()),
});
export type PlanLimits = z.infer<typeof planLimitsSchema>;

/** Funciones habilitables por plan */
export const FEATURES = {
  HUMAN_HANDOFF: 'human_handoff',
  REPORTS: 'reports',
  ADVANCED_AUTOMATIONS: 'advanced_automations',
  ADVANCED_AI: 'advanced_ai',
  MULTI_BRANCH: 'multi_branch',
  ADVANCED_ROLES: 'advanced_roles',
} as const;

/** Lee los límites del plan de la empresa actual (dentro de su transacción RLS). */
export async function getPlanLimits(tx: Tx): Promise<PlanLimits> {
  const sub = await tx.subscription.findFirst({ select: { status: true, plan: { select: { limits: true } } } });
  if (!sub) throw new ForbiddenException('La empresa no tiene suscripción');
  if (sub.status === 'CANCELED') throw new ForbiddenException('La suscripción está cancelada');
  return planLimitsSchema.parse(sub.plan.limits);
}

export function assertWithinLimit(current: number, max: number, what: string) {
  if (current >= max) {
    throw new ForbiddenException({ code: 'PLAN_LIMIT_REACHED', message: `Tu plan permite como máximo ${max} ${what}. Mejora tu plan para añadir más.` });
  }
}

export const currentPeriod = (d = new Date()) => d.toISOString().slice(0, 7);
