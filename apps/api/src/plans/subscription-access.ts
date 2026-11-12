import { HttpException, HttpStatus } from '@nestjs/common';
import type { SubscriptionStatus } from '../generated/prisma/enums.js';

/**
 * Estado de acceso de una empresa según su suscripción (cobro manual, ADR 036).
 *   TRIAL    prueba vigente                      → uso completo
 *   ACTIVE   periodo pagado vigente              → uso completo
 *   GRACE    periodo pagado vencido hace < N días → uso completo + aviso
 *   EXPIRED  prueba vencida o gracia agotada     → solo lectura
 *   CANCELED cancelada por la plataforma         → solo lectura
 * Se calcula en cada petición a partir de las fechas: no depende de un proceso
 * programado que cambie el estado a tiempo.
 */
export type AccessState = 'TRIAL' | 'ACTIVE' | 'GRACE' | 'EXPIRED' | 'CANCELED';

export interface SubscriptionDates {
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date;
}

export interface SubscriptionAccess {
  state: AccessState;
  readOnly: boolean;
  /** Fin de la prueba o del periodo pagado */
  endsAt: string;
  /** Fin del periodo de gracia (solo ACTIVE/GRACE tras un pago) */
  graceEndsAt: string | null;
  /** Días completos hasta que la cuenta pase a solo lectura (0 si ya lo está) */
  daysLeft: number;
}

const DAY = 86_400_000;

export function subscriptionAccess(sub: SubscriptionDates, graceDays: number, now = new Date()): SubscriptionAccess {
  const t = now.getTime();
  const left = (until: number) => Math.max(0, Math.ceil((until - t) / DAY));
  if (sub.status === 'TRIALING') {
    const end = (sub.trialEndsAt ?? sub.currentPeriodEnd).getTime();
    return t < end
      ? { state: 'TRIAL', readOnly: false, endsAt: new Date(end).toISOString(), graceEndsAt: null, daysLeft: left(end) }
      : { state: 'EXPIRED', readOnly: true, endsAt: new Date(end).toISOString(), graceEndsAt: null, daysLeft: 0 };
  }
  const end = sub.currentPeriodEnd.getTime();
  const graceEnd = end + graceDays * DAY;
  const base = { endsAt: sub.currentPeriodEnd.toISOString(), graceEndsAt: new Date(graceEnd).toISOString() };
  if (sub.status === 'CANCELED') return { ...base, state: 'CANCELED', readOnly: true, daysLeft: 0 };
  if (t < end) return { ...base, state: 'ACTIVE', readOnly: false, daysLeft: left(graceEnd) };
  if (t < graceEnd) return { ...base, state: 'GRACE', readOnly: false, daysLeft: left(graceEnd) };
  return { ...base, state: 'EXPIRED', readOnly: true, daysLeft: 0 };
}

/** Error uniforme cuando la cuenta está en solo lectura (HTTP 402). */
export function readOnlyError(access: SubscriptionAccess) {
  const message =
    access.state === 'CANCELED'
      ? 'La suscripción está cancelada. La cuenta queda en solo lectura.'
      : 'Tu periodo de prueba o tu plan venció. Puedes consultar tus datos, pero para seguir operando renueva tu plan.';
  return new HttpException({ code: 'SUBSCRIPTION_EXPIRED', message, access }, HttpStatus.PAYMENT_REQUIRED);
}

/** Suma meses de calendario en UTC; si el día no existe (31 → febrero) usa el último del mes. */
export function addMonths(d: Date, months: number): Date {
  const r = new Date(d.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + months);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}
