'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth, useCurrency } from '@/lib/auth';
import { date, dateTime, money, num, ORDER_STATUS, phoneLabel, RESERVATION_STATUS, dayIn, timeIn } from '@/lib/format';
import type { Customer } from '@/lib/types';
import { Badge, Button, Card, EmptyState, ErrorBox, Loading, PageHeader, StatCard, Table, Td, Th } from '@/components/ui';
import { RequirePermission } from '@/components/guard';
import { CustomerDialog } from '@/components/customer-dialog';

type Detail = Customer & {
  orders: { id: string; number: number; status: string; total: string; currency: string; createdAt: string }[];
  stats: { orders: number; totalSpent: string; lastPurchaseAt: string | null };
  topProducts: { name: string; quantity: number; total: string }[];
  reservations: { id: string; number: number; status: string; startsAt: string; partySize: number; serviceName: string | null }[];
};

function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const { can, me } = useAuth();
  const tz = me?.tenant?.timezone ?? 'America/Lima';
  const hasReservations = !!me?.tenant?.enabledModules.includes('reservations');
  const cur = useCurrency();
  const [edit, setEdit] = useState(false);
  const c = useQuery({ queryKey: ['customer', id], queryFn: () => api<Detail>(`/customers/${id}`) });
  if (c.isLoading) return <Loading />;
  if (c.error || !c.data) return <ErrorBox error={c.error ?? new Error('Cliente no encontrado')} />;
  const d = c.data;
  return (
    <>
      <PageHeader
        title={d.businessName ?? d.name ?? d.waProfileName ?? 'Cliente sin nombre'}
        description={`${d.businessName && d.name ? `Contacto: ${d.name} · ` : ''}${phoneLabel(d.phone)} · cliente desde ${dateTime(d.createdAt)}`}
        actions={
          <>
            <Link href="/clientes"><Button variant="ghost" icon={<ArrowLeft className="size-4" />}>Volver</Button></Link>
            {can('customers:write') && <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setEdit(true)}>Editar</Button>}
            {can('orders:write') && <Link href={`/pedidos/nuevo?cliente=${d.id}`}><Button icon={<Plus className="size-4" />}>Nuevo pedido</Button></Link>}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-1">
            <StatCard label="Compras" value={num(d.stats.orders)} hint="Confirmadas, sin anuladas" />
            <StatCard label="Total comprado" value={money(d.stats.totalSpent, cur)} hint={d.stats.lastPurchaseAt ? `Última compra: ${date(d.stats.lastPurchaseAt)}` : undefined} />
          </div>
          <Card className="flex flex-col gap-2 p-4 text-sm">
            {d.customerType === 'BUSINESS' && <p><Badge tone="info">Cliente comercial</Badge></p>}
            <p><span className="text-muted">Correo:</span> {d.email ?? '—'}</p>
            <p><span className="text-muted">Documento:</span> {d.documentId ?? '—'}</p>
            <p><span className="text-muted">Dirección:</span> {d.address ?? '—'}</p>
            <p><span className="text-muted">Origen:</span> {d.source === 'whatsapp' ? 'WhatsApp' : 'Manual'}</p>
            <p><span className="text-muted">Último contacto:</span> {dateTime(d.lastContactAt)}</p>
            {d.tags.length > 0 && <div className="flex flex-wrap gap-1">{d.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>}
            {d.notes && <p className="whitespace-pre-wrap rounded-lg bg-surface-2 p-2">{d.notes}</p>}
          </Card>
        </div>
        <div className="flex flex-col gap-6">
        {d.topProducts.length > 0 && (
          <Card>
            <h2 className="border-b border-border px-4 py-3 font-medium">Lo que más compra</h2>
            <Table>
              <thead><tr><Th>Producto</Th><Th className="text-right">Unidades</Th><Th className="text-right">Total</Th></tr></thead>
              <tbody>
                {d.topProducts.map((t) => (
                  <tr key={t.name}><Td>{t.name}</Td><Td className="text-right tabular-nums">{num(t.quantity)}</Td><Td className="text-right tabular-nums">{money(t.total, cur)}</Td></tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
        <Card>
          <h2 className="border-b border-border px-4 py-3 font-medium">Pedidos</h2>
          {!d.orders.length ? <EmptyState title="Sin pedidos" /> : (
            <Table>
              <thead><tr><Th>N.º</Th><Th>Fecha</Th><Th className="text-right">Total</Th><Th>Estado</Th></tr></thead>
              <tbody>
                {d.orders.map((o) => (
                  <tr key={o.id}>
                    <Td><Link href={`/pedidos/${o.id}`} className="font-medium hover:underline">#{o.number}</Link></Td>
                    <Td className="text-muted">{dateTime(o.createdAt)}</Td>
                    <Td className="text-right tabular-nums">{money(o.total, o.currency)}</Td>
                    <Td><Badge tone={ORDER_STATUS[o.status]?.tone}>{ORDER_STATUS[o.status]?.label}</Badge></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        {hasReservations && (
          <Card>
            <h2 className="border-b border-border px-4 py-3 font-medium">Reservas</h2>
            {!d.reservations.length ? <EmptyState title="Sin reservas" /> : (
              <Table>
                <thead><tr><Th>N.º</Th><Th>Fecha</Th><Th>Detalle</Th><Th>Estado</Th></tr></thead>
                <tbody>
                  {d.reservations.map((r) => (
                    <tr key={r.id}>
                      <Td className="font-medium">#{r.number}</Td>
                      <Td className="whitespace-nowrap text-muted">{dayIn(r.startsAt, tz)} · {timeIn(r.startsAt, tz)}</Td>
                      <Td>{r.serviceName ?? `${r.partySize} ${r.partySize === 1 ? 'persona' : 'personas'}`}</Td>
                      <Td><Badge tone={RESERVATION_STATUS[r.status]?.tone}>{RESERVATION_STATUS[r.status]?.label ?? r.status}</Badge></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        )}
        </div>
      </div>
      {edit && <CustomerDialog open onClose={() => setEdit(false)} customer={d} />}
      <p className="mt-6 text-xs text-muted">Las conversaciones de WhatsApp de este cliente se mostrarán aquí desde la Fase 5.</p>
    </>
  );
}

export default function ClientePage() {
  return <RequirePermission permission="customers:read"><CustomerDetail /></RequirePermission>;
}
