import { RequireModule } from '../common/decorators/module.decorator.js';
import { BadRequestException, Body, Controller, ForbiddenException, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { DatabaseService } from '../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { InventoryService } from './inventory.service.js';
import { paged, paginationSchema } from '../common/pagination.js';
import { FEATURES, getPlanLimits } from '../plans/plan-limits.js';
import type { Prisma } from '../generated/prisma/client.js';

/** Movimientos manuales permitidos desde el panel (las ventas los genera Pedidos) */
const movementSchema = z
  .object({
    variantId: z.uuid(),
    branchId: z.uuid().optional(),
    type: z.enum(['PURCHASE_IN', 'ADJUSTMENT', 'RETURN_IN']),
    quantity: z.number().int().refine((n) => n !== 0, 'La cantidad no puede ser 0').refine((n) => Math.abs(n) <= 1_000_000),
    reason: z.string().trim().min(3, 'Indica el motivo').max(300),
    allowNegative: z.boolean().default(false),
    idempotencyKey: z.string().trim().min(8).max(100).optional(),
  })
  .refine((m) => m.type === 'ADJUSTMENT' || m.quantity > 0, { message: 'Las entradas deben ser positivas', path: ['quantity'] });

const transferSchema = z.object({
  variantId: z.uuid(),
  fromBranchId: z.uuid(),
  toBranchId: z.uuid(),
  quantity: z.number().int().positive().max(1_000_000),
  reason: z.string().trim().max(300).optional(),
});

const listSchema = paginationSchema.extend({
  variantId: z.uuid().optional(),
  productId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  type: z.enum(['PURCHASE_IN', 'SALE_OUT', 'ADJUSTMENT', 'RETURN_IN', 'TRANSFER_IN', 'TRANSFER_OUT', 'SALE_VOID']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

@RequireModule('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly db: DatabaseService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermission('inventory:write')
  @Post('movements')
  movement(@TenantUser() p: TenantPrincipal, @Body({ schema: movementSchema }) b: z.infer<typeof movementSchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const branchId = b.branchId ?? (await this.inventory.defaultBranchId(tx, p.tenantId));
      const r = await this.inventory.apply(tx, { ...b, branchId, tenantId: p.tenantId, userId: p.userId });
      if (b.allowNegative && r.stockAfter < 0) {
        await this.audit.inTx(tx, { tenantId: p.tenantId, userId: p.userId, action: 'inventory.negative_authorized', entityType: 'inventory_movement', entityId: r.movementId, metadata: { reason: b.reason } });
      }
      return r;
    });
  }

  /** Transferencia entre sucursales: dos movimientos en una sola transacción. */
  @RequirePermission('inventory:write')
  @Post('transfers')
  transfer(@TenantUser() p: TenantPrincipal, @Body({ schema: transferSchema }) b: z.infer<typeof transferSchema>) {
    if (b.fromBranchId === b.toBranchId) throw new BadRequestException('Las sucursales deben ser distintas');
    return this.db.tenant(p.tenantId, async (tx) => {
      const limits = await getPlanLimits(tx);
      if (!limits.features.includes(FEATURES.MULTI_BRANCH)) throw new ForbiddenException({ code: 'PLAN_FEATURE', message: 'Las transferencias entre sucursales requieren el plan Empresarial' });
      const reason = b.reason ?? 'Transferencia entre sucursales';
      const out = await this.inventory.apply(tx, { tenantId: p.tenantId, variantId: b.variantId, branchId: b.fromBranchId, type: 'TRANSFER_OUT', quantity: b.quantity, reason, userId: p.userId });
      const inn = await this.inventory.apply(tx, { tenantId: p.tenantId, variantId: b.variantId, branchId: b.toBranchId, type: 'TRANSFER_IN', quantity: b.quantity, reason, userId: p.userId });
      return { out, in: inn };
    });
  }

  @RequirePermission('inventory:read')
  @Get('movements')
  list(@TenantUser() p: TenantPrincipal, @Query({ schema: listSchema }) q: z.infer<typeof listSchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const where: Prisma.InventoryMovementWhereInput = {
        tenantId: p.tenantId,
        ...(q.variantId ? { variantId: q.variantId } : {}),
        ...(q.productId ? { variant: { productId: q.productId } } : {}),
        ...(q.branchId ? { branchId: q.branchId } : {}),
        ...(q.type ? { type: q.type } : {}),
        ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      };
      const [items, total] = await Promise.all([
        tx.inventoryMovement.findMany({
          where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
          include: { variant: { select: { sku: true, name: true, product: { select: { id: true, name: true } } } }, branch: { select: { name: true } }, order: { select: { number: true } } },
        }),
        tx.inventoryMovement.count({ where }),
      ]);
      return paged(items, total, q.page, q.pageSize);
    });
  }

  /** Productos en o por debajo de su stock mínimo. */
  @RequirePermission('inventory:read')
  @Get('alerts')
  alerts(@TenantUser() p: TenantPrincipal) {
    return this.db.tenant(p.tenantId, (tx) =>
      tx.$queryRaw<{ id: string; sku: string; name: string; min_stock: number; stock: number }[]>`
        SELECT p.id, p.sku, p.name, p.min_stock, COALESCE(SUM(sl.quantity), 0)::int AS stock
        FROM products p
        LEFT JOIN product_variants v ON v.product_id = p.id
        LEFT JOIN stock_levels sl ON sl.variant_id = v.id
        WHERE p.min_stock > 0 AND p.status = 'ACTIVE'
        GROUP BY p.id HAVING COALESCE(SUM(sl.quantity), 0) <= p.min_stock
        ORDER BY stock ASC LIMIT 200`,
    );
  }
}

const branchSchema = z.object({ name: z.string().trim().min(2).max(80), address: z.string().trim().max(200).optional() });

@Controller('branches')
export class BranchesController {
  constructor(private readonly db: DatabaseService) {}

  @RequirePermission('inventory:read')
  @Get()
  list(@TenantUser() p: TenantPrincipal) {
    return this.db.tenant(p.tenantId, (tx) => tx.branch.findMany({ where: { tenantId: p.tenantId }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] }));
  }

  @RequirePermission('tenant:settings')
  @Post()
  create(@TenantUser() p: TenantPrincipal, @Body({ schema: branchSchema }) b: z.infer<typeof branchSchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const limits = await getPlanLimits(tx);
      const n = await tx.branch.count({ where: { tenantId: p.tenantId } });
      if (n >= limits.maxBranches) throw new ForbiddenException({ code: 'PLAN_LIMIT_REACHED', message: `Tu plan permite ${limits.maxBranches} sucursal(es)` });
      return tx.branch.create({ data: { ...b, tenantId: p.tenantId } });
    });
  }
}
