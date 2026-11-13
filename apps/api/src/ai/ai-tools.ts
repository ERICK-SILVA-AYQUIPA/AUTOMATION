import { z } from 'zod';
import type { Tx } from '../database/database.service.js';
import type { OrdersService } from '../orders/orders.service.js';
import { ReservationError, type ReservationsService } from '../reservations/reservations.service.js';
import { readTiers } from '../catalog/pricing.js';
import { localParts } from '../common/time/zoned.js';
import type { ToolSpec } from './chat-model.js';

/**
 * Herramientas que el modelo puede pedir (ADR 037). Las ejecuta el backend con
 * la empresa y el cliente de la conversación: el modelo nunca elige empresa,
 * cliente, precios ni stock, y no hay ninguna herramienta que modifique
 * existencias. Un pedido del asistente queda PENDIENTE (sin descontar stock)
 * hasta que una persona lo confirma en el panel.
 */

export interface ToolContext {
  tenantId: string;
  currency: string;
  /** null en la prueba desde el panel: sin cliente no se consultan ni crean pedidos */
  customerId: string | null;
  conversationId: string | null;
  /** Mensaje que originó la respuesta: base de la clave de idempotencia del pedido */
  triggerMessageId: string;
  db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  orders: OrdersService;
  reservations: ReservationsService;
  /** Lo que la empresa tiene encendido (módulos y reglas de su plantilla) */
  features: ToolFeatures;
  /** Pide atención humana; lo aplica el motor al terminar */
  requestHandoff: (reason: string) => void;
}

export interface ToolFeatures {
  orders: boolean;
  reservations: boolean;
  volumePricing: boolean;
  /** TABLE (mesa, por personas) o APPOINTMENT (cita) */
  reservationKind: 'TABLE' | 'APPOINTMENT';
  timezone: string;
}

const searchArgs = z.object({ consulta: z.string().trim().min(1).max(80) });
const orderArgs = z.object({
  productos: z.array(z.object({ variante_id: z.uuid(), cantidad: z.number().int().min(1).max(999) })).min(1).max(20),
  direccion_entrega: z.string().trim().max(300).optional(),
  notas: z.string().trim().max(500).optional(),
});
const handoffArgs = z.object({ motivo: z.string().trim().min(1).max(300) });
const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const availabilityArgs = z.object({ fecha: dateArg, personas: z.number().int().min(1).max(500).optional(), servicio_id: z.uuid().optional() });
const reserveArgs = z.object({ fecha: dateArg, hora: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), personas: z.number().int().min(1).max(500).optional(), servicio_id: z.uuid().optional(), notas: z.string().trim().max(500).optional() });

const RESERVATION_TOOLS: ToolSpec[] = [
  {
    name: 'consultar_disponibilidad',
    description: 'Devuelve los horarios libres de un día para reservar (mesa o cita). Úsala siempre antes de ofrecer un horario. La fecha va en formato AAAA-MM-DD según la fecha actual de la tienda.',
    parameters: {
      type: 'object',
      properties: {
        fecha: { type: 'string', description: 'AAAA-MM-DD' },
        personas: { type: 'integer', minimum: 1, description: 'Número de personas (reservas de mesa)' },
        servicio_id: { type: 'string', description: 'servicio_id devuelto por buscar_productos (citas de un servicio)' },
      },
      required: ['fecha'],
    },
  },
  {
    name: 'crear_reserva',
    description: 'Registra la reserva o cita del cliente de esta conversación, solo cuando el cliente confirmó fecha, hora y (si aplica) personas o servicio. El sistema comprueba el cupo; si falla, ofrece otro horario de consultar_disponibilidad.',
    parameters: {
      type: 'object',
      properties: {
        fecha: { type: 'string', description: 'AAAA-MM-DD' },
        hora: { type: 'string', description: 'HH:MM, uno de los horarios libres' },
        personas: { type: 'integer', minimum: 1 },
        servicio_id: { type: 'string' },
        notas: { type: 'string' },
      },
      required: ['fecha', 'hora'],
    },
  },
  {
    name: 'ver_reservas_del_cliente',
    description: 'Lista las próximas reservas o citas del cliente de esta conversación con su estado.',
    parameters: { type: 'object', properties: {} },
  },
];

/** Herramientas según los módulos de la empresa: sin pedidos no se ofrece crear_pedido, sin reservas no se reserva */
export function toolsFor(f: ToolFeatures): ToolSpec[] {
  const sales = SALES_TOOLS.filter((t) => f.orders || !['crear_pedido', 'ver_pedidos_del_cliente'].includes(t.name));
  return f.reservations ? [...sales.slice(0, -1), ...RESERVATION_TOOLS, sales.at(-1)!] : sales;
}

