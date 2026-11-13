import { NOTIFIABLE_STATUSES } from '../automations/catalog.js';
import { AutomationEvents } from '../automations/automation-events.service.js';
import { WebhookEvents } from '../webhooks/webhook-events.service.js';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { readTiers, unitPriceFor } from '../catalog/pricing.js';
import { readSettings } from '../tenants/tenant-settings.js';
import type { OrderChannel, OrderStatus } from '../generated/prisma/enums.js';

export interface OrderActor {
  tenantId: string;
  /** null cuando lo crea el asistente de IA */
  userId: string | null;
}

export interface CreateOrderInput {
  customerId: string;
  items: { variantId: string; quantity: number }[];
  channel: OrderChannel;
  branchId?: string;
  conversationId?: string;
  notes?: string | null;
  deliveryAddress?: string | null;
  /** Repetir la misma clave devuelve el pedido existente (no crea otro) */
  idempotencyKey?: string;
  /** true: confirma y descuenta stock en la misma transacción */
  confirm: boolean;
}

/** Transiciones de estado permitidas */
export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'SHIPPED', 'DELIVERED', 'CANCELLED'],
  PREPARING: ['SHIPPED', 'DELIVERED', 'CANCELLED'],
  SHIPPED: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};

/** Estados en los que el stock ya fue descontado */
const STOCK_COMMITTED: OrderStatus[] = ['CONFIRMED', 'PREPARING', 'SHIPPED', 'DELIVERED'];

