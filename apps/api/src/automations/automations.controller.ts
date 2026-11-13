import { Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import { RequireModule } from '../common/decorators/module.decorator.js';
import { paged, paginationSchema } from '../common/pagination.js';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { AutomationEventStatus, AutomationKey, type Prisma } from '../generated/prisma/client.js';
import { planLimitsSchema } from '../plans/plan-limits.js';
import { AutomationEvents } from './automation-events.service.js';
import { CATALOG, catalogEntry, effectiveConfig, mergeConfig, type CatalogEntry } from './catalog.js';

const keyParam = { schema: z.enum(AutomationKey) };
const updateSchema = z
  .object({ enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional() })
  .strict()
  .refine((v) => v.enabled !== undefined || v.config !== undefined, 'Nada que actualizar');
const eventsQuery = paginationSchema.extend({ key: z.enum(AutomationKey).optional(), status: z.enum(AutomationEventStatus).optional() });

/**
 * Automatizaciones de la empresa (ADR 040): catálogo con su estado,
 * configuración validada por el catálogo, historial y reintento manual.
 * La empresa activa y configura; los flujos no se editan desde aquí.
 */
@RequireModule('automations')
@Controller('automations')
export class AutomationsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly events: AutomationEvents,
  ) {}

  @RequirePermission('automations:manage')
  @Get()
  list(@TenantUser() p: TenantPrincipal) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const [rows, ctx, stats] = await Promise.all([
        tx.automation.findMany(),
        this.tenantContext(tx, p.tenantId),
        tx.automationEvent.groupBy({ by: ['key', 'status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      ]);
      return {
        n8nConfigured: this.events.n8nConfigured,
        items: CATALOG.map((e) => {
          const row = rows.find((r) => r.key === e.key);
          const version = row?.version ?? e.version;
          const counts = Object.fromEntries(stats.filter((s) => s.key === e.key).map((s) => [s.status, s._count._all]));
          return {
            key: e.key, name: e.name, description: e.description, executor: e.executor, audience: e.audience, module: e.module,
            enabled: row ? row.isEnabled : e.defaultEnabled,
            config: effectiveConfig(e, row?.config), fields: e.fields,
            moduleEnabled: ctx.modules.includes(e.module),
            featureAvailable: !e.feature || ctx.features.includes(e.feature),
            version, latestVersion: e.version, updateAvailable: version < e.version,
            pendingChanges: Object.entries(e.changelog).filter(([v]) => Number(v) > version).map(([v, text]) => ({ version: Number(v), text })),
            workflowFile: e.workflowFile ?? null,
            updatedAt: row?.updatedAt ?? null,
            stats30d: { SENT: counts.SENT ?? 0, FAILED: counts.FAILED ?? 0, SKIPPED: counts.SKIPPED ?? 0, PENDING: counts.PENDING ?? 0 },
          };
        }),
      };
    });
  }

  @RequirePermission('automations:manage')
  @Patch(':key')
  update(@TenantUser() p: TenantPrincipal, @Param('key', keyParam) key: AutomationKey, @Body({ schema: updateSchema }) body: z.infer<typeof updateSchema>) {
    const entry = this.entry(key);
    return this.db.tenant(p.tenantId, async (tx) => {
      const row = await tx.automation.findUnique({ where: { tenantId_key: { tenantId: p.tenantId, key } } });
      if (body.enabled) await this.assertCanEnable(tx, p.tenantId, entry);
      const data: Prisma.AutomationUncheckedUpdateInput = { updatedById: p.userId };
      if (body.enabled !== undefined) data.isEnabled = body.enabled;
      if (body.config) {
        // Se valida la configuración completa: lo enviado sobre lo guardado y los valores del catálogo
        const unknownKeys = Object.keys(body.config).filter((k) => !(k in entry.defaults));
        const parsed = unknownKeys.length
          ? entry.schema.safeParse(body.config)
          : entry.schema.safeParse(pick(effectiveConfig(entry, mergeConfig(row?.config, body.config)), entry));
        if (!parsed.success) throw new ConflictException({ code: 'INVALID_CONFIG', message: 'La configuración no es válida', errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
        data.config = parsed.data as Prisma.InputJsonValue;
        // Guardar desde el formulario actual equivale a aceptar la versión actual del catálogo
        data.version = entry.version;
      }
      const saved = row
        ? await tx.automation.update({ where: { id: row.id }, data })
        : await tx.automation.create({ data: { tenantId: p.tenantId, key, isEnabled: body.enabled ?? entry.defaultEnabled, config: (data.config ?? {}) as Prisma.InputJsonValue, version: (data.version as number | undefined) ?? 1, updatedById: p.userId } });
      await this.audit.inTx(tx, {
        tenantId: p.tenantId, userId: p.userId, action: 'automation.updated', entityType: 'automation', entityId: saved.id,
        metadata: { key, ...(body.enabled !== undefined ? { enabled: body.enabled } : {}), ...(body.config ? { config: data.config as Prisma.InputJsonValue } : {}) },
      });
      return { key, enabled: saved.isEnabled, config: effectiveConfig(entry, saved.config), version: saved.version };
    });
  }

  /** Aplica la versión nueva del catálogo conservando lo que la empresa personalizó */
  @RequirePermission('automations:manage')
  @Post(':key/upgrade')
  upgrade(@TenantUser() p: TenantPrincipal, @Param('key', keyParam) key: AutomationKey) {
    const entry = this.entry(key);
    return this.db.tenant(p.tenantId, async (tx) => {
      const row = await tx.automation.findUnique({ where: { tenantId_key: { tenantId: p.tenantId, key } } });
      if (!row) throw new NotFoundException('Automatización no encontrada');
      if (row.version >= entry.version) return { key, version: row.version, upgraded: false };
      const parsed = entry.schema.safeParse(pick(effectiveConfig(entry, row.config), entry));
      if (!parsed.success) throw new ConflictException({ code: 'INVALID_CONFIG', message: 'La configuración guardada no encaja con la versión nueva: revísala y guárdala desde el formulario' });
      await tx.automation.update({ where: { id: row.id }, data: { config: parsed.data as Prisma.InputJsonValue, version: entry.version, updatedById: p.userId } });
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'automation.upgraded', entityType: 'automation', entityId: row.id, metadata: { key, from: row.version, to: entry.version } });
      return { key, version: entry.version, upgraded: true };
    });
  }

  @RequirePermission('automations:manage')
  @Get('events')
  history(@TenantUser() p: TenantPrincipal, @Query({ schema: eventsQuery }) q: z.infer<typeof eventsQuery>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const where: Prisma.AutomationEventWhereInput = { ...(q.key ? { key: q.key } : {}), ...(q.status ? { status: q.status } : {}) };
      const [items, total] = await Promise.all([
        tx.automationEvent.findMany({
          where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
          select: { id: true, key: true, status: true, attempts: true, lastError: true, payload: true, createdAt: true, sentAt: true, nextAttemptAt: true, retriedById: true },
        }),
        tx.automationEvent.count({ where }),
      ]);
      return paged(items.map((i) => ({ ...i, name: catalogEntry(i.key)?.name ?? i.key })), total, q.page, q.pageSize);
    });
  }

  /** Reintento manual de un evento fallido u omitido: vuelve a la cola con los intentos a cero */
  @RequirePermission('automations:manage')
  @Post('events/:id/retry')
  retry(@TenantUser() p: TenantPrincipal, @Param('id', { schema: z.uuid() }) id: string) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const ev = await tx.automationEvent.findUnique({ where: { id }, select: { id: true, key: true, status: true } });
      if (!ev) throw new NotFoundException('Evento no encontrado');
      if (ev.status !== 'FAILED' && ev.status !== 'SKIPPED') throw new ConflictException({ code: 'NOT_RETRYABLE', message: 'Solo se reintentan eventos fallidos u omitidos' });
      const entry = this.entry(ev.key);
      const row = await tx.automation.findUnique({ where: { tenantId_key: { tenantId: p.tenantId, key: ev.key } }, select: { isEnabled: true } });
      if (!(row ? row.isEnabled : entry.defaultEnabled)) throw new ConflictException({ code: 'AUTOMATION_DISABLED', message: 'Activa la automatización antes de reintentar' });
      await this.assertCanEnable(tx, p.tenantId, entry);
      if (entry.executor === 'n8n' && !this.events.n8nConfigured) throw new ConflictException({ code: 'N8N_NOT_CONFIGURED', message: 'n8n no está configurado en el servidor: el reintento volvería a omitirse' });
      // Condición sobre el estado: dos reintentos simultáneos no lo encolan dos veces
      const r = await tx.automationEvent.updateMany({
        where: { id, status: { in: ['FAILED', 'SKIPPED'] } },
        data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null, retriedById: p.userId },
      });
      if (r.count === 0) throw new ConflictException({ code: 'NOT_RETRYABLE', message: 'El evento ya se reintentó' });
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'automation.event_retried', entityType: 'automation_event', entityId: id, metadata: { key: ev.key, previous: ev.status } });
      return { id, status: 'PENDING' as const };
    });
  }

  private entry(key: AutomationKey): CatalogEntry {
    const e = catalogEntry(key);
    if (!e) throw new NotFoundException('Automatización no encontrada');
    return e;
  }

  private async tenantContext(tx: Tx, tenantId: string) {
    const [tenant, sub] = await Promise.all([
      tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { enabledModules: true } }),
      tx.subscription.findFirst({ select: { plan: { select: { limits: true } } } }),
    ]);
    const limits = sub ? planLimitsSchema.safeParse(sub.plan.limits) : null;
    return { modules: tenant.enabledModules, features: limits?.success ? limits.data.features : [] };
  }

  private async assertCanEnable(tx: Tx, tenantId: string, entry: CatalogEntry) {
    const ctx = await this.tenantContext(tx, tenantId);
    if (!ctx.modules.includes(entry.module)) throw new ConflictException({ code: 'MODULE_DISABLED', message: 'El módulo que usa esta automatización no está activado para tu empresa' });
    if (entry.feature && !ctx.features.includes(entry.feature)) throw new ForbiddenException({ code: 'PLAN_FEATURE', message: 'Tu plan no incluye esta automatización. Mejora tu plan para activarla.' });
  }
}

/** Solo las claves que conoce el catálogo (lo obsoleto de versiones anteriores se descarta) */
function pick(cfg: Record<string, unknown>, entry: CatalogEntry) {
  return Object.fromEntries(Object.entries(cfg).filter(([k]) => k in entry.defaults));
}
