import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { hasPermission } from '../common/permissions.js';
import { RequireModule } from '../common/decorators/module.decorator.js';
import { AuditService } from '../audit/audit.service.js';
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
  /** human: atendidas por una persona (IA en pausa); mine: asignadas a mí; unassigned: sin asignar */
  view: z.enum(['human', 'mine', 'unassigned']).optional(),
  tag: z.string().trim().max(30).optional(),
});
const updateSchema = z
  .object({
    status: z.enum(['OPEN', 'RESOLVED']).optional(),
    /** ACTIVE: la IA vuelve a responder; PAUSED: atiende una persona */
    botStatus: z.enum(['ACTIVE', 'PAUSED']).optional(),
    assignedUserId: z.uuid().nullable().optional(),
    tags: z.array(z.string().trim().toLowerCase().min(1).max(30)).max(10).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nada que actualizar');
const noteSchema = z.object({ body: z.string().trim().min(1).max(2000) });
const replySchema = z.object({
  text: z.string().trim().min(1).max(4096),
  /** Clave del cliente (p. ej. UUID generado al abrir el editor) para no duplicar envíos */
  idempotencyKey: z.string().trim().min(8).max(100),
});

/** Bandeja interna de conversaciones de WhatsApp: atención, asignación, notas y control de la IA. */
@RequireModule('conversations')
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly outbound: OutboundService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermission('conversations:read')
  @Get()
  list(@TenantUser() p: TenantPrincipal, @Query({ schema: listSchema }) q: z.infer<typeof listSchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const where: Prisma.ConversationWhereInput = {
        tenantId: p.tenantId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.view === 'human' ? { botStatus: 'PAUSED' as const } : q.view === 'mine' ? { assignedUserId: p.userId } : q.view === 'unassigned' ? { assignedUserId: null } : {}),
        ...(q.tag ? { tags: { has: q.tag.toLowerCase() } } : {}),
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
    const r = await this.db.tenant(p.tenantId, async (tx) => {
      const c = await tx.conversation.findFirst({
        where: { id, tenantId: p.tenantId },
        include: {
          customer: { select: { id: true, name: true, phone: true, waProfileName: true, waUserId: true } },
          whatsappNumber: { select: { id: true, displayPhone: true, label: true, isActive: true } },
          // Los 500 más recientes (se invierten abajo para mostrarlos en orden)
          messages: { orderBy: { createdAt: 'desc' }, take: 500, select: { id: true, direction: true, senderType: true, type: true, content: true, status: true, errorCode: true, errorMessage: true, createdAt: true } },
          notes: { orderBy: { createdAt: 'asc' }, take: 200, select: { id: true, body: true, authorId: true, createdAt: true } },
        },
      });
      if (!c) return null;
      // Nombres de los autores de notas y de la persona asignada (solo de esta empresa)
      const ids = [...new Set([c.assignedUserId, ...c.notes.map((n) => n.authorId)].filter((v): v is string => !!v))];
      const people = ids.length ? await tx.user.findMany({ where: { tenantId: p.tenantId, id: { in: ids } }, select: { id: true, name: true } }) : [];
      return { c, people: Object.fromEntries(people.map((u) => [u.id, u.name])) };
    });
    if (!r) throw new NotFoundException('Conversación no encontrada');
    const { c, people } = r;
    const lastInbound = c.messages.find((m) => m.direction === 'INBOUND');
    return { ...c, people, messages: c.messages.reverse(), serviceWindowEndsAt: lastInbound ? new Date(lastInbound.createdAt.getTime() + 24 * 3_600_000) : null };
  }

  @RequirePermission('conversations:reply')
  @Post(':id/messages')
  async reply(@TenantUser() p: TenantPrincipal, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: replySchema }) b: z.infer<typeof replySchema>) {
    const r = await this.outbound.enqueueText({ tenantId: p.tenantId, conversationId: id, text: b.text, sender: { type: 'AGENT', userId: p.userId }, idempotencyKey: `agent:${p.userId}:${b.idempotencyKey}` });
    // Responde una persona: la IA se pausa para no contestar a la vez (se reactiva a mano o al cerrar)
    if (r.created) {
      await this.db.tenant(p.tenantId, async (tx) => {
        await tx.conversation.updateMany({ where: { id, tenantId: p.tenantId, botStatus: 'ACTIVE' }, data: { botStatus: 'PAUSED', handoffAt: new Date(), handoffReason: 'agent_reply' } });
        await tx.conversation.updateMany({ where: { id, tenantId: p.tenantId, assignedUserId: null }, data: { assignedUserId: p.userId } });
      });
    }
    return { outboundId: r.outbound.id, status: r.outbound.status, idempotentReplay: !r.created };
  }

  /** Cerrar o reabrir, pausar o reactivar la IA, asignar y etiquetar. */
  @RequirePermission('conversations:reply')
  @Patch(':id')
  async update(@TenantUser() p: TenantPrincipal, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: updateSchema }) b: z.infer<typeof updateSchema>) {
    if (b.assignedUserId !== undefined && b.assignedUserId !== p.userId && !hasPermission(p.role, 'conversations:assign')) {
      throw new BadRequestException('Solo un supervisor o administrador puede asignar conversaciones a otra persona');
    }
    return this.db.tenant(p.tenantId, async (tx) => {
      const c = await tx.conversation.findFirst({ where: { id, tenantId: p.tenantId }, select: { id: true } });
      if (!c) throw new NotFoundException('Conversación no encontrada');
      if (b.assignedUserId) {
        const u = await tx.user.findFirst({ where: { id: b.assignedUserId, tenantId: p.tenantId, status: 'ACTIVE' }, select: { id: true } });
        if (!u) throw new BadRequestException('El usuario no existe o está inactivo');
      }
      const data: Prisma.ConversationUpdateInput = {
        ...(b.tags ? { tags: [...new Set(b.tags)] } : {}),
        ...(b.assignedUserId !== undefined ? { assignedUserId: b.assignedUserId } : {}),
        ...(b.botStatus === 'ACTIVE' ? { botStatus: 'ACTIVE', handoffAt: null, handoffReason: null } : {}),
        ...(b.botStatus === 'PAUSED' ? { botStatus: 'PAUSED', handoffAt: new Date(), handoffReason: 'manual' } : {}),
        // Cerrar devuelve la siguiente conversación a la IA; reabrir no cambia quién atiende
        ...(b.status === 'RESOLVED' ? { status: 'RESOLVED', botStatus: 'ACTIVE', handoffAt: null, handoffReason: null } : {}),
        ...(b.status === 'OPEN' ? { status: 'OPEN' } : {}),
      };
      const updated = await tx.conversation.update({ where: { id }, data, select: { id: true, status: true, botStatus: true, assignedUserId: true, tags: true, handoffReason: true } });
      await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'conversation.updated', entityType: 'conversation', entityId: id, metadata: b });
      return updated;
    });
  }

  /** Nota interna del equipo: no se envía al cliente ni a la IA. */
  @RequirePermission('conversations:reply')
  @Post(':id/notes')
  addNote(@TenantUser() p: TenantPrincipal, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: noteSchema }) b: z.infer<typeof noteSchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const c = await tx.conversation.findFirst({ where: { id, tenantId: p.tenantId }, select: { id: true } });
      if (!c) throw new NotFoundException('Conversación no encontrada');
      return tx.conversationNote.create({ data: { tenantId: p.tenantId, conversationId: id, authorId: p.userId, body: b.body }, select: { id: true, body: true, authorId: true, createdAt: true } });
    });
  }
}