export const SALES_TOOLS: ToolSpec[] = [
  {
    name: 'buscar_productos',
    description:
      'Busca productos del catálogo de la tienda por nombre, código o descripción. Devuelve precio, variantes (con su variante_id) y si hay stock. Úsala siempre antes de mencionar un precio o disponibilidad.',
    parameters: { type: 'object', properties: { consulta: { type: 'string', description: 'Palabras a buscar, p. ej. "gaseosa 500 ml"' } }, required: ['consulta'] },
  },
  {
    name: 'ver_pedidos_del_cliente',
    description: 'Lista los últimos pedidos del cliente de esta conversación con su estado y total.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'crear_pedido',
    description:
      'Registra un pedido PENDIENTE para el cliente de esta conversación, solo cuando el cliente confirmó explícitamente productos y cantidades. Los precios los pone el sistema. Una persona de la tienda lo confirmará después.',
    parameters: {
      type: 'object',
      properties: {
        productos: {
          type: 'array',
          items: {
            type: 'object',
            properties: { variante_id: { type: 'string', description: 'variante_id devuelto por buscar_productos' }, cantidad: { type: 'integer', minimum: 1 } },
            required: ['variante_id', 'cantidad'],
          },
        },
        direccion_entrega: { type: 'string' },
        notas: { type: 'string' },
      },
      required: ['productos'],
    },
  },
  {
    name: 'derivar_a_humano',
    description:
      'Pasa la conversación a una persona de la tienda. Úsala si el cliente lo pide, tiene un reclamo, pregunta algo que no puedes responder con las herramientas o la información del negocio, o si algo falla.',
    parameters: { type: 'object', properties: { motivo: { type: 'string' } }, required: ['motivo'] },
  },
];

const money = (v: unknown) => Number(v).toFixed(2);

