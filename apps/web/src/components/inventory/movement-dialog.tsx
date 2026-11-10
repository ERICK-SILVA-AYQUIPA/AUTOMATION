'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useCurrency } from '@/lib/auth';
import { fieldErrors } from '@/lib/form';
import { num } from '@/lib/format';
import type { Branch } from '@/lib/types';
import { Button, Dialog, ErrorBox, Field, Input, Select } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { VariantPicker } from './variant-picker';

const TYPES = [
  { value: 'PURCHASE_IN', label: 'Entrada por compra', hint: 'Mercadería recibida de un proveedor' },
  { value: 'RETURN_IN', label: 'Devolución de cliente', hint: 'Unidades que regresan al stock' },
  { value: 'ADJUSTMENT', label: 'Ajuste (+/-)', hint: 'Corrección tras un conteo, merma o pérdida. Usa negativo para restar.' },
] as const;

/**
 * Registra un movimiento manual. Las salidas por venta las genera el pedido,
 * nunca este formulario. La clave de idempotencia evita duplicados por doble clic.
 * Móntalo solo mientras está abierto para empezar con el formulario vacío.
 */
export function MovementDialog({ open, onClose, preset }: { open: boolean; onClose: () => void; preset?: { variantId: string; label: string } }) {
  const cur = useCurrency();
  const toast = useToast();
  const qc = useQueryClient();
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api<Branch[]>('/branches'), enabled: open });
  const [target, setTarget] = useState<{ variantId: string; label: string; stock?: number } | null>(preset ?? null);
  const [type, setType] = useState<(typeof TYPES)[number]['value']>('PURCHASE_IN');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [branchId, setBranchId] = useState('');
  const [allowNegative, setAllowNegative] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);


  const insufficient = error instanceof ApiError && error.code === 'INSUFFICIENT_STOCK';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ stockAfter: number }>('/inventory/movements', {
        method: 'POST',
        body: { variantId: target.variantId, branchId: branchId || undefined, type, quantity: Number(quantity), reason, allowNegative: type === 'ADJUSTMENT' && allowNegative, idempotencyKey: key },
      });
      toast.success(`Movimiento registrado. Stock actual: ${num(r.stockAfter)}`);
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['product'] });
      qc.invalidateQueries({ queryKey: ['movements'] });
      qc.invalidateQueries({ queryKey: ['stock-alerts'] });
      onClose();
    } catch (err) {
      setError(err);
      // Un intento fallido no consumió la clave, pero si el usuario cambia datos generamos otra
      setKey(crypto.randomUUID());
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Registrar movimiento de inventario"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" form="movement-form" loading={busy} disabled={!target}>Registrar</Button>
        </>
      }
    >
      <form id="movement-form" onSubmit={submit} className="flex flex-col gap-4">
        {target ? (
          <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-sm">
            <span className="font-medium">{target.label}</span>
            {!preset && <button type="button" className="text-xs text-muted underline" onClick={() => setTarget(null)}>Cambiar</button>}
          </div>
        ) : (
          <Field label="Producto"><VariantPicker currency={cur} autoFocus onPick={(p) => setTarget({ variantId: p.variant.id, label: `${p.label} (${p.variant.sku}) · stock ${p.variant.stock}` })} /></Field>
        )}
        <Field label="Tipo" hint={TYPES.find((t) => t.value === type)?.hint}>
          <Select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Cantidad" error={errors.quantity}>
            <Input type="number" step="1" min={type === 'ADJUSTMENT' ? undefined : 1} value={quantity} onChange={(e) => setQuantity(e.target.value)} required invalid={!!errors.quantity} />
          </Field>
          {(branches.data?.length ?? 0) > 1 && (
            <Field label="Sucursal">
              <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">Principal</option>
                {branches.data!.filter((b) => !b.isDefault && b.isActive).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </Field>
          )}
        </div>
        <Field label="Motivo" error={errors.reason} hint="Queda en el historial; no se puede editar después">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={300} placeholder="Factura 001-234, conteo mensual…" invalid={!!errors.reason} />
        </Field>
        {type === 'ADJUSTMENT' && (insufficient || allowNegative) && (
          <label className="flex items-start gap-2 rounded-lg border border-warning/40 bg-amber-500/5 p-3 text-sm">
            <input type="checkbox" className="mt-0.5 size-4" checked={allowNegative} onChange={(e) => setAllowNegative(e.target.checked)} />
            <span>Autorizo dejar el stock en negativo. Queda registrado en la auditoría con mi usuario.</span>
          </label>
        )}
        <ErrorBox error={error} />
      </form>
    </Dialog>
  );
}
