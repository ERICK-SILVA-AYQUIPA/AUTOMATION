import { Body, type CanActivate, Controller, type ExecutionContext, ForbiddenException, HttpCode, Inject, Injectable, Logger, NotFoundException, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';
import { z } from 'zod';
import { Public } from '../common/decorators/auth.decorators.js';
import { ENV, type Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { MailService } from '../mail/mail.service.js';

const notifySchema = z.object({
  eventId: z.uuid(),
  subject: z.string().trim().min(1).max(150),
  text: z.string().trim().min(1).max(4000),
});

/** Solo redes privadas o la propia máquina: n8n corre en la red interna de Docker */
export function isPrivateAddress(raw: string | undefined): boolean {
  if (!raw) return false;
  const ip = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(ip) === 6) return ip === '::1' || /^f[cd][0-9a-f]{2}:/i.test(ip);
  return false;
}

/** Token compartido + IP privada. Se comprueba ANTES de validar el cuerpo. */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const expected = this.env.N8N_INTERNAL_TOKEN;
    if (!expected) throw new NotFoundException();
    const a = Buffer.from(req.header('x-internal-token') ?? '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenException('Token interno inválido');
    if (!isPrivateAddress(req.ip)) throw new ForbiddenException('Solo desde la red interna');
    return true;
  }
}

/**
 * API interna para n8n. Nunca se publica a través de la web (next.config
 * excluye /api/v1/internal) y además exige el token compartido y una IP privada.
 */
@Public()
@UseGuards(InternalTokenGuard)
@Controller('internal')
export class InternalController {
  private readonly log = new Logger(InternalController.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly mail: MailService,
  ) {}

  /**
   * Correo a los administradores de la empresa del evento. Idempotente: n8n puede
   * reintentar y el correo sale una sola vez. El texto lo arma el flujo de n8n.
   */
  @Post('notify')
  @HttpCode(200)
  async notify(@Body({ schema: notifySchema }) b: z.infer<typeof notifySchema>) {
    const claimed = await this.db.system.$queryRaw<{ tenant_id: string }[]>`
      UPDATE automation_events SET notified_at = now() WHERE id = ${b.eventId}::uuid AND notified_at IS NULL RETURNING tenant_id`;
    if (!claimed.length) {
      const exists = await this.db.system.automationEvent.findUnique({ where: { id: b.eventId }, select: { id: true } });
      if (!exists) throw new NotFoundException('Evento desconocido');
      return { delivered: 0, duplicate: true };
    }
    const tenantId = claimed[0]!.tenant_id;
    const admins = await this.db.system.user.findMany({ where: { tenantId, role: 'TENANT_ADMIN', status: 'ACTIVE' }, select: { email: true } });
    try {
      let delivered = 0;
      for (const a of admins) if (await this.mail.send({ to: a.email, subject: b.subject, text: b.text })) delivered++;
      if (admins.length && !delivered) throw new Error('SMTP no configurado o sin respuesta');
      return { delivered, duplicate: false };
    } catch (e) {
      // Se libera para que el reintento de n8n vuelva a intentarlo
      await this.db.system.automationEvent.update({ where: { id: b.eventId }, data: { notifiedAt: null } });
      this.log.warn(`No se pudo enviar el aviso del evento ${b.eventId}: ${(e as Error).message}`);
      throw new ServiceUnavailableException('No se pudo enviar el correo; reintenta más tarde');
    }
  }
}
