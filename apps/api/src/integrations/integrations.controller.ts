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

export const TENANT_SERVICES = ['whatsapp', 'ai', 'email', 'webhooks'] as const;
type TenantService = (typeof TENANT_SERVICES)[number];
const keySchema = z.object({ apiKey: z.string().trim().min(20).max(200).regex(/^[\w-]+$/, 'Formato de clave no válido') }).strict();
const DAY = 24 * 3600 * 1000;

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
  ) {}

  @Get()
  async overview(@TenantUser() p: TenantPrincipal) {
    const provider = await this.assistant.providerFor(p.tenantId);
    return this.db.tenant(p.tenantId, async (tx) => {
      const since = new Date(Date.now() - 7 * DAY);
      const [numbers, own, chatwoot, endpoints, failedDeliveries, failedAutomations, lastChecks] = await Promise.all([
        tx.whatsappNumber.findMany({ where: { isActive: true }, select: { status: true, lastWebhookAt: true, lastError: true, displayPhone: true } }),
        tx.tenantIntegration.findUnique({ where: { tenantId_type: { tenantId: p.tenantId, type: 'GEMINI' } }, select: { status: true, config: true, lastError: true, lastCheckedAt: true } }),
        tx.tenantIntegration.findUnique({ where: { tenantId_type: { tenantId: p.tenantId, type: 'CHATWOOT' } }, select: { status: true, lastError: true, updatedAt: true } }),
        tx.webhookEndpoint.findMany({ where: { isActive: true }, select: { lastError: true, lastDeliveryAt: true } }),
        tx.webhookDelivery.count({ where: { status: 'FAILED', createdAt: { gte: since } } }),
        tx.automationEvent.count({ where: { status: 'FAILED', createdAt: { gte: since } } }),
        tx.$queryRaw<{ service: string; ok: boolean; detail: string | null; created_at: Date }[]>`
          SELECT DISTINCT ON (service) service, ok, detail, created_at FROM integration_checks ORDER BY service, created_at DESC`,
      ]);
      const last = (s: string) => {
        const c = lastChecks.find((x) => x.service === s);
        return c ? { ok: c.ok, detail: c.detail, at: c.created_at } : null;
      };
      const waError = numbers.find((n) => n.status === 'ERROR');
      const lastWebhook = numbers.map((n) => n.lastWebhookAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime()).at(-1) ?? null;
      const failingEndpoints = endpoints.filter((e) => e.lastError).length;
      const ownHint = (own?.config as { hint?: string } | null)?.hint ?? null;
      return [
        {
          key: 'whatsapp', name: 'WhatsApp Business (Cloud API)', testable: numbers.length > 0, lastCheck: last('whatsapp'),
          status: !numbers.length ? 'not_configured' : waError ? 'error' : numbers.every((n) => n.status === 'CONNECTED') ? 'connected' : 'pending',
          detail: !numbers.length ? 'Sin números conectados' : waError ? `${waError.displayPhone ?? 'Un número'}: ${waError.lastError ?? 'error'}` : `${numbers.length} número(s); último mensaje recibido ${lastWebhook ? 'registrado' : 'aún no llega'}`,
          lastActivityAt: lastWebhook, howTo: 'Abajo, en «Números de WhatsApp»: credenciales de Meta, URL del webhook y prueba de envío.',
        },
        {
          key: 'ai', name: 'Gemini (asistente IA)', testable: !!provider, lastCheck: last('ai'),
          status: own?.status === 'ERROR' ? 'error' : provider ? 'connected' : 'not_configured',
          detail: provider?.source === 'tenant' ? `Clave propia de la empresa (${ownHint ?? 'guardada'})` : provider ? 'Usa la clave de la plataforma' : 'Sin clave: los mensajes los atiende tu equipo',
          ownKey: own ? { hint: ownHint, status: own.status, lastError: own.lastError, lastCheckedAt: own.lastCheckedAt } : null,
          howTo: 'Opcional: crea una clave en Google AI Studio (aistudio.google.com → Get API key) y pégala aquí. Se valida con Google antes de guardarla y se guarda cifrada.',
        },
        {
          key: 'email', name: 'Correo saliente', testable: this.mail.configured, lastCheck: last('email'),
          status: this.mail.configured ? 'managed' : 'not_configured',
          detail: this.mail.configured ? 'Lo gestiona la plataforma (invitaciones, avisos y automatizaciones)' : 'La plataforma aún no configuró el servidor de correo',
          howTo: '«Probar» te envía un correo de prueba a tu dirección.',
        },
        {
          key: 'automations', name: 'Automatizaciones (n8n)', testable: false, lastCheck: null,
          status: !this.checks.configured('n8n') ? 'not_configured' : failedAutomations ? 'error' : 'managed',
          detail: !this.checks.configured('n8n') ? 'n8n no está configurado en el servidor: los avisos por correo quedan omitidos' : failedAutomations ? `${failedAutomations} ejecución(es) fallida(s) en 7 días` : 'Lo gestiona la plataforma',
          howTo: 'Actívalas y revisa su historial en Automatizaciones.',
        },
        {
          key: 'chatwoot', name: 'Chatwoot (bandeja de agentes)', testable: false, lastCheck: null,
          status: !chatwoot ? 'not_configured' : chatwoot.status === 'CONNECTED' ? 'connected' : chatwoot.status === 'ERROR' ? 'error' : 'pending',
          detail: !chatwoot ? 'Sin conectar (opcional)' : (chatwoot.lastError ?? 'Cuenta creada'),
          howTo: 'Abajo, en «Chatwoot».',
        },
        {
          key: 'webhooks', name: 'Webhooks salientes', testable: endpoints.length > 0, lastCheck: last('webhooks'),
          status: !endpoints.length ? 'not_configured' : failingEndpoints || failedDeliveries ? 'error' : 'connected',
          detail: !endpoints.length ? 'Sin URLs: avisa a tus sistemas de pedidos, stock y derivaciones' : `${endpoints.length} URL(s)${failingEndpoints ? `, ${failingEndpoints} con error` : ''}${failedDeliveries ? `; ${failedDeliveries} entrega(s) fallida(s) en 7 días` : ''}`,
          howTo: 'Abajo, en «Webhooks»: cada entrega va firmada con HMAC-SHA256.',
        },
        {
          key: 'payments', name: 'Pagos', testable: false, lastCheck: null, status: 'managed',
          detail: 'Cobro manual: la plataforma registra tus pagos. No hay cobros automáticos.',
          howTo: 'Tu plan y tus pagos están en Configuración.',
        },
      ];
    });
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
