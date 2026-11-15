'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Button, Dialog, EmptyState, ErrorBox, Field, Input, Loading, Select, Table, Td, Textarea, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { MODULE_LABEL, money } from '@/lib/format';
import { BILLING, KIND, type Item } from './shared';

const PLAN: Record<string, string> = { BASIC: 'Básico', PROFESSIONAL: 'Profesional', ENTERPRISE: 'Empresarial' };
type Form = { code: string; name: string; description: string; kind: string; billing: 'ONE_TIME' | 'MONTHLY'; unitPrice: string; currency: string; unit: string; planCode: string; module: string; isActive: boolean; sort: string };
const empty: Form = { code: '', name: '', description: '', kind: 'PLAN', billing: 'MONTHLY', unitPrice: '', currency: 'PEN', unit: '', planCode: '', module: '', isActive: true, sort: '0' };
const formOf = (i: Item): Form => ({ code: i.code, name: i.name, description: i.description ?? '', kind: i.kind, billing: i.billing, unitPrice: i.unitPrice, currency: i.currency, unit: i.unit ?? '', planCode: i.planCode ?? '', module: i.module ?? '', isActive: i.isActive, sort: String(i.sort) });

/** Catálogo comercial: los conceptos y precios con los que se arman las cotizaciones (los fija la plataforma) */
export function CatalogTab() {
  const q = useQuery({ queryKey: ['commerce-items'], queryFn: () => api<Item[]>('/platform/commerce/items') });
  const [edit, setEdit] = useState<{ id: string | null; f: Form } | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">Planes, usuarios adicionales, módulos, instalación, servidor, integraciones, soporte y mantenimiento. Cambiar un precio no altera las cotizaciones ya armadas: cada una guarda su precio.</p>
        <Button icon={<Plus className="size-4" />} onClick={() => setEdit({ id: null, f: empty })}>Nuevo concepto</Button>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? (
        <EmptyState title="Catálogo vacío" description="Agrega los conceptos que vendes con sus precios reales. Sin catálogo también puedes escribir conceptos libres en cada cotización." />
      ) : (
        <Table>
          <thead><tr><Th>Código</Th><Th>Concepto</Th><Th>Tipo</Th><Th>Cobro</Th><Th className="text-right">Precio</Th><Th>Estado</Th><Th /></tr></thead>
          <tbody>
            {q.data!.map((i) => (
              <tr key={i.id} className="border-t border-border">
                <Td className="font-mono text-xs">{i.code}</Td>
                <Td><span className="font-medium">{i.name}</span>{i.description && <span className="block text-xs text-muted">{i.description}</span>}</Td>
                <Td>{KIND[i.kind] ?? i.kind}{i.planCode ? ` · ${PLAN[i.planCode]}` : ''}{i.module ? ` · ${MODULE_LABEL[i.module] ?? i.module}` : ''}</Td>
                <Td>{BILLING[i.billing]}</Td>
                <Td className="text-right tabular-nums">{money(i.unitPrice, i.currency)}{i.unit ? <span className="text-xs text-muted"> / {i.unit}</span> : null}</Td>
                <Td><Badge tone={i.isActive ? 'success' : 'neutral'}>{i.isActive ? 'Activo' : 'Desactivado'}</Badge></Td>
                <Td><Button size="sm" variant="secondary" onClick={() => setEdit({ id: i.id, f: formOf(i) })} aria-label={`Editar ${i.name}`}>Editar</Button></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {edit && <ItemDialog id={edit.id} initial={edit.f} onClose={() => setEdit(null)} />}
    </div>
  );
}

function ItemDialog({ id, initial, onClose }: { id: string | null; initial: Form; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { ...f, unitPrice: f.unitPrice.trim(), planCode: f.planCode || null, module: f.module || null, sort: Number(f.sort) || 0 };
      await api(id ? `/platform/commerce/items/${id}` : '/platform/commerce/items', { method: id ? 'PUT' : 'POST', body });
      toast.success(id ? 'Concepto guardado' : 'Concepto agregado al catálogo');
      void qc.invalidateQueries({ queryKey: ['commerce-items'] });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.errors?.length) setErrors(Object.fromEntries(err.errors.map((x) => [x.path, x.message])));
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title={id ? 'Editar concepto' : 'Nuevo concepto'} wide footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="item-form" loading={busy}>Guardar</Button></>}>
      <form id="item-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><ErrorBox error={error} /></div>
        <Field label="Código" error={errors.code} hint="Ej.: PLAN-PRO, USUARIO-EXTRA"><Input value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase())} maxLength={40} required /></Field>
        <Field label="Nombre" error={errors.name}><Input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={160} required /></Field>
        <Field label="Descripción (opcional)" className="sm:col-span-2"><Textarea value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={1000} rows={2} /></Field>
        <Field label="Tipo">
          <Select value={f.kind} onChange={(e) => set('kind', e.target.value)}>
            {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Cobro">
          <Select value={f.billing} onChange={(e) => set('billing', e.target.value as Form['billing'])}>
            {Object.entries(BILLING).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-[1fr_6rem] gap-2">
          <Field label="Precio unitario" error={errors.unitPrice}><Input inputMode="decimal" value={f.unitPrice} onChange={(e) => set('unitPrice', e.target.value)} required placeholder="0.00" /></Field>
          <Field label="Moneda" error={errors.currency}><Input value={f.currency} maxLength={3} onChange={(e) => set('currency', e.target.value.toUpperCase())} required /></Field>
        </div>
        <Field label="Unidad (opcional)" hint="Ej.: usuario, hora, mes"><Input value={f.unit} onChange={(e) => set('unit', e.target.value)} maxLength={40} /></Field>
        {f.kind === 'PLAN' && (
          <Field label="Plan del sistema">
            <Select value={f.planCode} onChange={(e) => set('planCode', e.target.value)}>
              <option value="">—</option>
              {Object.entries(PLAN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
        )}
        {f.kind === 'MODULE' && (
          <Field label="Módulo del sistema">
            <Select value={f.module} onChange={(e) => set('module', e.target.value)}>
              <option value="">—</option>
              {Object.entries(MODULE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Orden en la lista"><Input type="number" min={0} max={10000} value={f.sort} onChange={(e) => set('sort', e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} />Activo (disponible para nuevas cotizaciones)</label>
      </form>
    </Dialog>
  );
}
