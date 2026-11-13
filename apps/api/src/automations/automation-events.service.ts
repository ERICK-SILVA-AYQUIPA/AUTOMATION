import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import type { Tx } from '../database/database.service.js';
import type { AutomationKey, Prisma } from '../generated/prisma/client.js';
import { planLimitsSchema } from '../plans/plan-limits.js';
import { CATALOG, catalogEntry, effectiveConfig } from './catalog.js';

/** Ruta del webhook de n8n para cada flujo (services/n8n/workflows) */
export const N8N_PATHS: Partial<Record<AutomationKey, string>> = Object.fromEntries(CATALOG.filter((e) => e.n8nPath).map((e) => [e.key, e.n8nPath]));

/**
 * Registra eventos de automatización en la bandeja de salida, dentro de la
 * transacción del cambio de negocio: si la transacción se revierte, el evento
 * no existe. Solo se registran si la automatización está activa, su módulo
 * está activo y el plan la incluye; la configuración de la empresa filtra
 * qué casos aplican. La entrega la hace el worker (AutomationDispatcher).
 */
@Injectable()
export class AutomationEvents {
  constructor(@Inject(ENV) private readonly env: Env) {}

  /** n8n configurado en el servidor (no significa que esté respondiendo) */
  get n8nConfigured() {
    return !!this.env.N8N_WEBHOOK_BASE_URL && !!this.env.N8N_INTERNAL_TOKEN;
  }

  async emit(tx: Tx, tenantId: string, key: AutomationKey, payload: Record<string, unknown>, opts: { dedupeKey?: string } = {}): Promise<string | null> {
    const entry = catalogEntry(key);
    if (!entry) return null;
    const [row, tenant, sub] = await Promise.all([
      tx.automation.findUnique({ where: { tenantId_key: { tenantId, key } }, select: { isEnabled: true, config: true } }),
      tx.tenant.findUnique({ where: { id: tenantId }, select: { enabledModules: true } }),
      entry.feature ? tx.subscription.findUnique({ where: { tenantId }, select: { plan: { select: { limits: true } } } }) : null,
    ]);
    if (!(row ? row.isEnabled : entry.defaultEnabled)) return null;
    if (!tenant?.enabledModules.includes(entry.module)) return null;
    if (entry.feature) {
      const limits = sub ? planLimitsSchema.safeParse(sub.plan.limits) : null;
      if (!limits?.success || !limits.data.features.includes(entry.feature)) return null;
    }
    if (!applies(key, effectiveConfig(entry, row?.config), payload)) return null;

    // Sin n8n configurado queda constancia en el historial en lugar de perderse en silencio
    const skipped = entry.executor === 'n8n' && !this.n8nConfigured;
    const data = {
      tenantId, key, payload: payload as Prisma.InputJsonValue, dedupeKey: opts.dedupeKey ?? null,
      ...(skipped ? { status: 'SKIPPED' as const, lastError: 'n8n no está configurado en el servidor (N8N_WEBHOOK_BASE_URL)' } : {}),
    };
    if (opts.dedupeKey) {
      const existing = await tx.automationEvent.findUnique({ where: { tenantId_key_dedupeKey: { tenantId, key, dedupeKey: opts.dedupeKey } }, select: { id: true } });
      if (existing) return null;
    }
    const ev = await tx.automationEvent.create({ data, select: { id: true } });
    return skipped ? null : ev.id;
  }
}

/** Filtros de la configuración de cada automatización sobre el caso concreto */
function applies(key: AutomationKey, cfg: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  if (key === 'NEW_ORDER_NOTIFICATION') {
    const channels = (cfg.channels as string[] | undefined) ?? [];
    return channels.includes(String(payload.channel)) && Number(payload.total ?? 0) >= Number(cfg.minTotal ?? 0);
  }
  // Solo pedidos que llegaron por WhatsApp: a los demás no hay conversación a la que escribir
  if (key === 'ORDER_STATUS_NOTIFICATION') return payload.viaWhatsapp === true && ((cfg.statuses as string[] | undefined) ?? []).includes(String(payload.status));
  return true;
}
