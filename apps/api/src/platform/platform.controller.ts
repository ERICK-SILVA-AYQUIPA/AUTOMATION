import { Body, Controller, Get, NotFoundException, Param, Patch, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, RequirePermission } from '../common/decorators/auth.decorators.js';
import type { Principal } from '../common/context/principal.js';
import { DatabaseService } from '../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const statusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: z.string().trim().max(500).optional() });
const planSchema = z.object({ planCode: z.enum(['BASIC', 'PROFESSIONAL', 'ENTERPRISE']) });

/**
 * Panel del ADMINISTRADOR GENERAL. Única zona que usa el rol de sistema para
 * leer datos de varias empresas; protegida por el permiso platform:manage.
 */
@RequirePermission('platform:manage')
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  @Get('tenants')
  async tenants(@Query({ schema: listSchema }) q: z.infer<typeof listSchema>) {
    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' as const } }, { slug: { contains: q.q.toLowerCase() } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.db.system.tenant.findMany({
        where,
        include: { subscription: { include: { plan: { select: { code: true, name: true } } } }, _count: { select: { users: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.db.system.tenant.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  @Patch('tenants/:id/status')
  async setStatus(@CurrentUser() p: Principal, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: statusSchema }) body: z.infer<typeof statusSchema>) {
    const t = await this.db.system.tenant.update({ where: { id }, data: { status: body.status } }).catch(() => null);
    if (!t) throw new NotFoundException('Empresa no encontrada');
    await this.audit.system({ tenantId: id, userId: p.userId, action: `platform.tenant_${body.status.toLowerCase()}`, entityType: 'tenant', entityId: id, metadata: { reason: body.reason ?? null } });
    return t;
  }

  /** Cambio de plan manual (sin cobro: no hay proveedor de pagos configurado). */
  @Patch('tenants/:id/plan')
  async setPlan(@CurrentUser() p: Principal, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: planSchema }) body: z.infer<typeof planSchema>) {
    const plan = await this.db.system.plan.findUniqueOrThrow({ where: { code: body.planCode } });
    const sub = await this.db.system.subscription.update({ where: { tenantId: id }, data: { planId: plan.id } }).catch(() => null);
    if (!sub) throw new NotFoundException('Empresa no encontrada');
    await this.audit.system({ tenantId: id, userId: p.userId, action: 'platform.plan_changed', entityType: 'subscription', entityId: sub.id, metadata: { planCode: body.planCode } });
    return sub;
  }

  @Get('metrics')
  async metrics() {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [tenants, active, users, byPlan, orders30d, conversations30d] = await Promise.all([
      this.db.system.tenant.count(),
      this.db.system.tenant.count({ where: { status: 'ACTIVE' } }),
      this.db.system.user.count({ where: { tenantId: { not: null }, status: 'ACTIVE' } }),
      this.db.system.subscription.groupBy({ by: ['planId', 'status'], _count: { _all: true } }),
      this.db.system.order.count({ where: { createdAt: { gte: since }, status: { not: 'CANCELLED' } } }),
      this.db.system.conversation.count({ where: { createdAt: { gte: since } } }),
    ]);
    const plans = await this.db.system.plan.findMany({ select: { id: true, code: true } });
    const code = new Map(plans.map((p) => [p.id, p.code]));
    return {
      tenants: { total: tenants, active, suspended: tenants - active },
      activeUsers: users,
      subscriptions: byPlan.map((b) => ({ plan: code.get(b.planId), status: b.status, count: b._count._all })),
      last30Days: { orders: orders30d, conversations: conversations30d },
    };
  }
}
