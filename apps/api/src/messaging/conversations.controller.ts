import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { DatabaseService } from '../database/database.service.js';
import { paged, paginationSchema } from '../common/pagination.js';
import { OutboundService } from './outbound.service.js';
import type { Prisma } from '../generated/prisma/client.js';

const listSchema = paginationSchema.extend({
  status: z.enum(['OPEN', 'RESOLVED']).optional(),
  q: z.string().trim().max(100).optional(),
});
const replySchema = z.object({
  text: z.string().trim().min(1).max(4096),
  /** Clave del cliente (p. ej. UUID generado al abrir el editor) para no duplicar envíos */
  idempotencyKey: z.string().trim().min(8).max(100),
});

/** Bandeja interna de conversaciones de WhatsApp (la integración con Chatwoot llega en la FASE 5). */
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly outbound: OutboundService,
  ) {}

  @RequirePermission('conversations:read')
  @Get()
  list(@TenantUser() p: TenantPrincipal, @Query({ schema: listSchema }) q: z.infer<typeof listSchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const where: Prisma.ConversationWhereInput = {
        tenantId: p.tenantId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.q ? { customer: { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { waProfileName: { contains: q.q, mode: 'insensitive' } }, { phone: { contains: q.q.replace(/\D/g, '') || q.q } }] } } : {}),
      };
      const [items, total] = await Promise.all([
        tx.conversation.findMany({
          where, orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
          include: {
            customer: { select: { id: true, name: true, phone: true, waProfileName: true } },
            whatsappNumber: { select: { id: true, displayPhone: true, label: true } },
            messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { content: true, direction: true, createdAt: true, status: true } },
          },
        }),
        tx.conversation.count({ where }),
      ]);
      return paged(items, total, q.page, q.pageSize);
    });
  }

  @RequirePermission('conversations:read')
  @Get(':id')
  async get(@TenantUser() p: TenantPrincipal, @Param('id', { schema: z.uuid() }) id: string) {
    const c = await this.db.tenant(p.tenantId, (tx) =>
      tx.conversation.findFirst({
        where: { id, tenantId: p.tenantId },
        include: {
          customer: { select: { id: true, name: true, phone: true, waProfileName: true, waUserId: true } },
          whatsappNumber: { select: { id: true, displayPhone: true, label: true, isActive: true } },
          // Los 500 más recientes (se invierten abajo para mostrarlos en orden)
          messages: { orderBy: { createdAt: 'desc' }, take: 500, select: { id: true, direction: true, senderType: true, type: true, content: true, status: true, errorCode: true, errorMessage: true, createdAt: true } },
        },
      }),
    );
    if (!c) throw new NotFoundException('Conversación no encontrada');
    const lastInbound = c.messages.find((m) => m.direction === 'INBOUND');
    return { ...c, messages: c.messages.reverse(), serviceWindowEndsAt: lastInbound ? new Date(lastInbound.createdAt.getTime() + 24 * 3_600_000) : null };
  }

  @RequirePermission('conversations:reply')
  @Post(':id/messages')
  async reply(@TenantUser() p: TenantPrincipal, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: replySchema }) b: z.infer<typeof replySchema>) {
    const r = await this.outbound.enqueueText({ tenantId: p.tenantId, conversationId: id, text: b.text, sender: { type: 'AGENT', userId: p.userId }, idempotencyKey: `agent:${p.userId}:${b.idempotencyKey}` });
    return { outboundId: r.outbound.id, status: r.outbound.status, idempotentReplay: !r.created };
  }
}
