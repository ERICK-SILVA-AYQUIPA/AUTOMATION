import { RequireModule } from '../common/decorators/module.decorator.js';
import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { DatabaseService } from '../database/database.service.js';
import { paged, paginationSchema } from '../common/pagination.js';
import { OrdersService, orderInclude } from './orders.service.js';
import { phone } from '../customers/customers.controller.js';

const statusEnum = z.enum(['PENDING', 'CONFIRMED', 'PREPARING', 'SHIPPED', 'DELIVERED', 'CANCELLED']);

const createSchema = z
  .object({
    customerId: z.uuid().optional(),
    customer: z.object({ phone, name: z.string().trim().min(1).max(120).optional() }).optional(),
    branchId: z.uuid().optional(),
    items: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().positive().max(10_000) })).min(1).max(100),
    notes: z.string().trim().max(1000).nullish(),
    deliveryAddress: z.string().trim().max(300).nullish(),
    idempotencyKey: z.string().trim().min(8).max(100).optional(),
    confirm: z.boolean().default(true),
  })
  .refine((v) => v.customerId || v.customer, { message: 'Indica customerId o customer', path: ['customerId'] });

const listSchema = paginationSchema.extend({
  status: statusEnum.optional(),
  q: z.string().trim().max(100).optional(),
  customerId: z.uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

@RequireModule('orders')
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly db: DatabaseService,
  ) {}

  private where(p: TenantPrincipal, q: Omit<z.infer<typeof listSchema>, 'page' | 'pageSize'>): Prisma.OrderWhereInput {
    const n = q.q && /^\d+$/.test(q.q) ? Number(q.q) : undefined;
    return {
      tenantId: p.tenantId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      ...(q.q ? { OR: [...(n !== undefined ? [{ number: n }] : []), { customer: { name: { contains: q.q, mode: 'insensitive' as const } } }, { customer: { phone: { contains: q.q } } }] } : {}),
    };
  }

  @RequirePermission('orders:read')
  @Get()
  list(@TenantUser() p: TenantPrincipal, @Query({ schema: listSchema }) q: z.infer<typeof listSchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const where = this.where(p, q);
      const [items, total] = await Promise.all([
        tx.order.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { customer: { select: { id: true, name: true, phone: true, waProfileName: true } }, _count: { select: { items: true } } } }),
        tx.order.count({ where }),
      ]);
      return paged(items, total, q.page, q.pageSize);
    });
  }

  @RequirePermission('orders:read')
  @Get('export')
  async export(@TenantUser() p: TenantPrincipal, @Query({ schema: listSchema.omit({ page: true, pageSize: true }) }) q: Omit<z.infer<typeof listSchema>, 'page' | 'pageSize'>, @Res() res: Response) {
    const rows = await this.db.tenant(p.tenantId, (tx) =>
      tx.order.findMany({ where: this.where(p, q), orderBy: { createdAt: 'desc' }, take: 50_000, include: { customer: true, items: true } }),
    );
    // Neutraliza fórmulas (CSV injection) y escapa comillas
    const esc = (v: { toString(): string } | null | undefined) => {
      const t = (v ?? '').toString();
      return `"${(/^[=+\-@\t\r]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`;
    };
    const header = ['numero', 'fecha', 'estado', 'canal', 'cliente', 'telefono', 'productos', 'subtotal', 'descuento', 'total', 'moneda'];
    const lines = rows.map((o) =>
      [o.number, o.createdAt.toISOString(), o.status, o.channel, o.customer.name ?? o.customer.waProfileName, o.customer.phone ?? '', o.items.map((i) => `${i.quantity}x ${i.productName} ${i.variantName}`).join(' | '), o.subtotal, o.discount, o.total, o.currency].map(esc).join(','),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pedidos-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + [header.join(','), ...lines].join('\n'));
  }

  @RequirePermission('orders:read')
  @Get(':id')
  async get(@TenantUser() p: TenantPrincipal, @Param('id', { schema: z.uuid() }) id: string) {
    const o = await this.db.tenant(p.tenantId, (tx) => tx.order.findFirst({ where: { id, tenantId: p.tenantId }, include: { ...orderInclude, movements: { select: { id: true, type: true, quantity: true, variantId: true, createdAt: true } } } }));
    if (!o) throw new NotFoundException('Pedido no encontrado');
    return o;
  }

  @RequirePermission('orders:write')
  @Post()
  async create(@TenantUser() p: TenantPrincipal, @Body({ schema: createSchema }) b: z.infer<typeof createSchema>, @Res({ passthrough: true }) res: Response) {
    let customerId = b.customerId;
    if (!customerId && b.customer) {
      const where = { tenantId_phone: { tenantId: p.tenantId, phone: b.customer.phone } };
      const upsert = () =>
        this.db.tenant(p.tenantId, (tx) =>
          tx.customer.upsert({ where, create: { tenantId: p.tenantId, phone: b.customer!.phone, name: b.customer!.name, source: 'manual' }, update: {}, select: { id: true } }),
        );
      // El upsert de Prisma no es atómico: dos pedidos simultáneos de un cliente nuevo
      // chocan en el índice único; el perdedor lee el cliente que creó el otro.
      const c = await upsert().catch(async (e: unknown) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          return this.db.tenant(p.tenantId, (tx) => tx.customer.findUniqueOrThrow({ where, select: { id: true } }));
        }
        throw e;
      });
      customerId = c.id;
    }
    const r = await this.orders.create(
      { tenantId: p.tenantId, userId: p.userId },
      { ...b, customerId: customerId!, channel: 'MANUAL' },
    );
    res.status(r.created ? 201 : 200);
    return { ...r.order, idempotentReplay: !r.created };
  }

  @RequirePermission('orders:write')
  @Patch(':id/status')
  status(@TenantUser() p: TenantPrincipal, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: z.object({ status: statusEnum, note: z.string().trim().max(500).optional() }) }) b: { status: z.infer<typeof statusEnum>; note?: string }) {
    return this.orders.transition({ tenantId: p.tenantId, userId: p.userId }, id, b.status, b.note ?? null);
  }
}
