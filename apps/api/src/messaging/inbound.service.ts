import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { currentPeriod } from '../plans/plan-limits.js';
import type { InboundMessageEvent, StatusEvent } from '../whatsapp/webhook-payload.js';

type StoredEvent = (InboundMessageEvent | StatusEvent) & { whatsappNumberId: string };

/** Orden de los estados de salida: nunca se retrocede (read no vuelve a delivered) */
const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, played: 4 };

export interface InboundResult {
  outcome: 'processed' | 'duplicate' | 'ignored';
  conversationId?: string;
  messageId?: string;
  newConversation?: boolean;
  tenantId?: string;
  kind?: 'message' | 'status';
}

/**
 * Procesa los eventos guardados por el webhook (lo ejecuta el worker).
 * Todo ocurre dentro de la transacción RLS de la empresa dueña del número.
 */
@Injectable()
export class InboundService {
  private readonly log = new Logger('Inbound');

  constructor(private readonly db: DatabaseService) {}

  async processEvent(eventId: string): Promise<InboundResult> {
    const ev = await this.db.system.inboundEvent.findUnique({ where: { id: eventId } });
    if (!ev || ev.status === 'PROCESSED' || ev.status === 'IGNORED') return { outcome: 'duplicate' };
    if (!ev.tenantId) return this.finish(eventId, 'IGNORED', { outcome: 'ignored' }, 'Sin empresa');
    const payload = ev.payload as unknown as StoredEvent;
    try {
      const r = payload.kind === 'message' ? await this.message(ev.tenantId, payload) : await this.status(ev.tenantId, payload, ev.receivedAt);
      return this.finish(eventId, r.outcome === 'ignored' ? 'IGNORED' : 'PROCESSED', { ...r, tenantId: ev.tenantId, kind: payload.kind === 'message' ? 'message' : 'status' });
    } catch (e) {
      await this.db.system.inboundEvent.update({ where: { id: eventId }, data: { attempts: { increment: 1 }, error: (e as Error).message.slice(0, 1000) } });
      throw e; // BullMQ reintenta
    }
  }

  /** Agotados los reintentos: queda visible como FAILED (cola de errores) */
  markFailed(eventId: string, error: string) {
    return this.db.system.inboundEvent.update({ where: { id: eventId }, data: { status: 'FAILED', error: error.slice(0, 1000) } });
  }

  private async finish(eventId: string, status: 'PROCESSED' | 'IGNORED', r: InboundResult, error?: string) {
    await this.db.system.inboundEvent.update({ where: { id: eventId }, data: { status, processedAt: new Date(), attempts: { increment: 1 }, error: error ?? null } });
    return r;
  }

  /** Busca al cliente por BSUID o teléfono y completa lo que falte */
  private async customer(tx: Tx, tenantId: string, e: InboundMessageEvent) {
    const or = [...(e.bsuid ? [{ waUserId: e.bsuid }] : []), ...(e.phone ? [{ phone: e.phone }] : [])];
    const found = await tx.customer.findMany({ where: { tenantId, OR: or } });
    // Preferimos la coincidencia por BSUID (estable aunque el usuario oculte su número)
    const c = found.find((x) => e.bsuid && x.waUserId === e.bsuid) ?? found[0];
    const now = new Date();
    if (!c) {
      return tx.customer.create({ data: { tenantId, phone: e.phone, waUserId: e.bsuid, waProfileName: e.profileName, source: 'whatsapp', lastContactAt: now } });
    }
    return tx.customer.update({
      where: { id: c.id },
      data: {
        lastContactAt: now,
        ...(e.profileName ? { waProfileName: e.profileName } : {}),
        // Completa identificadores que antes no conocíamos (sin pisar otro cliente)
        ...(!c.waUserId && e.bsuid && !found.some((x) => x.id !== c.id && x.waUserId === e.bsuid) ? { waUserId: e.bsuid } : {}),
        ...(!c.phone && e.phone && !found.some((x) => x.id !== c.id && x.phone === e.phone) ? { phone: e.phone } : {}),
      },
    });
  }

