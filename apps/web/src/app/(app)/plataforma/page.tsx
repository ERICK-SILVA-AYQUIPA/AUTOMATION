'use client';

import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Eye, Plus, Search, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { PAYMENT_METHOD, date, money, num } from '@/lib/format';
import { TenantDetailDialog } from './tenant-detail';
import { PlansEditor } from './plans-editor';
import { PlatformIntegrations } from './platform-integrations';
import type { SubscriptionAccess } from '@/lib/types';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Field, Input, Loading, PageHeader, Pagination, Select, StatCard, Table, Td, Textarea, Th, cn } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';

interface Tenant {
  id: string; name: string; slug: string; status: 'ACTIVE' | 'SUSPENDED' | 'ONBOARDING'; createdAt: string; currency: string;
  subscription: { status: string; trialEndsAt: string | null; currentPeriodEnd: string; plan: { code: string; name: string }; access: SubscriptionAccess } | null; _count: { users: number };
}
interface Revenue { currency: string; amount: string; payments: number }
interface Metrics {
  tenants: { total: number; active: number; suspended: number; onboarding: number }; activeUsers: number; pendingRenewals: number;
  subscriptions: Record<SubscriptionAccess['state'], number> & { byPlan: Record<string, number> };
  revenue: { thisMonth: Revenue[]; last30Days: Revenue[] };
  ai: { period: string; replies: number; tokens: number };
  last30Days: { messages: number; inboundMessages: number; orders: number; conversations: number; automations: { sent: number; pending: number; failed: number } };
  errors: { whatsappNumbers: number; inboundEventsFailed: number; automationsFailed: number };
}
const revenueText = (r: Revenue[]) => (r.length ? r.map((x) => money(x.amount, x.currency)).join(' + ') : money(0, 'PEN'));
const PLANS = [{ code: 'BASIC', name: 'Básico' }, { code: 'PROFESSIONAL', name: 'Profesional' }, { code: 'ENTERPRISE', name: 'Empresarial' }];
interface PlanRow { code: string; name: string; priceMonthly: string; currency: string }
interface Payment { id: string; amount: string; currency: string; months: number; method: string; reference: string | null; paidAt: string; periodStart: string; periodEnd: string; plan: { code: string; name: string } }
const ACCESS: Record<SubscriptionAccess['state'], { label: string; tone: 'info' | 'success' | 'warning' | 'danger' }> = {
  TRIAL: { label: 'Prueba', tone: 'info' },
  ACTIVE: { label: 'Pagado', tone: 'success' },
  GRACE: { label: 'Vencido (gracia)', tone: 'warning' },
  EXPIRED: { label: 'Solo lectura', tone: 'danger' },
  CANCELED: { label: 'Cancelada', tone: 'danger' },
};

function AccessCell({ s }: { s: Tenant['subscription'] }) {
  if (!s) return <span className="text-muted">—</span>;
  const a = ACCESS[s.access.state];
  const until = s.access.state === 'TRIAL' || s.access.state === 'ACTIVE' ? `hasta ${date(s.access.endsAt)}` : s.access.state === 'GRACE' ? `gracia hasta ${date(s.access.graceEndsAt)}` : `desde ${date(s.access.endsAt)}`;
  return <div className="flex flex-col items-start gap-0.5"><Badge tone={a.tone}>{a.label}</Badge><span className="text-xs text-muted">{until}</span></div>;
}

