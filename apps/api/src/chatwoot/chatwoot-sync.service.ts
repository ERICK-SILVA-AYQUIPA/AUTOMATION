import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { ChatwootApiError, ChatwootClient, type ChatwootMessageStatus } from './chatwoot.client.js';
import { ChatwootService, type ChatwootContext } from './chatwoot.service.js';

/** Error que no se arregla reintentando (el worker no vuelve a intentarlo) */
export class ChatwootPermanentError extends Error {}

const STATUS_MAP: Record<string, ChatwootMessageStatus | undefined> = { sent: 'sent', delivered: 'delivered', read: 'read', played: 'read', failed: 'failed' };

/**
 * Espejo en Chatwoot de lo que pasa en WhatsApp (lo ejecuta el worker, cola chatwoot-sync):
 * - mirror: copia un mensaje (entrante del cliente o saliente del bot/panel).
 * - status: copia el estado de entrega de un mensaje saliente.
 * Los mensajes que nacen en Chatwoot (respuestas de agentes) ya traen su id y no se copian.
 */
@Injectable()
export class ChatwootSyncService {
  private readonly log = new Logger('ChatwootSync');

  constructor(
    private readonly db: DatabaseService,
    private readonly cw: ChatwootClient,
    private readonly chatwoot: ChatwootService,
  ) {}

  async run(kind: 'mirror' | 'status', tenantId: string, messageId: string): Promise<string> {
    const ctx = await this.chatwoot.context(tenantId);
    if (!ctx) return 'skipped: chatwoot no conectado';
    try {
      return kind === 'mirror' ? await this.mirror(ctx, messageId) : await this.status(ctx, messageId);
    } catch (e) {
      // 4xx de Chatwoot (salvo 429) no se arregla reintentando
      if (e instanceof ChatwootApiError && !e.retryable) throw new ChatwootPermanentError(e.message);
      throw e;
    }
  }

  private async mirror(ctx: ChatwootContext, messageId: string): Promise<string> {
    const { tenantId } = ctx;
    const m = await this.db.tenant(tenantId, (tx) =>
      tx.message.findFirst({ where: { id: messageId, tenantId }, include: { conversation: { include: { customer: true } } } }),
    );
    if (!m) return 'skipped: mensaje no encontrado';
    if (m.chatwootMessageId) return 'skipped: ya copiado';
    const conv = m.conversation;
    const c = conv.customer;
    const { accountId, inboxId } = ctx.cfg;

    // 1. Contacto (+ su source_id en el buzón API)
    let contactId = c.chatwootContactId;
    let sourceId = c.chatwootSourceId;
    if (!contactId || !sourceId) {
      const name = c.name ?? c.waProfileName ?? (c.phone ? `+${c.phone}` : 'Cliente de WhatsApp');
      const r = await this.cw.createContact(accountId, ctx.botToken, { inboxId, name, phone: c.phone, identifier: c.id });
      contactId = r.payload.contact.id;
      sourceId = r.payload.contact_inbox?.source_id ?? r.payload.contact_inboxes?.find((x) => !x.inbox || x.inbox.id === inboxId)?.source_id ?? null;
      if (!sourceId) sourceId = (await this.cw.createContactInbox(accountId, ctx.botToken, contactId, inboxId)).source_id;
      await this.db.tenant(tenantId, (tx) => tx.customer.update({ where: { id: c.id }, data: { chatwootContactId: contactId, chatwootSourceId: sourceId } }));
    }

    // 2. Conversación
    let cwConvId = conv.chatwootConversationId;
    if (!cwConvId) {
      cwConvId = (await this.cw.createConversation(accountId, ctx.botToken, { sourceId: sourceId!, inboxId, contactId: contactId! })).id;
      await this.db.tenant(tenantId, (tx) => tx.conversation.update({ where: { id: conv.id }, data: { chatwootConversationId: cwConvId } }));
    }

    // 3. Mensaje. El texto del cliente se copia tal cual (Chatwoot lo muestra como texto)
    const created = await this.cw.createMessage(accountId, ctx.botToken, cwConvId, { content: m.content, type: m.direction === 'INBOUND' ? 'incoming' : 'outgoing' });
    await this.db.tenant(tenantId, (tx) => tx.message.update({ where: { id: m.id }, data: { chatwootMessageId: created.id } }));
    // Si el estado de entrega llegó antes que la copia, se refleja ahora
    if (m.direction === 'OUTBOUND' && m.status && m.status !== 'queued') await this.status(ctx, m.id);
    return `mirrored: ${created.id}`;
  }

  private async status(ctx: ChatwootContext, messageId: string): Promise<string> {
    const m = await this.db.tenant(ctx.tenantId, (tx) =>
      tx.message.findFirst({ where: { id: messageId, tenantId: ctx.tenantId }, include: { conversation: { select: { chatwootConversationId: true } } } }),
    );
    if (!m || m.direction !== 'OUTBOUND') return 'skipped';
    const status = STATUS_MAP[m.status ?? ''];
    if (!status) return 'skipped: sin estado que copiar';
    // Aún no copiado: se reintenta más tarde (la cola mantiene el orden)
    if (!m.chatwootMessageId || !m.conversation.chatwootConversationId) throw new Error('El mensaje aún no está en Chatwoot');
    try {
      await this.cw.updateMessageStatus(ctx.cfg.accountId, ctx.botToken, m.conversation.chatwootConversationId, m.chatwootMessageId, status, m.errorMessage ?? undefined);
    } catch (e) {
      // Chatwoot no deja retroceder (p. ej. read -> delivered): no es un error
      if (e instanceof ChatwootApiError && e.status === 422) return 'skipped: estado anterior';
      throw e;
    }
    return `status: ${status}`;
  }
}
