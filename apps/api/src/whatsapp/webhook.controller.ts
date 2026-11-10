import { BadRequestException, Controller, ForbiddenException, Get, Headers, HttpCode, Inject, Logger, NotFoundException, Param, Post, Query, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../common/decorators/auth.decorators.js';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { decrypt, safeEqual } from '../common/crypto/crypto.js';
import { Queues } from '../queues/queues.module.js';
import { parseWebhook, validSignature } from './webhook-payload.js';
import type { Prisma } from '../generated/prisma/client.js';

const KEY = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Webhook de WhatsApp Cloud API, una URL por número (/webhooks/whatsapp/<clave>).
 * Solo guarda y encola: el procesamiento lo hace el worker, así Meta recibe el 200
 * enseguida y un fallo interno no pierde mensajes (quedan en inbound_events).
 */
@Public()
@SkipThrottle()
@Controller('webhooks/whatsapp')
export class WhatsappWebhookController {
  private readonly log = new Logger('WhatsappWebhook');

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly queues: Queues,
  ) {}

  /** El enrutado ocurre antes de conocer la empresa: único uso del rol de sistema aquí */
  private async number(key: string) {
    if (!KEY.test(key)) throw new NotFoundException();
    const n = await this.db.system.whatsappNumber.findUnique({ where: { webhookKey: key } });
    if (!n || n.provider !== 'CLOUD_API') throw new NotFoundException();
    return n;
  }

  /** Verificación de Meta: hub.mode=subscribe, hub.verify_token, hub.challenge */
  @Get(':key')
  async verify(@Param('key') key: string, @Query('hub.mode') mode?: string, @Query('hub.verify_token') token?: string, @Query('hub.challenge') challenge?: string) {
    const n = await this.number(key);
    const expected = n.verifyTokenEnc ? decrypt(n.verifyTokenEnc, this.env.DATA_ENCRYPTION_KEY) : '';
    if (mode !== 'subscribe' || !token || !expected || !safeEqual(token, expected) || !challenge || !/^[\w-]{1,128}$/.test(challenge)) {
      throw new ForbiddenException('Verificación rechazada');
    }
    this.log.log(`Webhook verificado para el número ${n.id}`);
    return challenge;
  }

  @Post(':key')
  @HttpCode(200)
  async receive(@Param('key') key: string, @Req() req: Request, @Headers('x-hub-signature-256') signature?: string) {
    const n = await this.number(key);
    const raw = Buffer.isBuffer(req.body) ? req.body : null;
    if (!raw) throw new BadRequestException();
    const secret = n.appSecretEnc ? decrypt(n.appSecretEnc, this.env.DATA_ENCRYPTION_KEY) : this.env.WHATSAPP_APP_SECRET;
    if (!secret) throw new ServiceUnavailableException('Número sin App Secret configurado');
    if (!validSignature(raw, signature, secret)) {
      this.log.warn(`Firma inválida en el webhook del número ${n.id}`);
      throw new UnauthorizedException('Firma inválida');
    }
    // Número desactivado: se confirma la recepción (Meta deja de reintentar) pero no se procesa
    if (!n.isActive) return 'EVENT_RECEIVED';

    let events;
    try {
      events = parseWebhook(JSON.parse(raw.toString('utf8')));
    } catch {
      throw new BadRequestException('Cuerpo no reconocido');
    }
    // Un número solo acepta eventos de su propio phone_number_id
    const mine = events.filter((e) => e.phoneNumberId === n.phoneNumberId);
    if (mine.length) {
      const rows = await this.db.system.inboundEvent.createManyAndReturn({
        data: mine.map((e) => ({
          provider: 'whatsapp_cloud',
          externalId: e.kind === 'message' ? `msg:${e.wamid}` : `status:${e.wamid}:${e.status}`,
          tenantId: n.tenantId,
          payload: { ...e, whatsappNumberId: n.id } as unknown as Prisma.InputJsonValue,
        })),
        skipDuplicates: true, // reintentos y duplicados de Meta
        select: { id: true },
      });
      if (rows.length) await this.queues.inbound.addBulk(rows.map((r) => ({ name: 'event', data: { eventId: r.id }, opts: { jobId: r.id } })));
    }
    await this.db.system.whatsappNumber.update({ where: { id: n.id }, data: { lastWebhookAt: new Date() } });
    return 'EVENT_RECEIVED';
  }
}
