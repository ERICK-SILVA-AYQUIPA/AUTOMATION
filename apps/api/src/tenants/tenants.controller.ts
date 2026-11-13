import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { subscriptionAccess } from '../plans/subscription-access.js';
import { z } from 'zod';
import { RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { DatabaseService } from '../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { currentPeriod, getPlanLimits } from '../plans/plan-limits.js';
import { computeOnboarding } from './onboarding.js';

/** Perfil que la empresa edita por sí misma (dominio, modalidad y módulos los fija la plataforma). */
export const tenantProfileSchema = z.object({
  name: z.string().trim().min(2).max(120),
  currency: z.string().regex(/^[A-Z]{3}$/),
  timezone: z.string().min(3).max(64).refine((tz) => Intl.supportedValuesOf('timeZone').includes(tz) || tz === 'UTC', 'Zona horaria no válida'),
  legalName: z.string().trim().max(200).nullable(),
  /** RUC peruano (11 dígitos) u otro identificador fiscal si el país no es PE */
  taxId: z.string().trim().max(30).nullable(),
  country: z.string().regex(/^[A-Z]{2}$/),
  address: z.string().trim().max(300).nullable(),
  phone: z.string().trim().max(30).nullable(),
  contactEmail: z.email().max(200).nullable(),
  businessType: z.enum(['RETAIL', 'RESTAURANT', 'DISTRIBUTOR', 'SERVICES', 'PHARMACY', 'OTHER']),
  logoUrl: z.url({ protocol: /^https$/ }).max(500).nullable(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
});
const updateTenantSchema = tenantProfileSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nada que actualizar')
  .refine((v) => !(v.country === 'PE' && v.taxId && !/^(10|15|17|20)\d{9}$/.test(v.taxId)), { message: 'El RUC debe tener 11 dígitos y empezar por 10, 15, 17 o 20', path: ['taxId'] });

/** Datos de la empresa del usuario autenticado (siempre la suya: RLS). */
@Controller('tenant')
export class TenantsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
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
        subscription: tenant.subscription && { ...tenant.subscription, access: subscriptionAccess(tenant.subscription, this.env.BILLING_GRACE_DAYS) },
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

  /** Puesta en marcha: qué falta para que la plataforma active la empresa (ADR 039) */
  @RequirePermission('tenant:read')
  @Get('onboarding')
  onboarding(@TenantUser() p: TenantPrincipal) {
    return this.db.tenant(p.tenantId, (tx) =>
      computeOnboarding(tx, p.tenantId, { graceDays: this.env.BILLING_GRACE_DAYS, aiProviderConfigured: !!this.env.GEMINI_API_KEY, checkInvitations: false }),
    );
  }

  /** Pagos registrados por la plataforma (solo lectura; solo el administrador de la empresa) */
  @RequirePermission('tenant:settings')
  @Get('payments')
  payments(@TenantUser() p: TenantPrincipal) {
    return this.db.tenant(p.tenantId, (tx) =>
      tx.payment.findMany({
        orderBy: { paidAt: 'desc' },
        take: 50,
        select: { id: true, amount: true, currency: true, months: true, method: true, reference: true, paidAt: true, periodStart: true, periodEnd: true, plan: { select: { code: true, name: true } } },
      }),
    );
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
