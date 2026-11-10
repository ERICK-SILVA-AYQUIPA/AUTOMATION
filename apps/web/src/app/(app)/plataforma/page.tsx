'use client';

import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { date, num } from '@/lib/format';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Field, Input, Loading, PageHeader, Pagination, Select, StatCard, Table, Td, Textarea, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';

interface Tenant {
  id: string; name: string; slug: string; status: 'ACTIVE' | 'SUSPENDED'; createdAt: string; currency: string;
  subscription: { status: string; trialEndsAt: string | null; plan: { code: string; name: string } } | null; _count: { users: number };
}
interface Metrics { tenants: { total: number; active: number; suspended: number }; activeUsers: number; subscriptions: { plan: string; status: string; count: number }[]; last30Days: { orders: number; conversations: number } }
const PLANS = [{ code: 'BASIC', name: 'Básico' }, { code: 'PROFESSIONAL', name: 'Profesional' }, { code: 'ENTERPRISE', name: 'Empresarial' }];

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
  useEffect(() => {
    const t = setTimeout(() => { setDq(q.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);
  const metrics = useQuery({ queryKey: ['platform-metrics'], queryFn: () => api<Metrics>('/platform/metrics') });
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
      <PageHeader title="Empresas" description="Administración general de la plataforma. Los cambios de plan no generan cobros." />
      <ErrorBox error={metrics.error} />
      {m && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Empresas" value={num(m.tenants.total)} hint={`${num(m.tenants.active)} activas · ${num(m.tenants.suspended)} suspendidas`} />
          <StatCard label="Usuarios activos" value={num(m.activeUsers)} />
          <StatCard label="Pedidos (30 días)" value={num(m.last30Days.orders)} />
          <StatCard label="Conversaciones (30 días)" value={num(m.last30Days.conversations)} />
        </div>
      )}
      <Card>
        <div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input className="pl-9" placeholder="Buscar empresa" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar empresa" />
          </div>
          <Select className="sm:w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Estado">
            <option value="">Todas</option>
            <option value="ACTIVE">Activas</option>
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
                    <Td><span className="font-medium">{t.name}</span><span className="block text-xs text-muted">{t.slug}</span></Td>
                    <Td>
                      <Select className="h-8 w-36" value={t.subscription?.plan.code ?? ''} onChange={(e) => setPlan(t, e.target.value)} aria-label={`Plan de ${t.name}`}>
                        {PLANS.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                      </Select>
                    </Td>
                    <Td className="text-muted">{t.subscription?.status === 'TRIALING' ? `Prueba hasta ${date(t.subscription.trialEndsAt)}` : t.subscription?.status}</Td>
                    <Td className="text-right tabular-nums">{t._count.users}</Td>
                    <Td className="text-muted">{date(t.createdAt)}</Td>
                    <Td><Badge tone={t.status === 'ACTIVE' ? 'success' : 'danger'}>{t.status === 'ACTIVE' ? 'Activa' : 'Suspendida'}</Badge></Td>
                    <Td className="text-right">
                      {t.status === 'ACTIVE'
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
  return <RequirePermission permission="platform:manage"><Platform /></RequirePermission>;
}
