'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { TenantSettings } from '@/lib/types';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Select } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { DEFAULT_WEEK, WeekGrid } from '@/components/weekly-hours';

interface SettingsResponse {
  settings: TenantSettings;
  template: { key: string; name: string; version: number | null; latestVersion: number } | null;
}

const Check = ({ checked, onChange, disabled, children }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children: React.ReactNode }) => (
  <label className="flex items-start gap-2 text-sm">
    <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
    <span>{children}</span>
  </label>
);

/** Número entero de un input; vacío → null */
const int = (v: string) => (v.trim() === '' ? null : Math.trunc(Number(v)));

/**
 * Reglas de operación (ADR 043): las deja la plantilla del sector y la empresa
 * las ajusta aquí. Los valores comerciales (capacidad, horario, pedido mínimo)
 * nunca se rellenan solos.
 */
export function OperationSettings() {
  const { can, me, reload } = useAuth();
  const edit = can('tenant:settings');
  const modules = me?.tenant?.enabledModules ?? [];
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['tenant-settings'], queryFn: () => api<SettingsResponse>('/tenant/settings') });
  const [draft, setDraft] = useState<TenantSettings | null>(null);
  const [minAmount, setMinAmount] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (q.isLoading) return <Card className="p-5 lg:col-span-2"><Loading /></Card>;
  if (!q.data) return <Card className="p-5 lg:col-span-2"><ErrorBox error={q.error} /></Card>;
  const s = draft ?? q.data.settings;
  const tpl = q.data.template;
  const r = s.reservations;
  const set = <K extends keyof TenantSettings>(k: K, p: Partial<TenantSettings[K]>) => setDraft({ ...s, [k]: { ...s[k], ...p } });
  const min = minAmount ?? (s.orders.minAmount == null ? '' : String(s.orders.minAmount));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const amount = min.trim() === '' ? null : Number(min);
      const body = { ...s, orders: { minAmount: amount } };
      await api('/tenant/settings', { method: 'PATCH', body });
      await reload();
      await qc.invalidateQueries({ queryKey: ['tenant-settings'] });
      await qc.invalidateQueries({ queryKey: ['reservation-availability'] });
      setDraft(null);
      setMinAmount(null);
      toast.success('Reglas de operación guardadas');
    } catch (e) {
      // Los errores de validación llegan con la ruta del campo (p. ej. reservations.capacity)
      if (e instanceof ApiError && e.errors?.length) setError(new Error(`${e.message}: ${e.errors.map((x) => `${x.path} ${x.message}`).join('; ')}`));
      else setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="flex flex-col gap-5 p-5 lg:col-span-2">
      <div id="operacion" className="flex flex-wrap items-center justify-between gap-2 scroll-mt-20">
        <div>
          <h2 className="font-medium">Operación</h2>
          <p className="text-sm text-muted">Cómo trabaja tu negocio: catálogo, pedidos, clientes y reservas. Los cambios aplican también al asistente de WhatsApp.</p>
        </div>
        {tpl ? (
          <Badge tone="info">Plantilla: {tpl.name}{tpl.version != null && tpl.version < tpl.latestVersion ? ` (hay una versión ${tpl.latestVersion})` : ''}</Badge>
        ) : (
          <Badge>Sin plantilla de sector</Badge>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="flex flex-col gap-3" aria-label="Catálogo">
          <h3 className="text-sm font-medium">Catálogo</h3>
          <Field label="Nombre en el menú" hint="Productos, Menú, Servicios…">
            <Input value={s.catalog.label} minLength={2} maxLength={30} disabled={!edit} onChange={(e) => set('catalog', { label: e.target.value })} />
          </Field>
          <Check checked={s.catalog.trackStockDefault} disabled={!edit} onChange={(v) => set('catalog', { trackStockDefault: v })}>Los productos nuevos controlan stock</Check>
          <Check checked={s.catalog.volumePricing} disabled={!edit} onChange={(v) => set('catalog', { volumePricing: v })}>Precios por volumen (mayorista)</Check>
          <Check checked={s.catalog.durations} disabled={!edit} onChange={(v) => set('catalog', { durations: v })}>Los productos tienen duración (servicios)</Check>
        </section>

        <section className="flex flex-col gap-3" aria-label="Pedidos y clientes">
          {modules.includes('orders') && (
            <>
              <h3 className="text-sm font-medium">Pedidos</h3>
              <Field label={`Pedido mínimo (${me?.tenant?.currency ?? ''})`} hint="Vacío: sin mínimo. Lo aplican el panel y el asistente.">
                <Input type="number" min={0} step="0.01" inputMode="decimal" value={min} disabled={!edit} onChange={(e) => setMinAmount(e.target.value)} />
              </Field>
            </>
          )}
          {modules.includes('customers') && (
            <>
              <h3 className="text-sm font-medium">Clientes</h3>
              <Check checked={s.customers.businessFields} disabled={!edit} onChange={(v) => set('customers', { businessFields: v })}>Registrar clientes comerciales (empresa y razón social)</Check>
            </>
          )}
        </section>

        {modules.includes('reservations') && (
          <section className="flex flex-col gap-3 lg:col-span-3" aria-label="Reservas">
            <h3 className="text-sm font-medium">Reservas y citas</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Tipo">
                <Select value={r.kind} disabled={!edit} onChange={(e) => set('reservations', { kind: e.target.value as 'TABLE' | 'APPOINTMENT' })}>
                  <option value="TABLE">Mesas (por personas)</option>
                  <option value="APPOINTMENT">Citas (un servicio por cliente)</option>
                </Select>
              </Field>
              <Field label={r.kind === 'TABLE' ? 'Aforo (personas a la vez)' : 'Citas simultáneas'} hint="Obligatorio para aceptar reservas">
                <Input type="number" min={1} max={5000} value={r.capacity ?? ''} disabled={!edit} onChange={(e) => set('reservations', { capacity: int(e.target.value) })} />
              </Field>
              <Field label="Cada cuántos minutos" hint="Intervalo entre horarios">
                <Input type="number" min={10} max={240} value={r.slotMinutes} disabled={!edit} onChange={(e) => set('reservations', { slotMinutes: int(e.target.value) ?? 0 })} />
              </Field>
              <Field label="Duración (minutos)" hint={r.kind === 'APPOINTMENT' ? 'Si el servicio no tiene su propia duración' : 'Tiempo que ocupa una mesa'}>
                <Input type="number" min={10} max={720} value={r.durationMinutes} disabled={!edit} onChange={(e) => set('reservations', { durationMinutes: int(e.target.value) ?? 0 })} />
              </Field>
              {r.kind === 'TABLE' && (
                <Field label="Máximo de personas por reserva">
                  <Input type="number" min={1} max={500} value={r.maxPartySize} disabled={!edit} onChange={(e) => set('reservations', { maxPartySize: int(e.target.value) ?? 0 })} />
                </Field>
              )}
              <Field label="Antelación mínima (minutos)" hint="Solo para reservas por WhatsApp">
                <Input type="number" min={0} max={10080} value={r.minNoticeMinutes} disabled={!edit} onChange={(e) => set('reservations', { minNoticeMinutes: int(e.target.value) ?? 0 })} />
              </Field>
              <Field label="Hasta cuántos días antes">
                <Input type="number" min={1} max={365} value={r.maxDaysAhead} disabled={!edit} onChange={(e) => set('reservations', { maxDaysAhead: int(e.target.value) ?? 0 })} />
              </Field>
            </div>
            <Check checked={r.requireConfirmation} disabled={!edit} onChange={(v) => set('reservations', { requireConfirmation: v })}>
              Las reservas del asistente quedan «por confirmar» hasta que el equipo las acepta
            </Check>
            <Check checked={!!r.hours} disabled={!edit} onChange={(v) => set('reservations', { hours: v ? DEFAULT_WEEK : null })}>Horario de reservas</Check>
            {r.hours ? (
              <div className={edit ? '' : 'pointer-events-none opacity-70'}>
                <WeekGrid hours={r.hours} label="Reservas" onChange={(h) => set('reservations', { hours: h })} />
              </div>
            ) : (
              <p className="text-sm text-muted">Sin horario no se aceptan reservas.</p>
            )}
          </section>
        )}
      </div>
      <ErrorBox error={error} />
      {edit && (
        <div className="flex justify-end gap-2">
          {(draft || minAmount !== null) && <Button variant="ghost" onClick={() => { setDraft(null); setMinAmount(null); setError(null); }}>Descartar cambios</Button>}
          <Button onClick={save} loading={saving} disabled={!draft && minAmount === null}>Guardar operación</Button>
        </div>
      )}
    </Card>
  );
}
