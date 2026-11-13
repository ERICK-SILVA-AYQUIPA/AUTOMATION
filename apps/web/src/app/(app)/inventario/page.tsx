'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDownUp, ArrowRightLeft, Boxes, Plus, Store } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth, useCurrency } from '@/lib/auth';
import { fieldErrors } from '@/lib/form';
import { dateTime, MOVEMENT_TYPE, num } from '@/lib/format';
import type { Branch, Paged } from '@/lib/types';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Field, Input, Loading, PageHeader, Pagination, Select, Table, Td, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';
import { MovementDialog } from '@/components/inventory/movement-dialog';
import { VariantPicker } from '@/components/inventory/variant-picker';

interface Movement {
  id: string; type: string; quantity: number; stockBefore: number; stockAfter: number; reason: string | null; createdAt: string; allowNegative: boolean;
  variant: { sku: string; name: string; product: { id: string; name: string } }; branch: { name: string }; order: { number: number } | null;
}
interface Alert { id: string; sku: string; name: string; min_stock: number; stock: number }

function Movements({ multiBranch, branches }: { multiBranch: boolean; branches: Branch[] }) {
  const [type, setType] = useState('');
  const [branchId, setBranchId] = useState('');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['movements', { type, branchId, page }],
    queryFn: () => api<Paged<Movement>>('/inventory/movements', { query: { type, branchId, page, pageSize: 25 } }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card>
      <div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row">
        <Select className="sm:w-60" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} aria-label="Tipo de movimiento">
          <option value="">Todos los tipos</option>
          {Object.entries(MOVEMENT_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        {multiBranch && (
          <Select className="sm:w-52" value={branchId} onChange={(e) => { setBranchId(e.target.value); setPage(1); }} aria-label="Sucursal">
            <option value="">Todas las sucursales</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        )}
      </div>
      <ErrorBox error={list.error} />
      {list.isLoading ? <Loading /> : !list.data?.items.length ? (
        <EmptyState icon={<Boxes className="size-5" />} title="Sin movimientos" description="Cada entrada, ajuste, venta o anulación queda registrada aquí y no se puede modificar." />
      ) : (
        <>
          <Table>
            <thead><tr><Th>Fecha</Th><Th>Producto</Th><Th>Tipo</Th><Th className="text-right">Cantidad</Th><Th className="text-right">Antes → después</Th><Th>Motivo</Th></tr></thead>
            <tbody>
              {list.data.items.map((m) => (
                <tr key={m.id}>
                  <Td className="whitespace-nowrap text-muted">{dateTime(m.createdAt)}</Td>
                  <Td>
                    <Link href={`/productos/${m.variant.product.id}`} className="font-medium hover:underline">{m.variant.product.name}</Link>
                    <span className="block text-xs text-muted">{m.variant.name !== 'Única' ? `${m.variant.name} · ` : ''}{m.variant.sku}{multiBranch ? ` · ${m.branch.name}` : ''}</span>
                  </Td>
                  <Td>{MOVEMENT_TYPE[m.type] ?? m.type}{m.allowNegative && <Badge tone="warning">Negativo autorizado</Badge>}</Td>
                  <Td className={`text-right tabular-nums ${m.quantity < 0 ? 'text-danger' : 'text-success'}`}>{m.quantity > 0 ? '+' : ''}{num(m.quantity)}</Td>
                  <Td className="whitespace-nowrap text-right tabular-nums text-muted">{num(m.stockBefore)} → <span className="text-text">{num(m.stockAfter)}</span></Td>
                  <Td className="text-muted">{m.order ? <span>Pedido #{m.order.number}</span> : m.reason}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} onPage={setPage} />
        </>
      )}
    </Card>
  );
}

function Alerts() {
  const list = useQuery({ queryKey: ['stock-alerts'], queryFn: () => api<Alert[]>('/inventory/alerts') });
  return (
    <Card>
      <ErrorBox error={list.error} />
      {list.isLoading ? <Loading /> : !list.data?.length ? (
        <EmptyState title="Sin alertas" description="Ningún producto activo está en o por debajo de su stock mínimo." />
      ) : (
        <Table>
          <thead><tr><Th>Producto</Th><Th>SKU</Th><Th className="text-right">Stock</Th><Th className="text-right">Mínimo</Th><Th className="text-right">Faltan</Th></tr></thead>
          <tbody>
            {list.data.map((a) => (
              <tr key={a.id}>
                <Td><Link href={`/productos/${a.id}`} className="font-medium hover:underline">{a.name}</Link></Td>
                <Td className="text-muted">{a.sku}</Td>
                <Td className="text-right tabular-nums font-medium text-danger">{num(a.stock)}</Td>
                <Td className="text-right tabular-nums">{num(a.min_stock)}</Td>
                <Td className="text-right tabular-nums">{num(Math.max(0, a.min_stock - a.stock + 1))}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Branches({ branches, loading }: { branches: Branch[]; loading: boolean }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', address: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/branches', { method: 'POST', body: { name: f.name, address: f.address || undefined } });
      qc.invalidateQueries({ queryKey: ['branches'] });
      toast.success('Sucursal creada');
      setOpen(false);
      setF({ name: '', address: '' });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm text-muted">El stock se controla por sucursal. Los pedidos descuentan de la principal salvo que se indique otra.</p>
        {can('tenant:settings') && <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => { setError(null); setOpen(true); }}>Sucursal</Button>}
      </div>
      {loading ? <Loading /> : (
        <Table>
          <thead><tr><Th>Nombre</Th><Th>Dirección</Th><Th>Estado</Th></tr></thead>
          <tbody>
            {branches.map((b) => (
              <tr key={b.id}>
                <Td className="font-medium">{b.name} {b.isDefault && <Badge tone="info">Principal</Badge>}</Td>
                <Td className="text-muted">{b.address ?? '—'}</Td>
                <Td>{b.isActive ? <Badge tone="success">Activa</Badge> : <Badge>Inactiva</Badge>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title="Nueva sucursal" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancelar</Button><Button type="submit" form="branch-form" loading={busy}>Crear</Button></>}>
        <form id="branch-form" onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Nombre" error={fieldErrors(error).name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={80} /></Field>
          <Field label="Dirección (opcional)"><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} maxLength={200} /></Field>
          <p className="text-xs text-muted">El número de sucursales depende de tu plan.</p>
          <ErrorBox error={error} />
        </form>
      </Dialog>
    </Card>
  );
}

function TransferDialog({ open, onClose, branches }: { open: boolean; onClose: () => void; branches: Branch[] }) {
  const cur = useCurrency();
  const qc = useQueryClient();
  const toast = useToast();
  const [target, setTarget] = useState<{ variantId: string; label: string } | null>(null);
  const [f, setF] = useState({ fromBranchId: '', toBranchId: '', quantity: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await api('/inventory/transfers', { method: 'POST', body: { variantId: target.variantId, fromBranchId: f.fromBranchId, toBranchId: f.toBranchId, quantity: Number(f.quantity), reason: f.reason || undefined } });
      ['movements', 'products', 'product'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.success('Transferencia registrada');
      setTarget(null);
      setF({ fromBranchId: '', toBranchId: '', quantity: '', reason: '' });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  const active = branches.filter((b) => b.isActive);
  return (
    <Dialog open={open} onClose={onClose} title="Transferir entre sucursales" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="transfer-form" loading={busy} disabled={!target}>Transferir</Button></>}>
      <form id="transfer-form" onSubmit={submit} className="flex flex-col gap-4">
        {target ? (
          <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-sm"><span className="font-medium">{target.label}</span><button type="button" className="text-xs underline" onClick={() => setTarget(null)}>Cambiar</button></div>
        ) : (
          <Field label="Producto"><VariantPicker stockedOnly currency={cur} onPick={(p) => setTarget({ variantId: p.variant.id, label: `${p.label} (${p.variant.sku})` })} /></Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Desde"><Select value={f.fromBranchId} onChange={(e) => setF({ ...f, fromBranchId: e.target.value })} required><option value="">Elige…</option>{active.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          <Field label="Hacia"><Select value={f.toBranchId} onChange={(e) => setF({ ...f, toBranchId: e.target.value })} required><option value="">Elige…</option>{active.filter((b) => b.id !== f.fromBranchId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          <Field label="Cantidad"><Input type="number" min="1" step="1" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} required /></Field>
          <Field label="Motivo (opcional)"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} maxLength={300} /></Field>
        </div>
        <ErrorBox error={error} />
      </form>
    </Dialog>
  );
}

function Inventory() {
  const { can } = useAuth();
  const params = useSearchParams();
  const [tab, setTab] = useState<'movimientos' | 'alertas' | 'sucursales'>(params.get('tab') === 'alertas' ? 'alertas' : 'movimientos');
  const [movement, setMovement] = useState(false);
  const [transfer, setTransfer] = useState(false);
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api<Branch[]>('/branches') });
  const multiBranch = (branches.data?.length ?? 0) > 1;
  const tabs = [
    { k: 'movimientos', label: 'Movimientos', icon: ArrowDownUp },
    { k: 'alertas', label: 'Alertas de stock', icon: AlertTriangle },
    { k: 'sucursales', label: 'Sucursales', icon: Store },
  ] as const;
  return (
    <>
      <PageHeader
        title="Inventario"
        description="Historial inmutable de entradas, salidas y ajustes. Las ventas descuentan stock al confirmar el pedido."
        actions={
          can('inventory:write') && (
            <>
              {multiBranch && <Button variant="secondary" icon={<ArrowRightLeft className="size-4" />} onClick={() => setTransfer(true)}>Transferir</Button>}
              <Button icon={<Plus className="size-4" />} onClick={() => setMovement(true)}>Registrar movimiento</Button>
            </>
          )
        }
      />
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-border" role="tablist">
        {tabs.map((t) => (
          <button key={t.k} role="tab" aria-selected={tab === t.k} onClick={() => setTab(t.k)} className={`-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === t.k ? 'border-primary font-medium' : 'border-transparent text-muted hover:text-text'}`}>
            <t.icon className="size-4" /> {t.label}
          </button>
        ))}
      </div>
      {tab === 'movimientos' && <Movements multiBranch={multiBranch} branches={branches.data ?? []} />}
      {tab === 'alertas' && <Alerts />}
      {tab === 'sucursales' && <Branches branches={branches.data ?? []} loading={branches.isLoading} />}
      {movement && <MovementDialog open onClose={() => setMovement(false)} />}
      {multiBranch && <TransferDialog open={transfer} onClose={() => setTransfer(false)} branches={branches.data ?? []} />}
    </>
  );
}

export default function InventarioPage() {
  return <RequirePermission permission="inventory:read"><Suspense><Inventory /></Suspense></RequirePermission>;
}