/** Registrar un pago manual (Yape, transferencia...) y ver el historial de la empresa. */
function PaymentDialog({ tenant, onClose, onDone }: { tenant: Tenant | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const plans = useQuery({ queryKey: ['platform-plans'], queryFn: () => api<PlanRow[]>('/platform/plans'), enabled: !!tenant });
  const history = useQuery({ queryKey: ['platform-payments', tenant?.id], queryFn: () => api<Payment[]>(`/platform/tenants/${tenant!.id}/payments`), enabled: !!tenant });
  // Se monta de nuevo por empresa (key), así el formulario empieza limpio sin efectos
  const [form, setForm] = useState({ planCode: tenant?.subscription?.plan.code ?? 'BASIC', months: '1', amount: '', currency: 'PEN', method: 'YAPE', reference: '', paidAt: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const plan = plans.data?.find((p) => p.code === form.planCode);
  const suggested = plan ? `${plan.name}: ${money(plan.priceMonthly, plan.currency)} al mes` : '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!tenant) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/platform/tenants/${tenant.id}/payments`, {
        method: 'POST',
        body: {
          planCode: form.planCode, months: Number(form.months), amount: Number(form.amount), currency: form.currency, method: form.method,
          reference: form.reference.trim() || undefined, paidAt: form.paidAt ? new Date(`${form.paidAt}T12:00:00`).toISOString() : undefined,
        },
      });
      toast.success(tenant.status === 'ONBOARDING' ? `Pago registrado. ${tenant.name} sigue en preparación hasta que la actives` : `Pago registrado: ${tenant.name} queda activa`);
      onDone();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function cancelSubscription() {
    if (!tenant) return;
    setBusy(true);
    try {
      await api(`/platform/tenants/${tenant.id}/cancel-subscription`, { method: 'POST', body: {} });
      toast.success(`Suscripción de ${tenant.name} cancelada: queda en solo lectura`);
      onDone();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!tenant} onClose={onClose} title={`Cobro de ${tenant?.name ?? ''}`} wide
      footer={<><Button variant="secondary" onClick={onClose}>Cerrar</Button><Button type="submit" form="payment-form" loading={busy}>Registrar pago y activar</Button></>}>
      <form id="payment-form" onSubmit={submit} className="flex flex-col gap-4 text-sm">
        <p className="text-muted">Registra un pago que ya recibiste (Yape, Plin, transferencia o efectivo). La plataforma no cobra por sí misma: esto solo activa o renueva el plan. Si el plan sigue vigente, los meses se suman al final del periodo actual.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Plan" hint={suggested}>
            <Select value={form.planCode} onChange={(e) => setForm({ ...form, planCode: e.target.value })} required>
              {(plans.data ?? PLANS).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Meses pagados">
            <Input type="number" min={1} max={24} step={1} value={form.months} onChange={(e) => setForm({ ...form, months: e.target.value })} required />
          </Field>
          <Field label="Fecha del pago" hint="Vacío = hoy">
            <Input type="date" value={form.paidAt} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setForm({ ...form, paidAt: e.target.value })} />
          </Field>
          <Field label="Importe recibido">
            <Input type="number" min={0} step="0.01" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
          </Field>
          <Field label="Moneda">
            <Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              {['PEN', 'USD'].map((c) => <option key={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Medio">
            <Select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              {Object.entries(PAYMENT_METHOD).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="N.º de operación o referencia (queda en auditoría)">
          <Input value={form.reference} maxLength={120} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
        </Field>
        <ErrorBox error={error} />
      </form>
      <div className="mt-6">
        <h3 className="mb-2 text-sm font-medium">Pagos anteriores</h3>
        {history.isLoading ? <Loading /> : !history.data?.length ? <p className="text-sm text-muted">Sin pagos registrados.</p> : (
          <Table>
            <thead><tr><Th>Fecha</Th><Th>Plan</Th><Th>Periodo</Th><Th className="text-right">Importe</Th><Th>Medio</Th></tr></thead>
            <tbody>
              {history.data.map((p) => (
                <tr key={p.id}>
                  <Td>{date(p.paidAt)}</Td>
                  <Td>{p.plan.name} · {p.months} {p.months === 1 ? 'mes' : 'meses'}</Td>
                  <Td className="text-muted">{date(p.periodStart)} – {date(p.periodEnd)}</Td>
                  <Td className="text-right tabular-nums">{money(p.amount, p.currency)}</Td>
                  <Td>{PAYMENT_METHOD[p.method] ?? p.method}{p.reference && <span className="block text-xs text-muted">{p.reference}</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
      {tenant?.subscription && tenant.subscription.access.state !== 'CANCELED' && (
        <div className="mt-6 border-t border-border pt-4 text-sm">
          {!confirmCancel
            ? <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(true)}>Cancelar suscripción…</Button>
            : <div className="flex flex-wrap items-center gap-2"><span className="text-muted">La empresa quedará en solo lectura de inmediato.</span><Button size="sm" variant="danger" loading={busy} onClick={cancelSubscription}>Confirmar cancelación</Button></div>}
        </div>
      )}
    </Dialog>
  );
}

function Platform() {
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [suspend, setSuspend] = useState<Tenant | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [billing, setBilling] = useState<Tenant | null>(null);
  const params = useSearchParams();
  const router = useRouter();
  const [detail, setDetailState] = useState<string | null>(() => params.get('empresa'));
  const setDetail = (id: string | null) => {
    setDetailState(id);
    if (!id && params.get('empresa')) router.replace('/plataforma');
  };
  const [tab, setTab] = useState<'tenants' | 'plans' | 'integrations'>('tenants');
  useEffect(() => {
    const t = setTimeout(() => { setDq(q.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);
  const metrics = useQuery({ queryKey: ['platform-metrics'], queryFn: () => api<Metrics>('/platform/metrics') });
  const plans = useQuery({ queryKey: ['platform-plans'], queryFn: () => api<PlanRow[]>('/platform/plans') });
  const list = useQuery({
    queryKey: ['platform-tenants', dq, status, page],
    queryFn: () => api<{ items: Tenant[]; total: number; page: number; pageSize: number }>('/platform/tenants', { query: { q: dq, status, page, pageSize: 20 } }),
    placeholderData: keepPreviousData,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['platform-tenants'] });
    qc.invalidateQueries({ queryKey: ['platform-metrics'] });
  };

  async function setTenantStatus(t: Tenant, s: 'ACTIVE' | 'SUSPENDED', why?: string) {
    setBusy(true);
    try {
      await api(`/platform/tenants/${t.id}/status`, { method: 'PATCH', body: { status: s, reason: why || undefined } });
      toast.success(s === 'SUSPENDED' ? `${t.name} suspendida` : `${t.name} reactivada`);
      refresh();
      setSuspend(null);
      setReason('');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }
  async function setPlan(t: Tenant, planCode: string) {
    try {
      await api(`/platform/tenants/${t.id}/plan`, { method: 'PATCH', body: { planCode } });
      toast.success(`Plan de ${t.name} actualizado`);
      refresh();
    } catch (err) {
      toast.error(err);
    }
  }

  const m = metrics.data;
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  return (
    <>
      <PageHeader title="Empresas" description="Administración general de la plataforma. Cobro manual: registra aquí los pagos recibidos por Yape o transferencia."
        actions={<Link href="/plataforma/nueva" className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-fg hover:opacity-90"><Plus className="size-4" />Nueva empresa</Link>} />
      <ErrorBox error={metrics.error} />
      {m && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Empresas" value={num(m.tenants.total)} hint={`${num(m.tenants.active)} activas · ${num(m.tenants.onboarding)} en preparación · ${num(m.tenants.suspended)} suspendidas`} />
          <StatCard label="Suscripciones" value={`${num(m.subscriptions.ACTIVE)} pagadas`} hint={`${num(m.subscriptions.TRIAL)} en prueba · ${num(m.subscriptions.CANCELED)} canceladas`} />
          <StatCard label="Por renovar" value={num(m.pendingRenewals)} tone={m.pendingRenewals ? 'warning' : undefined} hint={`${num(m.subscriptions.GRACE)} en gracia · ${num(m.subscriptions.EXPIRED)} en solo lectura`} />
          <StatCard label="Ingresos del mes" value={revenueText(m.revenue.thisMonth)} hint={`30 días: ${revenueText(m.revenue.last30Days)} · pagos registrados a mano`} />
          <StatCard label="Usuarios activos" value={num(m.activeUsers)} />
          <StatCard label="Mensajes (30 días)" value={num(m.last30Days.messages)} hint={`${num(m.last30Days.inboundMessages)} recibidos · ${num(m.last30Days.conversations)} conversaciones nuevas · ${num(m.last30Days.orders)} pedidos`} />
          <StatCard label={`IA (${m.ai.period})`} value={`${num(m.ai.replies)} respuestas`} hint={`${num(m.ai.tokens)} tokens`} />
          <StatCard label="Errores" value={num(m.errors.whatsappNumbers + m.errors.inboundEventsFailed + m.errors.automationsFailed)} tone={m.errors.whatsappNumbers + m.errors.inboundEventsFailed + m.errors.automationsFailed ? 'danger' : undefined}
            hint={`${num(m.errors.whatsappNumbers)} números de WhatsApp con fallo · ${num(m.errors.inboundEventsFailed)} mensajes sin procesar · ${num(m.errors.automationsFailed)} automatizaciones fallidas (30 días)`} />
        </div>
      )}
      <div className="mb-4 flex gap-1 text-sm" role="tablist">
        {([['tenants', 'Empresas'], ['plans', 'Planes y precios'], ['integrations', 'Integraciones']] as const).map(([v, l]) => (
          <button key={v} type="button" role="tab" aria-selected={tab === v} onClick={() => setTab(v)} className={cn('rounded-md px-3 py-1.5', tab === v ? 'bg-surface-2 font-medium text-text' : 'text-muted hover:text-text')}>{l}</button>
        ))}
      </div>
      {tab === 'plans' ? <PlansEditor /> : tab === 'integrations' ? <PlatformIntegrations /> : (
      <Card>
        <div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input className="pl-9" placeholder="Buscar empresa" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar empresa" />
          </div>
          <Select className="sm:w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Estado">
            <option value="">Todas</option>
            <option value="ACTIVE">Activas</option>
            <option value="ONBOARDING">En preparación</option>
            <option value="SUSPENDED">Suspendidas</option>
          </Select>
        </div>
        <ErrorBox error={list.error} />
        {list.isLoading ? <Loading /> : !list.data?.items.length ? <EmptyState icon={<Building2 className="size-5" />} title="Sin empresas" /> : (
          <>
            <Table>
              <thead><tr><Th>Empresa</Th><Th>Plan</Th><Th>Suscripción</Th><Th className="text-right">Usuarios</Th><Th>Alta</Th><Th>Estado</Th><Th /></tr></thead>
              <tbody>
                {list.data.items.map((t) => (
                  <tr key={t.id}>
                    <Td><button type="button" onClick={() => setDetail(t.id)} className="text-left font-medium hover:underline">{t.name}</button><span className="block text-xs text-muted">{t.slug}</span></Td>
                    <Td>
                      <Select className="h-8 w-36" value={t.subscription?.plan.code ?? ''} onChange={(e) => setPlan(t, e.target.value)} aria-label={`Plan de ${t.name}`}>
                        {(plans.data ?? PLANS).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                      </Select>
                    </Td>
                    <Td><AccessCell s={t.subscription} /></Td>
                    <Td className="text-right tabular-nums">{t._count.users}</Td>
                    <Td className="text-muted">{date(t.createdAt)}</Td>
                    <Td><Badge tone={t.status === 'ACTIVE' ? 'success' : t.status === 'ONBOARDING' ? 'info' : 'danger'}>{t.status === 'ACTIVE' ? 'Activa' : t.status === 'ONBOARDING' ? 'En preparación' : 'Suspendida'}</Badge></Td>
                    <Td className="whitespace-nowrap text-right">
                      <Button size="sm" variant="ghost" icon={<Eye className="size-4" />} onClick={() => setDetail(t.id)} className="mr-2" aria-label={`Ver ${t.name}`}>Ficha</Button>
                      <Button size="sm" variant="secondary" icon={<Wallet className="size-4" />} onClick={() => setBilling(t)} className="mr-2">Cobro</Button>
                      {t.status !== 'SUSPENDED'
                        ? <Button size="sm" variant="secondary" onClick={() => setSuspend(t)}>Suspender</Button>
                        : <Button size="sm" variant="secondary" loading={busy} onClick={() => setTenantStatus(t, 'ACTIVE')}>Reactivar</Button>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pages={pages} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
      )}
      <TenantDetailDialog id={detail} onClose={() => setDetail(null)} onChanged={refresh} />
      <PaymentDialog key={billing?.id ?? 'none'} tenant={billing} onClose={() => setBilling(null)} onDone={() => { refresh(); qc.invalidateQueries({ queryKey: ['platform-payments'] }); }} />
      <Dialog open={!!suspend} onClose={() => setSuspend(null)} title={`¿Suspender ${suspend?.name}?`} footer={<><Button variant="secondary" onClick={() => setSuspend(null)}>Cancelar</Button><Button variant="danger" loading={busy} onClick={() => setTenantStatus(suspend!, 'SUSPENDED', reason)}>Suspender</Button></>}>
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted">Sus usuarios no podrán entrar y el asistente dejará de responder. Los datos se conservan y puedes reactivarla cuando quieras.</p>
          <Field label="Motivo (queda en auditoría)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
        </div>
      </Dialog>
    </>
  );
}

export default function PlataformaPage() {
  return <RequirePermission permission="platform:manage"><Suspense fallback={<Loading />}><Platform /></Suspense></RequirePermission>;
}