  private message(tenantId: string, e: StoredEvent & InboundMessageEvent): Promise<InboundResult> {
    return this.db.tenant(tenantId, async (tx) => {
      const dup = await tx.message.findFirst({ where: { tenantId, providerMessageId: e.wamid }, select: { id: true, conversationId: true } });
      if (dup) return { outcome: 'duplicate', conversationId: dup.conversationId, messageId: dup.id };
      const number = await tx.whatsappNumber.findFirst({ where: { id: e.whatsappNumberId, tenantId } });
      if (!number) return { outcome: 'ignored' };
      const customer = await this.customer(tx, tenantId, e);
      const sentAt = e.timestamp ? new Date(e.timestamp * 1000) : new Date();

      let conv = await tx.conversation.findFirst({ where: { tenantId, customerId: customer.id, whatsappNumberId: number.id, status: 'OPEN' }, orderBy: { createdAt: 'desc' } });
      const newConversation = !conv;
      if (!conv) {
        conv = await tx.conversation.create({ data: { tenantId, customerId: customer.id, whatsappNumberId: number.id, lastMessageAt: sentAt } });
        // Uso del plan: conversaciones iniciadas en el mes
        await tx.$executeRaw`
          INSERT INTO usage_counters (tenant_id, metric, period, value) VALUES (${tenantId}::uuid, 'conversations', ${currentPeriod()}, 1)
          ON CONFLICT (tenant_id, metric, period) DO UPDATE SET value = usage_counters.value + 1`;
      } else {
        await tx.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: sentAt } });
      }
      const msg = await tx.message.create({
        data: {
          tenantId, conversationId: conv.id, direction: 'INBOUND', senderType: 'CUSTOMER', type: e.type,
          // Contenido NO CONFIABLE: se guarda tal cual como texto; nunca se interpreta como instrucción
          content: e.text ?? `[${e.type}]`, providerMessageId: e.wamid, status: 'received', providerTimestamp: sentAt,
        },
      });
      return { outcome: 'processed', conversationId: conv.id, messageId: msg.id, newConversation };
    });
  }

  private status(tenantId: string, e: StoredEvent & StatusEvent, receivedAt: Date): Promise<InboundResult> {
    return this.db.tenant(tenantId, async (tx) => {
      const m = await tx.message.findFirst({ where: { tenantId, providerMessageId: e.wamid, direction: 'OUTBOUND' } });
      if (!m) {
        // El estado puede llegar antes de que el worker guarde el wamid del envío: se reintenta un rato
        if (Date.now() - receivedAt.getTime() < 5 * 60_000) throw new Error('Mensaje de salida aún no registrado');
        return { outcome: 'ignored' };
      }
      if (e.status === 'failed') {
        if ((RANK[m.status ?? 'queued'] ?? 0) >= RANK.delivered!) return { outcome: 'processed', messageId: m.id }; // ya entregado: se ignora un fallo tardío
        await tx.message.update({ where: { id: m.id }, data: { status: 'failed', errorCode: e.error?.code ?? null, errorMessage: e.error?.message ?? null } });
        if (m.outboundId) await tx.outboundMessage.update({ where: { id: m.outboundId }, data: { status: 'FAILED', errorCode: e.error?.code ?? null, error: e.error?.message ?? null } });
        return { outcome: 'processed', messageId: m.id };
      }
      if (m.status === 'failed' || (RANK[e.status] ?? 0) <= (RANK[m.status ?? 'queued'] ?? 0)) return { outcome: 'processed', messageId: m.id };
      await tx.message.update({ where: { id: m.id }, data: { status: e.status } });
      return { outcome: 'processed', messageId: m.id };
    });
  }

  /** Eventos que quedaron sin procesar (p. ej. Redis caído al recibirlos) */
  stale(olderThanMs = 120_000, limit = 500) {
    return this.db.system.inboundEvent.findMany({
      where: { status: 'RECEIVED', receivedAt: { lt: new Date(Date.now() - olderThanMs) }, attempts: { lt: 10 } },
      select: { id: true, attempts: true },
      orderBy: { receivedAt: 'asc' },
      take: limit,
    });
  }
}
