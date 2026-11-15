'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, Columns3, List, Plus, Search, Target, UserX } from 'lucide-react';
import { api } from '@/lib/api';
import { dateTime, money, num } from '@/lib/format';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Field, Input, Loading, PageHeader, Pagination, Select, StatCard, Table, Td, Th, cn } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';
import {
  LEAD_STATUS, LeadFields, LostDialog, MANUAL, SECTOR, SOURCE, duplicatesOf, emptyForm, isOverdue, leadNo, payloadOf, useOwners,
  type Lead, type LeadStatus,
} from './shared';

interface Column { status: LeadStatus; manual: boolean; count: number; budget: { currency: string; amount: string }[]; items: Lead[] }
interface Summary { open: number; overdue: number; unassigned: number; openBudget: { currency: string; amount: string }[]; closed90: { won: number; lost: number; winRate: number | null }; bySource: Record<string, number> }
interface Paged { items: Lead[]; total: number; page: number; pages: number }

const budgetText = (b: { currency: string; amount: string }[]) => (b.length ? b.map((x) => money(x.amount, x.currency)).join(' + ') : '—');

function LeadCard({ l, draggable, onOpen }: { l: Lead; draggable: boolean; onOpen: () => void }) {
  const late = isOverdue(l);
  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', l.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onOpen}
      className={cn('flex w-full flex-col gap-1 rounded-lg border bg-surface p-3 text-left text-sm shadow-sm transition hover:border-primary', late ? 'border-danger/60' : 'border-border', draggable && 'cursor-grab active:cursor-grabbing')}
      aria-label={`${leadNo(l.number)} ${l.name}`}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="font-medium">{l.name}</span>
        <span className="font-mono text-[11px] text-muted">{leadNo(l.number)}</span>
      </span>
      {l.company && <span className="text-xs text-muted">{l.company}</span>}
      {l.estimatedBudget && <span className="text-xs tabular-nums">{money(l.estimatedBudget, l.budgetCurrency)}</span>}
      {l.nextAction && (
        <span className={cn('flex items-center gap-1 text-xs', late ? 'font-medium text-danger' : 'text-muted')}>
          <AlarmClock className="size-3 shrink-0" />
          <span className="truncate">{l.nextAction} · {dateTime(l.nextActionAt)}</span>
        </span>
      )}
      <span className="text-xs text-muted">{l.owner?.name ?? 'Sin responsable'}</span>
    </button>
  );
}

