import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { currentPeriod } from '../plans/plan-limits.js';
import { subscriptionAccess, type AccessState } from '../plans/subscription-access.js';

/**
 * Métricas del panel general. Todo sale de la base de datos con el rol de
 * sistema; el estado de cada suscripción se CALCULA con sus fechas (el campo
 * guardado puede decir ACTIVE aunque el periodo ya venció).
 */
@Injectable()
export class PlatformMetricsService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async overview() {
    const db = this.db.system;
    const now = new Date();
    const since30 = new Date(now.getTime() - 30 * 86_400_000);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [tenants, subs, users, revenueMonth, revenue30, aiUsage, messages30, inbound30, automations, orders30, conversations30, waErrors, inboundFailed] = await Promise.all([
      db.tenant.groupBy({ by: ['status'], _count: { _all: true } }),
      db.subscription.findMany({ select: { status: true, trialEndsAt: true, currentPeriodEnd: true, plan: { select: { code: true } }, tenant: { select: { status: true } } } }),
      db.user.count({ where: { tenantId: { not: null }, status: 'ACTIVE' } }),
      db.payment.groupBy({ by: ['currency'], where: { paidAt: { gte: monthStart } }, _sum: { amount: true }, _count: { _all: true } }),
      db.payment.groupBy({ by: ['currency'], where: { paidAt: { gte: since30 } }, _sum: { amount: true }, _count: { _all: true } }),
      db.usageCounter.groupBy({ by: ['metric'], where: { period: currentPeriod(), metric: { in: ['ai_replies', 'ai_tokens', 'conversations'] } }, _sum: { value: true } }),
      db.message.count({ where: { createdAt: { gte: since30 } } }),
      db.message.count({ where: { createdAt: { gte: since30 }, direction: 'INBOUND' } }),
      db.automationEvent.groupBy({ by: ['status'], where: { createdAt: { gte: since30 } }, _count: { _all: true } }),
      db.order.count({ where: { createdAt: { gte: since30 }, status: { not: 'CANCELLED' } } }),
      db.conversation.count({ where: { createdAt: { gte: since30 } } }),
      db.whatsappNumber.count({ where: { OR: [{ status: 'ERROR' }, { status: 'DISCONNECTED' }] } }),
      db.inboundEvent.count({ where: { status: 'FAILED', receivedAt: { gte: since30 } } }),
    ]);
    const byAccess: Record<AccessState, number> = { TRIAL: 0, ACTIVE: 0, GRACE: 0, EXPIRED: 0, CANCELED: 0 };
    const byPlan: Record<string, number> = {};
    for (const s of subs) {
      byAccess[subscriptionAccess(s, this.env.BILLING_GRACE_DAYS, now).state]++;
      byPlan[s.plan.code] = (byPlan[s.plan.code] ?? 0) + 1;
    }
    const total = tenants.reduce((n, t) => n + t._count._all, 0);
    const suspended = tenants.find((t) => t.status === 'SUSPENDED')?._count._all ?? 0;
    const money = (rows: typeof revenueMonth) => rows.map((r) => ({ currency: r.currency, amount: Number(r._sum.amount ?? 0).toFixed(2), payments: r._count._all }));
    const usage = Object.fromEntries(aiUsage.map((u) => [u.metric, u._sum.value ?? 0]));
    const ev = Object.fromEntries(automations.map((a) => [a.status, a._count._all]));
    return {
      tenants: { total, active: total - suspended, suspended },
      subscriptions: { ...byAccess, byPlan },
      /** Empresas que deben renovar: en gracia o ya en solo lectura (excepto canceladas) */
      pendingRenewals: byAccess.GRACE + byAccess.EXPIRED,
      activeUsers: users,
      revenue: { thisMonth: money(revenueMonth), last30Days: money(revenue30) },
      ai: { period: currentPeriod(), replies: usage.ai_replies ?? 0, tokens: usage.ai_tokens ?? 0 },
      last30Days: { messages: messages30, inboundMessages: inbound30, orders: orders30, conversations: conversations30, automations: { sent: ev.SENT ?? 0, pending: ev.PENDING ?? 0, failed: ev.FAILED ?? 0 } },
      errors: { whatsappNumbers: waErrors, inboundEventsFailed: inboundFailed, automationsFailed: ev.FAILED ?? 0 },
    };
  }

  /** Consumo y errores de una empresa (detalle en el panel general). */
  async tenantUsage(tenantId: string) {
    const db = this.db.system;
    const since30 = new Date(Date.now() - 30 * 86_400_000);
    const [usage, messages, orders, automationsFailed] = await Promise.all([
      db.usageCounter.findMany({ where: { tenantId, period: currentPeriod() }, select: { metric: true, value: true } }),
      db.message.count({ where: { tenantId, createdAt: { gte: since30 } } }),
      db.order.groupBy({ by: ['status'], where: { tenantId, createdAt: { gte: since30 } }, _count: { _all: true } }),
      db.automationEvent.count({ where: { tenantId, status: 'FAILED', createdAt: { gte: since30 } } }),
    ]);
    return {
      period: currentPeriod(),
      counters: Object.fromEntries(usage.map((u) => [u.metric, u.value])),
      last30Days: { messages, orders: Object.fromEntries(orders.map((o) => [o.status, o._count._all])), automationsFailed },
    };
  }
}
