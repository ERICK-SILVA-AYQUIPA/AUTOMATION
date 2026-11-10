import { Body, Controller, Get, Patch } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { DatabaseService } from '../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { currentPeriod, getPlanLimits } from '../plans/plan-limits.js';

const updateTenantSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    timezone: z.string().min(3).max(64).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nada que actualizar');

/** Datos de la empresa del usuario autenticado (siempre la suya: RLS). */
@Controller('tenant')
export class TenantsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermission('tenant:read')
  @Get()
  get(@TenantUser() p: TenantPrincipal) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: p.tenantId },
        include: { subscription: { include: { plan: { select: { code: true, name: true, priceMonthly: true, currency: true } } } } },
      });
      const limits = await getPlanLimits(tx);
      const period = currentPeriod();
      const [users, products, numbers, usage] = await Promise.all([
        tx.user.count({ where: { status: { not: 'DISABLED' } } }),
        tx.product.count({ where: { status: { not: 'ARCHIVED' } } }),
        tx.whatsappNumber.count(),
        tx.usageCounter.findMany({ where: { period } }),
      ]);
      return {
        ...tenant,
        limits,
        usage: {
          period,
          users,
          products,
          whatsappNumbers: numbers,
          ...Object.fromEntries(usage.map((u) => [u.metric, u.value])),
        },
      };
    });
  }

  @RequirePermission('tenant:settings')
  @Patch()
  update(@TenantUser() p: TenantPrincipal, @Body({ schema: updateTenantSchema }) body: z.infer<typeof updateTenantSchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const t = await tx.tenant.update({ where: { id: p.tenantId }, data: body });
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'tenant.updated', entityType: 'tenant', entityId: p.tenantId, metadata: body });
      return t;
    });
  }
}
