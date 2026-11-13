'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { fieldErrors, parseAttributes } from '@/lib/form';
import type { Product } from '@/lib/types';
import { Button, Card, ErrorBox, Field, Input, PageHeader } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';
import { ProductFields, emptyProduct, toPayload, type ProductValues } from '@/components/products/product-fields';
import { useTenantSettings } from '@/lib/settings';

interface VariantRow { sku: string; barcode: string; name: string; attributes: string; salePrice: string }
const emptyVariant: VariantRow = { sku: '', barcode: '', name: '', attributes: '', salePrice: '' };

function NewProductForm() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const settings = useTenantSettings();
  const [v, setV] = useState<ProductValues>({ ...emptyProduct, trackStock: settings.catalog.trackStockDefault, barcode: params.get('barcode') ?? '' });
  const [hasVariants, setHasVariants] = useState(false);
  const [variants, setVariants] = useState<VariantRow[]>([{ ...emptyVariant }]);
  const [initialStock, setInitialStock] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        ...toPayload(v, settings, !hasVariants),
        status: v.status === 'ARCHIVED' ? 'ACTIVE' : v.status,
        ...(hasVariants
          ? {
              variants: variants.map((x) => ({
                sku: x.sku.trim(), barcode: x.barcode.trim() || null, name: x.name.trim(),
                attributes: parseAttributes(x.attributes), salePrice: x.salePrice.trim() || null,
              })),
            }
          : initialStock && v.trackStock
            ? { initialStock: Number(initialStock) }
            : {}),
      };
      const p = await api<Product>('/products', { method: 'POST', body });
      qc.invalidateQueries({ queryKey: ['products'] });
      toast.success('Producto creado');
      router.replace(`/productos/${p.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const setVar = (i: number, p: Partial<VariantRow>) => setVariants((vs) => vs.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <PageHeader
        title="Nuevo producto"
        actions={<Link href="/productos"><Button type="button" variant="ghost" icon={<ArrowLeft className="size-4" />}>Volver</Button></Link>}
      />
      <ErrorBox error={error} />
      <Card className="p-5">
        <ProductFields v={v} set={(p) => setV((x) => ({ ...x, ...p }))} errors={errors} allowTiers={!hasVariants} />
      </Card>
      <Card className="p-5">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={hasVariants} onChange={(e) => setHasVariants(e.target.checked)} />
          Este producto tiene variantes (talla, color, presentación…)
        </label>
        {!hasVariants ? (
          v.trackStock && <Field label="Stock inicial (opcional)" hint="Se registra como movimiento de ajuste en la sucursal principal" error={errors.initialStock} className="mt-4 max-w-xs">
            <Input type="number" min="0" step="1" value={initialStock} onChange={(e) => setInitialStock(e.target.value)} />
          </Field>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-sm text-muted">Cada variante tiene su propio SKU y stock. El precio es opcional: si lo dejas vacío usa el del producto. El stock se registra después en Inventario.</p>
            {variants.map((x, i) => (
              <div key={i} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_1fr_1.4fr_0.8fr_auto] sm:items-end">
                <Field label="Nombre" error={errors[`variants.${i}.name`]}><Input value={x.name} onChange={(e) => setVar(i, { name: e.target.value })} placeholder="Rojo / M" required /></Field>
                <Field label="SKU" error={errors[`variants.${i}.sku`]}><Input value={x.sku} onChange={(e) => setVar(i, { sku: e.target.value })} required /></Field>
                <Field label="Cód. barras" error={errors[`variants.${i}.barcode`]}><Input value={x.barcode} onChange={(e) => setVar(i, { barcode: e.target.value })} /></Field>
                <Field label="Atributos"><Input value={x.attributes} onChange={(e) => setVar(i, { attributes: e.target.value })} placeholder="Color: Rojo, Talla: M" /></Field>
                <Field label="Precio" error={errors[`variants.${i}.salePrice`]}><Input type="number" min="0" step="0.01" value={x.salePrice} onChange={(e) => setVar(i, { salePrice: e.target.value })} /></Field>
                <Button type="button" variant="ghost" aria-label="Quitar variante" disabled={variants.length === 1} onClick={() => setVariants((vs) => vs.filter((_, j) => j !== i))} icon={<Trash2 className="size-4" />} />
              </div>
            ))}
            <Button type="button" variant="secondary" size="sm" className="self-start" icon={<Plus className="size-4" />} onClick={() => setVariants((vs) => [...vs, { ...emptyVariant }])}>Añadir variante</Button>
          </div>
        )}
      </Card>
      <div className="flex justify-end gap-2">
        <Link href="/productos"><Button type="button" variant="secondary">Cancelar</Button></Link>
        <Button type="submit" loading={busy}>Crear producto</Button>
      </div>
    </form>
  );
}

export default function NuevoProductoPage() {
  return (
    <RequirePermission permission="products:write">
      <Suspense>
        <NewProductForm />
      </Suspense>
    </RequirePermission>
  );
}
