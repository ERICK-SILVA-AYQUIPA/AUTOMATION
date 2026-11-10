import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import type { AutomationKey } from '../generated/prisma/client.js';
import { AutomationEvents, N8N_PATHS } from './automation-events.service.js';

export const MAX_DELIVERY_ATTEMPTS = 8;
const BATCH = 20;

interface Claimed { id: string; tenant_id: string; tenant_name: string; key: AutomationKey; payload: unknown; attempts: number; created_at: Date }

/**
 * Entrega los eventos pendientes a n8n (FLUJO 7: reintento controlado).
 * Cada evento se "reserva" con FOR UPDATE SKIP LOCKED, así varios workers no
 * lo envían a la vez. Reintentos con espera creciente; al agotarlos se marca
 * FAILED y se avisa a los administradores dentro del panel.
 */
@Injectable()
export class AutomationDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AutomationDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly events: AutomationEvents,
  ) {}

  onModuleInit() {
    if (!this.events.enabled) {
      this.log.warn('n8n no configurado (N8N_WEBHOOK_BASE_URL / N8N_INTERNAL_TOKEN): no se envían eventos de automatización');
      return;
    }
    this.timer = setInterval(() => void this.tick(), 5_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Procesa un lote; devuelve cuántos eventos se intentaron (público para pruebas) */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      // La reserva aplaza el siguiente intento: si el proceso muere a mitad, se reintenta solo
      const rows = await this.db.system.$queryRaw<Claimed[]>`
        UPDATE automation_events SET attempts = attempts + 1, next_attempt_at = now() + interval '2 minutes'
        WHERE id IN (
          SELECT id FROM automation_events WHERE status = 'PENDING' AND next_attempt_at <= now()
          ORDER BY next_attempt_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING id, tenant_id, key, payload, attempts, created_at,
          (SELECT name FROM tenants t WHERE t.id = automation_events.tenant_id) AS tenant_name`;
      await Promise.all(rows.map((r) => this.deliver(r)));
      return rows.length;
    } catch (e) {
      this.log.error(`Fallo al procesar eventos de automatización: ${(e as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async deliver(r: Claimed) {
    const url = `${this.env.N8N_WEBHOOK_BASE_URL.replace(/\/$/, '')}/${N8N_PATHS[r.key]}`;
    let error: string | null = null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': this.env.N8N_INTERNAL_TOKEN },
        body: JSON.stringify({
          eventId: r.id, tenantId: r.tenant_id, tenantName: r.tenant_name, key: r.key, occurredAt: r.created_at.toISOString(), attempt: r.attempts,
          payload: r.payload, callbackUrl: `${this.env.N8N_API_BASE_URL.replace(/\/$/, '')}/api/v1/internal/notify`,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) error = `n8n respondió ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`;
    } catch (e) {
      error = `Sin conexión con n8n: ${(e as Error).message}`;
    }

    if (!error) {
      await this.db.system.automationEvent.update({ where: { id: r.id }, data: { status: 'SENT', sentAt: new Date(), lastError: null } });
      return;
    }
    if (r.attempts >= MAX_DELIVERY_ATTEMPTS) {
      await this.db.system.$transaction([
        this.db.system.automationEvent.update({ where: { id: r.id }, data: { status: 'FAILED', lastError: error } }),
        this.db.system.notification.create({
          data: {
            tenantId: r.tenant_id, type: 'automation.failed', title: 'Automatización no entregada',
            body: `No se pudo ejecutar la automatización ${r.key} tras ${r.attempts} intentos. Revisa que n8n esté en marcha.`,
            data: { eventId: r.id, error },
          },
        }),
      ]);
      this.log.error(`Evento ${r.id} (${r.key}) descartado tras ${r.attempts} intentos: ${error}`);
      return;
    }
    const waitSeconds = Math.min(3600, 10 * 2 ** (r.attempts - 1));
    await this.db.system.automationEvent.update({ where: { id: r.id }, data: { lastError: error, nextAttemptAt: new Date(Date.now() + waitSeconds * 1000) } });
    this.log.warn(`Evento ${r.id} (${r.key}) intento ${r.attempts} falló; se reintenta en ${waitSeconds}s: ${error}`);
  }
}
