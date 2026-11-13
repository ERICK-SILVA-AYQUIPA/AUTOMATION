'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, ScanBarcode, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useTenantSettings } from '@/lib/settings';
import type { Category, PriceTier, TenantSettings } from '@/lib/types';
import { Button, Field, Input, Select, Textarea } from '@/components/ui';
import { BarcodeScanner } from '@/components/barcode-scanner';

export interface ProductValues {
  sku: string; barcode: string; name: string; description: string; categoryId: string;
  salePrice: string; costPrice: string; minStock: string; status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  trackStock: boolean; durationMinutes: string; priceTiers: TierRow[];
}
export interface TierRow { minQty: string; unitPrice: string }

export const emptyProduct: ProductValues = { sku: '', barcode: '', name: '', description: '', categoryId: '', salePrice: '', costPrice: '', minStock: '0', status: 'ACTIVE', trackStock: true, durationMinutes: '', priceTiers: [] };
export const tierRows = (t: PriceTier[] | undefined): TierRow[] => (t ?? []).map((x) => ({ minQty: String(x.minQty), unitPrice: String(x.unitPrice) }));
export const tierPayload = (rows: TierRow[]) => rows.filter((r) => r.minQty.trim() && r.unitPrice.trim()).map((r) => ({ minQty: Number(r.minQty), unitPrice: r.unitPrice.trim() }));

/** Precios por volumen: desde N unidades, cada unidad cuesta X */
export function TierEditor({ rows, set, error, disabled }: { rows: TierRow[]; set: (r: TierRow[]) => void; error?: string; disabled?: boolean }) {
  const upd = (i: number, p: Partial<TierRow>) => set(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">Precios por volumen</legend>
      <p className="text-xs text-muted">Desde la cantidad indicada, cada unidad cuesta el precio del tramo. Ordena de menor a mayor cantidad.</p>
      {rows.map((r, i) => (
        <div key={i} className="flex items-end gap-2">
          <Field label={`Desde (unidades) ${i + 1}`}><Input type="number" min="2" step="1" value={r.minQty} onChange={(e) => upd(i, { minQty: e.target.value })} disabled={disabled} /></Field>
          <Field label={`Precio unitario ${i + 1}`}><Input type="number" min="0" step="0.01" value={r.unitPrice} onChange={(e) => upd(i, { unitPrice: e.target.value })} disabled={disabled} /></Field>
          <Button type="button" variant="ghost" aria-label={`Quitar tramo ${i + 1}`} icon={<Trash2 className="size-4" />} onClick={() => set(rows.filter((_, j) => j !== i))} disabled={disabled} />
        </div>
      ))}
      {error && <p className="text-sm text-danger">{error}</p>}
      {rows.length < 6 && <Button type="button" size="sm" variant="secondary" className="self-start" icon={<Plus className="size-4" />} onClick={() => set([...rows, { minQty: '', unitPrice: '' }])} disabled={disabled}>Añadir tramo</Button>}
    </fieldset>
  );
}

