import { RequireModule } from '../common/decorators/module.decorator.js';
import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { DatabaseService } from '../database/database.service.js';
import { paged, paginationSchema } from '../common/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';

/** Teléfono en formato internacional sin "+" ni separadores (como lo envía WhatsApp). */
export const phone = z
  .string()
  .transform((v) => v.replace(/[^\d]/g, ''))
  .refine((v) => /^\d{8,15}$/.test(v), 'Teléfono inválido: usa formato internacional, p. ej. 51987654321');

const customerSchema = z.object({
  phone,
  name: z.string().trim().min(1).max(120).nullish(),
  email: z.email().max(254).nullish(),
  documentId: z.string().trim().max(30).nullish(),
  address: z.string().trim().max(300).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).optional(),
});
const listSchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  tag: z.string().trim().max(30).optional(),
});

@RequireModule('customers')
@Controller('customers')
export class CustomersController {
  constructor(private readonly db: DatabaseService) {}

  @RequirePermission('customers:read')
  @Get()
  list(@TenantUser() p: TenantPrincipal, @Query({ schema: listSchema }) q: z.infer<typeof listSchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const where: Prisma.CustomerWhereInput = {
        tenantId: p.tenantId,
        ...(q.tag ? { tags: { has: q.tag } } : {}),
        ...(q.q
          ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { phone: { contains: q.q.replace(/[^\d]/g, '') || q.q } }, { email: { contains: q.q, mode: 'insensitive' } }, { documentId: q.q }] }
          : {}),
      };
      const [items, total] = await Promise.all([
        tx.customer.findMany({ where, orderBy: [{ lastContactAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { _count: { select: { orders: true } } } }),
        tx.customer.count({ where }),
      ]);
      return paged(items, total, q.page, q.pageSize);
    });
  }

  @RequirePermission('customers:read')
  @Get(':id')
  async get(@TenantUser() p: TenantPrincipal, @Param('id', { schema: z.uuid() }) id: string) {
    const c = await this.db.tenant(p.tenantId, async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id, tenantId: p.tenantId },
        include: { orders: { orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, number: true, status: true, total: true, currency: true, createdAt: true } } },
      });
      if (!customer) return null;
      const stats = await tx.order.aggregate({ where: { customerId: id, status: { notIn: ['CANCELLED', 'PENDING'] } }, _sum: { total: true }, _count: true });
      return { ...customer, stats: { orders: stats._count, totalSpent: stats._sum.total?.toString() ?? '0' } };
    });
    if (!c) throw new NotFoundException('Cliente no encontrado');
    return c;
  }

  @RequirePermission('customers:write')
  @Post()
  create(@TenantUser() p: TenantPrincipal, @Body({ schema: customerSchema }) b: z.infer<typeof customerSchema>) {
    return this.db.tenant(p.tenantId, (tx) => tx.customer.create({ data: { ...b, tenantId: p.tenantId, source: 'manual' } }));
  }

  @RequirePermission('customers:write')
  @Patch(':id')
  update(@TenantUser() p: TenantPrincipal, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: customerSchema.partial() }) b: Partial<z.infer<typeof customerSchema>>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const c = await tx.customer.findFirst({ where: { id, tenantId: p.tenantId } });
      if (!c) throw new NotFoundException('Cliente no encontrado');
      return tx.customer.update({ where: { id }, data: b });
    });
  }
}
