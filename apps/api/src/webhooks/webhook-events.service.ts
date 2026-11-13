import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/database.service.js';
import type { Prisma } from '../generated/prisma/client.js';

/** Eventos que una empresa puede recibir en su URL (ADR 042) */
export const WEBHOOK_EVENTS = {
  'order.created': 'Pedido nuevo',
  'order.status_changed': 'Cambio de estado de un pedido',
  'stock.low': 'Producto bajo su stock mínimo',
  'conversation.handoff': 'Conversación pasada a una persona',
  'reservation.created': 'Reserva o cita nueva',
  'reservation.status_changed': 'Cambio de estado de una reserva',
} as const;
export type WebhookEvent = keyof typeof WEBHOOK_EVENTS;

/**
 * Registra entregas en la misma transacción del cambio de negocio: si se
 * revierte, no se avisa de nada que no ocurrió. El envío lo hace el worker.
 */
@Injectable()
export class WebhookEvents {
  async emit(tx: Tx, tenantId: string, event: WebhookEvent, data: Record<string, unknown>) {
    const endpoints = await tx.webhookEndpoint.findMany({ where: { tenantId, isActive: true, events: { has: event } }, select: { id: true } });
    if (!endpoints.length) return 0;
    const occurredAt = new Date().toISOString();
    const r = await tx.webhookDelivery.createMany({
      data: endpoints.map((e) => ({ tenantId, endpointId: e.id, event, payload: { event, occurredAt, tenantId, data } as Prisma.InputJsonValue })),
    });
    return r.count;
  }
}