/** Campos comunes a "nuevo producto" y "editar producto". `allowTiers`: solo productos sin variantes. */
export function ProductFields({ v, set, errors, disabled, allowTiers = true }: { v: ProductValues; set: (p: Partial<ProductValues>) => void; errors: Record<string, string>; disabled?: boolean; allowTiers?: boolean }) {
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<Category[]>('/categories') });
  const settings = useTenantSettings();
  const [scan, setScan] = useState(false);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Nombre" error={errors.name} className="sm:col-span-2">
        <Input value={v.name} onChange={(e) => set({ name: e.target.value })} required maxLength={160} disabled={disabled} invalid={!!errors.name} />
      </Field>
      <Field label="SKU (código interno)" error={errors.sku} hint="Letras, números y . _ - /">
        <Input value={v.sku} onChange={(e) => set({ sku: e.target.value })} required maxLength={64} disabled={disabled} invalid={!!errors.sku} />
      </Field>
      <Field label="Código de barras (opcional)" error={errors.barcode}>
        <div className="flex gap-2">
          <Input value={v.barcode} onChange={(e) => set({ barcode: e.target.value })} maxLength={64} disabled={disabled} invalid={!!errors.barcode} />
          <Button type="button" variant="secondary" onClick={() => setScan(true)} disabled={disabled} aria-label="Escanear código" icon={<ScanBarcode className="size-4" />} />
        </div>
      </Field>
      <Field label="Precio de venta" error={errors.salePrice}>
        <Input type="number" min="0" step="0.01" inputMode="decimal" value={v.salePrice} onChange={(e) => set({ salePrice: e.target.value })} required disabled={disabled} invalid={!!errors.salePrice} />
      </Field>
      <Field label="Costo (opcional)" error={errors.costPrice} hint="No se muestra a los clientes">
        <Input type="number" min="0" step="0.01" inputMode="decimal" value={v.costPrice} onChange={(e) => set({ costPrice: e.target.value })} disabled={disabled} invalid={!!errors.costPrice} />
      </Field>
      <Field label="Categoría" error={errors.categoryId}>
        <Select value={v.categoryId} onChange={(e) => set({ categoryId: e.target.value })} disabled={disabled}>
          <option value="">Sin categoría</option>
          {cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      <label className="flex items-start gap-2 text-sm sm:col-span-2">
        <input type="checkbox" className="mt-0.5 size-4" checked={v.trackStock} onChange={(e) => set({ trackStock: e.target.checked, ...(e.target.checked ? {} : { minStock: '0' }) })} disabled={disabled} />
        <span>Controla stock<span className="block text-xs text-muted">Desmárcalo para platos preparados y servicios: se venden mientras estén activos y no llevan inventario.</span></span>
      </label>
      {v.trackStock && (
        <Field label="Stock mínimo (alerta)" error={errors.minStock} hint="0 = sin alerta">
          <Input type="number" min="0" step="1" value={v.minStock} onChange={(e) => set({ minStock: e.target.value })} disabled={disabled} invalid={!!errors.minStock} />
        </Field>
      )}
      {(settings.catalog.durations || v.durationMinutes) && (
        <Field label="Duración (minutos)" error={errors.durationMinutes} hint="Para servicios que se reservan como cita">
          <Input type="number" min="5" max="1440" step="5" value={v.durationMinutes} onChange={(e) => set({ durationMinutes: e.target.value })} disabled={disabled} invalid={!!errors.durationMinutes} />
        </Field>
      )}
      <Field label="Estado" error={errors.status}>
        <Select value={v.status} onChange={(e) => set({ status: e.target.value as ProductValues['status'] })} disabled={disabled || v.status === 'ARCHIVED'}>
          <option value="ACTIVE">Activo (visible para el asistente)</option>
          <option value="INACTIVE">Inactivo (oculto)</option>
          {v.status === 'ARCHIVED' && <option value="ARCHIVED">Archivado</option>}
        </Select>
      </Field>
      <Field label="Descripción" error={errors.description} className="sm:col-span-2" hint="El asistente usa esta descripción para responder preguntas del producto">
        <Textarea value={v.description} onChange={(e) => set({ description: e.target.value })} maxLength={5000} disabled={disabled} />
      </Field>
      {settings.catalog.volumePricing && allowTiers && (
        <div className="sm:col-span-2"><TierEditor rows={v.priceTiers} set={(priceTiers) => set({ priceTiers })} error={errors.priceTiers} disabled={disabled} /></div>
      )}
      {scan && (
        <BarcodeScanner
          open
          onClose={() => setScan(false)}
          onDetected={(code) => {
            set({ barcode: code });
            setScan(false);
          }}
        />
      )}
    </div>
  );
}

/** Valores del formulario → cuerpo para la API */
export const toPayload = (v: ProductValues, s: TenantSettings, allowTiers = true) => ({
  trackStock: v.trackStock,
  ...(s.catalog.durations || v.durationMinutes ? { durationMinutes: v.durationMinutes.trim() ? Number(v.durationMinutes) : null } : {}),
  ...(s.catalog.volumePricing && allowTiers ? { priceTiers: tierPayload(v.priceTiers) } : {}),
  sku: v.sku.trim(),
  barcode: v.barcode.trim() || null,
  name: v.name.trim(),
  description: v.description.trim() || null,
  categoryId: v.categoryId || null,
  salePrice: v.salePrice,
  costPrice: v.costPrice.trim() || null,
  minStock: Number(v.minStock || 0),
});
