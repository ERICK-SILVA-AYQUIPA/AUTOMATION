import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { RequirePermission, TenantUser } from '../common/decorators/auth.decorators.js';
import type { TenantPrincipal } from '../common/context/principal.js';
import { DatabaseService, type Tx } from '../database/database.service.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato AAAA-MM-DD');
const rangeSchema = z.object({ from: day.optional(), to: day.optional() });

/** Fecha local (AAAA-MM-DD) de "ahora" en la zona horaria de la empresa */
const localToday = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

/**
 * Métricas del panel, calculadas en PostgreSQL sobre datos reales y en la zona
 * horaria de la empresa. "Venta" = pedido confirmado y no anulado; su fecha es
 * la de confirmación.
 */
@Controller()
export class DashboardController {
  constructor(private readonly db: DatabaseService) {}

  private async range(tx: Tx, tenantId: string, q: z.infer<typeof rangeSchema>) {
    const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true, currency: true } });
    const today = localToday(t.timezone);
    const to = q.to ?? today;
    const from = q.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
    if (from > to) throw new BadRequestException('La fecha inicial es posterior a la final');
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw new BadRequestException('El rango máximo es de un año');
    return { tz: t.timezone, currency: t.currency, today, from, to };
  }

  @RequirePermission('tenant:read')
  @Get('dashboard')
  dashboard(@TenantUser() p: TenantPrincipal, @Query({ schema: rangeSchema }) q: z.infer<typeof rangeSchema>) {
    return this.db.tenant(p.tenantId, async (tx) => {
      const r = await this.range(tx, p.tenantId, q);
      const month = r.today.slice(0, 7) + '-01';
      // Límites [desde, hasta+1día) convertidos de fecha local a timestamptz
      const [sales] = await tx.$queryRaw<{ today_total: string; today_count: number; month_total: string; month_count: number; range_total: string; range_count: number }[]>`
        WITH s AS (
          SELECT total, (confirmed_at AT TIME ZONE ${r.tz})::date AS d FROM orders
          WHERE confirmed_at IS NOT NULL AND status <> 'CANCELLED'
        )
        SELECT
          COALESCE(SUM(total) FILTER (WHERE d = ${r.today}::date), 0)::text AS today_total,
          COUNT(*) FILTER (WHERE d = ${r.today}::date)::int AS today_count,
          COALESCE(SUM(total) FILTER (WHERE d >= ${month}::date AND d <= ${r.today}::date), 0)::text AS month_total,
          COUNT(*) FILTER (WHERE d >= ${month}::date AND d <= ${r.today}::date)::int AS month_count,
          COALESCE(SUM(total) FILTER (WHERE d BETWEEN ${r.from}::date AND ${r.to}::date), 0)::text AS range_total,
          COUNT(*) FILTER (WHERE d BETWEEN ${r.from}::date AND ${r.to}::date)::int AS range_count
        FROM s`;
      const series = await tx.$queryRaw<{ day: string; total: string; orders: number }[]>`
        SELECT to_char(g.d, 'YYYY-MM-DD') AS day, COALESCE(SUM(o.total), 0)::text AS total, COUNT(o.id)::int AS orders
        FROM generate_series(${r.from}::date, ${r.to}::date, interval '1 day') AS g(d)
        LEFT JOIN orders o ON o.confirmed_at IS NOT NULL AND o.status <> 'CANCELLED'
          AND (o.confirmed_at AT TIME ZONE ${r.tz})::date = g.d::date
        GROUP BY g.d ORDER BY g.d`;
      const [orders] = await tx.$queryRaw<{ pending: number; completed: number; cancelled: number }[]>`
        SELECT COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
               COUNT(*) FILTER (WHERE status = 'DELIVERED' AND (updated_at AT TIME ZONE ${r.tz})::date BETWEEN ${r.from}::date AND ${r.to}::date)::int AS completed,
               COUNT(*) FILTER (WHERE status = 'CANCELLED' AND (updated_at AT TIME ZONE ${r.tz})::date BETWEEN ${r.from}::date AND ${r.to}::date)::int AS cancelled
        FROM orders`;
      const [conv] = await tx.$queryRaw<{ received: number; transferred: number; ai_only: number }[]>`
        SELECT COUNT(*)::int AS received,
               COUNT(*) FILTER (WHERE handoff_at IS NOT NULL)::int AS transferred,
               COUNT(*) FILTER (WHERE handoff_at IS NULL)::int AS ai_only
        FROM conversations WHERE (created_at AT TIME ZONE ${r.tz})::date BETWEEN ${r.from}::date AND ${r.to}::date`;
      const [customers] = await tx.$queryRaw<{ new_customers: number }[]>`
        SELECT COUNT(*)::int AS new_customers FROM customers
        WHERE (created_at AT TIME ZONE ${r.tz})::date BETWEEN ${r.from}::date AND ${r.to}::date`;
      const top = await tx.$queryRaw<{ product_name: string; quantity: number; revenue: string }[]>`
        SELECT oi.product_name, SUM(oi.quantity)::int AS quantity, SUM(oi.total)::text AS revenue
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.confirmed_at IS NOT NULL AND o.status <> 'CANCELLED'
          AND (o.confirmed_at AT TIME ZONE ${r.tz})::date BETWEEN ${r.from}::date AND ${r.to}::date
        GROUP BY oi.product_name ORDER BY quantity DESC, revenue DESC LIMIT 10`;
      const lowStock = await tx.$queryRaw<{ id: string; sku: string; name: string; min_stock: number; stock: number }[]>`
        SELECT p.id, p.sku, p.name, p.min_stock, COALESCE(SUM(sl.quantity), 0)::int AS stock
        FROM products p LEFT JOIN product_variants v ON v.product_id = p.id LEFT JOIN stock_levels sl ON sl.variant_id = v.id
        WHERE p.min_stock > 0 AND p.status = 'ACTIVE'
        GROUP BY p.id HAVING COALESCE(SUM(sl.quantity), 0) <= p.min_stock ORDER BY stock ASC LIMIT 10`;
      return {
        range: { from: r.from, to: r.to, timezone: r.tz, currency: r.currency },
        sales: {
          today: { total: sales!.today_total, orders: sales!.today_count },
          month: { total: sales!.month_total, orders: sales!.month_count },
          range: { total: sales!.range_total, orders: sales!.range_count },
          series,
        },
        orders: orders!,
        conversations: { received: conv!.received, handledByAi: conv!.ai_only, transferredToHuman: conv!.transferred },
        newCustomers: customers!.new_customers,
        topProducts: top,
        lowStock,
      };
    });
  }

  /** Reporte de ventas por día (CSV) del rango indicado. */
  @RequirePermission('reports:read')
  @Get('reports/sales.csv')
  async salesCsv(@TenantUser() p: TenantPrincipal, @Query({ schema: rangeSchema }) q: z.infer<typeof rangeSchema>, @Res() res: Response) {
    const { rows, r } = await this.db.tenant(p.tenantId, async (tx) => {
      const r = await this.range(tx, p.tenantId, q);
      const rows = await tx.$queryRaw<{ day: string; orders: number; total: string; items: number }[]>`
        SELECT to_char(g.d, 'YYYY-MM-DD') AS day, COUNT(DISTINCT o.id)::int AS orders, COALESCE(SUM(oi.total), 0)::text AS total, COALESCE(SUM(oi.quantity), 0)::int AS items
        FROM generate_series(${r.from}::date, ${r.to}::date, interval '1 day') AS g(d)
        LEFT JOIN orders o ON o.confirmed_at IS NOT NULL AND o.status <> 'CANCELLED' AND (o.confirmed_at AT TIME ZONE ${r.tz})::date = g.d::date
        LEFT JOIN order_items oi ON oi.order_id = o.id
        GROUP BY g.d ORDER BY g.d`;
      return { rows, r };
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ventas-${r.from}_${r.to}.csv"`);
    res.send('﻿' + ['fecha,pedidos,unidades,total,moneda', ...rows.map((x) => `${x.day},${x.orders},${x.items},${x.total},${r.currency}`)].join('\n'));
  }
}
