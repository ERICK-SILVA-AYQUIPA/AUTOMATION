'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlarmClock, CalendarClock, LifeBuoy, Plus, Star } from 'lucide-react';
import { RequirePermission } from '@/components/guard';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Field, Input, Loading, PageHeader, Select, StatCard, Table, Td, Textarea, Th, cn } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { DEPLOYMENT_MODE, dateTime, money } from '@/lib/format';
import { KIND, PRIORITY, SOURCE, STATUS, ticketNo, type SupportKind, type SupportPriority, type SupportStatus, type Ticket, type TicketDetail } from '@/lib/support';

interface Row extends Ticket { tenant: { id: string; name: string; deploymentMode: string }; assignee: { id: string; name: string } | null; _count: { messages: number } }
interface Summary { open: Partial<Record<SupportPriority, number>>; overdue: number; satisfaction: { average: number | null; count: number; days: number } }
interface Renewal {
  tenantId: string; status: string; trialEndsAt: string | null; currentPeriodEnd: string;
  plan: { code: string; name: string; priceMonthly: string | null; currency: string };
  tenant: { id: string; name: string; status: string; deploymentMode: string };
  access: { state: 'TRIAL' | 'ACTIVE' | 'GRACE' | 'EXPIRED' | 'CANCELED'; endsAt: string; graceEndsAt: string | null; daysLeft: number; readOnly: boolean };
  notices: { kind: 'D7' | 'D3' | 'D1' | 'EXPIRED'; createdAt: string; recipients: number }[];
}

const ACCESS: Record<Renewal['access']['state'], { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  TRIAL: { label: 'En prueba', tone: 'info' }, ACTIVE: { label: 'Al día', tone: 'success' }, GRACE: { label: 'En gracia', tone: 'warning' }, EXPIRED: { label: 'Vencida (solo lectura)', tone: 'danger' }, CANCELED: { label: 'Cancelada', tone: 'neutral' },
};
const NOTICE: Record<Renewal['notices'][number]['kind'], string> = { D7: '7 días antes', D3: '3 días antes', D1: '1 día antes', EXPIRED: 'Al vencer' };
const FILTERS = [['active', 'Pendientes'], ['OPEN', 'Abiertos'], ['WAITING_CLIENT', 'Esperando al cliente'], ['RESOLVED', 'Resueltos'], ['CLOSED', 'Cerrados'], ['', 'Todos']] as const;

