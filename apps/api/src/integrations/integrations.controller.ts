import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AssistantService } from '../ai/assistant.service.js';
import { GeminiChatModel } from '../ai/gemini.client.js';
import { AuditService } from '../audit/audit.service.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { encrypt } from '../common/crypto/crypto.js';
import { RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { MailService } from '../mail/mail.service.js';
import { WhatsappNumbersService } from '../whatsapp/whatsapp-numbers.service.js';
import { WebhookSender } from '../webhooks/webhook-sender.js';
import { IntegrationChecks, type CheckResult } from './integration-checks.service.js';
import { IntegrationsStatus } from './integrations-status.service.js';

export const TENANT_SERVICES = ['whatsapp', 'ai', 'email', 'webhooks'] as const;
type TenantService = (typeof TENANT_SERVICES)[number];
const keySchema = z.object({ apiKey: z.string().trim().min(20).max(200).regex(/^[\w-]+$/, 'Formato de clave no válido') }).strict();

/**
 * Centro de integraciones de la empresa (ADR 042): estado de cada una con su
 * última comprobación, botón «Probar» que hace una petición real, historial
 * de errores y la clave propia de Gemini (cifrada; nunca se muestra entera).
 */
@RequirePermission('integrations:manage')
@Controller('integrations')
export class IntegrationsController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly checks: IntegrationChecks,
    private readonly gemini: GeminiChatModel,
    private readonly assistant: AssistantService,
    private readonly mail: MailService,
    private readonly numbers: WhatsappNumbersService,
    private readonly sender: WebhookSender,
    private readonly status: IntegrationsStatus,
  ) {}

  @Get()
  overview(@TenantUser() p: TenantPrincipal) {
    return this.status.overview(p.tenantId);
  }

  /** Comprobación real del servicio, registrada en el historial */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post(':service/test')
  async test(@TenantUser() p: TenantPrincipal, @Param('service', { schema: z.enum(TENANT_SERVICES) }) service: TenantService) {
    const r = await this.run(p, service);
    await this.checks.record(p.tenantId, service, r, p.userId);
    if (service === 'ai') {
      await this.db.tenant(p.tenantId, (tx) =>
        tx.tenantIntegration.updateMany({ where: { tenantId: p.tenantId, type: 'GEMINI' }, data: { lastCheckedAt: new Date(), status: r.ok ? 'CONNECTED' : 'ERROR', lastError: r.ok ? null : r.detail.slice(0, 500) } }),
      );
    }
    return r;
  }

  private async run(p: TenantPrincipal, service: TenantService): Promise<CheckResult> {
    const t = Date.now();
    switch (service) {
      case 'ai': {
        const provider = await this.assistant.providerFor(p.tenantId);
        if (!provider) return { ok: false, ms: 0, detail: 'Sin clave de Gemini (ni propia ni de la plataforma)' };
        const r = await this.gemini.check(provider.key);
        return { ...r, detail: `${provider.source === 'tenant' ? 'Clave propia' : 'Clave de la plataforma'}: ${r.detail}` };
      }
      case 'email': {
        const user = await this.db.tenant(p.tenantId, (tx) => tx.user.findUniqueOrThrow({ where: { id: p.userId }, select: { email: true } }));
        try {
          await this.mail.send({ to: user.email, subject: 'Correo de prueba de AI Sales Assistant', text: 'Si lees esto, el correo saliente funciona.\n\nMensaje automático enviado desde Integraciones.' });
          return { ok: true, ms: Date.now() - t, detail: `Enviado a ${user.email}: revisa tu bandeja (y la carpeta de spam)` };
        } catch (e) {
          return { ok: false, ms: Date.now() - t, detail: `El servidor de correo rechazó el envío: ${(e as Error).message}` };
        }
      }
      case 'whatsapp': {
        const list = await this.db.tenant(p.tenantId, (tx) => tx.whatsappNumber.findMany({ where: { isActive: true, provider: 'CLOUD_API' }, select: { id: true, displayPhone: true } }));
        if (!list.length) return { ok: false, ms: 0, detail: 'Sin números de WhatsApp Cloud API' };
        const out: string[] = [];
        let ok = true;
        for (const n of list) {
          const r = await this.numbers.check(p, n.id);
          if (r.status !== 'CONNECTED') ok = false;
          out.push(`${n.displayPhone ?? n.id}: ${r.status === 'CONNECTED' ? `credenciales válidas${r.verifiedName ? ` (${r.verifiedName})` : ''}` : (r.lastError ?? 'error')}`);
        }
        return { ok, ms: Date.now() - t, detail: out.join('; ') };
      }
      case 'webhooks': {
        const endpoints = await this.db.tenant(p.tenantId, (tx) => tx.webhookEndpoint.findMany({ where: { isActive: true }, select: { id: true } }));
        if (!endpoints.length) return { ok: false, ms: 0, detail: 'Sin URLs de webhook activas' };
        const results = await Promise.all(endpoints.map((e) => pingEndpoint(this.db, this.sender, p.tenantId, e.id)));
        const bad = results.filter((r) => !r.ok);
        return { ok: !bad.length, ms: Date.now() - t, detail: bad.length ? `${bad.length} de ${results.length} URL(s) no respondieron 2xx: ${bad.map((b) => b.error).join('; ').slice(0, 300)}` : `${results.length} URL(s) respondieron 2xx` };
      }
    }
  }

  /** Clave propia de Gemini: se comprueba con Google antes de guardarla y se guarda cifrada */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Put('ai/key')
  async setKey(@TenantUser() p: TenantPrincipal, @Body({ schema: keySchema }) b: z.infer<typeof keySchema>) {
    const r = await this.gemini.check(b.apiKey);
    await this.checks.record(p.tenantId, 'ai', { ...r, detail: `Clave propia nueva: ${r.detail}` }, p.userId);
    if (!r.ok) throw new BadRequestException({ code: 'INVALID_KEY', message: `Google no aceptó la clave: ${r.detail}` });
    const hint = `…${b.apiKey.slice(-4)}`;
    await this.db.tenant(p.tenantId, async (tx) => {
      const data = { secretsEnc: encrypt(b.apiKey, this.env.DATA_ENCRYPTION_KEY), config: { hint }, status: 'CONNECTED' as const, lastError: null, lastCheckedAt: new Date() };
      await tx.tenantIntegration.upsert({ where: { tenantId_type: { tenantId: p.tenantId, type: 'GEMINI' } }, create: { tenantId: p.tenantId, type: 'GEMINI', ...data }, update: data });
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'integration.gemini_key_set', entityType: 'tenant_integration', metadata: { hint } });
    });
    return { status: 'CONNECTED', hint, detail: r.detail };
  }

  @Delete('ai/key')
  @HttpCode(204)
  async removeKey(@TenantUser() p: TenantPrincipal) {
    await this.db.tenant(p.tenantId, async (tx) => {
      await tx.tenantIntegration.deleteMany({ where: { tenantId: p.tenantId, type: 'GEMINI' } });
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'integration.gemini_key_removed', entityType: 'tenant_integration' });
    });
  }

  /** Historial de comprobaciones (los errores primero si se filtra por ok=false) */
  @Get('checks')
  history(@TenantUser() p: TenantPrincipal, @Query({ schema: z.object({ service: z.string().max(30).optional(), ok: z.enum(['true', 'false']).optional() }) }) q: { service?: string; ok?: 'true' | 'false' }) {
    return this.db.tenant(p.tenantId, (tx) =>
      tx.integrationCheck.findMany({
        where: { ...(q.service ? { service: q.service } : {}), ...(q.ok ? { ok: q.ok === 'true' } : {}) },
        orderBy: { createdAt: 'desc' }, take: 50,
        select: { id: true, service: true, ok: true, latencyMs: true, detail: true, createdAt: true },
      }),
    );
  }
}

/** Crea una entrega «ping» y la envía al momento (no espera al worker) */
export async function pingEndpoint(db: DatabaseService, sender: WebhookSender, tenantId: string, endpointId: string) {
  const d = await db.tenant(tenantId, (tx) =>
    tx.webhookDelivery.create({ data: { tenantId, endpointId, event: 'ping', attempts: 1, nextAttemptAt: new Date(Date.now() + 10 * 60_000), payload: { event: 'ping', occurredAt: new Date().toISOString(), tenantId, data: { message: 'Prueba desde AI Sales Assistant' } } } }),
  );
  const e = await db.tenant(tenantId, (tx) => tx.webhookEndpoint.findUniqueOrThrow({ where: { id: endpointId }, select: { url: true, secretEnc: true } }));
  // La entrega de prueba no se reintenta: se marca como último intento
  return sender.deliver({ id: d.id, tenant_id: tenantId, endpoint_id: endpointId, event: 'ping', payload: d.payload as Record<string, unknown>, attempts: 99, url: e.url, secret_enc: e.secretEnc }, { notify: false });
}
