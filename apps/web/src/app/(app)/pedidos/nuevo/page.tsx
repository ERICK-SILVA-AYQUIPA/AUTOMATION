'use client';

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Minus, Plus, ScanBarcode, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useCurrency } from '@/lib/auth';
import { money, num, phoneLabel } from '@/lib/format';
import type { Customer, Order, Paged, Product } from '@/lib/types';
import { Button, Card, ErrorBox, Field, Input, PageHeader, Textarea } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';
import { VariantPicker } from '@/components/inventory/variant-picker';
import { BarcodeScanner } from '@/components/barcode-scanner';

interface Line { variantId: string; label: string; sku: string; unitPrice: string; stock: number; quantity: number }

function NewOrder() {
  const cur = useCurrency();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const qc = useQueryClient();
  const [lines, setLines] = useState<Line[]>([]);
  const [picked, setPicked] = useState<Pick<Customer, 'id' | 'name' | 'phone' | 'waProfileName'> | null>(null);
  const [presetDismissed, setPresetDismissed] = useState(false);
  const [cq, setCq] = useState('');
  const [newCustomer, setNewCustomer] = useState({ phone: '', name: '' });
  const [notes, setNotes] = useState('');
  const [address, setAddress] = useState('');
  const [confirm, setConfirm] = useState(true);
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Una clave por formulario: un doble envío no crea dos pedidos
  const [key] = useState(() => crypto.randomUUID());

  const presetCustomer = params.get('cliente');
  const preset = useQuery({ queryKey: ['customer', presetCustomer], queryFn: () => api<Customer>(`/customers/${presetCustomer}`), enabled: !!presetCustomer });
  // Cliente elegido, o el que viene en ?cliente= mientras no se cambie
  const customer = picked ?? (presetDismissed ? null : (preset.data ?? null));
  const setCustomer = (c: Pick<Customer, 'id' | 'name' | 'phone' | 'waProfileName'> | null) => {
    setPicked(c);
    setPresetDismissed(true);
  };

  const customers = useQuery({
    queryKey: ['customers', 'pick', cq],
    queryFn: () => api<Paged<Customer>>('/customers', { query: { q: cq, pageSize: 6 } }),
    enabled: cq.trim().length > 1 && !customer,
  });

  const add = (l: Omit<Line, 'quantity'>) =>
    setLines((ls) => (ls.some((x) => x.variantId === l.variantId) ? ls.map((x) => (x.variantId === l.variantId ? { ...x, quantity: x.quantity + 1 } : x)) : [...ls, { ...l, quantity: 1 }]));
  const setQty = (id: string, q: number) => setLines((ls) => ls.map((x) => (x.variantId === id ? { ...x, quantity: Math.max(1, Math.min(10_000, q || 1)) } : x)));
  const total = useMemo(() => lines.reduce((s, l) => s + Number(l.unitPrice) * l.quantity, 0), [lines]);

  async function onScan(code: string) {
    setScan(false);
    try {
      const p = await api<Product>(`/products/barcode/${encodeURIComponent(code)}`);
      const v = p.variants.find((x) => x.barcode === code) ?? (p.variants.length === 1 ? p.variants[0] : undefined);
      if (!v) return toast.error(`${p.name} tiene varias variantes: elígela en el buscador`);
      if (p.status !== 'ACTIVE' || !v.isActive) return toast.error(`${p.name} no está disponible para la venta`);
      add({ variantId: v.id, label: p.variants.length > 1 ? `${p.name} · ${v.name}` : p.name, sku: v.sku, unitPrice: v.effectivePrice, stock: v.stock });
    } catch (e) {
      toast.error(e instanceof ApiError && e.status === 404 ? `Ningún producto tiene el código ${code}` : e);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const o = await api<Order>('/orders', {
        method: 'POST',
        body: {
          ...(customer ? { customerId: customer.id } : { customer: { phone: newCustomer.phone, name: newCustomer.name || undefined } }),
          items: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
          notes: notes || null,
          deliveryAddress: address || null,
          confirm,
          idempotencyKey: key,
        },
      });
      ['orders', 'products', 'dashboard', 'customers'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.success(`Pedido #${o.number} ${confirm ? 'confirmado' : 'guardado como pendiente'}`);
      router.replace(`/pedidos/${o.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = lines.length > 0 && (customer || newCustomer.phone.replace(/\D/g, '').length >= 8);

  return (
    <form onSubmit={submit}>
      <PageHeader title="Nuevo pedido" description="Los precios se toman del catálogo al guardar; no se pueden editar aquí." actions={<Link href="/pedidos"><Button type="button" variant="ghost" icon={<ArrowLeft className="size-4" />}>Volver</Button></Link>} />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-medium">Productos</h2>
            <Button type="button" variant="secondary" size="sm" icon={<ScanBarcode className="size-4" />} onClick={() => setScan(true)}>Escanear</Button>
          </div>
          <VariantPicker currency={cur} onPick={({ variant: v, label }) => add({ variantId: v.id, label, sku: v.sku, unitPrice: v.effectivePrice, stock: v.stock })} />
          {lines.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">Busca o escanea productos para añadirlos.</p>
          ) : (
            <ul className="mt-4 divide-y divide-border">
              {lines.map((l) => (
                <li key={l.variantId} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{l.label}</p>
                    <p className="text-xs text-muted">{l.sku} · {money(l.unitPrice, cur)} c/u · <span className={l.quantity > l.stock ? 'text-danger' : ''}>stock {num(l.stock)}</span></p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button type="button" size="sm" variant="secondary" aria-label="Menos" icon={<Minus className="size-3.5" />} onClick={() => setQty(l.variantId, l.quantity - 1)} />
                    <Input type="number" className="h-8 w-16 text-center" min={1} value={l.quantity} onChange={(e) => setQty(l.variantId, Number(e.target.value))} aria-label={`Cantidad de ${l.label}`} />
                    <Button type="button" size="sm" variant="secondary" aria-label="Más" icon={<Plus className="size-3.5" />} onClick={() => setQty(l.variantId, l.quantity + 1)} />
                  </div>
                  <p className="w-24 text-right tabular-nums">{money(Number(l.unitPrice) * l.quantity, cur)}</p>
                  <Button type="button" size="sm" variant="ghost" aria-label={`Quitar ${l.label}`} icon={<Trash2 className="size-4" />} onClick={() => setLines((ls) => ls.filter((x) => x.variantId !== l.variantId))} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="p-4">
            <h2 className="mb-3 font-medium">Cliente</h2>
            {customer ? (
              <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-sm">
                <span><span className="font-medium">{customer.name ?? customer.waProfileName ?? 'Sin nombre'}</span><span className="block text-xs text-muted">{phoneLabel(customer.phone)}</span></span>
                <button type="button" className="text-xs underline" onClick={() => setCustomer(null)}>Cambiar</button>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <Input placeholder="Buscar cliente por nombre o teléfono" value={cq} onChange={(e) => setCq(e.target.value)} aria-label="Buscar cliente" />
                {customers.data && customers.data.items.length > 0 && (
                  <div className="rounded-lg border border-border">
                    {customers.data.items.map((c) => (
                      <button type="button" key={c.id} onClick={() => setCustomer(c)} className="block w-full border-b border-border px-3 py-2 text-left text-sm last:border-0 hover:bg-surface-2">
                        {c.name ?? c.waProfileName ?? 'Sin nombre'} <span className="text-muted">{phoneLabel(c.phone)}</span>
                      </button>
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted">¿Cliente nuevo? Escribe sus datos (se guarda al crear el pedido):</p>
                <Field label="Teléfono (con código de país)"><Input value={newCustomer.phone} onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })} placeholder="51987654321" inputMode="tel" /></Field>
                <Field label="Nombre"><Input value={newCustomer.name} onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} /></Field>
              </div>
            )}
          </Card>
          <Card className="flex flex-col gap-3 p-4">
            <Field label="Dirección de entrega (opcional)"><Input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} /></Field>
            <Field label="Notas (opcional)"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} className="min-h-16" /></Field>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 size-4" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
              <span>Confirmar ahora y descontar stock. Si lo desmarcas queda <em>pendiente</em> y no reserva stock.</span>
            </label>
            <div className="flex items-baseline justify-between border-t border-border pt-3">
              <span className="text-sm text-muted">Total</span>
              <span className="text-xl font-semibold tabular-nums">{money(total, cur)}</span>
            </div>
            <ErrorBox error={error} />
            <Button type="submit" loading={busy} disabled={!canSubmit}>{confirm ? 'Crear y confirmar' : 'Guardar pendiente'}</Button>
          </Card>
        </div>
      </div>
      {scan && <BarcodeScanner open onClose={() => setScan(false)} onDetected={onScan} />}
    </form>
  );
}

export default function NuevoPedidoPage() {
  return <RequirePermission permission="orders:write"><Suspense><NewOrder /></Suspense></RequirePermission>;
}
