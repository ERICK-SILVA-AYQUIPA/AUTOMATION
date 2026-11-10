'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, Bot, Clock, Download, MessagesSquare, ShoppingBag, UserPlus, Wallet, XCircle, CheckCircle2, Headset } from 'lucide-react';
import { api, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money, num } from '@/lib/format';
import { Button, Card, EmptyState, ErrorBox, Input, PageHeader, Skeleton, StatCard, Table, Td, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';

interface Dashboard {
  range: { from: string; to: string; timezone: string; currency: string };
  sales: {
    today: { total: string; orders: number };
    month: { total: string; orders: number };
    range: { total: string; orders: number };
    series: { day: string; total: string; orders: number }[];
  };
  orders: { pending: number; completed: number; cancelled: number };
  conversations: { received: number; handledByAi: number; transferredToHuman: number };
  newCustomers: number;
  topProducts: { product_name: string; quantity: number; revenue: string }[];
  lowStock: { id: string; sku: string; name: string; min_stock: number; stock: number }[];
}

const shortDay = (d: string) => new Intl.DateTimeFormat('es-PE', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));

export default function InicioPage() {
  const { me, can } = useAuth();
  const toast = useToast();
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard', range],
    queryFn: () => api<Dashboard>('/dashboard', { query: range }),
  });
  const cur = data?.range.currency ?? me?.tenant?.currency ?? 'PEN';
  const series = data?.sales.series.map((s) => ({ ...s, total: Number(s.total) })) ?? [];

  return (
    <>
      <PageHeader
        title={`Hola, ${me?.name.split(' ')[0] ?? ''}`}
        description={data ? `Resumen del ${shortDay(data.range.from)} al ${shortDay(data.range.to)} (${data.range.timezone})` : 'Resumen de tu negocio'}
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-muted">
              Desde
              <Input type="date" className="h-8 w-36" value={range.from ?? data?.range.from ?? ''} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value || undefined }))} />
            </label>
            <label className="text-xs text-muted">
              Hasta
              <Input type="date" className="h-8 w-36" value={range.to ?? data?.range.to ?? ''} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value || undefined }))} />
            </label>
            {can('reports:read') && (
              <Button
                variant="secondary"
                size="sm"
                icon={<Download className="size-4" />}
                onClick={() => download('/reports/sales.csv', { from: data?.range.from, to: data?.range.to }).catch(toast.error)}
              >
                Exportar ventas
              </Button>
            )}
          </div>
        }
      />
      <ErrorBox error={error} />
      {isLoading || !data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Ventas de hoy" value={money(data.sales.today.total, cur)} hint={`${num(data.sales.today.orders)} pedido(s)`} icon={<Wallet className="size-4" />} />
            <StatCard label="Ventas del mes" value={money(data.sales.month.total, cur)} hint={`${num(data.sales.month.orders)} pedido(s)`} icon={<ShoppingBag className="size-4" />} />
            <StatCard label="Pedidos pendientes" value={num(data.orders.pending)} hint={<Link href="/pedidos?status=PENDING" className="underline">Ver pendientes</Link>} icon={<Clock className="size-4" />} tone={data.orders.pending ? 'warning' : undefined} />
            <StatCard label="Clientes nuevos" value={num(data.newCustomers)} hint="En el rango" icon={<UserPlus className="size-4" />} />
            <StatCard label="Pedidos completados" value={num(data.orders.completed)} hint="Entregados en el rango" icon={<CheckCircle2 className="size-4" />} />
            <StatCard label="Pedidos anulados" value={num(data.orders.cancelled)} hint="En el rango" icon={<XCircle className="size-4" />} />
            <StatCard label="Conversaciones" value={num(data.conversations.received)} hint={`${num(data.conversations.handledByAi)} atendidas solo por IA`} icon={<MessagesSquare className="size-4" />} />
            <StatCard label="Transferidas a humano" value={num(data.conversations.transferredToHuman)} hint="WhatsApp se conecta en la Fase 4" icon={<Headset className="size-4" />} />
          </div>

          <Card className="p-4">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="font-medium">Ventas por día</h2>
              <p className="text-sm text-muted">
                Total del rango: <span className="font-medium text-text">{money(data.sales.range.total, cur)}</span> · {num(data.sales.range.orders)} pedido(s)
              </p>
            </div>
            {data.sales.range.orders === 0 ? (
              <EmptyState title="Sin ventas en este rango" description="Las ventas aparecen aquí cuando confirmas pedidos." />
            ) : (
              <div className="h-64" role="img" aria-label="Gráfico de ventas por día">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--border)" />
                    <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} minTickGap={16} />
                    <YAxis tickFormatter={(v: number) => num(v)} tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} width={56} />
                    <Tooltip
                      cursor={{ fill: 'var(--surface-2)' }}
                      contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', fontSize: 13 }}
                      labelFormatter={(d) => shortDay(String(d))}
                      formatter={(v, _n, item) => [`${money(Number(v), cur)} · ${(item.payload as { orders: number }).orders} pedido(s)`, 'Ventas']}
                    />
                    <Bar dataKey="total" fill="var(--primary)" radius={[4, 4, 0, 0]} maxBarSize={28} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <h2 className="border-b border-border px-4 py-3 font-medium">Productos más vendidos</h2>
              {data.topProducts.length === 0 ? (
                <EmptyState title="Aún no hay ventas" />
              ) : (
                <Table>
                  <thead><tr><Th>Producto</Th><Th className="text-right">Unidades</Th><Th className="text-right">Ingresos</Th></tr></thead>
                  <tbody>
                    {data.topProducts.map((p) => (
                      <tr key={p.product_name}><Td>{p.product_name}</Td><Td className="text-right tabular-nums">{num(p.quantity)}</Td><Td className="text-right tabular-nums">{money(p.revenue, cur)}</Td></tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
            <Card>
              <h2 className="flex items-center gap-2 border-b border-border px-4 py-3 font-medium"><AlertTriangle className="size-4 text-warning" /> Productos con poco stock</h2>
              {data.lowStock.length === 0 ? (
                <EmptyState title="Todo en orden" description="Ningún producto está en o por debajo de su stock mínimo." />
              ) : (
                <Table>
                  <thead><tr><Th>Producto</Th><Th className="text-right">Stock</Th><Th className="text-right">Mínimo</Th></tr></thead>
                  <tbody>
                    {data.lowStock.map((p) => (
                      <tr key={p.id}>
                        <Td><Link href={`/productos/${p.id}`} className="hover:underline">{p.name}</Link> <span className="text-xs text-muted">{p.sku}</span></Td>
                        <Td className="text-right tabular-nums font-medium text-danger">{num(p.stock)}</Td>
                        <Td className="text-right tabular-nums">{num(p.min_stock)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>
          <p className="flex items-center gap-2 text-xs text-muted"><Bot className="size-3.5" /> Las métricas de conversaciones se llenarán cuando conectes WhatsApp (Fase 4) y el asistente (Fase 6).</p>
        </div>
      )}
    </>
  );
}
