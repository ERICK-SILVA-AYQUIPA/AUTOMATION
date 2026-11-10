import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { assertWithinLimit, getPlanLimits } from '../plans/plan-limits.js';
import { paged } from '../common/pagination.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import type { CreateProductInput, ListProductsQuery, UpdateProductInput } from './catalog.schemas.js';
import type { z } from 'zod';
import type { updateVariantSchema, variantSchema } from './catalog.schemas.js';

const TRACKED: (keyof UpdateProductInput)[] = ['sku', 'barcode', 'name', 'description', 'categoryId', 'salePrice', 'costPrice', 'minStock', 'status'];

export const productInclude = {
  category: { select: { id: true, name: true } },
  variants: { orderBy: [{ isDefault: 'desc' }, { name: 'asc' }], include: { stockLevels: { select: { branchId: true, quantity: true } } } },
  images: { orderBy: { position: 'asc' } },
} satisfies Prisma.ProductInclude;

type ProductWithRelations = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

/** Añade stock total por variante y por producto, y el precio efectivo de cada variante. */
export function withStock(p: ProductWithRelations) {
  const variants = p.variants.map((v) => ({
    ...v,
    effectivePrice: (v.salePrice ?? p.salePrice).toString(),
    stock: v.stockLevels.reduce((s, l) => s + l.quantity, 0),
  }));
  const stock = variants.reduce((s, v) => s + v.stock, 0);
  return { ...p, variants, stock, lowStock: p.minStock > 0 && stock <= p.minStock };
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly inventory: InventoryService,
  ) {}

  async list(p: TenantPrincipal, q: ListProductsQuery) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const where: Prisma.ProductWhereInput = { tenantId: p.tenantId };
      if (q.status) where.status = q.status;
      else where.status = { not: 'ARCHIVED' };
      if (q.categoryId) where.categoryId = q.categoryId;
      if (q.q) {
        where.OR = [
          { name: { contains: q.q, mode: 'insensitive' } },
          { sku: { contains: q.q, mode: 'insensitive' } },
          { barcode: q.q },
          { variants: { some: { OR: [{ sku: { contains: q.q, mode: 'insensitive' } }, { barcode: q.q }, { name: { contains: q.q, mode: 'insensitive' } }] } } },
        ];
      }
      if (q.lowStock === 'true') {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT p.id FROM products p
          LEFT JOIN product_variants v ON v.product_id = p.id
          LEFT JOIN stock_levels sl ON sl.variant_id = v.id
          WHERE p.min_stock > 0
          GROUP BY p.id, p.min_stock HAVING COALESCE(SUM(sl.quantity), 0) <= p.min_stock`;
        where.id = { in: rows.map((r) => r.id) };
      }
      const desc = q.sort.startsWith('-');
      const field = q.sort.replace('-', '') as 'name' | 'createdAt' | 'salePrice';
      const [items, total] = await Promise.all([
        tx.product.findMany({
          where, include: productInclude, orderBy: { [field]: desc ? 'desc' : 'asc' },
          skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        }),
        tx.product.count({ where }),
      ]);
      return paged(items.map(withStock), total, q.page, q.pageSize);
    });
  }

  async get(p: TenantPrincipal, id: string) {
    const prod = await this.db.tenant(p.tenantId, (tx) => tx.product.findFirst({ where: { id, tenantId: p.tenantId }, include: productInclude }));
    if (!prod) throw new NotFoundException('Producto no encontrado');
    return withStock(prod);
  }

  /** Búsqueda por código de barras (producto o variante) para el lector móvil. */
  async byBarcode(p: TenantPrincipal, code: string) {
    const prod = await this.db.tenant(p.tenantId, (tx) =>
      tx.product.findFirst({
        where: { tenantId: p.tenantId, OR: [{ barcode: code }, { variants: { some: { barcode: code } } }] },
        include: productInclude,
      }),
    );
    if (!prod) throw new NotFoundException('Ningún producto tiene ese código de barras');
    return withStock(prod);
  }

  async create(p: TenantPrincipal, input: CreateProductInput) {
    if (input.variants?.length && input.initialStock) {
      throw new BadRequestException('El stock inicial solo aplica a productos sin variantes; registra entradas por variante en Inventario');
    }
    return this.db.tenant(p.tenantId, async (tx) => {
      const prod = await this.createInTx(tx, p, input);
      return withStock(await tx.product.findUniqueOrThrow({ where: { id: prod.id }, include: productInclude }));
    });
  }

  /** Reutilizado por la importación masiva. */
  async createInTx(tx: Tx, p: TenantPrincipal, input: CreateProductInput) {
    const limits = await getPlanLimits(tx);
    const count = await tx.product.count({ where: { tenantId: p.tenantId, status: { not: 'ARCHIVED' } } });
    assertWithinLimit(count, limits.maxProducts, 'productos');
    if (input.categoryId) await this.assertCategory(tx, p.tenantId, input.categoryId);

    const { variants, initialStock, ...data } = input;
    const prod = await tx.product.create({ data: { ...data, tenantId: p.tenantId } });
    const variantRows = variants?.length
      ? variants.map((v, i) => ({ ...v, isDefault: i === 0 }))
      : [{ sku: input.sku, barcode: input.barcode ?? null, name: 'Única', attributes: {}, isDefault: true }];
    for (const v of variantRows) {
      await tx.productVariant.create({ data: { ...v, tenantId: p.tenantId, productId: prod.id } });
    }
    if (initialStock) {
      const variant = await tx.productVariant.findFirstOrThrow({ where: { productId: prod.id, isDefault: true } });
      await this.inventory.apply(tx, {
        tenantId: p.tenantId, variantId: variant.id, branchId: await this.inventory.defaultBranchId(tx, p.tenantId),
        type: 'ADJUSTMENT', quantity: initialStock, reason: 'Stock inicial', userId: p.userId,
      });
    }
    await tx.productHistory.create({ data: { tenantId: p.tenantId, productId: prod.id, userId: p.userId, action: 'created', changes: { sku: input.sku, name: input.name, salePrice: input.salePrice } } });
    return prod;
  }

  async update(p: TenantPrincipal, id: string, input: UpdateProductInput) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const before = await tx.product.findFirst({ where: { id, tenantId: p.tenantId } });
      if (!before) throw new NotFoundException('Producto no encontrado');
      if (input.categoryId) await this.assertCategory(tx, p.tenantId, input.categoryId);
      const updated = await tx.product.update({ where: { id }, data: input });
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of TRACKED) {
        if (!(k in input)) continue;
        const from = before[k as keyof typeof before]?.toString() ?? null;
        const to = updated[k as keyof typeof updated]?.toString() ?? null;
        if (from !== to) changes[k] = { from, to };
      }
      // Si la variante única comparte SKU/código con el producto, se mantiene sincronizada
      if (changes.sku || changes.barcode) {
        const variants = await tx.productVariant.findMany({ where: { productId: id } });
        if (variants.length === 1 && variants[0]!.sku === before.sku) {
          await tx.productVariant.update({ where: { id: variants[0]!.id }, data: { sku: updated.sku, barcode: updated.barcode } });
        }
      }
      if (Object.keys(changes).length) {
        await tx.productHistory.create({ data: { tenantId: p.tenantId, productId: id, userId: p.userId, action: 'updated', changes: changes as Prisma.InputJsonValue } });
      }
      return withStock(await tx.product.findUniqueOrThrow({ where: { id }, include: productInclude }));
    });
  }

  /** "Eliminar" archiva: el producto conserva su historial de ventas y movimientos. */
  async archive(p: TenantPrincipal, id: string) {
    return this.update(p, id, { status: 'ARCHIVED' });
  }

  async history(p: TenantPrincipal, id: string) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const exists = await tx.product.count({ where: { id, tenantId: p.tenantId } });
      if (!exists) throw new NotFoundException('Producto no encontrado');
      return tx.productHistory.findMany({ where: { productId: id }, orderBy: { createdAt: 'desc' }, take: 200 });
    });
  }

  async addVariant(p: TenantPrincipal, productId: string, input: z.infer<typeof variantSchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const prod = await tx.product.findFirst({ where: { id: productId, tenantId: p.tenantId } });
      if (!prod) throw new NotFoundException('Producto no encontrado');
      const v = await tx.productVariant.create({ data: { ...input, tenantId: p.tenantId, productId } });
      await tx.productHistory.create({ data: { tenantId: p.tenantId, productId, userId: p.userId, action: 'variant_added', changes: { sku: v.sku, name: v.name } } });
      return v;
    });
  }

  async updateVariant(p: TenantPrincipal, productId: string, variantId: string, input: z.infer<typeof updateVariantSchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const v = await tx.productVariant.findFirst({ where: { id: variantId, productId, tenantId: p.tenantId } });
      if (!v) throw new NotFoundException('Variante no encontrada');
      const u = await tx.productVariant.update({ where: { id: variantId }, data: input });
      await tx.productHistory.create({ data: { tenantId: p.tenantId, productId, userId: p.userId, action: 'variant_updated', changes: { variantId, ...input } as Prisma.InputJsonValue } });
      return u;
    });
  }

  private async assertCategory(tx: Tx, tenantId: string, categoryId: string) {
    const c = await tx.category.count({ where: { id: categoryId, tenantId } });
    if (!c) throw new BadRequestException('La categoría no existe');
  }
}
