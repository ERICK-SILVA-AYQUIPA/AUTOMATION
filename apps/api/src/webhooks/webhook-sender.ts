import { Inject, Injectable } from '@nestjs/common';
import { decrypt } from '../common/crypto/crypto.js';
import { OutboundError, safePost } from '../common/net/outbound.js';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { signWebhook } from './webhook-signing.js';

export const MAX_WEBHOOK_ATTEMPTS = 6;

export interface ClaimedDelivery { id: string; tenant_id: string; endpoint_id: string; event: string; payload: Record<string, unknown>; attempts: number; url: string; secret_enc: string }

/** Envío firmado de una entrega y registro del resultado (worker y botón «Probar») */
@Injectable()
export class WebhookSender {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
  ) {}

  /** Envía una entrega ya reservada y registra el resultado (también lo usa la prueba del panel) */
  async deliver(r: ClaimedDelivery, opts: { notify?: boolean } = {}): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    const body = JSON.stringify({ id: r.id, ...r.payload });
    let status: number | null = null;
    let error: string | null = null;
    let permanent = false;
    try {
      const secret = decrypt(r.secret_enc, this.env.DATA_ENCRYPTION_KEY);
      const res = await safePost(r.url, body, { 'X-AISA-Event': r.event, 'X-AISA-Delivery': r.id, 'X-AISA-Signature': signWebhook(secret, body) }, { allowPrivate: this.env.WEBHOOKS_ALLOW_PRIVATE_NETWORK === 'true', timeoutMs: 10_000 });
      status = res.status;
      if (res.status < 200 || res.status >= 300) error = `Respondió ${res.status}${res.body ? `: ${res.body.slice(0, 200)}` : ''}`;
    } catch (e) {
      error = (e as Error).message || 'Error de conexión';
      permanent = e instanceof OutboundError && e.permanent;
    }
    const now = new Date();
    if (!error) {
      await this.db.system.$transaction([
        this.db.system.webhookDelivery.update({ where: { id: r.id }, data: { status: 'SENT', sentAt: now, responseStatus: status, lastError: null } }),
        this.db.system.webhookEndpoint.update({ where: { id: r.endpoint_id }, data: { lastDeliveryAt: now, lastStatus: status, lastError: null } }),
      ]);
      return { ok: true, status, error: null };
    }
    const final = permanent || r.attempts >= MAX_WEBHOOK_ATTEMPTS;
    const wait = Math.min(3600, 30 * 2 ** (r.attempts - 1));
    await this.db.system.$transaction([
      this.db.system.webhookDelivery.update({
        where: { id: r.id },
        data: { responseStatus: status, lastError: error.slice(0, 500), ...(final ? { status: 'FAILED' as const } : { nextAttemptAt: new Date(Date.now() + wait * 1000) }) },
      }),
      this.db.system.webhookEndpoint.update({ where: { id: r.endpoint_id }, data: { lastDeliveryAt: now, lastStatus: status, lastError: error.slice(0, 500) } }),
    ]);
    if (final && opts.notify !== false) {
      // Un aviso por URL y día, no uno por entrega
      const key = `webhook:${r.endpoint_id}:${now.toISOString().slice(0, 10)}`;
      const exists = await this.db.system.notification.findFirst({ where: { tenantId: r.tenant_id, type: 'webhook.failed', data: { path: ['key'], equals: key } }, select: { id: true } });
      if (!exists) {
        await this.db.system.notification.create({
          data: { tenantId: r.tenant_id, type: 'webhook.failed', title: 'Un webhook no se pudo entregar', body: `${r.url} no aceptó «${r.event}»: ${error.slice(0, 200)}. Revísalo en Integraciones → Webhooks.`, data: { key, endpointId: r.endpoint_id } },
        });
      }
    }
    return { ok: false, status, error };
  }
}
