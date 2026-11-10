'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, CheckCircle2, PackageCheck, Truck, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, money, num, ORDER_STATUS, phoneLabel } from '@/lib/format';
import type { Order } from '@/lib/types';
import { Badge, Button, Card, Dialog, ErrorBox, Field, Loading, PageHeader, Table, Td, Textarea, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';

/** Copia de las transiciones del backend, solo para mostrar botones. La API valida cada cambio. */
const NEXT: Record<string, string[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'SHIPPED', 'DELIVERED', 'CANCELLED'],
  PREPARING: ['SHIPPED', 'DELIVERED', 'CANCELLED'],
  SHIPPED: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};
const ACTION: Record<string, { label: string; icon: typeof CheckCircle2 }> = {
  CONFIRMED: { label: 'Confirmar (descuenta stock)', icon: CheckCircle2 },
  PREPARING: { label: 'En preparación', icon: Wrench },
  SHIPPED: { label: 'Marcar enviado', icon: Truck },
  DELIVERED: { label: 'Marcar entregado', icon: PackageCheck },
  CANCELLED: { label: 'Anular', icon: Ban },
};
const STOCK_COMMITTED = ['CONFIRMED', 'PREPARING', 'SHIPPED', 'DELIVERED'];

type FullOrder = Order & { branchId: string; movements: { id: string; type: string; quantity: number; variantId: string; createdAt: string }[] };

function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const order = useQuery({ queryKey: ['order', id], queryFn: () => api<FullOrder>(`/orders/${id}`) });
  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (order.isLoading) return <Loading />;
  if (order.error || !order.data) return <ErrorBox error={order.error ?? new Error('Pedido no encontrado')} />;
  const o = order.data;
  const st = ORDER_STATUS[o.status];

  async function change() {
    setBusy(true);
    setError(null);
    try {
      await api(`/orders/${id}/status`, { method: 'PATCH', body: { status: pending, note: note.trim() || undefined } });
      ['order', 'orders', 'products', 'product', 'dashboard', 'movements'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.success(`Pedido #${o.number}: ${ORDER_STATUS[pending!]?.label}`);
      setPending(null);
      setNote('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title={`Pedido #${o.number}`}
        description={`${dateTime(o.createdAt)} · ${o.channel === 'WHATSAPP' ? 'WhatsApp' : 'Manual'}`}
        actions={<Link href="/pedidos"><Button variant="ghost" icon={<ArrowLeft className="size-4" />}>Volver</Button></Link>}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-6">
          <Card>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="font-medium">Productos</h2>
              <Badge tone={st?.tone}>{st?.label ?? o.status}</Badge>
            </div>
            <Table>
              <thead><tr><Th>Producto</Th><Th className="text-right">Cant.</Th><Th className="text-right">Precio</Th><Th className="text-right">Total</Th></tr></thead>
              <tbody>
                {o.items?.map((i) => (
                  <tr key={i.id}>
                    <Td>{i.productName}{i.variantName !== 'Única' && <span className="text-muted"> · {i.variantName}</span>}<span className="block text-xs text-muted">{i.sku}</span></Td>
                    <Td className="text-right tabular-nums">{num(i.quantity)}</Td>
                    <Td className="text-right tabular-nums">{money(i.unitPrice, o.currency)}</Td>
                    <Td className="text-right tabular-nums">{money(i.total, o.currency)}</Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {Number(o.discount) > 0 && <tr><Td className="text-right text-muted" >Descuento</Td><Td /><Td /><Td className="text-right tabular-nums">-{money(o.discount, o.currency)}</Td></tr>}
                <tr><td className="px-4 py-3 text-right font-medium" colSpan={3}>Total</td><td className="px-4 py-3 text-right text-lg font-semibold tabular-nums">{money(o.total, o.currency)}</td></tr>
              </tfoot>
            </Table>
          </Card>
          <Card className="p-4">
            <h2 className="mb-3 font-medium">Historial de estados</h2>
            <ol className="flex flex-col gap-3">
              {o.statusHistory?.map((h) => (
                <li key={h.id} className="border-l-2 border-border pl-3 text-sm">
                  <p><span className="font-medium">{h.fromStatus ? `${ORDER_STATUS[h.fromStatus]?.label} → ` : ''}{ORDER_STATUS[h.toStatus]?.label}</span> <span className="text-muted">· {dateTime(h.createdAt)}</span></p>
                  {h.note && <p className="text-muted">{h.note}</p>}
                </li>
              ))}
            </ol>
            {o.movements.length > 0 && (
              <p className="mt-4 text-xs text-muted">
                Movimientos de inventario de este pedido: {o.movements.map((m) => `${m.type === 'SALE_OUT' ? 'venta' : 'anulación'} ${m.quantity > 0 ? '+' : ''}${m.quantity}`).join(', ')}.
              </p>
            )}
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <Card className="p-4 text-sm">
            <h2 className="mb-2 font-medium">Cliente</h2>
            <Link href={`/clientes/${o.customer.id}`} className="font-medium hover:underline">{o.customer.name ?? 'Sin nombre'}</Link>
            <p className="text-muted">{phoneLabel(o.customer.phone)}</p>
            {o.deliveryAddress && <p className="mt-3"><span className="text-muted">Entrega:</span> {o.deliveryAddress}</p>}
            {o.notes && <p className="mt-2"><span className="text-muted">Notas:</span> {o.notes}</p>}
          </Card>
          {can('orders:write') && NEXT[o.status]!.length > 0 && (
            <Card className="flex flex-col gap-2 p-4">
              <h2 className="mb-1 font-medium">Cambiar estado</h2>
              {NEXT[o.status]!.map((s) => {
                const A = ACTION[s]!;
                return (
                  <Button key={s} variant={s === 'CANCELLED' ? 'danger' : s === NEXT[o.status]![0] ? 'primary' : 'secondary'} icon={<A.icon className="size-4" />} onClick={() => { setError(null); setPending(s); }}>
                    {A.label}
                  </Button>
                );
              })}
            </Card>
          )}
        </div>
      </div>
      <Dialog
        open={!!pending}
        onClose={() => setPending(null)}
        title={pending === 'CANCELLED' ? `¿Anular el pedido #${o.number}?` : `¿Cambiar a “${ORDER_STATUS[pending ?? '']?.label}”?`}
        footer={<><Button variant="secondary" onClick={() => setPending(null)}>Volver</Button><Button variant={pending === 'CANCELLED' ? 'danger' : 'primary'} loading={busy} onClick={change}>{pending === 'CANCELLED' ? 'Anular pedido' : 'Confirmar cambio'}</Button></>}
      >
        <div className="flex flex-col gap-3 text-sm">
          {pending === 'CONFIRMED' && <p className="text-muted">Se descontará el stock de cada producto. Si no hay stock suficiente, el cambio se rechaza y nada se modifica.</p>}
          {pending === 'CANCELLED' && <p className="text-muted">{STOCK_COMMITTED.includes(o.status) ? 'El stock descontado se devolverá al inventario. ' : ''}Esta acción no se puede deshacer.</p>}
          <Field label="Nota (opcional)"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="min-h-16" /></Field>
          <ErrorBox error={error} />
        </div>
      </Dialog>
    </>
  );
}

export default function PedidoPage() {
  return <RequirePermission permission="orders:read"><OrderDetail /></RequirePermission>;
}
