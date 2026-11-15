'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { RequirePermission } from '@/components/guard';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Select, Table, Td, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { DEPLOYMENT_MODE, dateTime } from '@/lib/format';
import { CATEGORY, fmt, fmtAll, thisPeriod, type Category, type Margin, type Money } from '../shared';

interface Budget { scope: 'AI' | 'TOTAL'; amount: number; currency: string; thresholdPct: number; spent: number | null; level: 'WARN' | 'EXCEEDED' | null; missingRates: string[] }
interface Report {
  period: string; partial: boolean; base: string;
  tenant: { id: string; name: string; status: string; deploymentMode: string };
  lead: { id: string; name: string } | null;
  price: { monthly: Money | null; oneTime: Money | null; quoteId: string | null; plan: { name: string; listPrice: Money } | null; access: string | null };
  mrr: (Money & { source: string }) | null; mrrNote: string; collected: Money[];
  costs: { category: Category; label: string; measured: Money[]; manual: Money[]; known: boolean; note: string }[];
  margin: Margin;
  pending: { kind: string; id: string; label: string; amount: number; currency: string; status: string; since: string }[];
  budgets: Budget[];
  items: { id: string; category: Category; description: string; amount: string; currency: string; cycle: 'MONTHLY' | 'ONE_TIME'; startsOn: string; endsOn: string | null; inPeriod: boolean }[];
  servers: { id: string; name: string; status: string; serverType: string; deleted: boolean; priceMonthly: number | null; currency: string | null; cost: Money | null }[];
  alerts: { scope: string; period: string; level: string; spent: string; budget: string; currency: string; recipients: number; createdAt: string }[];
}

/** Fecha de hoy en Lima (UTC-5): las partidas se registran por día local */
const today = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

