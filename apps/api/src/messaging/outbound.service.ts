import { AutomationEvents } from '../automations/automation-events.service.js';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { decrypt } from '../common/crypto/crypto.js';
import { Queues } from '../queues/queues.module.js';
import { CloudApiClient, WhatsappApiError, type Recipient } from '../whatsapp/cloud-api.client.js';
import type { Prisma } from '../generated/prisma/client.js';
import { subscriptionAccess } from '../plans/subscription-access.js';

/** Ventana de atención de WhatsApp: fuera de ella solo se permiten plantillas */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface EnqueueText {
  tenantId: string;
  conversationId: string;
  text: string;
  sender: { type: 'BOT' | 'AGENT' | 'SYSTEM'; userId?: string | null };
  /** Repetir la misma clave no crea otro envío */
  idempotencyKey: string;
  /** El mensaje ya existe en Chatwoot (respuesta de un agente): no se vuelve a copiar */
  chatwootMessageId?: number;
}

/** Error definitivo: el worker no debe reintentar */
export class PermanentSendError extends Error {}

/**
 * Salida de mensajes: se registra en BD (outbound_messages + messages) y se encola.
 * El envío real lo hace el worker con reintentos; el estado de entrega llega por webhook.
 */
@Injectable()
export class OutboundService {
  private readonly log = new Logger('Outbound');

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly queues: Queues,
    private readonly cloud: CloudApiClient,
    private readonly automations: AutomationEvents,
  ) {}

  async enqueueText(input: EnqueueText) {
    const text = input.text.trim();
    if (!text) throw new BadRequestException('El mensaje está vacío');
    if (text.length > 4096) throw new BadRequestException('Máximo 4096 caracteres');
    const out = await this.db.tenant(input.tenantId, async (tx) => {
      const existing = await tx.outboundMessage.findUnique({ where: { tenantId_idempotencyKey: { tenantId: input.tenantId, idempotencyKey: input.idempotencyKey } } });
      if (existing) return { outbound: existing, created: false, messageId: null };
      // Cuenta en solo lectura: no se envía nada en nombre de la empresa (agentes, IA ni automatizaciones)
      const sub = await tx.subscription.findFirst({ select: { status: true, trialEndsAt: true, currentPeriodEnd: true } });
      if (!sub || subscriptionAccess(sub, this.env.BILLING_GRACE_DAYS).readOnly) {
        throw new BadRequestException({ code: 'SUBSCRIPTION_EXPIRED', message: 'La suscripción de la empresa venció: renueva el plan para volver a enviar mensajes' });
      }
      const conv = await tx.conversation.findFirst({ where: { id: input.conversationId, tenantId: input.tenantId }, include: { whatsappNumber: true } });
      if (!conv) throw new NotFoundException('Conversación no encontrada');
      if (!conv.whatsappNumber.isActive) throw new BadRequestException('El número de WhatsApp de esta conversación está desactivado');
      const lastInbound = await tx.message.findFirst({ where: { conversationId: conv.id, direction: 'INBOUND' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      if (!lastInbound || Date.now() - lastInbound.createdAt.getTime() > SERVICE_WINDOW_MS) {
        throw new BadRequestException({ code: 'OUTSIDE_SERVICE_WINDOW', message: 'Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp solo permite plantillas aprobadas' });
      }
      const outbound = await tx.outboundMessage.create({
        data: { tenantId: input.tenantId, conversationId: conv.id, idempotencyKey: input.idempotencyKey, payload: { type: 'text', text } as Prisma.InputJsonValue },
      });
      const msg = await tx.message.create({
        data: {
          tenantId: input.tenantId, conversationId: conv.id, direction: 'OUTBOUND', senderType: input.sender.type, senderUserId: input.sender.userId ?? null,
          type: 'text', content: text, status: 'queued', outboundId: outbound.id, chatwootMessageId: input.chatwootMessageId ?? null,
        },
      });
      await tx.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date() } });
      return { outbound, created: true, messageId: msg.id };
    });
    if (out.created) {
      await this.queues.outbound.add('send', { tenantId: input.tenantId, outboundId: out.outbound.id }, { jobId: out.outbound.id });
      if (!input.chatwootMessageId && out.messageId) await this.queues.mirrorToChatwoot(input.tenantId, out.messageId);
    }
    return out;
  }

  /** Lo llama el worker. Lanza error para reintentar; PermanentSendError para no hacerlo. */
  async send(tenantId: string, outboundId: string): Promise<'sent' | 'skipped'> {
    const ctx = await this.db.tenant(tenantId, async (tx) => {
      const o = await tx.outboundMessage.findFirst({ where: { id: outboundId, tenantId } });
      if (!o || o.status !== 'QUEUED') return null;
      const conv = await tx.conversation.findFirstOrThrow({ where: { id: o.conversationId }, include: { whatsappNumber: true, customer: true } });
      return { o, conv };
    });
    if (!ctx) return 'skipped';
    const { o, conv } = ctx;
    const n = conv.whatsappNumber;
    const payload = o.payload as { type: 'text'; text: string };

    const fail = async (code: number | null, error: string) => {
      await this.db.tenant(tenantId, async (tx) => {
        await tx.outboundMessage.update({ where: { id: o.id }, data: { status: 'FAILED', errorCode: code, error, attempts: { increment: 1 } } });
        await tx.message.updateMany({ where: { outboundId: o.id }, data: { status: 'failed', errorCode: code, errorMessage: error } });
        // FLUJO 7: alerta administrativa
        await this.automations.emit(tx, tenantId, 'ERROR_ALERT', { source: 'whatsapp.send', conversationId: o.conversationId, outboundId: o.id, code, error });
      });
      await this.statusToChatwoot(tenantId, o.id);
    };

    if (n.provider !== 'CLOUD_API' || !n.phoneNumberId || !n.accessTokenEnc) {
      await fail(null, 'El número no tiene credenciales de WhatsApp Cloud API');
      throw new PermanentSendError('Número sin credenciales');
    }
    const to: Recipient | null = conv.customer.phone ? { phone: conv.customer.phone } : conv.customer.waUserId ? { bsuid: conv.customer.waUserId } : null;
    if (!to) {
      await fail(null, 'El cliente no tiene teléfono ni identificador de WhatsApp');
      throw new PermanentSendError('Sin destinatario');
    }

    try {
      const wamid = await this.cloud.sendText(n.phoneNumberId, decrypt(n.accessTokenEnc, this.env.DATA_ENCRYPTION_KEY), to, payload.text);
      await this.db.tenant(tenantId, async (tx) => {
        await tx.outboundMessage.update({ where: { id: o.id }, data: { status: 'SENT', providerMessageId: wamid, sentAt: new Date(), attempts: { increment: 1 }, error: null, errorCode: null } });
        // Si el webhook de estado llegó antes que esta actualización, no retrocedemos el estado
        await tx.message.updateMany({ where: { outboundId: o.id, status: 'queued' }, data: { status: 'sent' } });
        await tx.message.updateMany({ where: { outboundId: o.id }, data: { providerMessageId: wamid } });
      });
      await this.statusToChatwoot(tenantId, o.id);
      return 'sent';
    } catch (e) {
      if (!(e instanceof WhatsappApiError)) throw e;
      if (e.retryable) {
        await this.db.tenant(tenantId, (tx) => tx.outboundMessage.update({ where: { id: o.id }, data: { attempts: { increment: 1 }, errorCode: e.code, error: e.message } }));
        throw e;
      }
      await fail(e.code, e.message);
      if (e.code === 190) {
        // Token caducado o revocado: se marca el número y se avisa a los administradores
        await this.db.tenant(tenantId, async (tx) => {
          await tx.whatsappNumber.update({ where: { id: n.id }, data: { status: 'ERROR', lastError: 'El token de acceso de Meta caducó o fue revocado' } });
          await this.automations.emit(tx, tenantId, 'ERROR_ALERT', { source: 'whatsapp.token_expired', whatsappNumberId: n.id, displayPhone: n.displayPhone, code: 190, error: e.message });
          await tx.notification.create({ data: { tenantId, type: 'whatsapp.token_expired', title: 'WhatsApp desconectado', body: `El token de acceso del número ${n.displayPhone} ya no es válido. Actualízalo en Integraciones.`, data: { whatsappNumberId: n.id } } });
        });
      }
      throw new PermanentSendError(e.message);
    }
  }

  /** Agotados los reintentos de un error temporal */
  async markExhausted(tenantId: string, outboundId: string, error: string) {
    await this.db.tenant(tenantId, async (tx) => {
      const o = await tx.outboundMessage.findFirst({ where: { id: outboundId, tenantId } });
      if (!o || o.status !== 'QUEUED') return;
      await tx.outboundMessage.update({ where: { id: o.id }, data: { status: 'FAILED', error } });
      await tx.message.updateMany({ where: { outboundId: o.id }, data: { status: 'failed', errorCode: o.errorCode, errorMessage: error } });
      await this.automations.emit(tx, tenantId, 'ERROR_ALERT', { source: 'whatsapp.send', conversationId: o.conversationId, outboundId: o.id, code: o.errorCode, error });
    });
    await this.statusToChatwoot(tenantId, outboundId);
  }

  /** Copia el estado de entrega al mensaje espejo de Chatwoot (si existe la integración) */
  private async statusToChatwoot(tenantId: string, outboundId: string) {
    const m = await this.db.tenant(tenantId, (tx) => tx.message.findFirst({ where: { outboundId, tenantId }, select: { id: true } }));
    if (m) await this.queues.mirrorToChatwoot(tenantId, m.id, 'status');
  }
}
