import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, RequirePermission } from '../common/decorators/auth.decorators.js';
import type { Principal } from '../common/context/principal.js';
import { DatabaseService } from '../database/database.service.js';
import { IntegrationChecks, PLATFORM_SERVICES, type PlatformService } from './integration-checks.service.js';

const serviceParam = { schema: z.enum(Object.keys(PLATFORM_SERVICES) as [PlatformService, ...PlatformService[]]) };
const DAY = 24 * 3600 * 1000;

/** Integraciones del servidor para el administrador general (ADR 042). Nunca devuelve valores de secretos. */
@RequirePermission('platform:manage')
@Controller('platform/integrations')
export class PlatformIntegrationsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly checks: IntegrationChecks,
  ) {}

  @Get()
  async overview() {
    const sys = this.db.system;
    const since = new Date(Date.now() - 7 * DAY);
    const [last, recentErrors, waByStatus, failedAutomations, failedWebhooks, tenantErrors] = await Promise.all([
      sys.$queryRaw<{ service: string; ok: boolean; detail: string | null; latency_ms: number | null; created_at: Date }[]>`
        SELECT DISTINCT ON (service) service, ok, detail, latency_ms, created_at FROM integration_checks WHERE tenant_id IS NULL ORDER BY service, created_at DESC`,
      sys.integrationCheck.findMany({ where: { tenantId: null, ok: false }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, service: true, detail: true, createdAt: true } }),
      sys.whatsappNumber.groupBy({ by: ['status'], where: { isActive: true }, _count: { _all: true } }),
      sys.automationEvent.count({ where: { status: 'FAILED', createdAt: { gte: since } } }),
      sys.webhookDelivery.count({ where: { status: 'FAILED', createdAt: { gte: since } } }),
      sys.whatsappNumber.findMany({ where: { isActive: true, status: 'ERROR' }, take: 20, select: { displayPhone: true, lastError: true, updatedAt: true, tenantId: true } }),
    ]);
    const names = await sys.tenant.findMany({ where: { id: { in: [...new Set(tenantErrors.map((n) => n.tenantId))] } }, select: { id: true, name: true } });
    return {
      services: (Object.keys(PLATFORM_SERVICES) as PlatformService[]).map((key) => {
        const c = last.find((x) => x.service === key);
        return {
          key, ...PLATFORM_SERVICES[key], configured: this.checks.configured(key),
          lastCheck: c ? { ok: c.ok, detail: c.detail, ms: c.latency_ms, at: c.created_at } : null,
        };
      }),
      payments: { provider: null, detail: 'Cobro manual (ADR 036): no hay proveedor de pagos configurado ni cobros automáticos.' },
      whatsapp: { numbers: Object.fromEntries(waByStatus.map((g) => [g.status, g._count._all])), errors: tenantErrors.map((n) => ({ tenant: names.find((t) => t.id === n.tenantId) ?? { id: n.tenantId, name: '' }, displayPhone: n.displayPhone, error: n.lastError, at: n.updatedAt })) },
      last7Days: { failedAutomations, failedWebhooks },
      recentErrors,
    };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post(':service/test')
  async test(@CurrentUser() u: Principal, @Param('service', serviceParam) service: PlatformService) {
    const r = await this.checks.runPlatform(service);
    if (this.checks.configured(service)) await this.checks.record(null, service, r, u.userId);
    await this.audit.system({ tenantId: null, userId: u.userId, action: 'platform.integration_tested', entityType: 'integration', metadata: { service, ok: r.ok } });
    return r;
  }
}