function AddCost({ tenantId, base, onDone }: { tenantId: string; base: string; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ category: 'WHATSAPP' as Category, description: '', amount: '', currency: base, cycle: 'MONTHLY', startsOn: today() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/platform/finance/tenants/${tenantId}/costs`, { method: 'POST', body: { ...f, currency: f.currency.toUpperCase() } });
      toast.success('Costo registrado');
      setF({ ...f, description: '', amount: '' });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Registrar costo">
      <ErrorBox error={error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Concepto de costo"><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as Category })}>{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label="Descripción" className="sm:col-span-2"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} minLength={2} maxLength={200} placeholder="Tarifa de Meta, parte del servidor compartido, horas de soporte…" required /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Importe" hint="0 si no le cuesta nada a la plataforma"><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required /></Field>
        <Field label="Moneda"><Input value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value })} required /></Field>
        <Field label="Frecuencia"><Select value={f.cycle} onChange={(e) => setF({ ...f, cycle: e.target.value })}><option value="MONTHLY">Mensual</option><option value="ONE_TIME">Una vez</option></Select></Field>
        <Field label="Desde"><Input type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} required /></Field>
      </div>
      <div><Button type="submit" loading={busy}>Registrar costo</Button></div>
    </form>
  );
}

function BudgetForm({ tenantId, scope, current, base, onDone }: { tenantId: string; scope: 'AI' | 'TOTAL'; current?: Budget; base: string; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ amount: current ? String(current.amount) : '', currency: current?.currency ?? base, thresholdPct: current?.thresholdPct ?? 80 });
  const [busy, setBusy] = useState<string | null>(null);
  const label = scope === 'AI' ? 'IA' : 'costos totales';
  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void run('save', () => api(`/platform/finance/tenants/${tenantId}/budgets/${scope}`, { method: 'PUT', body: { ...f, currency: f.currency.toUpperCase() } }), `Presupuesto de ${label} guardado`); }} className="flex flex-col gap-3" aria-label={`Presupuesto de ${label}`}>
      <p className="font-medium">Presupuesto mensual de {label}</p>
      {current && (
        <p className="text-sm">
          {current.spent != null ? `Consumido: ${fmt({ amount: current.spent, currency: current.currency })} de ${fmt({ amount: current.amount, currency: current.currency })}` : `No se puede comparar: falta el tipo de cambio ${current.missingRates.join(', ')}`}
          {current.level && <span className="ml-2"><Badge tone="danger">{current.level === 'EXCEEDED' ? 'Superado' : `Llegó al ${current.thresholdPct}%`}</Badge></span>}
        </p>
      )}
      <div className="grid grid-cols-3 gap-2">
        <Field label={`Monto (${label})`}><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required /></Field>
        <Field label={`Moneda (${label})`}><Input value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value })} required /></Field>
        <Field label={`Avisar al % (${label})`}><Input type="number" min={1} max={100} value={f.thresholdPct} onChange={(e) => setF({ ...f, thresholdPct: Number(e.target.value) })} required /></Field>
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="secondary" loading={busy === 'save'}>Guardar presupuesto</Button>
        {current && <Button type="button" variant="ghost" loading={busy === 'del'} onClick={() => run('del', () => api(`/platform/finance/tenants/${tenantId}/budgets/${scope}`, { method: 'DELETE' }), 'Presupuesto quitado')}>Quitar</Button>}
      </div>
    </form>
  );
}

function Detail() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const [period, setPeriod] = useState(() => (/^\d{4}-\d{2}$/.test(params.get('mes') ?? '') ? params.get('mes')! : thisPeriod()));
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['finance-tenant', id, period], queryFn: () => api<Report>(`/platform/finance/tenants/${id}`, { query: { period } }) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['finance-tenant', id] });
    void qc.invalidateQueries({ queryKey: ['finance'] });
  };
  async function end(itemId: string) {
    try {
      await api(`/platform/finance/tenants/${id}/costs/${itemId}`, { method: 'PATCH', body: { endsOn: today() } });
      toast.success('Partida terminada hoy');
      refresh();
    } catch (err) {
      toast.error(err);
    }
  }
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const r = q.data!;
  return (
    <div className="flex flex-col gap-6">
      <Link href="/plataforma/rentabilidad" className="flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft className="size-4" /> Rentabilidad</Link>
      <PageHeader
        title={r.tenant.name}
        description={`${DEPLOYMENT_MODE[r.tenant.deploymentMode] ?? r.tenant.deploymentMode}${r.partial ? ' · mes en curso: costos medidos hasta hoy' : ''}`}
        actions={<Field label="Mes"><Input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} /></Field>}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="flex flex-col gap-1 p-4 text-sm">
          <p className="text-muted">Precio de venta</p>
          <p className="text-lg font-semibold">{r.price.monthly ? `${fmt(r.price.monthly)} al mes` : 'Sin cotización aceptada'}</p>
          {r.price.oneTime && r.price.oneTime.amount > 0 && <p>{fmt(r.price.oneTime)} pago único</p>}
          {r.price.plan && <p className="text-muted">Plan {r.price.plan.name}: lista {fmt(r.price.plan.listPrice)} al mes</p>}
          {r.lead && <Link href={`/plataforma/ventas/${r.lead.id}`} className="text-primary hover:underline">Ver el prospecto</Link>}
        </Card>
        <Card className="flex flex-col gap-1 p-4 text-sm">
          <p className="text-muted">Ingreso recurrente</p>
          <p className="text-lg font-semibold">{r.mrr ? `${fmt(r.mrr)} al mes` : '—'}</p>
          <p className="text-muted">{r.mrrNote}</p>
          <p>Cobrado en el mes: {fmtAll(r.collected)}</p>
        </Card>
        <Card className="flex flex-col gap-1 p-4 text-sm" >
          <p className="text-muted">Margen estimado del mes</p>
          {r.margin.value != null ? (
            <>
              <p className={r.margin.value < 0 ? 'text-lg font-semibold text-red-600' : 'text-lg font-semibold'}>{fmt({ amount: r.margin.value, currency: r.margin.currency })}{r.margin.pct != null ? ` (${r.margin.pct}%)` : ''}</p>
              <p className="text-muted">Ingreso {fmt({ amount: r.margin.revenue!, currency: r.margin.currency })} − costos {fmt({ amount: r.margin.costs!, currency: r.margin.currency })}</p>
            </>
          ) : (
            <>
              <p className="text-lg font-semibold">No se calcula</p>
              <ul className="list-disc pl-5 text-muted" aria-label="Datos que faltan">{r.margin.missing.map((m) => <li key={m}>{m}</li>)}</ul>
            </>
          )}
        </Card>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Costos del mes</h2>
        <Table>
          <thead><tr><Th>Concepto</Th><Th>Medido</Th><Th>Registrado</Th><Th>Estado</Th></tr></thead>
          <tbody>
            {r.costs.map((c) => (
              <tr key={c.category}>
                <Td className="font-medium">{c.label}</Td>
                <Td>{fmtAll(c.measured)}</Td>
                <Td>{fmtAll(c.manual)}</Td>
                <Td>{c.known ? <Badge tone="success">Conocido</Badge> : <Badge tone="warning">Falta dato</Badge>}<div className="text-xs text-muted">{c.note}</div></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4"><AddCost tenantId={r.tenant.id} base={r.base} onDone={refresh} /></Card>
        <Card className="flex flex-col gap-3 p-4 text-sm">
          <p className="font-medium">Partidas registradas</p>
          {!r.items.length ? <p className="text-muted">Ninguna todavía.</p> : (
            <ul className="flex flex-col gap-2">
              {r.items.map((i) => (
                <li key={i.id} className="flex items-start justify-between gap-2">
                  <span>
                    <span className="font-medium">{CATEGORY[i.category]}</span>: {i.description} · {fmt({ amount: Number(i.amount), currency: i.currency })} {i.cycle === 'MONTHLY' ? 'al mes' : 'una vez'}
                    <span className="block text-xs text-muted">Desde {i.startsOn}{i.endsOn ? ` hasta ${i.endsOn}` : ''}{i.inPeriod ? '' : ' · no cuenta en este mes'}</span>
                  </span>
                  {!i.endsOn && i.cycle === 'MONTHLY' && <Button size="sm" variant="ghost" onClick={() => end(i.id)} aria-label={`Terminar ${i.description}`}>Terminar</Button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {(['AI', 'TOTAL'] as const).map((s) => (
          <Card key={s} className="p-4"><BudgetForm key={JSON.stringify(r.budgets.find((b) => b.scope === s) ?? null)} tenantId={r.tenant.id} scope={s} current={r.budgets.find((b) => b.scope === s)} base={r.base} onDone={refresh} /></Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="flex flex-col gap-2 p-4 text-sm">
          <p className="font-medium">Pagos pendientes</p>
          {!r.pending.length ? <p className="text-muted">Nada pendiente.</p> : r.pending.map((p) => <p key={p.id}>{p.label}: {fmt(p)}{p.status === 'PROOF_SUBMITTED' ? ' · comprobante por validar' : ''}</p>)}
          <p className="font-medium">Alertas de consumo enviadas</p>
          {!r.alerts.length ? <p className="text-muted">Ninguna.</p> : r.alerts.map((a) => <p key={`${a.scope}${a.period}${a.level}`}>{a.period} · {a.scope === 'AI' ? 'IA' : 'Total'} · {a.level === 'EXCEEDED' ? 'superado' : 'umbral'} · {Number(a.spent).toFixed(2)} de {Number(a.budget).toFixed(2)} {a.currency} · {dateTime(a.createdAt)}</p>)}
        </Card>
        <Card className="flex flex-col gap-2 p-4 text-sm">
          <p className="font-medium">Servidores</p>
          {!r.servers.length ? <p className="text-muted">Sin servidores en Infraestructura.</p> : r.servers.map((s) => <p key={s.id}>{s.name} ({s.serverType}){s.deleted ? ' · eliminado' : ''}: {s.cost ? `${fmt(s.cost)} este mes` : 'sin precio del proveedor'}</p>)}
        </Card>
      </div>
    </div>
  );
}

export default function TenantProfitPage() {
  return <RequirePermission permission="platform:manage"><Suspense fallback={<Loading />}><Detail /></Suspense></RequirePermission>;
}
