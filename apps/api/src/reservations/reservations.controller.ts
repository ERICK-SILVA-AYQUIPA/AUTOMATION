import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { RequireModule } from '../common/decorators/module.decorator.js';
import { RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { paged, paginationSchema } from '../common/pagination.js';
import { zonedToUtc } from '../common/time/zoned.js';
import { phone } from '../customers/customers.controller.js';
import { DatabaseService } from '../database/database.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { ReservationsService, reservationInclude } from './reservations.service.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato AAAA-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora en formato HH:MM');
const statusEnum = z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW']);

const createSchema = z
  .object({
    customerId: z.uuid().optional(),
    customer: z.object({ phone, name: z.string().trim().min(1).max(120).optional() }).optional(),
    date, time,
    partySize: z.number().int().min(1).max(500).default(1),
    productId: z.uuid().nullish(),
    notes: z.string().trim().max(1000).nullish(),
    idempotencyKey: z.string().trim().min(8).max(100).optional(),
  })
  .strict()
  .refine((v) => v.customerId || v.customer, { message: 'Indica el cliente', path: ['customer'] });

const listSchema = paginationSchema.extend({
  /** Día local de la empresa; sin él, las próximas */
  date: date.optional(),
  status: statusEnum.optional(),
  customerId: z.uuid().optional(),
});

@RequireModule('reservations')
@Controller('reservations')
export class ReservationsController {
  constructor(
    private readonly reservations: ReservationsService,
    private readonly db: DatabaseService,
  ) {}

  @RequirePermission('reservations:read')
  @Get()
  list(@TenantUser() p: TenantPrincipal, @Query({ schema: listSchema }) q: z.infer<typeof listSchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const { timezone } = await tx.tenant.findUniqueOrThrow({ where: { id: p.tenantId }, select: { timezone: true } });
      const where: Prisma.ReservationWhereInput = {
        ...(q.status ? { status: q.status } : {}),
        ...(q.customerId ? { customerId: q.customerId } : {}),
        ...(q.date
          ? { startsAt: { gte: zonedToUtc(q.date, '00:00', timezone), lt: new Date(zonedToUtc(q.date, '00:00', timezone).getTime() + 86_400_000) } }
          : { startsAt: { gte: new Date(Date.now() - 2 * 3600_000) } }),
      };
      const [items, total] = await Promise.all([
        tx.reservation.findMany({ where, orderBy: { startsAt: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: reservationInclude }),
        tx.reservation.count({ where }),
      ]);
      return paged(items, total, q.page, q.pageSize);
    });
  }

  /** Horarios libres de un día (lo mismo que consulta el asistente) */
  @RequirePermission('reservations:read')
  @Get('availability')
  availability(@TenantUser() p: TenantPrincipal, @Query({ schema: z.object({ date, partySize: z.coerce.number().int().min(1).max(500).default(1), productId: z.uuid().optional() }) }) q: { date: string; partySize: number; productId?: string }) {
    return this.db.tenant(p.tenantId, (tx) => this.reservations.availability(tx, p.tenantId, q, new Date(), { staff: true }));
  }

  @RequirePermission('reservations:write')
  @Post()
  async create(@TenantUser() p: TenantPrincipal, @Body({ schema: createSchema }) b: z.infer<typeof createSchema>, @Res({ passthrough: true }) res: Response) {
    let customerId = b.customerId;
    if (!customerId && b.customer) {
      const where = { tenantId_phone: { tenantId: p.tenantId, phone: b.customer.phone } };
      const c = await this.db
        .tenant(p.tenantId, (tx) => tx.customer.upsert({ where, create: { tenantId: p.tenantId, phone: b.customer!.phone, name: b.customer!.name, source: 'manual' }, update: {}, select: { id: true } }))
        .catch(async (e: unknown) => {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return this.db.tenant(p.tenantId, (tx) => tx.customer.findUniqueOrThrow({ where, select: { id: true } }));
          throw e;
        });
      customerId = c.id;
    }
    const { customer: _c, ...rest } = b;
    const r = await this.reservations.create({ tenantId: p.tenantId, userId: p.userId }, { ...rest, customerId: customerId!, channel: 'MANUAL', confirm: true });
    res.status(r.created ? 201 : 200);
    return r.reservation;
  }

  @RequirePermission('reservations:write')
  @Patch(':id/status')
  status(@TenantUser() p: TenantPrincipal, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: z.object({ status: statusEnum, note: z.string().trim().max(500).nullish() }).strict() }) b: { status: z.infer<typeof statusEnum>; note?: string | null }) {
    return this.reservations.transition({ tenantId: p.tenantId, userId: p.userId }, id, b.status, b.note ?? null);
  }
}
