import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { encrypt, randomToken } from '../common/crypto/crypto.js';
import { RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import { OutboundError, validateTargetUrl } from '../common/net/outbound.js';
import { paged, paginationSchema } from '../common/pagination.js';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { pingEndpoint } from '../integrations/integrations.controller.js';
import { WEBHOOK_EVENTS } from './webhook-events.service.js';
import { WebhookSender } from './webhook-sender.js';

const MAX_ENDPOINTS = 5;
const events = z.array(z.enum(Object.keys(WEBHOOK_EVENTS) as [keyof typeof WEBHOOK_EVENTS, ...(keyof typeof WEBHOOK_EVENTS)[]])).min(1).max(10);
const createSchema = z.object({ url: z.string().trim().max(500), description: z.string().trim().max(120).nullable().optional(), events }).strict();
const updateSchema = z.object({ url: z.string().trim().max(500).optional(), description: z.string().trim().max(120).nullable().optional(), events: events.optional(), isActive: z.boolean().optional() }).strict();
const uuid = { schema: z.uuid() };

/** Webhooks salientes de la empresa (ADR 042). El secreto de firma se muestra completo solo al crearlo o rotarlo. */
@RequirePermission('integrations:manage')
@Controller('integrations/webhooks')
export class WebhooksController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly sender: WebhookSender,
  ) {}

  private checkUrl(url: string) {
    try {
      return validateTargetUrl(url, this.env.WEBHOOKS_ALLOW_PRIVATE_NETWORK === 'true').toString();
    } catch (e) {
      throw new BadRequestException({ code: 'INVALID_URL', message: e instanceof OutboundError ? e.message : 'URL no válida', errors: [{ path: 'url', message: e instanceof OutboundError ? e.message : 'URL no válida' }] });
    }
  }

  @Get()
  async list(@TenantUser() p: TenantPrincipal) {
    const rows = await this.db.tenant(p.tenantId, (tx) => tx.webhookEndpoint.findMany({ orderBy: { createdAt: 'asc' } }));
    return {
      events: WEBHOOK_EVENTS,
      items: rows.map(({ secretEnc: _s, ...e }) => e),
    };
  }

  @Post()
  create(@TenantUser() p: TenantPrincipal, @Body({ schema: createSchema }) b: z.infer<typeof createSchema>) {
    const url = this.checkUrl(b.url);
    return this.db.tenant(p.tenantId, async (tx) => {
      if ((await tx.webhookEndpoint.count()) >= MAX_ENDPOINTS) throw new ForbiddenException({ code: 'LIMIT_REACHED', message: `Máximo ${MAX_ENDPOINTS} URLs de webhook por empresa` });
      const secret = `whsec_${randomToken(24)}`;
      const e = await tx.webhookEndpoint.create({
        data: { tenantId: p.tenantId, url, description: b.description || null, events: [...new Set(b.events)], secretEnc: encrypt(secret, this.env.DATA_ENCRYPTION_KEY), secretHint: `…${secret.slice(-4)}` },
      });
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'webhook.created', entityType: 'webhook_endpoint', entityId: e.id, metadata: { url, events: e.events } });
      const { secretEnc: _s, ...view } = e;
      return { ...view, secret };
    });
  }

  @Patch(':id')
  update(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string, @Body({ schema: updateSchema }) b: z.infer<typeof updateSchema>) {
    const data = { ...b, ...(b.url ? { url: this.checkUrl(b.url) } : {}), ...(b.events ? { events: [...new Set(b.events)] } : {}) };
    return this.db.tenant(p.tenantId, async (tx) => {
      const r = await tx.webhookEndpoint.updateMany({ where: { id }, data });
      if (!r.count) throw new NotFoundException('Webhook no encontrado');
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'webhook.updated', entityType: 'webhook_endpoint', entityId: id, metadata: data });
      const { secretEnc: _s, ...view } = await tx.webhookEndpoint.findUniqueOrThrow({ where: { id } });
      return view;
    });
  }

  /** Nuevo secreto: el anterior deja de valer en el acto */
  @Post(':id/rotate-secret')
  @HttpCode(200)
  rotate(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string) {
    const secret = `whsec_${randomToken(24)}`;
    return this.db.tenant(p.tenantId, async (tx) => {
      const r = await tx.webhookEndpoint.updateMany({ where: { id }, data: { secretEnc: encrypt(secret, this.env.DATA_ENCRYPTION_KEY), secretHint: `…${secret.slice(-4)}` } });
      if (!r.count) throw new NotFoundException('Webhook no encontrado');
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'webhook.secret_rotated', entityType: 'webhook_endpoint', entityId: id });
      return { id, secret };
    });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string) {
    await this.db.tenant(p.tenantId, async (tx) => {
      const r = await tx.webhookEndpoint.deleteMany({ where: { id } });
      if (!r.count) throw new NotFoundException('Webhook no encontrado');
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'webhook.deleted', entityType: 'webhook_endpoint', entityId: id });
    });
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/test')
  @HttpCode(200)
  async test(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string) {
    const exists = await this.db.tenant(p.tenantId, (tx) => tx.webhookEndpoint.count({ where: { id } }));
    if (!exists) throw new NotFoundException('Webhook no encontrado');
    return pingEndpoint(this.db, this.sender, p.tenantId, id);
  }

  @Get(':id/deliveries')
  deliveries(@TenantUser() p: TenantPrincipal, @Param('id', uuid) id: string, @Query({ schema: paginationSchema }) q: z.infer<typeof paginationSchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const where = { endpointId: id };
      const [items, total] = await Promise.all([
        tx.webhookDelivery.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true, event: true, status: true, attempts: true, responseStatus: true, lastError: true, createdAt: true, sentAt: true, nextAttemptAt: true } }),
        tx.webhookDelivery.count({ where }),
      ]);
      return paged(items, total, q.page, q.pageSize);
    });
  }

  /** Reencola una entrega fallida */
  @Post('deliveries/:deliveryId/retry')
  @HttpCode(200)
  retry(@TenantUser() p: TenantPrincipal, @Param('deliveryId', uuid) deliveryId: string) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const r = await tx.webhookDelivery.updateMany({ where: { id: deliveryId, status: 'FAILED', event: { not: 'ping' } }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null } });
      if (!r.count) throw new NotFoundException('Solo se reintentan entregas fallidas');
      return { id: deliveryId, status: 'PENDING' };
    });
  }
}
