'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ScanBarcode } from 'lucide-react';
import { api } from '@/lib/api';
import type { Category } from '@/lib/types';
import { Button, Field, Input, Select, Textarea } from '@/components/ui';
import { BarcodeScanner } from '@/components/barcode-scanner';

export interface ProductValues {
  sku: string; barcode: string; name: string; description: string; categoryId: string;
  salePrice: string; costPrice: string; minStock: string; status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
}

export const emptyProduct: ProductValues = { sku: '', barcode: '', name: '', description: '', categoryId: '', salePrice: '', costPrice: '', minStock: '0', status: 'ACTIVE' };

/** Campos comunes a "nuevo producto" y "editar producto". */
export function ProductFields({ v, set, errors, disabled }: { v: ProductValues; set: (p: Partial<ProductValues>) => void; errors: Record<string, string>; disabled?: boolean }) {
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<Category[]>('/categories') });
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
      <Field label="Stock mínimo (alerta)" error={errors.minStock} hint="0 = sin alerta">
        <Input type="number" min="0" step="1" value={v.minStock} onChange={(e) => set({ minStock: e.target.value })} disabled={disabled} invalid={!!errors.minStock} />
      </Field>
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
export const toPayload = (v: ProductValues) => ({
  sku: v.sku.trim(),
  barcode: v.barcode.trim() || null,
  name: v.name.trim(),
  description: v.description.trim() || null,
  categoryId: v.categoryId || null,
  salePrice: v.salePrice,
  costPrice: v.costPrice.trim() || null,
  minStock: Number(v.minStock || 0),
});
