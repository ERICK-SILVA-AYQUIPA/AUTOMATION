import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import type { Tx } from '../database/database.service.js';
import type { AutomationKey, Prisma } from '../generated/prisma/client.js';

/** Ruta del webhook de n8n para cada flujo (services/n8n/workflows) */
export const N8N_PATHS: Partial<Record<AutomationKey, string>> = {
  NEW_ORDER_NOTIFICATION: 'aisa-pedido-nuevo',
  LOW_STOCK_ALERT: 'aisa-stock-bajo',
  ERROR_ALERT: 'aisa-error',
};

/**
 * Registra eventos para n8n en la bandeja de salida, dentro de la transacción
 * del cambio de negocio: si la transacción se revierte, el evento no existe.
 * La entrega la hace el worker (AutomationDispatcher).
 */
@Injectable()
export class AutomationEvents {
  constructor(@Inject(ENV) private readonly env: Env) {}

  get enabled() {
    return !!this.env.N8N_WEBHOOK_BASE_URL && !!this.env.N8N_INTERNAL_TOKEN;
  }

  async emit(tx: Tx, tenantId: string, key: AutomationKey, payload: Record<string, unknown>): Promise<string | null> {
    if (!this.enabled || !N8N_PATHS[key]) return null;
    // Sin fila = activada por defecto; la empresa puede desactivarla
    const cfg = await tx.automation.findUnique({ where: { tenantId_key: { tenantId, key } }, select: { isEnabled: true } });
    if (cfg && !cfg.isEnabled) return null;
    const ev = await tx.automationEvent.create({ data: { tenantId, key, payload: payload as Prisma.InputJsonValue }, select: { id: true } });
    return ev.id;
  }
}