export async function runTool(ctx: ToolContext, name: string, rawArgs: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'buscar_productos': {
      const a = searchArgs.safeParse(rawArgs);
      if (!a.success) return { error: 'Argumentos no válidos: indica "consulta"' };
      const words = a.data.consulta.split(/\s+/).filter((w) => w.length > 1).slice(0, 5);
      const products = await ctx.db((tx) =>
        tx.product.findMany({
          where: {
            tenantId: ctx.tenantId,
            status: 'ACTIVE',
            AND: words.map((w) => ({ OR: [{ name: { contains: w, mode: 'insensitive' as const } }, { sku: { contains: w, mode: 'insensitive' as const } }, { description: { contains: w, mode: 'insensitive' as const } }] })),
          },
          take: 6,
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            description: true,
            salePrice: true,
            trackStock: true,
            durationMinutes: true,
            category: { select: { name: true } },
            variants: { where: { isActive: true }, select: { id: true, name: true, salePrice: true, priceTiers: true, stockLevels: { select: { quantity: true } } } },
          },
        }),
      );
      if (!products.length) return { resultados: [], nota: 'No hay productos que coincidan. No inventes productos.' };
      return {
        moneda: ctx.currency,
        resultados: products.map((p) => ({
          producto: p.name,
          categoria: p.category?.name ?? null,
          descripcion: p.description?.slice(0, 300) ?? null,
          // Platos y servicios no llevan stock: están disponibles mientras estén activos
          ...(p.trackStock ? {} : { sin_control_de_stock: true }),
          ...(p.durationMinutes ? { duracion_minutos: p.durationMinutes } : {}),
          ...(ctx.features.reservations && !p.trackStock && ctx.features.reservationKind === 'APPOINTMENT' ? { servicio_id: p.id } : {}),
          variantes: p.variants.map((v) => {
            const stock = v.stockLevels.reduce((s, l) => s + l.quantity, 0);
            const tiers = ctx.features.volumePricing ? readTiers(v.priceTiers) : [];
            return {
              variante_id: v.id, variante: v.name, precio: money(v.salePrice ?? p.salePrice),
              ...(p.trackStock ? { disponible: stock > 0, unidades_disponibles: Math.max(0, stock) } : { disponible: true }),
              ...(tiers.length ? { precios_por_volumen: tiers.map((t) => ({ desde_unidades: t.minQty, precio_unitario: money(t.unitPrice) })) } : {}),
            };
          }),
        })),
      };
    }
    case 'ver_pedidos_del_cliente': {
      if (!ctx.customerId) return { error: 'No disponible en la prueba del panel' };
      const orders = await ctx.db((tx) =>
        tx.order.findMany({
          where: { tenantId: ctx.tenantId, customerId: ctx.customerId! },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { number: true, status: true, total: true, currency: true, createdAt: true, items: { select: { productName: true, variantName: true, quantity: true } } },
        }),
      );
      return { pedidos: orders.map((o) => ({ numero: o.number, estado: o.status, total: money(o.total), moneda: o.currency, fecha: o.createdAt.toISOString().slice(0, 10), productos: o.items.map((i) => `${i.quantity} x ${i.productName}${i.variantName && i.variantName !== i.productName ? ` (${i.variantName})` : ''}`) })) };
    }
    case 'crear_pedido': {
      if (!ctx.customerId || !ctx.conversationId) return { error: 'No disponible en la prueba del panel' };
      const a = orderArgs.safeParse(rawArgs);
      if (!a.success) return { error: 'Productos no válidos: usa los variante_id que devolvió buscar_productos' };
      const items = a.data.productos.map((p) => ({ variantId: p.variante_id, quantity: p.cantidad })).sort((x, y) => x.variantId.localeCompare(y.variantId));
      try {
        const { order, created } = await ctx.orders.create(
          { tenantId: ctx.tenantId, userId: null },
          {
            customerId: ctx.customerId,
            conversationId: ctx.conversationId,
            channel: 'WHATSAPP',
            items,
            deliveryAddress: a.data.direccion_entrega ?? null,
            notes: a.data.notas ?? null,
            // Mismo mensaje y mismo carrito = mismo pedido aunque el trabajo se reintente
            idempotencyKey: `ai:${ctx.triggerMessageId}:${items.map((i) => `${i.variantId}x${i.quantity}`).join(',')}`.slice(0, 250),
            confirm: false,
          },
        );
        return { numero: order.number, estado: order.status, total: money(order.total), moneda: order.currency, nuevo: created, nota: 'Pedido registrado como PENDIENTE: la tienda lo confirmará.' };
      } catch (e) {
        return { error: `No se pudo registrar el pedido: ${(e as Error).message}` };
      }
    }
    case 'consultar_disponibilidad': {
      if (!ctx.features.reservations) return { error: 'La tienda no toma reservas por este medio' };
      const a = availabilityArgs.safeParse(rawArgs);
      if (!a.success) return { error: 'Indica la fecha en formato AAAA-MM-DD' };
      try {
        const r = await ctx.db((tx) => ctx.reservations.availability(tx, ctx.tenantId, { date: a.data.fecha, partySize: a.data.personas ?? 1, productId: a.data.servicio_id }));
        return { fecha: r.date, horarios_libres: r.slots.map((x) => x.time), ...(r.reason ? { nota: r.reason } : {}) };
      } catch (e) {
        return { error: (e as Error).message };
      }
    }
    case 'crear_reserva': {
      if (!ctx.features.reservations) return { error: 'La tienda no toma reservas por este medio' };
      if (!ctx.customerId || !ctx.conversationId) return { error: 'No disponible en la prueba del panel' };
      const a = reserveArgs.safeParse(rawArgs);
      if (!a.success) return { error: 'Indica fecha (AAAA-MM-DD) y hora (HH:MM) de un horario libre' };
      try {
        const { reservation: r, created } = await ctx.reservations.create(
          { tenantId: ctx.tenantId, userId: null },
          {
            customerId: ctx.customerId, conversationId: ctx.conversationId, channel: 'WHATSAPP', confirm: false,
            date: a.data.fecha, time: a.data.hora, partySize: ctx.features.reservationKind === 'TABLE' ? (a.data.personas ?? 1) : 1,
            productId: a.data.servicio_id ?? null, notes: a.data.notas ?? null,
            idempotencyKey: `ai:${ctx.triggerMessageId}:${a.data.fecha}T${a.data.hora}`,
          },
        );
        return {
          numero: r.number, estado: r.status, fecha: a.data.fecha, hora: a.data.hora, nuevo: created,
          nota: r.status === 'PENDING' ? 'Reserva registrada como PENDIENTE: la tienda la confirmará.' : 'Reserva confirmada.',
        };
      } catch (e) {
        return { error: `No se pudo reservar: ${e instanceof ReservationError || e instanceof Error ? e.message : 'error'}` };
      }
    }
    case 'ver_reservas_del_cliente': {
      if (!ctx.customerId) return { error: 'No disponible en la prueba del panel' };
      const rows = await ctx.db((tx) =>
        tx.reservation.findMany({
          where: { tenantId: ctx.tenantId, customerId: ctx.customerId!, startsAt: { gte: new Date() } },
          orderBy: { startsAt: 'asc' }, take: 5,
          select: { number: true, status: true, startsAt: true, partySize: true, serviceName: true },
        }),
      );
      return {
        reservas: rows.map((r) => {
          const l = localParts(r.startsAt, ctx.features.timezone);
          return { numero: r.number, estado: r.status, fecha: l.date, hora: l.time, personas: r.partySize, servicio: r.serviceName };
        }),
      };
    }
    case 'derivar_a_humano': {
      const a = handoffArgs.safeParse(rawArgs);
      ctx.requestHandoff(a.success ? a.data.motivo : 'solicitado por el asistente');
      return { ok: true, nota: 'Una persona de la tienda continuará la conversación. Despídete brevemente avisándolo.' };
    }
    default:
      return { error: `La herramienta ${name} no existe` };
  }
}
