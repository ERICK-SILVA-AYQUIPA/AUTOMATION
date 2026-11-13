'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { money, num } from '@/lib/format';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Select } from '@/components/ui';
import { useToast } from '@/components/ui/toast';

interface Limits { maxUsers: number; maxWhatsappNumbers: number; maxConversationsPerMonth: number; maxProducts: number; maxBranches: number; features: string[] }
interface Plan { id: string; code: string; name: string; priceMonthly: string; currency: string; limits: Limits; isActive: boolean; _count: { subscriptions: number } }

const LIMIT_LABEL: [keyof Omit<Limits, 'features'>, string][] = [
  ['maxUsers', 'Usuarios'], ['maxWhatsappNumbers', 'Números de WhatsApp'], ['maxConversationsPerMonth', 'Conversaciones al mes'],
  ['maxProducts', 'Productos'], ['maxBranches', 'Sucursales'],
];
const FEATURE_LABEL: Record<string, string> = {
  human_handoff: 'Transferencia a humano', reports: 'Reportes', advanced_automations: 'Automatizaciones avanzadas',
  advanced_ai: 'IA avanzada', multi_branch: 'Varias sucursales', advanced_roles: 'Roles avanzados',
};

function PlanCard({ plan }: { plan: Plan }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    name: plan.name, price: plan.priceMonthly, currency: plan.currency, isActive: plan.isActive,
    limits: Object.fromEntries(LIMIT_LABEL.map(([k]) => [k, String(plan.limits[k])])) as Record<string, string>,
    features: plan.limits.features,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/platform/plans/${plan.code}`, {
        method: 'PATCH',
        body: {
          name: f.name, priceMonthly: Number(f.price), currency: f.currency, isActive: f.isActive,
          limits: { ...Object.fromEntries(LIMIT_LABEL.map(([k]) => [k, Number(f.limits[k])])), features: f.features },
        },
      });
      toast.success(`Plan ${f.name} guardado`);
      qc.invalidateQueries({ queryKey: ['platform-plans-all'] });
      qc.invalidateQueries({ queryKey: ['platform-plans'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      <Card className="flex flex-col gap-3 p-4 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-muted">{plan.code}</span>
          <span className="flex items-center gap-2">
            <Badge tone="neutral">{num(plan._count.subscriptions)} empresas</Badge>
            <span className="font-medium tabular-nums">{money(plan.priceMonthly, plan.currency)}/mes</span>
          </span>
        </div>
        <Field label="Nombre"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={60} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Precio mensual"><Input type="number" min={0} step="0.01" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} required /></Field>
          <Field label="Moneda">
            <Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
              {[...new Set(['PEN', 'USD', f.currency])].map((c) => <option key={c}>{c}</option>)}
            </Select>
          </Field>
          {LIMIT_LABEL.map(([k, l]) => (
            <Field key={k} label={l}><Input type="number" min={1} step={1} value={f.limits[k]} onChange={(e) => setF({ ...f, limits: { ...f.limits, [k]: e.target.value } })} required /></Field>
          ))}
        </div>
        <fieldset className="grid gap-1">
          <legend className="mb-1 font-medium">Funciones incluidas</legend>
          {Object.entries(FEATURE_LABEL).map(([k, l]) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={f.features.includes(k)} onChange={(e) => setF({ ...f, features: e.target.checked ? [...f.features, k] : f.features.filter((x) => x !== k) })} />{l}
            </label>
          ))}
        </fieldset>
        <label className="flex items-center gap-2"><input type="checkbox" className="size-4 accent-[var(--primary)]" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />Disponible para nuevas altas</label>
        <ErrorBox error={error} />
        <Button type="submit" className="self-end" loading={busy}>Guardar plan</Button>
      </Card>
    </form>
  );
}

/** Precios y límites de los planes: los fija el dueño de la plataforma desde aquí, nunca el código. */
export function PlansEditor() {
  const q = useQuery({ queryKey: ['platform-plans-all'], queryFn: () => api<Plan[]>('/platform/plans/all') });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorBox error={q.error} />;
  return (
    <>
      <p className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
        Los precios iniciales (29, 79 y 199 USD) son de ejemplo. Escribe aquí tus precios reales; cada cambio queda en la auditoría. Las empresas que ya pagaron conservan su periodo.
      </p>
      <div className="grid gap-4 lg:grid-cols-3">
        {q.data.map((p) => <PlanCard key={`${p.id}-${p.priceMonthly}-${p.currency}`} plan={p} />)}
      </div>
    </>
  );
}
