'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowLeft, ImagePlus, Pencil, Plus, Trash2, ArrowDownUp } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth, useCurrency } from '@/lib/auth';
import { fieldErrors, formatAttributes, parseAttributes } from '@/lib/form';
import { dateTime, money, MOVEMENT_TYPE, num, PRODUCT_STATUS } from '@/lib/format';
import type { Branch, Paged, Product, Variant } from '@/lib/types';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Field, Input, Loading, PageHeader, Table, Td, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';
import { ProductFields, toPayload, type ProductValues } from '@/components/products/product-fields';
import { MovementDialog } from '@/components/inventory/movement-dialog';

const toValues = (p: Product): ProductValues => ({
  sku: p.sku, barcode: p.barcode ?? '', name: p.name, description: p.description ?? '', categoryId: p.categoryId ?? '',
  salePrice: p.salePrice, costPrice: p.costPrice ?? '', minStock: String(p.minStock), status: p.status,
});

const HISTORY_ACTION: Record<string, string> = {
  created: 'Creado', updated: 'Modificado', variant_added: 'Variante añadida', variant_updated: 'Variante modificada',
  image_added: 'Imagen añadida', image_removed: 'Imagen eliminada', imported: 'Creado por importación', imported_update: 'Actualizado por importación',
};
const FIELD_LABEL: Record<string, string> = { sku: 'SKU', barcode: 'Código de barras', name: 'Nombre', description: 'Descripción', categoryId: 'Categoría', salePrice: 'Precio', costPrice: 'Costo', minStock: 'Stock mínimo', status: 'Estado' };

function VariantDialog({ productId, variant, open, onClose }: { productId: string; variant: Variant | null; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState(() =>
    variant
      ? { name: variant.name, sku: variant.sku, barcode: variant.barcode ?? '', attributes: formatAttributes(variant.attributes), salePrice: variant.salePrice ?? '', isActive: variant.isActive }
      : { name: '', sku: '', barcode: '', attributes: '', salePrice: '', isActive: true },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = { name: f.name.trim(), sku: f.sku.trim(), barcode: f.barcode.trim() || null, attributes: parseAttributes(f.attributes), salePrice: f.salePrice.trim() || null, isActive: f.isActive };
    try {
      if (variant) await api(`/products/${productId}/variants/${variant.id}`, { method: 'PATCH', body });
      else await api(`/products/${productId}/variants`, { method: 'POST', body });
      qc.invalidateQueries({ queryKey: ['product', productId] });
      toast.success(variant ? 'Variante actualizada' : 'Variante añadida');
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title={variant ? 'Editar variante' : 'Nueva variante'} footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="variant-form" loading={busy}>Guardar</Button></>}>
      <form id="variant-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Nombre" error={errors.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required placeholder="Rojo / M" /></Field>
        <Field label="SKU" error={errors.sku}><Input value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} required /></Field>
        <Field label="Código de barras" error={errors.barcode}><Input value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value })} /></Field>
        <Field label="Precio propio" error={errors.salePrice} hint="Vacío = precio del producto"><Input type="number" min="0" step="0.01" value={f.salePrice} onChange={(e) => setF({ ...f, salePrice: e.target.value })} /></Field>
        <Field label="Atributos" className="sm:col-span-2" hint="Formato: Color: Rojo, Talla: M"><Input value={f.attributes} onChange={(e) => setF({ ...f, attributes: e.target.value })} /></Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="size-4" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Variante activa (se puede vender)</label>
        <div className="sm:col-span-2"><ErrorBox error={error} /></div>
      </form>
    </Dialog>
  );
}

interface Movement { id: string; type: string; quantity: number; stockAfter: number; reason: string | null; createdAt: string; variant: { sku: string; name: string }; branch: { name: string }; order: { number: number } | null }
interface History { id: string; action: string; changes: Record<string, unknown>; createdAt: string }