/** Embudo: columnas por etapa; se arrastra entre las etapas que se mueven a mano */
function Board({ columns, onOpen, onMoved }: { columns: Column[]; onOpen: (id: string) => void; onMoved: () => void }) {
  const toast = useToast();
  const [over, setOver] = useState<LeadStatus | null>(null);
  const [lost, setLost] = useState<Lead | null>(null);
  const find = (id: string) => columns.flatMap((c) => c.items).find((l) => l.id === id);
  async function drop(status: LeadStatus, id: string) {
    setOver(null);
    const l = find(id);
    if (!l || l.status === status) return;
    if (status === 'LOST') return setLost(l);
    try {
      await api(`/platform/sales/leads/${id}/status`, { method: 'POST', body: { status } });
      toast.success(`${l.name}: ${LEAD_STATUS[status].label}`);
    } catch (err) {
      toast.error(err);
    } finally {
      onMoved();
    }
  }
  const max = Math.max(1, ...columns.map((c) => c.count));
  return (
    <>
      {/* Resumen del embudo: cantidad por etapa; un clic lleva a su columna */}
      <ol className="mb-3 grid grid-cols-4 gap-1 sm:grid-cols-6 lg:grid-cols-11" aria-label="Resumen del embudo">
        {columns.map((c) => (
          <li key={c.status}>
            <button
              type="button"
              onClick={() => document.getElementById(`col-${c.status}`)?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })}
              className="flex w-full flex-col gap-1 rounded-md px-1.5 py-1 text-left hover:bg-surface-2"
              title={`${LEAD_STATUS[c.status].label}: ${c.count}`}
            >
              <span className="h-1.5 w-full rounded-full bg-surface-2">
                <span className={cn('block h-1.5 rounded-full', c.status === 'LOST' ? 'bg-danger/70' : 'bg-primary')} style={{ width: `${(c.count / max) * 100}%` }} />
              </span>
              <span className="truncate text-[11px] text-muted">{LEAD_STATUS[c.status].label}</span>
              <span className="text-sm font-medium tabular-nums">{num(c.count)}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-3" role="list" aria-label="Embudo de ventas">
        {columns.map((c) => {
          const accepts = c.manual;
          return (
            <section
              key={c.status}
              id={`col-${c.status}`}
              role="listitem"
              aria-label={LEAD_STATUS[c.status].label}
              onDragOver={(e) => {
                if (!accepts) return;
                e.preventDefault();
                setOver(c.status);
              }}
              onDragLeave={() => setOver((o) => (o === c.status ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                if (accepts) void drop(c.status, e.dataTransfer.getData('text/plain'));
              }}
              className={cn('flex w-64 shrink-0 flex-col gap-2 rounded-xl border bg-surface-2/50 p-2', over === c.status ? 'border-primary ring-2 ring-primary/30' : 'border-border')}
            >
              <header className="px-1 pt-1">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">{LEAD_STATUS[c.status].label}</h3>
                  <span className="rounded-full bg-surface px-2 text-xs tabular-nums text-muted">{num(c.count)}</span>
                </div>
                <p className="text-xs tabular-nums text-muted">{budgetText(c.budget)}</p>
                {!c.manual && <p className="mt-0.5 text-[11px] leading-tight text-muted">{LEAD_STATUS[c.status].hint}</p>}
              </header>
              <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
                {c.items.map((l) => <LeadCard key={l.id} l={l} draggable={MANUAL.includes(l.status) || l.status === 'PAYMENT_CONFIRMED'} onOpen={() => onOpen(l.id)} />)}
                {c.count > c.items.length && <p className="px-1 text-xs text-muted">y {num(c.count - c.items.length)} más (usa la lista)</p>}
              </div>
            </section>
          );
        })}
      </div>
      <LostDialog lead={lost} onClose={() => setLost(null)} onDone={() => { toast.success('Marcado como perdido'); onMoved(); }} />
    </>
  );
}

function NewLeadDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const owners = useOwners();
  const [f, setF] = useState(emptyForm);
  const [ownerId, setOwnerId] = useState<string>('me');
  const [nextAction, setNextAction] = useState('');
  const [nextAt, setNextAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dups = duplicatesOf(error);
  async function submit(e: React.FormEvent, allowDuplicate = false) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<Lead>('/platform/sales/leads', {
        method: 'POST',
        body: {
          ...payloadOf(f), ...(ownerId === 'me' ? {} : { ownerId: ownerId || null }),
          ...(nextAction.trim() && nextAt ? { nextAction: nextAction.trim(), nextActionAt: new Date(nextAt).toISOString() } : {}),
          ...(allowDuplicate ? { allowDuplicate: true } : {}),
        },
      });
      setF(emptyForm());
      setNextAction('');
      setNextAt('');
      onCreated(r.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} wide title="Nuevo prospecto" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="lead-form" loading={busy}>Registrar prospecto</Button></>}>
      <form id="lead-form" onSubmit={(e) => submit(e)} className="flex flex-col gap-4">
        {dups ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm" role="alert">
            <p className="font-medium">Ya hay un prospecto con ese correo o teléfono</p>
            <ul className="mt-1 list-disc pl-5">
              {dups.map((d) => <li key={d.id}><Link className="underline" href={`/plataforma/ventas/${d.id}`}>{leadNo(d.number)} · {d.name}{d.company ? ` (${d.company})` : ''}</Link> · {LEAD_STATUS[d.status].label}</li>)}
            </ul>
            <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={(e) => submit(e as unknown as React.FormEvent, true)}>Registrar de todos modos</Button>
          </div>
        ) : <ErrorBox error={error} />}
        <LeadFields f={f} set={(p) => setF({ ...f, ...p })} />
        <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-3">
          <Field label="Responsable">
            <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="me">Yo</option>
              <option value="">Sin responsable</option>
              {owners.data?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </Field>
          <Field label="Próxima acción (opcional)"><Input value={nextAction} onChange={(e) => setNextAction(e.target.value)} maxLength={300} placeholder="Llamar para agendar demo" /></Field>
          <Field label="Fecha de la próxima acción"><Input type="datetime-local" value={nextAt} onChange={(e) => setNextAt(e.target.value)} required={!!nextAction.trim()} /></Field>
        </div>
      </form>
    </Dialog>
  );
}

