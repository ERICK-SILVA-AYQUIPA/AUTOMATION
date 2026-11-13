import { Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AllowWhenReadOnly, TenantUser } from '../common/decorators/auth.decorators.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { DatabaseService } from '../database/database.service.js';

const listSchema = z.object({ unread: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });

/**
 * Avisos internos del panel: derivaciones a una persona, WhatsApp desconectado,
 * stock bajo, fallos de automatizaciones… Un aviso sin usuario es para todo el
 * equipo de la empresa; marcarlo como leído lo marca para todos.
 */
@AllowWhenReadOnly()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly db: DatabaseService) {}

  private where(p: TenantPrincipal) {
    return { tenantId: p.tenantId, OR: [{ userId: null }, { userId: p.userId }] };
  }

  @Get()
  list(@TenantUser() p: TenantPrincipal, @Query({ schema: listSchema }) q: z.infer<typeof listSchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const where = { ...this.where(p), ...(q.unread === 'true' ? { readAt: null } : {}) };
      const [items, unread] = await Promise.all([
        tx.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: q.limit, select: { id: true, type: true, title: true, body: true, data: true, readAt: true, createdAt: true } }),
        tx.notification.count({ where: { ...this.where(p), readAt: null } }),
      ]);
      return { items, unread };
    });
  }

  @HttpCode(204)
  @Post(':id/read')
  async read(@TenantUser() p: TenantPrincipal, @Param('id', { schema: z.uuid() }) id: string) {
    const r = await this.db.tenant(p.tenantId, (tx) => tx.notification.updateMany({ where: { id, ...this.where(p), readAt: null }, data: { readAt: new Date() } }));
    if (r.count === 0) {
      const exists = await this.db.tenant(p.tenantId, (tx) => tx.notification.count({ where: { id, ...this.where(p) } }));
      if (!exists) throw new NotFoundException('Aviso no encontrado');
    }
  }

  @HttpCode(204)
  @Post('read-all')
  async readAll(@TenantUser() p: TenantPrincipal) {
    await this.db.tenant(p.tenantId, (tx) => tx.notification.updateMany({ where: { ...this.where(p), readAt: null }, data: { readAt: new Date() } }));
  }
}
