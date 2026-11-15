'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Coins, Repeat, Wallet } from 'lucide-react';
import { RequirePermission } from '@/components/guard';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Select, StatCard, Table, Td, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { DEPLOYMENT_MODE } from '@/lib/format';
import { fmt, fmtAll, thisPeriod, type Margin, type Money } from './shared';

interface Overview {
  period: string; base: string; rates: Record<string, number>;
  totals: { mrr: { byCurrency: Money[]; base: number | null }; pending: { byCurrency: Money[]; base: number | null; count: number }; margin: { known: number; unknown: number; value: number | null; negative: number }; alerts: number };
  rows: { tenant: { id: string; name: string; status: string; deploymentMode: string }; mrr: Money | null; mrrNote: string; collected: Money[]; costs: { category: string; label: string; known: boolean; total: Money[] }[]; margin: Margin; pending: number; budgets: { scope: string; level: string | null }[] }[];
}

function Rates({ base, rates }: { base: string; rates: Record<string, number> }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [b, setB] = useState(base);
  const [text, setText] = useState(Object.entries(rates).map(([k, v]) => `${k}=${v}`).join(', '));
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    const parsed: Record<string, number> = {};
    for (const part of text.split(/[,\n;]/).map((s) => s.trim()).filter(Boolean)) {
      const m = /^([A-Za-z]{3})\s*=\s*([\d.]+)$/.exec(part);
      if (!m) return toast.error(`No entiendo «${part}»: usa MONEDA=valor, p. ej. USD=3.75`);
      parsed[m[1]!.toUpperCase()] = Number(m[2]);
    }
    setBusy(true);
    try {
      await api('/platform/finance/settings', { method: 'PUT', body: { baseCurrency: b.trim().toUpperCase(), rates: parsed } });
      toast.success('Tipos de cambio guardados');
      void qc.invalidateQueries({ queryKey: ['finance'] });
      void qc.invalidateQueries({ queryKey: ['finance-tenant'] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="p-4">
      <form onSubmit={save} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Moneda base" className="sm:w-32"><Input value={b} onChange={(e) => setB(e.target.value)} maxLength={3} required /></Field>
        <Field label="Tipos de cambio" hint="Cuántas unidades de la moneda base vale 1 unidad de otra, p. ej. USD=3.75, EUR=4.05. Los defines tú: no se consultan solos." className="flex-1">
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="USD=3.75, EUR=4.05" />
        </Field>
        <Button type="submit" variant="secondary" loading={busy}>Guardar</Button>
      </form>
    </Card>
  );
}

function Profitability() {
  const [period, setPeriod] = useState(thisPeriod);
  const q = useQuery({ queryKey: ['finance', period], queryFn: () => api<Overview>('/platform/finance', { query: { period } }) });
  const d = q.data;
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'all' | 'missing' | 'negative' | 'pending' | 'alerts'>('all');
  const VIEWS = { all: 'Todas', missing: 'Faltan datos', negative: 'Margen negativo', pending: 'Con pagos pendientes', alerts: 'Con alertas' } as const;
  const rows = (d?.rows ?? []).filter((r) => r.tenant.name.toLowerCase().includes(search.trim().toLowerCase()) && (
    view === 'all' || (view === 'missing' && r.margin.value == null) || (view === 'negative' && (r.margin.value ?? 0) < 0) || (view === 'pending' && r.pending > 0) || (view === 'alerts' && r.budgets.some((b) => b.level))));
  const LIMIT = 100;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Rentabilidad"
        description="Ingreso recurrente frente a los costos de cada instalación. El margen solo aparece cuando se conocen todos los costos: si falta un dato, se dice cuál."
        actions={<Field label="Mes"><Input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} /></Field>}
      />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : d && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Ingreso recurrente mensual" value={d.totals.mrr.base != null ? fmt({ amount: d.totals.mrr.base, currency: d.base }) : fmtAll(d.totals.mrr.byCurrency)} hint={d.totals.mrr.base == null && d.totals.mrr.byCurrency.length > 1 ? 'Varias monedas: define los tipos de cambio' : undefined} icon={<Repeat className="size-5" />} />
            <StatCard label="Pagos pendientes" value={d.totals.pending.base != null ? fmt({ amount: d.totals.pending.base, currency: d.base }) : fmtAll(d.totals.pending.byCurrency)} hint={`${d.totals.pending.count} pendiente(s)`} tone={d.totals.pending.count ? 'warning' : undefined} icon={<Wallet className="size-5" />} />
            <StatCard label="Margen estimado" value={d.totals.margin.value != null ? fmt({ amount: d.totals.margin.value, currency: d.base }) : 'Sin datos suficientes'} hint={`${d.totals.margin.known} empresa(s) con margen calculado · ${d.totals.margin.unknown} con datos faltantes`} tone={d.totals.margin.negative ? 'danger' : undefined} icon={<Coins className="size-5" />} />
            <StatCard label="Alertas de consumo" value={d.totals.alerts} tone={d.totals.alerts ? 'danger' : undefined} icon={<AlertTriangle className="size-5" />} />
          </div>
          <Rates key={`${d.base}${JSON.stringify(d.rates)}`} base={d.base} rates={d.rates} />
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Buscar empresa" className="w-64"><Input value={search} onChange={(e) => setSearch(e.target.value)} /></Field>
            <Field label="Ver" className="w-56"><Select value={view} onChange={(e) => setView(e.target.value as typeof view)}>{Object.entries(VIEWS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <p className="pb-2 text-sm text-muted">{rows.length} empresa(s){rows.length > LIMIT ? `; se muestran las primeras ${LIMIT}, usa la búsqueda` : ''}</p>
          </div>
          <Table>
            <thead><tr><Th>Empresa</Th><Th>Ingreso mensual</Th><Th>Costos del mes</Th><Th>Margen estimado</Th><Th>Pendientes</Th></tr></thead>
            <tbody>
              {rows.slice(0, LIMIT).map((r) => (
                <tr key={r.tenant.id}>
                  <Td><Link href={`/plataforma/rentabilidad/${r.tenant.id}?mes=${period}`} className="font-medium text-primary hover:underline">{r.tenant.name}</Link><div className="text-xs text-muted">{DEPLOYMENT_MODE[r.tenant.deploymentMode] ?? r.tenant.deploymentMode}</div></Td>
                  <Td>{r.mrr ? fmt(r.mrr) : <span className="text-xs text-muted">{r.mrrNote}</span>}</Td>
                  <Td>
                    {fmtAll(r.costs.flatMap((c) => c.total))}
                    {r.costs.some((c) => !c.known) && <div className="text-xs text-muted">Falta: {r.costs.filter((c) => !c.known).map((c) => c.label.toLowerCase()).join(', ')}</div>}
                  </Td>
                  <Td>
                    {r.margin.value != null
                      ? <Badge tone={r.margin.value < 0 ? 'danger' : 'success'}>{fmt({ amount: r.margin.value, currency: r.margin.currency })}{r.margin.pct != null ? ` (${r.margin.pct}%)` : ''}</Badge>
                      : <span className="text-xs text-muted">No se calcula: faltan {r.margin.missing.length} dato(s)</span>}
                    {r.budgets.some((b) => b.level) && <div className="mt-1"><Badge tone="danger">Presupuesto {r.budgets.some((b) => b.level === 'EXCEEDED') ? 'superado' : 'por agotarse'}</Badge></div>}
                  </Td>
                  <Td>{r.pending || '—'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </div>
  );
}

export default function ProfitabilityPage() {
  return <RequirePermission permission="platform:manage"><Profitability /></RequirePermission>;
}
