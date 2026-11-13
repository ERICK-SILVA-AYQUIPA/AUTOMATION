import { WebhookEvents } from '../webhooks/webhook-events.service.js';
import { AutomationEvents } from '../automations/automation-events.service.js';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Tx } from '../database/database.service.js';
import { MovementType } from '../generated/prisma/enums.js';

/** Signo de cada tipo de movimiento. ADJUSTMENT usa el signo de la cantidad recibida. */
const SIGN: Record<MovementType, 1 | -1 | 0> = {
  PURCHASE_IN: 1,
  RETURN_IN: 1,
  TRANSFER_IN: 1,
  SALE_VOID: 1,
  SALE_OUT: -1,
  TRANSFER_OUT: -1,
  ADJUSTMENT: 0,
};

export interface MovementInput {
  tenantId: string;
  variantId: string;
  branchId: string;
  type: MovementType;
  /** Positiva para todos los tipos salvo ADJUSTMENT, donde lleva signo */
  quantity: number;
  reason?: string;
  orderId?: string;
  /** Si ya existe un movimiento con esta clave, no se aplica de nuevo */
  idempotencyKey?: string;
  /** Solo con autorización explícita de un usuario con inventory:write */
  allowNegative?: boolean;
  userId?: string;
}

export interface MovementResult {
  movementId: string;
  stockBefore: number;
  stockAfter: number;
  /** false si la clave de idempotencia ya existía (no se volvió a aplicar) */
  applied: boolean;
  lowStock: boolean;
}

export class InsufficientStockError extends ConflictException {
  constructor(
    readonly variantId: string,
    readonly available: number,
    readonly requested: number,
  ) {
    super({ code: 'INSUFFICIENT_STOCK', message: `Stock insuficiente: disponible ${available}, solicitado ${requested}`, variantId, available, requested });
  }
}

/**
 * ÚNICA vía para modificar existencias (también para la IA, que solo llega
 * aquí a través de crear_pedido). Debe llamarse dentro de una transacción de
 * empresa (db.tenant). Garantías:
 *  - bloqueo de fila (SELECT ... FOR UPDATE) => sin condiciones de carrera
 *  - libro inmutable de movimientos con stock antes/después
 *  - idempotencia por clave única (tenant_id, idempotency_key)
 *  - stock negativo prohibido salvo allowNegative (y CHECK en la BD)
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly automations: AutomationEvents,
    private readonly webhooks: WebhookEvents,
  ) {}

  async apply(tx: Tx, m: MovementInput): Promise<MovementResult> {
    if (!Number.isInteger(m.quantity) || m.quantity === 0) throw new BadRequestException('La cantidad debe ser un entero distinto de 0');
    const sign = SIGN[m.type];
    if (sign !== 0 && m.quantity < 0) throw new BadRequestException('La cantidad debe ser positiva para este tipo de movimiento');
    const delta = sign === 0 ? m.quantity : sign * m.quantity;

    if (m.idempotencyKey) {
      const prev = await tx.inventoryMovement.findUnique({
        where: { tenantId_idempotencyKey: { tenantId: m.tenantId, idempotencyKey: m.idempotencyKey } },
      });
      if (prev) return { movementId: prev.id, stockBefore: prev.stockBefore, stockAfter: prev.stockAfter, applied: false, lowStock: false };
    }

    const variant = await tx.productVariant.findFirst({
      where: { id: m.variantId, tenantId: m.tenantId },
      select: { id: true, productId: true, product: { select: { minStock: true } } },
    });
    if (!variant) throw new NotFoundException('Variante no encontrada');
    const branch = await tx.branch.findFirst({ where: { id: m.branchId, tenantId: m.tenantId, isActive: true }, select: { id: true } });
    if (!branch) throw new NotFoundException('Sucursal no encontrada o inactiva');

    // Asegura la fila y la bloquea hasta el final de la transacción
    await tx.$executeRaw`
      INSERT INTO stock_levels (tenant_id, variant_id, branch_id, quantity, updated_at)
      VALUES (${m.tenantId}::uuid, ${m.variantId}::uuid, ${m.branchId}::uuid, 0, now())
      ON CONFLICT (variant_id, branch_id) DO NOTHING`;
    const [row] = await tx.$queryRaw<{ quantity: number }[]>`
      SELECT quantity FROM stock_levels WHERE variant_id = ${m.variantId}::uuid AND branch_id = ${m.branchId}::uuid FOR UPDATE`;
    const before = row!.quantity;
    const after = before + delta;
    if (after < 0 && !m.allowNegative) throw new InsufficientStockError(m.variantId, before, -delta);

    const totalBefore = await this.productStock(tx, variant.productId);

    const movement = await tx.inventoryMovement.create({
      data: {
        tenantId: m.tenantId, variantId: m.variantId, branchId: m.branchId, type: m.type, quantity: delta,
        stockBefore: before, stockAfter: after, reason: m.reason, orderId: m.orderId,
        idempotencyKey: m.idempotencyKey, allowNegative: !!m.allowNegative, userId: m.userId,
      },
    });
    await tx.$executeRaw`
      UPDATE stock_levels SET quantity = ${after}, updated_at = now()
      WHERE variant_id = ${m.variantId}::uuid AND branch_id = ${m.branchId}::uuid`;

    // Alerta de stock mínimo al CRUZAR el umbral (no en cada movimiento)
    const minStock = variant.product.minStock;
    const totalAfter = totalBefore + delta;
    const lowStock = minStock > 0 && totalAfter <= minStock && totalBefore > minStock;
    if (lowStock) {
      const product = await tx.product.findUniqueOrThrow({ where: { id: variant.productId }, select: { name: true, sku: true } });
      await tx.notification.create({
        data: {
          tenantId: m.tenantId,
          type: 'LOW_STOCK',
          title: 'Stock bajo',
          body: `${product.name} (${product.sku}) tiene ${totalAfter} unidades; mínimo ${minStock}.`,
          data: { productId: variant.productId, stock: totalAfter, minStock },
        },
      });
      // FLUJO 4: n8n avisa por correo a los administradores
      await this.automations.emit(tx, m.tenantId, 'LOW_STOCK_ALERT', { productId: variant.productId, productName: product.name, sku: product.sku, stock: totalAfter, minStock });
      await this.webhooks.emit(tx, m.tenantId, 'stock.low', { productId: variant.productId, productName: product.name, sku: product.sku, stock: totalAfter, minStock });
    }
    return { movementId: movement.id, stockBefore: before, stockAfter: after, applied: true, lowStock };
  }

  async productStock(tx: Tx, productId: string): Promise<number> {
    const [r] = await tx.$queryRaw<{ total: bigint | null }[]>`
      SELECT COALESCE(SUM(sl.quantity), 0)::bigint AS total
      FROM stock_levels sl JOIN product_variants v ON v.id = sl.variant_id
      WHERE v.product_id = ${productId}::uuid`;
    return Number(r?.total ?? 0);
  }

  async defaultBranchId(tx: Tx, tenantId: string): Promise<string> {
    const b = await tx.branch.findFirst({ where: { tenantId, isDefault: true }, select: { id: true } });
    if (!b) throw new NotFoundException('La empresa no tiene sucursal predeterminada');
    return b.id;
  }
}
