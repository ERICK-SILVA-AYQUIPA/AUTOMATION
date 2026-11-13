import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ProvisioningService, provisionSchema, type ProvisionInput } from './provisioning.service.js';
import { ENV, type Env } from '../config/env.js';
import { addMonths, subscriptionAccess } from '../plans/subscription-access.js';
import { PlatformMetricsService } from './platform-metrics.service.js';
import { tenantProfileSchema } from '../tenants/tenants.controller.js';
import { MODULES } from '../common/decorators/module.decorator.js';
import { planLimitsSchema } from '../plans/plan-limits.js';
import type { Prisma } from '../generated/prisma/client.js';
import { z } from 'zod';
import { CurrentUser, RequirePermission } from '../common/decorators/auth.decorators.js';
import type { Principal } from '../common/context/principal.js';
import { DatabaseService } from '../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ONBOARDING']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const statusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: z.string().trim().max(500).optional() });
const planSchema = z.object({ planCode: z.enum(['BASIC', 'PROFESSIONAL', 'ENTERPRISE']) });
const paymentSchema = z.object({
  planCode: z.enum(['BASIC', 'PROFESSIONAL', 'ENTERPRISE']),
  months: z.number().int().min(1).max(24),
  amount: z.number().nonnegative().max(1_000_000).multipleOf(0.01),
  currency: z.string().regex(/^[A-Z]{3}$/).default('PEN'),
  method: z.enum(['YAPE', 'PLIN', 'BANK_TRANSFER', 'CASH', 'OTHER']),
  reference: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(500).optional(),
  /** Fecha del pago; por defecto ahora. No puede ser futura. */
  paidAt: z.coerce.date().optional(),
});
const cancelSchema = z.object({ reason: z.string().trim().max(500).optional() });
/** La plataforma edita además lo que la empresa no puede: dominio, modalidad y módulos */
const platformTenantSchema = tenantProfileSchema
  .extend({
    customDomain: z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'Dominio no válido').max(253).nullable(),
    deploymentMode: z.enum(['SAAS', 'DEDICATED', 'CUSTOM']),
    enabledModules: z.array(z.enum(MODULES)).max(MODULES.length),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nada que actualizar');
const planUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    priceMonthly: z.number().nonnegative().max(1_000_000).multipleOf(0.01),
    currency: z.string().regex(/^[A-Z]{3}$/),
    limits: planLimitsSchema,
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nada que actualizar');

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
    @Inject(ENV) private readonly env: Env,
    private readonly metricsService: PlatformMetricsService,
    private readonly provisioning: ProvisioningService,
  ) {}

  /** Asistente de alta: idempotente por `idempotencyKey`; la empresa nace en preparación (ADR 039). */
  @Post('tenants')
  async provision(@CurrentUser() p: Principal, @Body({ schema: provisionSchema }) body: ProvisionInput, @Res({ passthrough: true }) res: Response) {
    const r = await this.provisioning.provision(p.userId, body);
    res.status(r.created ? 201 : 200);
    return r;
  }

  @Get('tenants/:id/onboarding')
  async onboarding(@Param('id', { schema: z.uuid() }) id: string) {
    const t = await this.db.system.tenant.findUnique({ where: { id }, select: { id: true } });
    if (!t) throw new NotFoundException('Empresa no encontrada');
    return this.provisioning.onboarding(id);
  }

  @Post('tenants/:id/activate')
  activate(@CurrentUser() p: Principal, @Param('id', { schema: z.uuid() }) id: string) {
    return this.provisioning.activate(p.userId, id);
  }

  @Post('tenants/:id/resend-invitation')
  resend(@Param('id', { schema: z.uuid() }) id: string) {
    return this.provisioning.resendInvitations(id);
  }

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
    return {
      items: items.map((t) => ({ ...t, subscription: t.subscription && { ...t.subscription, access: subscriptionAccess(t.subscription, this.env.BILLING_GRACE_DAYS) } })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  @Patch('tenants/:id/status')
  async setStatus(@CurrentUser() p: Principal, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: statusSchema }) body: z.infer<typeof statusSchema>) {
    const current = await this.db.system.tenant.findUnique({ where: { id }, select: { activatedAt: true } });
    if (!current) throw new NotFoundException('Empresa no encontrada');
    // Reactivar una empresa que nunca se activó la devuelve a preparación (no se salta la lista de tareas)
    const status = body.status === 'ACTIVE' && !current.activatedAt ? 'ONBOARDING' : body.status;
    const t = await this.db.system.tenant.update({ where: { id }, data: { status } });
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

  /**
   * Registra un pago manual (Yape, transferencia...) y activa o renueva el plan.
   * Si el periodo pagado sigue vigente, los meses se suman a continuación; si no,
   * el nuevo periodo empieza hoy. Todo en una transacción con la fila bloqueada
   * para que dos registros simultáneos no calculen el mismo periodo.
   */
  @Post('tenants/:id/payments')
  async recordPayment(@CurrentUser() p: Principal, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: paymentSchema }) body: z.infer<typeof paymentSchema>) {
    const now = new Date();
    const paidAt = body.paidAt ?? now;
    if (paidAt.getTime() > now.getTime() + 60_000) throw new BadRequestException('La fecha del pago no puede ser futura');
    const result = await this.db.system.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM subscriptions WHERE tenant_id = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Empresa no encontrada');
      const sub = await tx.subscription.findUniqueOrThrow({ where: { tenantId: id } });
      const plan = await tx.plan.findUniqueOrThrow({ where: { code: body.planCode } });
      const extending = sub.status === 'ACTIVE' && sub.currentPeriodEnd > now;
      const periodStart = extending ? sub.currentPeriodEnd : now;
      const periodEnd = addMonths(periodStart, body.months);
      const payment = await tx.payment.create({
        data: {
          tenantId: id, planId: plan.id, amount: body.amount, currency: body.currency, months: body.months, method: body.method,
          reference: body.reference || null, notes: body.notes || null, paidAt, periodStart, periodEnd, recordedById: p.userId,
        },
      });
      const updated = await tx.subscription.update({
        where: { tenantId: id },
        data: {
          planId: plan.id, status: 'ACTIVE', currentPeriodEnd: periodEnd, paymentProvider: 'manual', paymentProviderRef: payment.id,
          ...(extending ? {} : { currentPeriodStart: periodStart }),
        },
        include: { plan: { select: { code: true, name: true } } },
      });
      await tx.auditLog.create({
        data: {
          tenantId: id, userId: p.userId, action: 'platform.payment_recorded', entityType: 'payment', entityId: payment.id,
          metadata: { planCode: body.planCode, months: body.months, amount: body.amount, currency: body.currency, method: body.method, reference: body.reference ?? null, periodStart, periodEnd },
        },
      });
      return { payment, subscription: { ...updated, access: subscriptionAccess(updated, this.env.BILLING_GRACE_DAYS) } };
    });
    return result;
  }

  @Get('plans')
  plans() {
    return this.db.system.plan.findMany({ where: { isActive: true }, orderBy: { priceMonthly: 'asc' }, select: { code: true, name: true, priceMonthly: true, currency: true } });
  }

  @Get('tenants/:id/payments')
  async payments(@Param('id', { schema: z.uuid() }) id: string) {
    return this.db.system.payment.findMany({
      where: { tenantId: id },
      orderBy: { paidAt: 'desc' },
      take: 100,
      include: { plan: { select: { code: true, name: true } } },
    });
  }

  /** Cancela la suscripción: la cuenta pasa a solo lectura de inmediato. */
  @Post('tenants/:id/cancel-subscription')
  async cancel(@CurrentUser() p: Principal, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: cancelSchema }) body: z.infer<typeof cancelSchema>) {
    const sub = await this.db.system.subscription.update({ where: { tenantId: id }, data: { status: 'CANCELED' } }).catch(() => null);
    if (!sub) throw new NotFoundException('Empresa no encontrada');
    await this.audit.system({ tenantId: id, userId: p.userId, action: 'platform.subscription_canceled', entityType: 'subscription', entityId: sub.id, metadata: { reason: body.reason ?? null } });
    return { ...sub, access: subscriptionAccess(sub, this.env.BILLING_GRACE_DAYS) };
  }

  @Get('metrics')
  metrics() {
    return this.metricsService.overview();
  }

  @Get('tenants/:id')
  async tenant(@Param('id', { schema: z.uuid() }) id: string) {
    const t = await this.db.system.tenant.findUnique({
      where: { id },
      include: {
        subscription: { include: { plan: { select: { code: true, name: true, priceMonthly: true, currency: true } } } },
        users: { where: { role: 'TENANT_ADMIN' }, select: { id: true, name: true, email: true, status: true, emailVerifiedAt: true } },
        _count: { select: { users: true } },
      },
    });
    if (!t) throw new NotFoundException('Empresa no encontrada');
    const [numbers, integrations, usage] = await Promise.all([
      this.db.system.whatsappNumber.findMany({ where: { tenantId: id }, select: { id: true, displayPhone: true, status: true, lastError: true, lastWebhookAt: true, isActive: true } }),
      this.db.system.tenantIntegration.findMany({ where: { tenantId: id }, select: { type: true, status: true, lastError: true, updatedAt: true } }),
      this.metricsService.tenantUsage(id),
    ]);
    return {
      ...t,
      subscription: t.subscription && { ...t.subscription, access: subscriptionAccess(t.subscription, this.env.BILLING_GRACE_DAYS) },
      whatsappNumbers: numbers,
      integrations,
      usage,
    };
  }

  @Patch('tenants/:id')
  async updateTenant(@CurrentUser() p: Principal, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: platformTenantSchema }) body: z.infer<typeof platformTenantSchema>) {
    const data: Prisma.TenantUpdateInput = { ...body, ...(body.enabledModules ? { enabledModules: [...new Set(body.enabledModules)] } : {}) };
    const t = await this.db.system.tenant.update({ where: { id }, data }).catch((e: { code?: string }) => {
      if (e.code === 'P2002') throw new BadRequestException('Ese dominio ya lo usa otra empresa');
      return null;
    });
    if (!t) throw new NotFoundException('Empresa no encontrada');
    await this.audit.system({ tenantId: id, userId: p.userId, action: 'platform.tenant_updated', entityType: 'tenant', entityId: id, metadata: body });
    return t;
  }

  @Get('plans/all')
  allPlans() {
    return this.db.system.plan.findMany({ orderBy: { priceMonthly: 'asc' }, include: { _count: { select: { subscriptions: true } } } });
  }

  /** Precios, moneda y límites de cada plan: los decide el dueño de la plataforma, no el código. */
  @Patch('plans/:code')
  async updatePlan(@CurrentUser() p: Principal, @Param('code', { schema: z.enum(['BASIC', 'PROFESSIONAL', 'ENTERPRISE']) }) code: 'BASIC' | 'PROFESSIONAL' | 'ENTERPRISE', @Body({ schema: planUpdateSchema }) body: z.infer<typeof planUpdateSchema>) {
    const before = await this.db.system.plan.findUniqueOrThrow({ where: { code } });
    const plan = await this.db.system.plan.update({ where: { code }, data: body });
    await this.audit.system({ tenantId: null, userId: p.userId, action: 'platform.plan_updated', entityType: 'plan', entityId: plan.id, metadata: { code, before: { priceMonthly: before.priceMonthly.toString(), currency: before.currency, limits: before.limits }, after: body } });
    return plan;
  }
}