export const orderInclude = {
  customer: { select: { id: true, name: true, phone: true, waProfileName: true } },
  items: true,
  statusHistory: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.OrderInclude;

/**
 * Pedidos. Garantías:
 *  - precios SIEMPRE leídos de la BD en el momento del pedido (nunca del cliente ni de la IA)
 *  - idempotencia por clave (tenant_id, idempotency_key) también ante peticiones concurrentes
 *  - descuento de stock una sola vez por pedido y variante (clave order:<id>:sale:<variante>)
 *  - anulación devuelve el stock una sola vez (order:<id>:void:<variante>)
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly inventory: InventoryService,
    private readonly automations: AutomationEvents,
    private readonly webhooks: WebhookEvents,
  ) {}

  async create(actor: OrderActor, input: CreateOrderInput): Promise<{ order: Prisma.OrderGetPayload<{ include: typeof orderInclude }>; created: boolean }> {
    if (input.idempotencyKey) {
      const existing = await this.findByKey(actor.tenantId, input.idempotencyKey);
      if (existing) return { order: existing, created: false };
    }
    try {
      const order = await this.db.tenant(actor.tenantId, (tx) => this.createInTx(tx, actor, input));
      return { order, created: true };
    } catch (e) {
      // Dos peticiones simultáneas con la misma clave: gana una, la otra recibe el mismo pedido
      if (input.idempotencyKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.findByKey(actor.tenantId, input.idempotencyKey);
        if (existing) return { order: existing, created: false };
      }
      throw e;
    }
  }

  private findByKey(tenantId: string, key: string) {
    return this.db.tenant(tenantId, (tx) =>
      tx.order.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } }, include: orderInclude }),
    );
  }

  async createInTx(tx: Tx, actor: OrderActor, input: CreateOrderInput) {
    if (!input.items.length) throw new BadRequestException('El pedido no tiene productos');
    // Une líneas repetidas de la misma variante
    const qty = new Map<string, number>();
    for (const it of input.items) {
      if (!Number.isInteger(it.quantity) || it.quantity <= 0) throw new BadRequestException('Cantidades deben ser enteros positivos');
      qty.set(it.variantId, (qty.get(it.variantId) ?? 0) + it.quantity);
    }
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { currency: true, settings: true } });
    const settings = readSettings(tenant.settings);
    const customer = await tx.customer.findFirst({ where: { id: input.customerId, tenantId: actor.tenantId }, select: { id: true, name: true, waProfileName: true, phone: true } });
    if (!customer) throw new NotFoundException('Cliente no encontrado');
    const variants = await tx.productVariant.findMany({
      where: { id: { in: [...qty.keys()] }, tenantId: actor.tenantId },
      include: { product: { select: { name: true, salePrice: true, status: true, trackStock: true } } },
    });
    if (variants.length !== qty.size) throw new NotFoundException('Algún producto del pedido no existe');
    for (const v of variants) {
      if (!v.isActive || v.product.status !== 'ACTIVE') throw new ConflictException({ code: 'PRODUCT_UNAVAILABLE', message: `${v.product.name} (${v.name}) no está disponible` });
    }

    const lines = variants.map((v) => {
      const q = qty.get(v.id)!;
      // Precio por volumen según la cantidad (si la empresa los usa)
      const unit = unitPriceFor(v.salePrice ?? v.product.salePrice, settings.catalog.volumePricing ? readTiers(v.priceTiers) : [], q);
      return { variantId: v.id, productName: v.product.name, variantName: v.name, sku: v.sku, quantity: q, unitPrice: unit, total: unit.mul(q) };
    });
    const subtotal = lines.reduce((s, l) => s.add(l.total), new Prisma.Decimal(0));
    const min = settings.orders.minAmount;
    if (min != null && subtotal.lessThan(min)) {
      throw new ConflictException({ code: 'ORDER_MINIMUM', message: `El pedido mínimo es ${tenant.currency} ${min.toFixed(2)}; este pedido suma ${subtotal.toFixed(2)}`, minimum: min.toFixed(2), subtotal: subtotal.toFixed(2) });
    }
    const branchId = input.branchId ?? (await this.inventory.defaultBranchId(tx, actor.tenantId));

    const [counter] = await tx.$queryRaw<{ value: number }[]>`
      INSERT INTO tenant_counters (tenant_id, key, value) VALUES (${actor.tenantId}::uuid, 'order_number', 1)
      ON CONFLICT (tenant_id, key) DO UPDATE SET value = tenant_counters.value + 1
      RETURNING value`;

    const order = await tx.order.create({
      data: {
        tenantId: actor.tenantId, number: counter!.value, customerId: customer.id, branchId, conversationId: input.conversationId,
        channel: input.channel, currency: tenant.currency, subtotal, total: subtotal, notes: input.notes, deliveryAddress: input.deliveryAddress,
        idempotencyKey: input.idempotencyKey, createdById: actor.userId,
        items: { create: lines.map((l) => ({ ...l, tenantId: actor.tenantId })) },
        statusHistory: { create: { tenantId: actor.tenantId, toStatus: 'PENDING', userId: actor.userId, note: input.channel === 'WHATSAPP' ? 'Creado desde WhatsApp' : null } },
      },
    });
    // FLUJO 3 (notificación): n8n avisa del pedido nuevo
    await this.automations.emit(tx, actor.tenantId, 'NEW_ORDER_NOTIFICATION', {
      orderId: order.id, number: order.number, channel: input.channel, total: subtotal.toFixed(2), currency: tenant.currency,
      customerName: customer.name ?? customer.waProfileName ?? (customer.phone ? `+${customer.phone}` : 'Cliente de WhatsApp'),
      // La variante única de un producto simple no aporta nada al nombre
      items: lines.map((l) => ({ name: l.variantName === 'Única' ? l.productName : `${l.productName} (${l.variantName})`, quantity: l.quantity })),
    });
    await this.webhooks.emit(tx, actor.tenantId, 'order.created', {
      orderId: order.id, number: order.number, channel: input.channel, status: 'PENDING', total: subtotal.toFixed(2), currency: tenant.currency,
      customer: { id: customer.id, name: customer.name ?? customer.waProfileName ?? null, phone: customer.phone ?? null },
      items: lines.map((l) => ({ variantId: l.variantId, sku: l.sku, name: l.productName, variant: l.variantName, quantity: l.quantity, unitPrice: l.unitPrice.toFixed(2) })),
    });
    if (input.confirm) await this.transitionInTx(tx, actor, order.id, 'CONFIRMED', null);
    return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
  }

  transition(actor: OrderActor, orderId: string, to: OrderStatus, note: string | null) {
    return this.db.tenant(actor.tenantId, async (tx) => {
      await this.transitionInTx(tx, actor, orderId, to, note);
      return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
    });
  }

  async transitionInTx(tx: Tx, actor: OrderActor, orderId: string, to: OrderStatus, note: string | null) {
    // Bloquea el pedido: dos cambios de estado simultáneos se ejecutan en serie
    const [row] = await tx.$queryRaw<{ status: OrderStatus; branch_id: string }[]>`
      SELECT status, branch_id FROM orders WHERE id = ${orderId}::uuid AND tenant_id = ${actor.tenantId}::uuid FOR UPDATE`;
    if (!row) throw new NotFoundException('Pedido no encontrado');
    const from = row.status;
    if (from === to) return; // idempotente
    if (!TRANSITIONS[from].includes(to)) {
      throw new ConflictException({ code: 'INVALID_TRANSITION', message: `No se puede pasar de ${from} a ${to}` });
    }
    // Solo los productos que controlan stock mueven inventario (no platos ni servicios)
    const items = await tx.orderItem.findMany({ where: { orderId, variant: { product: { trackStock: true } } } });

    if (to === 'CONFIRMED') {
      for (const it of items) {
        await this.inventory.apply(tx, {
          tenantId: actor.tenantId, variantId: it.variantId, branchId: row.branch_id, type: 'SALE_OUT', quantity: it.quantity,
          orderId, idempotencyKey: `order:${orderId}:sale:${it.variantId}`, reason: 'Venta', userId: actor.userId ?? undefined,
        });
      }
    }
    if (to === 'CANCELLED' && STOCK_COMMITTED.includes(from)) {
      for (const it of items) {
        await this.inventory.apply(tx, {
          tenantId: actor.tenantId, variantId: it.variantId, branchId: row.branch_id, type: 'SALE_VOID', quantity: it.quantity,
          orderId, idempotencyKey: `order:${orderId}:void:${it.variantId}`, reason: 'Anulación de venta', userId: actor.userId ?? undefined,
        });
      }
    }
    await tx.order.update({
      where: { id: orderId },
      data: { status: to, ...(to === 'CONFIRMED' ? { confirmedAt: new Date() } : {}), ...(to === 'CANCELLED' ? { cancelledAt: new Date() } : {}) },
    });
    await tx.orderStatusHistory.create({ data: { tenantId: actor.tenantId, orderId, fromStatus: from, toStatus: to, userId: actor.userId, note } });
    // Aviso al cliente (lo filtra la configuración de la empresa); se envía después de confirmar la transacción
    const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { number: true, conversationId: true } });
    await this.webhooks.emit(tx, actor.tenantId, 'order.status_changed', { orderId, number: o.number, from, to, note });
    if ((NOTIFIABLE_STATUSES as readonly string[]).includes(to)) {
      await this.automations.emit(tx, actor.tenantId, 'ORDER_STATUS_NOTIFICATION', { orderId, number: o.number, status: to, from, viaWhatsapp: !!o.conversationId }, { dedupeKey: `${orderId}:${to}` });
    }
  }
}