function TenantTicket({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const tenants = useQuery({ queryKey: ['support-tenant-pick', search], queryFn: () => api<{ items: { id: string; name: string }[] }>('/platform/tenants', { query: { q: search || undefined, pageSize: 20 } }) });
  const [f, setF] = useState<{ tenantId: string; kind: SupportKind; priority: SupportPriority; subject: string; body: string }>({ tenantId: '', kind: 'REQUEST', priority: 'NORMAL', subject: '', body: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await api<TicketDetail>('/platform/support/tickets', { method: 'POST', body: f });
      toast.success(`Caso ${ticketNo(t.number)} registrado`);
      router.push(`/plataforma/soporte/${t.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title="Registrar caso de una empresa" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="staff-ticket" loading={busy} disabled={!f.tenantId}>Registrar</Button></>}>
      <form id="staff-ticket" onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-muted">Para lo que la empresa pidió por teléfono o WhatsApp. Le llega un correo con el caso y puede seguirlo desde su panel.</p>
        <ErrorBox error={error} />
        <Field label="Buscar empresa"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nombre" /></Field>
        <Field label="Empresa">
          <Select value={f.tenantId} onChange={(e) => setF({ ...f, tenantId: e.target.value })} required>
            <option value="">Elige una empresa</option>
            {tenants.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tipo"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as SupportKind })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Prioridad"><Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as SupportPriority })}>{Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select></Field>
        </div>
        <Field label="Asunto"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} minLength={3} maxLength={200} required /></Field>
        <Field label="Detalle (lo verá la empresa)"><Textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} rows={4} maxLength={10000} required /></Field>
      </form>
    </Dialog>
  );
}

function Tickets() {
  const params = useSearchParams();
  const [status, setStatus] = useState<string>(() => FILTERS.find(([k]) => k === params.get('estado'))?.[0] ?? 'active');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const summary = useQuery({ queryKey: ['support-summary'], queryFn: () => api<Summary>('/platform/support/summary') });
  const list = useQuery({ queryKey: ['platform-support', status, q], queryFn: () => api<Row[]>('/platform/support/tickets', { query: { status: status || undefined, q: q.trim() || undefined } }) });
  const open = summary.data ? Object.values(summary.data.open).reduce((a, b) => a + (b ?? 0), 0) : null;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Casos pendientes" value={open ?? '—'} hint={summary.data ? `${summary.data.open.URGENT ?? 0} urgentes · ${summary.data.open.HIGH ?? 0} de prioridad alta` : undefined} icon={<LifeBuoy className="size-5" />} />
        <StatCard label="Primera respuesta vencida" value={summary.data?.overdue ?? '—'} tone={summary.data?.overdue ? 'danger' : undefined} icon={<AlarmClock className="size-5" />} />
        <StatCard label={`Satisfacción (${summary.data?.satisfaction.days ?? 90} días)`} value={summary.data?.satisfaction.average != null ? `${summary.data.satisfaction.average.toFixed(1)} / 5` : 'Sin calificaciones'} hint={summary.data ? `${summary.data.satisfaction.count} calificaciones` : undefined} icon={<Star className="size-5" />} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Estado">
          {FILTERS.map(([k, label]) => (
            <button key={k || 'all'} role="tab" aria-selected={status === k} onClick={() => setStatus(k)} className={cn('rounded-lg px-3 py-1.5 text-sm', status === k ? 'bg-primary/10 font-medium text-primary' : 'text-muted hover:bg-surface-2')}>{label}</button>
          ))}
        </div>
        <Input className="max-w-xs" placeholder="Buscar por asunto, empresa o número" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar casos" />
        <Button className="ml-auto" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Registrar caso</Button>
      </div>
      {list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : !list.data?.length ? (
        <EmptyState icon={<LifeBuoy className="size-6" />} title="Sin casos en esta vista" />
      ) : (
        <Table>
          <thead><tr><Th>Caso</Th><Th>Empresa</Th><Th>Asunto</Th><Th>Prioridad</Th><Th>Estado</Th><Th>Responsable</Th><Th>Primera respuesta</Th></tr></thead>
          <tbody>
            {list.data.map((t) => (
              <tr key={t.id}>
                <Td className="font-mono text-xs">{ticketNo(t.number)}</Td>
                <Td>{t.tenant.name}</Td>
                <Td><Link href={`/plataforma/soporte/${t.id}`} className="font-medium text-primary hover:underline">{t.subject}</Link><div className="text-xs text-muted">{KIND[t.kind]} · {SOURCE[t.source]}</div></Td>
                <Td><Badge tone={PRIORITY[t.priority].tone}>{PRIORITY[t.priority].label}</Badge></Td>
                <Td><Badge tone={STATUS[t.status as SupportStatus].tone}>{STATUS[t.status as SupportStatus].staff}</Badge></Td>
                <Td>{t.assignee?.name ?? <span className="text-muted">Sin asignar</span>}</Td>
                <Td>{t.firstResponseAt ? dateTime(t.firstResponseAt) : t.due.overdue ? <Badge tone="danger">Vencida</Badge> : <span className="text-muted">Antes del {dateTime(t.due.due)}</span>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {creating && <TenantTicket onClose={() => setCreating(false)} />}
    </div>
  );
}

function Renewals() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['support-renewals'], queryFn: () => api<Renewal[]>('/platform/support/renewals') });
  const [sending, setSending] = useState(false);
  async function sendNow() {
    setSending(true);
    try {
      const r = await api<{ sent: number }>('/platform/support/renewals/send', { method: 'POST' });
      toast.success(r.sent ? `Avisos enviados a ${r.sent} empresa(s)` : 'No había avisos pendientes');
      await q.refetch();
    } catch (err) {
      toast.error(err);
    } finally {
      setSending(false);
    }
  }
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4 text-sm text-muted sm:flex-row sm:items-center">
        <p className="flex-1">Suscripciones que vencen en los próximos 30 días o vencieron hace menos de 30. Los avisos por correo salen solos cada hora (7, 3 y 1 día antes y al vencer; una vez cada uno). El cobro es manual: registra el pago desde la ficha de la empresa.</p>
        <Button variant="secondary" loading={sending} onClick={sendNow}>Enviar avisos pendientes</Button>
      </Card>
      {!q.data?.length ? <EmptyState icon={<CalendarClock className="size-6" />} title="Nada por renovar en los próximos 30 días" /> : (
        <Table>
          <thead><tr><Th>Empresa</Th><Th>Plan</Th><Th>Vence</Th><Th>Acceso</Th><Th>Avisos enviados</Th><Th /></tr></thead>
          <tbody>
            {q.data.map((r) => (
              <tr key={r.tenantId}>
                <Td>{r.tenant.name}<div className="text-xs text-muted">{DEPLOYMENT_MODE[r.tenant.deploymentMode] ?? r.tenant.deploymentMode}</div></Td>
                <Td>{r.plan.name}<div className="text-xs text-muted">{r.plan.priceMonthly ? `${money(r.plan.priceMonthly, r.plan.currency)} al mes` : 'Precio no definido'}</div></Td>
                <Td>{dateTime(r.access.endsAt)}</Td>
                <Td><Badge tone={ACCESS[r.access.state].tone}>{ACCESS[r.access.state].label}</Badge>{!r.access.readOnly && <div className="text-xs text-muted">{r.access.daysLeft} día(s) hasta solo lectura</div>}</Td>
                <Td>{r.notices.length ? r.notices.map((n) => <div key={n.kind} className="text-xs">{NOTICE[n.kind]} · {dateTime(n.createdAt)} · {n.recipients} destinatario(s)</div>) : <span className="text-xs text-muted">Ninguno aún</span>}</Td>
                <Td><Link href={`/plataforma?empresa=${r.tenantId}`} className="text-sm text-primary hover:underline">Registrar pago</Link></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

function SupportCenter() {
  const params = useSearchParams();
  const [tab, setTab] = useState<'casos' | 'renovaciones'>(params.get('vista') === 'renovaciones' ? 'renovaciones' : 'casos');
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Soporte y renovaciones" description="Casos de las empresas, incidencias del monitoreo y suscripciones por vencer." />
      <div className="flex gap-1 border-b border-border" role="tablist" aria-label="Vista">
        {([['casos', 'Casos'], ['renovaciones', 'Renovaciones']] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn('-mb-px border-b-2 px-4 py-2 text-sm', tab === k ? 'border-primary font-medium text-text' : 'border-transparent text-muted hover:text-text')}>{label}</button>
        ))}
      </div>
      {tab === 'casos' ? <Tickets /> : <Renewals />}
    </div>
  );
}

export default function PlatformSupportPage() {
  return <RequirePermission permission="platform:manage"><Suspense fallback={<Loading />}><SupportCenter /></Suspense></RequirePermission>;
}
