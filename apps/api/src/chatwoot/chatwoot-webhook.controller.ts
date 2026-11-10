import { BadRequestException, Controller, HttpCode, Injectable, Logger, NotFoundException, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { Public } from '../common/decorators/auth.decorators.js';
import { DatabaseService } from '../database/database.service.js';
import { OutboundService } from '../messaging/outbound.service.js';
import { ChatwootClient } from './chatwoot.client.js';
import { ChatwootService, type ChatwootContext } from './chatwoot.service.js';

/** Margen para la marca de tiempo firmada (evita reenvíos de peticiones capturadas) */
const MAX_SKEW_SECONDS = 300;

/** Solo los campos que usamos; el resto del cuerpo se ignora */
const eventSchema = z.object({
  event: z.string().max(60),
  id: z.number().int().optional(),
  message_type: z.string().max(20).optional(),
  private: z.boolean().optional(),
  content: z.string().max(10_000).nullable().optional(),
  attachments: z.array(z.unknown()).max(50).optional(),
  sender: z.object({ id: z.number().int().optional(), type: z.string().max(30).optional() }).nullable().optional(),
  conversation: z.object({ id: z.number().int() }).nullable().optional(),
  status: z.string().max(20).optional(),
  meta: z.object({ assignee: z.object({ id: z.number().int() }).nullable().optional() }).optional(),
});
type CwEvent = z.infer<typeof eventSchema>;

export function validChatwootSignature(rawBody: Buffer, timestamp: string | undefined, signature: string | undefined, secret: string, now = Date.now()) {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex')}`);
  const got = Buffer.from(signature);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/**
 * Qué hacemos con cada aviso de Chatwoot (verificado con la instancia local v4.19.1):
 * - message_created saliente, público, escrito por un agente humano -> se envía por WhatsApp
 *   y el bot se pausa en esa conversación. Se ignoran: entrantes (los copiamos nosotros),
 *   notas privadas y los mensajes del usuario de integración (ya salieron por WhatsApp).
 * - conversation_status_changed: resuelta -> el bot vuelve a atender; abierta con agente
 *   asignado o pospuesta -> bot en pausa; pendiente -> atiende el bot.
 * - conversation_updated con cambio de agente asignado -> bot en pausa.
 */
@Injectable()
export class ChatwootWebhookService {
  private readonly log = new Logger('ChatwootWebhook');

  constructor(
    private readonly db: DatabaseService,
    private readonly outbound: OutboundService,
    private readonly cw: ChatwootClient,
  ) {}

  async handle(ctx: ChatwootContext, e: CwEvent): Promise<string> {
    const cwConvId = e.event.startsWith('message_') ? e.conversation?.id : e.id;
    if (!cwConvId) return 'ignored: sin conversación';
    const conv = await this.db.tenant(ctx.tenantId, (tx) => tx.conversation.findFirst({ where: { tenantId: ctx.tenantId, chatwootConversationId: cwConvId } }));
    if (!conv) return 'ignored: conversación desconocida';

    if (e.event === 'message_created') {
      if (e.message_type !== 'outgoing' || e.private || e.sender?.type !== 'user' || !e.sender.id || e.sender.id === ctx.cfg.botUserId || !e.id) return 'ignored';
      const text = (e.content ?? '').trim();
      if (!text) {
        await this.fail(ctx, cwConvId, e.id, 'Los adjuntos desde Chatwoot aún no se envían por WhatsApp');
        return 'rejected: sin texto';
      }
      const agent = await this.db.tenant(ctx.tenantId, (tx) => tx.user.findFirst({ where: { tenantId: ctx.tenantId, chatwootUserId: e.sender!.id }, select: { id: true } }));
      try {
        await this.outbound.enqueueText({
          tenantId: ctx.tenantId, conversationId: conv.id, text, sender: { type: 'AGENT', userId: agent?.id ?? null },
          // Clave por mensaje de Chatwoot: un aviso repetido no envía dos veces
          idempotencyKey: `chatwoot:${e.id}`, chatwootMessageId: e.id,
        });
      } catch (err) {
        if (err instanceof BadRequestException) {
          const body = err.getResponse() as { message?: string };
          await this.fail(ctx, cwConvId, e.id, body.message ?? err.message);
          return 'rejected';
        }
        throw err;
      }
      await this.pauseBot(ctx.tenantId, conv.id, 'agent_reply', agent?.id);
      return 'sent';
    }

    if (e.event === 'conversation_status_changed') {
      const status = e.status;
      await this.db.tenant(ctx.tenantId, (tx) =>
        tx.conversation.update({
          where: { id: conv.id },
          data:
            status === 'resolved' ? { status: 'RESOLVED', botStatus: 'ACTIVE', handoffReason: null }
            : status === 'pending' ? { status: 'OPEN', botStatus: 'ACTIVE' }
            : status === 'snoozed' || (status === 'open' && e.meta?.assignee) ? { status: 'OPEN', botStatus: 'PAUSED', handoffAt: conv.botStatus === 'ACTIVE' ? new Date() : conv.handoffAt }
            : { status: 'OPEN' },
        }),
      );
      return `status: ${status}`;
    }

    if (e.event === 'conversation_updated' && e.meta?.assignee?.id) {
      const agent = await this.db.tenant(ctx.tenantId, (tx) => tx.user.findFirst({ where: { tenantId: ctx.tenantId, chatwootUserId: e.meta!.assignee!.id }, select: { id: true } }));
      await this.pauseBot(ctx.tenantId, conv.id, 'assigned', agent?.id);
      return 'assigned';
    }
    return 'ignored';
  }

  private async pauseBot(tenantId: string, conversationId: string, reason: string, userId?: string) {
    await this.db.tenant(tenantId, (tx) =>
      tx.conversation.updateMany({
        where: { id: conversationId, tenantId },
        data: { botStatus: 'PAUSED', ...(userId ? { assignedUserId: userId } : {}) },
      }).then(() => tx.conversation.updateMany({ where: { id: conversationId, tenantId, handoffAt: null }, data: { handoffAt: new Date(), handoffReason: reason } })),
    );
  }

  /** Marca el mensaje del agente como fallido en Chatwoot, con el motivo visible */
  private async fail(ctx: ChatwootContext, cwConvId: number, cwMessageId: number, reason: string) {
    await this.cw.updateMessageStatus(ctx.cfg.accountId, ctx.botToken, cwConvId, cwMessageId, 'failed', reason).catch((err: Error) => this.log.warn(`No se pudo marcar el fallo en Chatwoot: ${err.message}`));
  }
}

@Public()
@SkipThrottle()
@Controller('webhooks/chatwoot')
export class ChatwootWebhookController {
  constructor(
    private readonly db: DatabaseService,
    private readonly chatwoot: ChatwootService,
    private readonly handler: ChatwootWebhookService,
  ) {}

  @Post(':key')
  @HttpCode(200)
  async receive(@Param('key') key: string, @Req() req: Request) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) throw new NotFoundException();
    const i = await this.db.system.tenantIntegration.findUnique({ where: { webhookKey: key } });
    const ctx = i && i.type === 'CHATWOOT' ? this.chatwoot.toContext(i) : null;
    if (!ctx) throw new NotFoundException();
    const raw = req.body as unknown;
    if (!Buffer.isBuffer(raw)) throw new BadRequestException('Cuerpo inválido');
    if (!validChatwootSignature(raw, req.header('x-chatwoot-timestamp'), req.header('x-chatwoot-signature'), ctx.webhookSecret)) throw new UnauthorizedException('Firma inválida');
    let parsed: CwEvent;
    try {
      parsed = eventSchema.parse(JSON.parse(raw.toString('utf8')));
    } catch {
      throw new BadRequestException('Evento inválido');
    }
    return { result: await this.handler.handle(ctx, parsed) };
  }
}