function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const cur = useCurrency();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const canWrite = can('products:write');
  const [tab, setTab] = useState<'datos' | 'movimientos' | 'historial'>('datos');
  const [draft, setDraft] = useState<ProductValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [variantDlg, setVariantDlg] = useState<{ open: boolean; variant: Variant | null }>({ open: false, variant: null });
  const [movement, setMovement] = useState<{ variantId: string; label: string } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const product = useQuery({ queryKey: ['product', id], queryFn: () => api<Product>(`/products/${id}`) });
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api<Branch[]>('/branches') });
  const movements = useQuery({ queryKey: ['movements', { productId: id }], queryFn: () => api<Paged<Movement>>('/inventory/movements', { query: { productId: id, pageSize: 50 } }), enabled: tab === 'movimientos' });
  const history = useQuery({ queryKey: ['product', id, 'history'], queryFn: () => api<History[]>(`/products/${id}/history`), enabled: tab === 'historial' });

  if (product.isLoading) return <Loading />;
  if (product.error || !product.data) return <ErrorBox error={product.error ?? new Error('Producto no encontrado')} />;
  const p = product.data;
  // Sin cambios locales, el formulario muestra los datos del servidor
  const v = draft ?? toValues(p);
  const setV = setDraft;
  const branchName = (bid: string) => branches.data?.find((b) => b.id === bid)?.name ?? '—';
  const multiBranch = (branches.data?.length ?? 0) > 1;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api(`/products/${id}`, { method: 'PATCH', body: { ...toPayload(v), status: v.status } });
      await qc.invalidateQueries({ queryKey: ['product', id] });
      setDraft(null);
      qc.invalidateQueries({ queryKey: ['products'] });
      toast.success('Cambios guardados');
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  async function archive() {
    try {
      await api(`/products/${id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['products'] });
      toast.success('Producto archivado');
      router.replace('/productos');
    } catch (err) {
      toast.error(err);
    }
  }

  async function upload(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      await api(`/products/${id}/images`, { method: 'POST', body: fd });
      qc.invalidateQueries({ queryKey: ['product', id] });
      toast.success('Imagen subida');
    } catch (err) {
      toast.error(err);
    }
  }

  async function removeImage(imageId: string) {
    try {
      await api(`/products/${id}/images/${imageId}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['product', id] });
    } catch (err) {
      toast.error(err);
    }
  }

  return (
    <>
      <PageHeader
        title={p.name}
        description={`SKU ${p.sku} · Stock total ${num(p.stock)}`}
        actions={
          <>
            <Link href="/productos"><Button variant="ghost" icon={<ArrowLeft className="size-4" />}>Volver</Button></Link>
            {can('inventory:write') && p.variants.length === 1 && (
              <Button variant="secondary" icon={<ArrowDownUp className="size-4" />} onClick={() => setMovement({ variantId: p.variants[0]!.id, label: `${p.name} (${p.variants[0]!.sku})` })}>Movimiento</Button>
            )}
            {canWrite && p.status !== 'ARCHIVED' && <Button variant="secondary" icon={<Archive className="size-4" />} onClick={() => setConfirmArchive(true)}>Archivar</Button>}
          </>
        }
      />
      <div className="mb-4 flex gap-1 border-b border-border" role="tablist">
        {(['datos', 'movimientos', 'historial'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 text-sm capitalize ${tab === t ? 'border-primary font-medium text-text' : 'border-transparent text-muted hover:text-text'}`}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'datos' && (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="flex flex-col gap-6">
            <form onSubmit={save}>
              <Card className="p-5">
                <div className="mb-4 flex items-center gap-2">
                  <h2 className="font-medium">Datos del producto</h2>
                  <Badge tone={p.status === 'ACTIVE' ? 'success' : p.status === 'ARCHIVED' ? 'neutral' : 'warning'}>{PRODUCT_STATUS[p.status]}</Badge>
                  {p.lowStock && <Badge tone="danger">Poco stock</Badge>}
                </div>
                <ProductFields v={v} set={(x) => setV({ ...v, ...x })} errors={fieldErrors(error)} disabled={!canWrite} />
                {p.status === 'ARCHIVED' && canWrite && (
                  <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={() => setV({ ...v, status: 'ACTIVE' })}>Restaurar (marcar como activo)</Button>
                )}
                <div className="mt-4"><ErrorBox error={error} /></div>
                {canWrite && <div className="mt-4 flex justify-end"><Button type="submit" loading={saving}>Guardar cambios</Button></div>}
              </Card>
            </form>

            <Card>
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 className="font-medium">Variantes y stock</h2>
                {canWrite && <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setVariantDlg({ open: true, variant: null })}>Variante</Button>}
              </div>
              <Table>
                <thead><tr><Th>Variante</Th><Th>SKU</Th><Th className="text-right">Precio</Th><Th className="text-right">Stock</Th><Th /></tr></thead>
                <tbody>
                  {p.variants.map((x) => (
                    <tr key={x.id}>
                      <Td>
                        <span className="font-medium">{x.name}</span> {!x.isActive && <Badge>Inactiva</Badge>}
                        {Object.keys(x.attributes).length > 0 && <p className="text-xs text-muted">{formatAttributes(x.attributes)}</p>}
                        {multiBranch && x.stockLevels.length > 0 && <p className="text-xs text-muted">{x.stockLevels.map((l) => `${branchName(l.branchId)}: ${l.quantity}`).join(' · ')}</p>}
                      </Td>
                      <Td className="text-muted">{x.sku}{x.barcode ? <span className="block text-xs">{x.barcode}</span> : null}</Td>
                      <Td className="text-right tabular-nums">{money(x.effectivePrice, cur)}</Td>
                      <Td className={`text-right tabular-nums ${x.stock <= 0 ? 'text-danger' : ''}`}>{num(x.stock)}</Td>
                      <Td className="whitespace-nowrap text-right">
                        {can('inventory:write') && <Button size="sm" variant="ghost" aria-label="Registrar movimiento" title="Registrar movimiento" icon={<ArrowDownUp className="size-4" />} onClick={() => setMovement({ variantId: x.id, label: `${p.name} · ${x.name} (${x.sku})` })} />}
                        {canWrite && <Button size="sm" variant="ghost" aria-label="Editar variante" icon={<Pencil className="size-4" />} onClick={() => setVariantDlg({ open: true, variant: x })} />}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          </div>

          <Card className="h-fit p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-medium">Imágenes</h2>
              {canWrite && (
                <>
                  <Button size="sm" variant="secondary" icon={<ImagePlus className="size-4" />} onClick={() => fileRef.current?.click()}>Subir</Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    capture="environment"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) upload(f);
                      e.target.value = '';
                    }}
                  />
                </>
              )}
            </div>
            {p.images.length === 0 ? (
              <p className="text-sm text-muted">Sin imágenes. JPG, PNG o WebP hasta 5 MB. El asistente podrá enviarlas por WhatsApp.</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {p.images.map((img) => (
                  <div key={img.id} className="group relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.url} alt={img.alt ?? p.name} className="aspect-square w-full rounded-lg border border-border object-cover" />
                    {canWrite && (
                      <button onClick={() => removeImage(img.id)} className="absolute right-1 top-1 rounded-md bg-surface/90 p-1 text-danger shadow" aria-label="Eliminar imagen">
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'movimientos' && (
        <Card>
          <ErrorBox error={movements.error} />
          {movements.isLoading ? <Loading /> : !movements.data?.items.length ? (
            <EmptyState title="Sin movimientos" description="Las entradas, ajustes y ventas de este producto aparecerán aquí." />
          ) : (
            <Table>
              <thead><tr><Th>Fecha</Th><Th>Tipo</Th><Th>Variante</Th><Th className="text-right">Cantidad</Th><Th className="text-right">Stock después</Th><Th>Motivo</Th></tr></thead>
              <tbody>
                {movements.data.items.map((m) => (
                  <tr key={m.id}>
                    <Td className="whitespace-nowrap text-muted">{dateTime(m.createdAt)}</Td>
                    <Td>{MOVEMENT_TYPE[m.type] ?? m.type}</Td>
                    <Td>{m.variant.name}{multiBranch ? <span className="block text-xs text-muted">{m.branch.name}</span> : null}</Td>
                    <Td className={`text-right tabular-nums ${m.quantity < 0 ? 'text-danger' : 'text-success'}`}>{m.quantity > 0 ? '+' : ''}{num(m.quantity)}</Td>
                    <Td className="text-right tabular-nums">{num(m.stockAfter)}</Td>
                    <Td className="text-muted">{m.order ? `Pedido #${m.order.number}` : m.reason}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {tab === 'historial' && (
        <Card className="p-4">
          <ErrorBox error={history.error} />
          {history.isLoading ? <Loading /> : !history.data?.length ? <EmptyState title="Sin historial" /> : (
            <ol className="flex flex-col gap-3">
              {history.data.map((h) => (
                <li key={h.id} className="border-l-2 border-border pl-3 text-sm">
                  <p><span className="font-medium">{HISTORY_ACTION[h.action] ?? h.action}</span> <span className="text-muted">· {dateTime(h.createdAt)}</span></p>
                  {h.action === 'updated' && (
                    <ul className="text-muted">
                      {Object.entries(h.changes as Record<string, { from: string | null; to: string | null }>).map(([k, c]) => (
                        <li key={k}>{FIELD_LABEL[k] ?? k}: <s>{c.from ?? '—'}</s> → {c.to ?? '—'}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}

      {variantDlg.open && <VariantDialog productId={id} open variant={variantDlg.variant} onClose={() => setVariantDlg({ open: false, variant: null })} />}
      {movement && <MovementDialog open preset={movement} onClose={() => setMovement(null)} />}
      <Dialog open={confirmArchive} onClose={() => setConfirmArchive(false)} title="¿Archivar este producto?" footer={<><Button variant="secondary" onClick={() => setConfirmArchive(false)}>Cancelar</Button><Button variant="danger" onClick={archive}>Archivar</Button></>}>
        <p className="text-sm text-muted">Dejará de mostrarse en el catálogo y el asistente no lo ofrecerá. Su historial de ventas e inventario se conserva y puedes restaurarlo después.</p>
      </Dialog>
    </>
  );
}

export default function ProductoPage() {
  return (
    <RequirePermission permission="products:read">
      <ProductDetail />
    </RequirePermission>
  );
}