function Sales() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const owners = useOwners();
  const [view, setView] = useState<'board' | 'list' | 'overdue'>('board');
  const [q, setQ] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [source, setSource] = useState('');
  const [sector, setSector] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const filters = { q: q.trim() || undefined, ownerId: ownerId || undefined, source: source || undefined, sector: sector || undefined };
  const summary = useQuery({ queryKey: ['sales-summary'], queryFn: () => api<Summary>('/platform/sales/summary') });
  const board = useQuery({ queryKey: ['sales-board', filters], queryFn: () => api<Column[]>('/platform/sales/board', { query: filters }), enabled: view === 'board', placeholderData: keepPreviousData });
  const list = useQuery({
    queryKey: ['sales-list', filters, view, status, page],
    queryFn: () => api<Paged>('/platform/sales/leads', { query: { ...filters, page, status: view === 'list' ? status || undefined : undefined, view: view === 'overdue' ? 'overdue' : undefined } }),
    enabled: view !== 'board', placeholderData: keepPreviousData,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['sales-board'] });
    void qc.invalidateQueries({ queryKey: ['sales-list'] });
    void qc.invalidateQueries({ queryKey: ['sales-summary'] });
  };
  const open = (id: string) => router.push(`/plataforma/ventas/${id}`);
  const s = summary.data;
  const tabs = [
    { k: 'board', label: 'Embudo', icon: Columns3 },
    { k: 'list', label: 'Lista', icon: List },
    { k: 'overdue', label: `Vencidas${s?.overdue ? ` (${s.overdue})` : ''}`, icon: AlarmClock },
  ] as const;

  return (
    <>
      <PageHeader
        title="Ventas"
        description="Centro comercial de AI Sales Assistant: prospectos, embudo, historial y conversión en clientes."
        actions={<Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Nuevo prospecto</Button>}
      />
      {s && (
        <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Prospectos abiertos" value={num(s.open)} icon={<Target className="size-4" />} hint={`Presupuesto estimado: ${budgetText(s.openBudget)}`} />
          <StatCard label="Próximas acciones vencidas" value={num(s.overdue)} icon={<AlarmClock className="size-4" />} tone={s.overdue ? 'danger' : undefined} />
          <StatCard label="Sin responsable" value={num(s.unassigned)} icon={<UserX className="size-4" />} tone={s.unassigned ? 'warning' : undefined} />
          <StatCard label="Ganados (90 días)" value={num(s.closed90.won)} hint={`${num(s.closed90.lost)} ${s.closed90.lost === 1 ? 'perdido' : 'perdidos'} · ${s.closed90.winRate === null ? 'aún no hay cierres' : `tasa de cierre ${s.closed90.winRate} %`}`} />
        </div>
      )}
      <Card className="mb-4 flex flex-col gap-3 p-3 lg:flex-row lg:items-end">
        <div className="flex gap-1 rounded-lg bg-surface-2 p-1" role="tablist" aria-label="Vista">
          {tabs.map((t) => (
            <button key={t.k} type="button" role="tab" aria-selected={view === t.k} onClick={() => { setView(t.k); setPage(1); }} className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm', view === t.k ? 'bg-surface font-medium shadow-sm' : 'text-muted hover:text-text')}>
              <t.icon className="size-4" />{t.label}
            </button>
          ))}
        </div>
        <div className="grid flex-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <div className="relative lg:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input className="pl-9" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Nombre, empresa, correo, teléfono o P-0001" aria-label="Buscar prospecto" />
          </div>
          <Select value={ownerId} onChange={(e) => { setOwnerId(e.target.value); setPage(1); }} aria-label="Filtrar por responsable">
            <option value="">Todos los responsables</option>
            <option value="none">Sin responsable</option>
            {owners.data?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </Select>
          <Select value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }} aria-label="Filtrar por fuente">
            <option value="">Todas las fuentes</option>
            {Object.entries(SOURCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Select value={sector} onChange={(e) => { setSector(e.target.value); setPage(1); }} aria-label="Filtrar por sector">
            <option value="">Todos los sectores</option>
            {Object.entries(SECTOR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </div>
        {view === 'list' && (
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Filtrar por etapa" className="lg:w-52">
            <option value="">Todas las etapas</option>
            {Object.entries(LEAD_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
        )}
      </Card>

      {view === 'board' ? (
        board.isLoading ? <Loading /> : board.error ? <ErrorBox error={board.error} /> : board.data!.every((c) => !c.count) ? (
          <EmptyState icon={<Target className="size-6" />} title="Sin prospectos" description="Registra el primero con «Nuevo prospecto». Más adelante llegarán también desde la página comercial y el WhatsApp comercial." />
        ) : (
          <>
            <p className="mb-2 text-xs text-muted">Arrastra una tarjeta para cambiar de etapa. «Pago confirmado», «Instalación pendiente» y «Cliente activo» no se mueven a mano.</p>
            <Board columns={board.data!} onOpen={open} onMoved={refresh} />
          </>
        )
      ) : list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : !list.data!.items.length ? (
        <EmptyState icon={<Target className="size-6" />} title={view === 'overdue' ? 'Nada vencido' : 'Sin resultados'} description={view === 'overdue' ? 'Todas las próximas acciones están al día.' : 'Cambia los filtros o registra un prospecto.'} />
      ) : (
        <>
          <Table>
            <thead><tr><Th>Prospecto</Th><Th>Etapa</Th><Th>Responsable</Th><Th>Próxima acción</Th><Th className="text-right">Presupuesto</Th><Th>Fuente</Th><Th>Actualizado</Th></tr></thead>
            <tbody>
              {list.data!.items.map((l) => (
                <tr key={l.id} className="cursor-pointer hover:bg-surface-2/60" onClick={() => open(l.id)}>
                  <Td><Link href={`/plataforma/ventas/${l.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{l.name}</Link><p className="text-xs text-muted">{leadNo(l.number)}{l.company ? ` · ${l.company}` : ''}</p></Td>
                  <Td><Badge tone={LEAD_STATUS[l.status].tone}>{LEAD_STATUS[l.status].label}</Badge></Td>
                  <Td>{l.owner?.name ?? <span className="text-muted">Sin responsable</span>}</Td>
                  <Td className={cn('text-xs', isOverdue(l) ? 'font-medium text-danger' : '')}>{l.nextAction ? <>{l.nextAction}<br />{dateTime(l.nextActionAt)}</> : <span className="text-muted">—</span>}</Td>
                  <Td className="text-right tabular-nums">{l.estimatedBudget ? money(l.estimatedBudget, l.budgetCurrency) : '—'}</Td>
                  <Td className="text-xs">{SOURCE[l.source]}</Td>
                  <Td className="text-xs text-muted">{dateTime(l.updatedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={list.data!.page} pages={list.data!.pages} total={list.data!.total} onPage={setPage} />
        </>
      )}

      <NewLeadDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); toast.success('Prospecto registrado'); refresh(); open(id); }} />
    </>
  );
}

export default function SalesPage() {
  return <RequirePermission permission="platform:manage"><Sales /></RequirePermission>;
}
