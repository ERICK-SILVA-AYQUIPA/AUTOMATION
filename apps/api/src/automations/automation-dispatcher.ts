import { HttpException, Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import type { AutomationKey } from '../generated/prisma/client.js';
import { OutboundService } from '../messaging/outbound.service.js';
import { AutomationEvents, N8N_PATHS } from './automation-events.service.js';
import { catalogEntry, effectiveConfig, fillTemplate } from './catalog.js';

export const MAX_DELIVERY_ATTEMPTS = 8;
const BATCH = 20;
const SCHEDULE_EVERY_MS = 60_000;

interface Claimed { id: string; tenant_id: string; tenant_name: string; key: AutomationKey; payload: unknown; attempts: number; created_at: Date }
type Outcome = { status: 'SENT'; note?: string } | { status: 'SKIPPED'; reason: string };

/** No es un fallo: la automatización no aplicaba (se registra y no se reintenta) */
class Skip extends Error {}

/**
 * Ejecuta la bandeja de salida de automatizaciones (FLUJO 7: reintento controlado).
 * - Las de n8n se entregan a su webhook; las del backend se ejecutan aquí.
 * - Cada evento se "reserva" con FOR UPDATE SKIP LOCKED: varios workers no lo procesan a la vez.
 * - Reintentos con espera creciente; al agotarlos queda FAILED y se avisa en el panel.
 * - Cada minuto programa los recordatorios de pedidos pendientes (uno por pedido).
 */
@Injectable()
export class AutomationDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AutomationDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastSchedule = 0;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly events: AutomationEvents,
    @Optional() private readonly outbound?: OutboundService,
  ) {}

  onModuleInit() {
    if (!this.events.n8nConfigured) this.log.warn('n8n no configurado (N8N_WEBHOOK_BASE_URL / N8N_INTERNAL_TOKEN): las automatizaciones de n8n quedan como omitidas');
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
      if (Date.now() - this.lastSchedule >= SCHEDULE_EVERY_MS) {
        this.lastSchedule = Date.now();
        await this.scheduleReminders();
      }
      // La reserva aplaza el siguiente intento: si el proceso muere a mitad, se reintenta solo
      const rows = await this.db.system.$queryRaw<Claimed[]>`
        UPDATE automation_events SET attempts = attempts + 1, next_attempt_at = now() + interval '2 minutes'
        WHERE id IN (
          SELECT id FROM automation_events WHERE status = 'PENDING' AND next_attempt_at <= now()
          ORDER BY next_attempt_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING id, tenant_id, key, payload, attempts, created_at,
          (SELECT name FROM tenants t WHERE t.id = automation_events.tenant_id) AS tenant_name`;
      await Promise.all(rows.map((r) => this.process(r)));
      return rows.length;
    } catch (e) {
      this.log.error(`Fallo al procesar eventos de automatización: ${(e as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** Recordatorios de pedidos pendientes: solo empresas activas, con la automatización y el plan que la incluye. */
  async scheduleReminders(): Promise<number> {
    const entry = catalogEntry('PENDING_ORDER_REMINDER')!;
    const defaultHours = Number(entry.defaults.hours);
    return this.db.system.$executeRaw`
      INSERT INTO automation_events (id, tenant_id, key, payload, dedupe_key)
      SELECT gen_random_uuid(), o.tenant_id, 'PENDING_ORDER_REMINDER',
             jsonb_build_object('orderId', o.id, 'number', o.number, 'total', o.total::text, 'currency', o.currency, 'hours', h.hours),
             'order:' || o.id
      FROM orders o
      JOIN automations a ON a.tenant_id = o.tenant_id AND a.key = 'PENDING_ORDER_REMINDER' AND a.is_enabled
      JOIN tenants t ON t.id = o.tenant_id AND t.status = 'ACTIVE' AND 'orders' = ANY(t.enabled_modules)
      JOIN subscriptions s ON s.tenant_id = o.tenant_id
      JOIN plans p ON p.id = s.plan_id AND (p.limits -> 'features') ? ${entry.feature!}
      CROSS JOIN LATERAL (SELECT COALESCE((a.config ->> 'hours')::int, ${defaultHours}) AS hours) h
      WHERE o.status = 'PENDING'
        AND o.created_at <= now() - make_interval(hours => h.hours)
        AND o.created_at > now() - interval '7 days'
      ON CONFLICT (tenant_id, key, dedupe_key) DO NOTHING`;
  }

  private async process(r: Claimed) {
    const entry = catalogEntry(r.key);
    let outcome: Outcome | null = null;
    let error: string | null = null;
    try {
      if (!entry) throw new Skip('Automatización desconocida');
      if (entry.executor === 'n8n') {
        if (!this.events.n8nConfigured) throw new Skip('n8n no está configurado en el servidor');
        error = await this.deliverToN8n(r);
        if (!error) outcome = { status: 'SENT' };
      } else {
        outcome = await this.runBackend(r);
      }
    } catch (e) {
      if (e instanceof Skip) outcome = { status: 'SKIPPED', reason: e.message };
      else error = (e as Error).message || String(e);
    }

    if (outcome?.status === 'SENT') {
      await this.db.system.automationEvent.update({ where: { id: r.id }, data: { status: 'SENT', sentAt: new Date(), lastError: outcome.note ?? null } });
      return;
    }
    if (outcome?.status === 'SKIPPED') {
      await this.db.system.automationEvent.update({ where: { id: r.id }, data: { status: 'SKIPPED', lastError: outcome.reason.slice(0, 500) } });
      return;
    }
    error ??= 'Error desconocido';
    if (r.attempts >= MAX_DELIVERY_ATTEMPTS) {
      await this.db.system.$transaction([
        this.db.system.automationEvent.update({ where: { id: r.id }, data: { status: 'FAILED', lastError: error.slice(0, 500) } }),
        this.db.system.notification.create({
          data: {
            tenantId: r.tenant_id, type: 'automation.failed', title: 'Automatización no ejecutada',
            body: `«${entry?.name ?? r.key}» falló tras ${r.attempts} intentos. Puedes reintentarla desde Automatizaciones → Historial.`,
            data: { eventId: r.id, error: error.slice(0, 300) },
          },
        }),
      ]);
      this.log.error(`Evento ${r.id} (${r.key}) descartado tras ${r.attempts} intentos: ${error}`);
      return;
    }
    const waitSeconds = Math.min(3600, 10 * 2 ** (r.attempts - 1));
    await this.db.system.automationEvent.update({ where: { id: r.id }, data: { lastError: error.slice(0, 500), nextAttemptAt: new Date(Date.now() + waitSeconds * 1000) } });
    this.log.warn(`Evento ${r.id} (${r.key}) intento ${r.attempts} falló; se reintenta en ${waitSeconds}s: ${error}`);
  }

  /** Devuelve el error, o null si n8n lo aceptó */
  private async deliverToN8n(r: Claimed): Promise<string | null> {
    const url = `${this.env.N8N_WEBHOOK_BASE_URL.replace(/\/$/, '')}/${N8N_PATHS[r.key]}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': this.env.N8N_INTERNAL_TOKEN },
        body: JSON.stringify({
          eventId: r.id, tenantId: r.tenant_id, tenantName: r.tenant_name, key: r.key, occurredAt: r.created_at.toISOString(), attempt: r.attempts,
          payload: r.payload, callbackUrl: `${this.env.N8N_API_BASE_URL.replace(/\/$/, '')}/api/v1/internal/notify`,
          panelUrl: this.env.APP_PUBLIC_URL,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return `n8n respondió ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`;
      return null;
    } catch (e) {
      return `Sin conexión con n8n: ${(e as Error).message}`;
    }
  }

  private async runBackend(r: Claimed): Promise<Outcome> {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    if (r.key === 'ORDER_STATUS_NOTIFICATION') return this.orderStatusMessage(r, p);
    if (r.key === 'PENDING_ORDER_REMINDER') return this.pendingOrderReminder(r, p);
    throw new Skip('Sin ejecutor en el backend');
  }

  /** Mensaje al cliente por WhatsApp con el texto que configuró la empresa. */
  private async orderStatusMessage(r: Claimed, p: Record<string, unknown>): Promise<Outcome> {
    if (!this.outbound) throw new Error('El envío de WhatsApp no está disponible en este proceso');
    const tenantId = r.tenant_id;
    const [tenant, cfgRow, order] = await Promise.all([
      this.db.system.tenant.findUnique({ where: { id: tenantId }, select: { status: true, name: true } }),
      this.db.system.automation.findUnique({ where: { tenantId_key: { tenantId, key: r.key } }, select: { config: true } }),
      this.db.system.order.findFirst({
        where: { id: String(p.orderId), tenantId },
        select: { number: true, total: true, currency: true, conversationId: true, customer: { select: { name: true, waProfileName: true } } },
      }),
    ]);
    if (tenant?.status !== 'ACTIVE') throw new Skip('La empresa no está activa');
    if (!order) throw new Skip('El pedido ya no existe');
    if (!order.conversationId) throw new Skip('El pedido no llegó por WhatsApp: no hay conversación a la que escribir');
    const cfg = effectiveConfig(catalogEntry(r.key)!, cfgRow?.config);
    const tpl = (cfg.templates as Record<string, string>)[String(p.status)];
    if (!tpl) throw new Skip(`Sin texto para el estado ${String(p.status)}`);
    const text = fillTemplate(tpl, {
      cliente: order.customer.name ?? order.customer.waProfileName ?? 'cliente',
      numero: String(order.number),
      total: new Intl.NumberFormat('es-PE', { style: 'currency', currency: order.currency }).format(Number(order.total)),
      empresa: tenant.name,
    });
    try {
      await this.outbound.enqueueText({ tenantId, conversationId: order.conversationId, text, idempotencyKey: `auto:${r.id}`, sender: { type: 'SYSTEM' } });
    } catch (e) {
      // Reglas de WhatsApp o de la cuenta: no se arreglan reintentando
      if (e instanceof HttpException && e.getStatus() < 500) {
        const body = e.getResponse() as { message?: string } | string;
        throw new Skip(typeof body === 'string' ? body : (body.message ?? e.message));
      }
      throw e;
    }
    return { status: 'SENT' };
  }

  private async pendingOrderReminder(r: Claimed, p: Record<string, unknown>): Promise<Outcome> {
    const order = await this.db.system.order.findFirst({ where: { id: String(p.orderId), tenantId: r.tenant_id }, select: { id: true, number: true, status: true } });
    if (!order) throw new Skip('El pedido ya no existe');
    if (order.status !== 'PENDING') throw new Skip('El pedido ya no está pendiente');
    await this.db.system.notification.create({
      data: {
        tenantId: r.tenant_id, type: 'order.pending', title: `Pedido #${order.number} sin confirmar`,
        body: `Lleva más de ${Number(p.hours ?? 0)} h pendiente. Confírmalo o anúlalo para que el cliente sepa qué pasa.`,
        data: { orderId: order.id },
      },
    });
    return { status: 'SENT' };
  }
}

