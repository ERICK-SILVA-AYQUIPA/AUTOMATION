'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, Plus, Search, ShoppingCart } from 'lucide-react';
import { api, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, money, ORDER_STATUS } from '@/lib/format';
import type { Order, Paged } from '@/lib/types';
import { Badge, Button, Card, EmptyState, ErrorBox, Input, Loading, PageHeader, Pagination, Select, Table, Td, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';

function Orders() {
  const { can } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const t = setTimeout(() => {
      setDq(q.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);
  // Fechas locales → límites ISO del día completo en la zona del navegador
  const filters = { status, q: dq, from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined, to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined };
  const list = useQuery({
    queryKey: ['orders', filters, page],
    queryFn: () => api<Paged<Order>>('/orders', { query: { ...filters, page, pageSize: 25 } }),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Pedidos"
        description="Pedidos manuales y de WhatsApp. Al confirmar se descuenta el stock; al anular se devuelve."
        actions={
          <>
            <Button variant="secondary" icon={<Download className="size-4" />} onClick={() => download('/orders/export', filters).catch(toast.error)}>Exportar CSV</Button>
            {can('orders:write') && <Link href="/pedidos/nuevo"><Button icon={<Plus className="size-4" />}>Nuevo pedido</Button></Link>}
          </>
        }
      />
      <Card>
        <div className="flex flex-col gap-2 border-b border-border p-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input className="pl-9" placeholder="N.º de pedido, cliente o teléfono" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar pedidos" />
          </div>
          <Select className="lg:w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Estado">
            <option value="">Todos los estados</option>
            {Object.entries(ORDER_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
          <Input type="date" className="lg:w-40" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} aria-label="Desde" />
          <Input type="date" className="lg:w-40" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} aria-label="Hasta" />
        </div>
        <ErrorBox error={list.error} />
        {list.isLoading ? <Loading /> : !list.data?.items.length ? (
          <EmptyState icon={<ShoppingCart className="size-5" />} title="No hay pedidos" description={status || dq || from || to ? 'Prueba con otros filtros.' : 'Registra un pedido manual o espera los de WhatsApp.'} />
        ) : (
          <>
            <Table>
              <thead><tr><Th>N.º</Th><Th>Fecha</Th><Th>Cliente</Th><Th>Canal</Th><Th className="text-right">Total</Th><Th>Estado</Th></tr></thead>
              <tbody>
                {list.data.items.map((o) => (
                  <tr key={o.id} className="cursor-pointer hover:bg-surface-2/60" onClick={() => router.push(`/pedidos/${o.id}`)}>
                    <Td className="font-medium"><Link href={`/pedidos/${o.id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">#{o.number}</Link></Td>
                    <Td className="whitespace-nowrap text-muted">{dateTime(o.createdAt)}</Td>
                    <Td>{o.customer.name ?? '—'}<span className="block text-xs text-muted">+{o.customer.phone}</span></Td>
                    <Td><Badge tone={o.channel === 'WHATSAPP' ? 'success' : 'neutral'}>{o.channel === 'WHATSAPP' ? 'WhatsApp' : 'Manual'}</Badge></Td>
                    <Td className="text-right tabular-nums">{money(o.total, o.currency)}</Td>
                    <Td><Badge tone={ORDER_STATUS[o.status]?.tone}>{ORDER_STATUS[o.status]?.label ?? o.status}</Badge></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}

export default function PedidosPage() {
  return <RequirePermission permission="orders:read"><Suspense><Orders /></Suspense></RequirePermission>;
}
