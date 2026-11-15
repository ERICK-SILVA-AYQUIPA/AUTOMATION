'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, ArrowLeft, Building2, CheckCircle2, UserPlus, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { DEPLOYMENT_MODE, MODULE_LABEL, PAYMENT_METHOD, dateTime, money } from '@/lib/format';
import { Badge, Button, Card, Dialog, ErrorBox, Field, Input, Loading, PageHeader, Select, Textarea, cn } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';
import { ACTIVITY, LEAD_STATUS, LeadFields, LostDialog, MANUAL, PLAN, SECTOR, SOURCE, formOf, isOverdue, leadNo, payloadOf, toLocalInput, useOwners, type Lead, type LeadStatus } from '../shared';

interface Activity { id: string; type: string; body: string | null; metadata: Record<string, unknown>; userName: string | null; createdAt: string }
interface Detail extends Lead { tenant: { id: string; name: string; status: string; activatedAt: string | null } | null; activities: Activity[] }

const FIELD: Record<string, string> = {
  name: 'Nombre', company: 'Empresa', phone: 'Teléfono', email: 'Correo', sector: 'Sector', need: 'Necesidad', source: 'Fuente', sourceDetail: 'Detalle de la fuente',
  estimatedBudget: 'Presupuesto', budgetCurrency: 'Moneda', interestMode: 'Modalidad', interestPlan: 'Plan', interestModules: 'Módulos',
};

/** Una línea legible por entrada del historial */
function describe(a: Activity, owners: Map<string, string>) {
  const m = a.metadata;
  const st = (k: unknown) => LEAD_STATUS[k as LeadStatus]?.label ?? String(k);
  switch (a.type) {
    case 'STATUS_CHANGED':
      return `${st(m.from)} → ${st(m.to)}`;
    case 'OWNER_CHANGED':
      return `${m.from ? (owners.get(String(m.from)) ?? 'otro') : 'Sin responsable'} → ${m.to ? (owners.get(String(m.to)) ?? 'otro') : 'Sin responsable'}`;
    case 'UPDATED':
      return Object.keys((m.changes as object) ?? {}).map((k) => FIELD[k] ?? k).join(', ');
    case 'NEXT_ACTION_SET':
      return `Para el ${dateTime(m.dueAt as string)}`;
    case 'NEXT_ACTION_DONE':
      return `${String(m.action)}${m.late ? ' (con retraso)' : ''}`;
    case 'PAYMENT_VALIDATED':
      return `${money(String(m.amount), String(m.currency))} por ${PAYMENT_METHOD[String(m.method)] ?? m.method} · operación ${String(m.reference)} · pagado el ${dateTime(String(m.paidAt))} · ingreso verificado en la cuenta`;
    case 'CONVERTED':
      return `Empresa creada: ${String(m.tenantName)} (${PLAN[String(m.planCode)] ?? m.planCode}, ${DEPLOYMENT_MODE[String(m.deploymentMode)] ?? m.deploymentMode})`;
    case 'CREATED':
      return `Fuente: ${SOURCE[String(m.source)] ?? m.source}`;
    default:
      return null;
  }
}

function PaymentDialog({ lead, open, onClose, onDone }: { lead: Lead; open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ amount: lead.estimatedBudget ?? '', currency: lead.budgetCurrency, method: 'YAPE', reference: '', paidAt: toLocalInput(new Date().toISOString()), note: '', verified: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/platform/sales/leads/${lead.id}/payment`, {
        method: 'POST',
        body: { amount: f.amount.trim(), currency: f.currency, method: f.method, reference: f.reference.trim(), paidAt: new Date(f.paidAt).toISOString(), verifiedInAccount: f.verified, note: f.note.trim() || null },
      });
      onDone();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Validar pago" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="pay-form" loading={busy} disabled={!f.verified}>Confirmar pago</Button></>}>
      <form id="pay-form" onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-muted">Un comprobante enviado por el cliente no prueba que el dinero llegó. Confirma solo después de ver el ingreso en la cuenta (Yape, banco…). Queda en el historial con tu nombre.</p>
        <ErrorBox error={error} />
        <div className="grid grid-cols-[1fr_6rem] gap-2">
          <Field label="Importe recibido"><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required /></Field>
          <Field label="Moneda"><Input value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} required /></Field>
        </div>
        <Field label="Medio">
          <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            {Object.entries(PAYMENT_METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Número de operación"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} maxLength={120} required /></Field>
        <Field label="Fecha y hora del pago"><Input type="datetime-local" value={f.paidAt} onChange={(e) => setF({ ...f, paidAt: e.target.value })} required /></Field>
        <Field label="Nota (opcional)"><Textarea value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={2000} rows={2} /></Field>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 accent-[var(--primary)]" checked={f.verified} onChange={(e) => setF({ ...f, verified: e.target.checked })} />
          <span>Verifiqué el ingreso en la cuenta (no solo el comprobante)</span>
        </label>
      </form>
    </Dialog>
  );
}

function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const owners = useOwners();
  const q = useQuery({ queryKey: ['sales-lead', id], queryFn: () => api<Detail>(`/platform/sales/leads/${id}`) });
  const [edit, setEdit] = useState<ReturnType<typeof formOf> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [target, setTarget] = useState<LeadStatus | ''>('');
  const [statusNote, setStatusNote] = useState('');
  const [lost, setLost] = useState(false);
  const [paying, setPaying] = useState(false);
  const [act, setAct] = useState({ type: 'NOTE', body: '' });
  const [next, setNext] = useState<{ text: string; at: string } | null>(null);
  const [doneNote, setDoneNote] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['sales-lead', id] });
    void qc.invalidateQueries({ queryKey: ['sales-board'] });
    void qc.invalidateQueries({ queryKey: ['sales-list'] });
    void qc.invalidateQueries({ queryKey: ['sales-summary'] });
  };
  async function run(key: string, fn: () => Promise<unknown>, ok: string, after?: () => void) {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      after?.();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
      refresh();
    }
  }
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const l = q.data!;
  const ownerNames = new Map((owners.data ?? []).map((o) => [o.id, o.name]));
  const closed = l.status === 'INSTALLATION_PENDING' || l.status === 'ACTIVE_CLIENT';
  const targets = l.status === 'PAYMENT_CONFIRMED' ? (['LOST'] as LeadStatus[]) : closed ? [] : MANUAL.filter((s) => s !== l.status);
  const nextForm = next ?? { text: l.nextAction ?? '', at: toLocalInput(l.nextActionAt) };

  return (
    <>
      <Link href="/plataforma/ventas" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft className="size-4" />Ventas</Link>
      <PageHeader
        title={`${leadNo(l.number)} · ${l.name}`}
        description={[l.company, l.email, l.phone].filter(Boolean).join(' · ')}
        actions={<Badge tone={LEAD_STATUS[l.status].tone}>{LEAD_STATUS[l.status].label}</Badge>}
      />
      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-5">
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="font-medium">Datos del prospecto</h2>
              {!edit && <Button size="sm" variant="secondary" onClick={() => setEdit(formOf(l))}>Editar</Button>}
            </div>
            {edit ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run('edit', () => api(`/platform/sales/leads/${l.id}`, { method: 'PATCH', body: payloadOf(edit) }), 'Datos guardados', () => setEdit(null));
                }}
                className="flex flex-col gap-4"
              >
                <LeadFields f={edit} set={(p) => setEdit({ ...edit, ...p })} />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="secondary" onClick={() => setEdit(null)}>Cancelar</Button>
                  <Button type="submit" loading={busy === 'edit'}>Guardar cambios</Button>
                </div>
              </form>
            ) : (
              <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[11rem_1fr]">
                {([
                  ['Sector', l.sector ? SECTOR[l.sector] : '—'],
                  ['Necesidad', l.need ?? '—'],
                  ['Fuente', `${SOURCE[l.source]}${l.sourceDetail ? ` · ${l.sourceDetail}` : ''}`],
                  ['Presupuesto estimado', l.estimatedBudget ? money(l.estimatedBudget, l.budgetCurrency) : '—'],
                  ['Solución de interés', [l.interestMode && DEPLOYMENT_MODE[l.interestMode], l.interestPlan && `Plan ${PLAN[l.interestPlan]}`].filter(Boolean).join(' · ') || '—'],
                  ['Módulos de interés', l.interestModules.length ? l.interestModules.map((m) => MODULE_LABEL[m] ?? m).join(', ') : '—'],
                  ['Registrado', dateTime(l.createdAt)],
                  ['Acepta seguimiento', l.followUpConsent ? `Sí (${l.followUpConsentSource === 'web' ? 'página web' : l.followUpConsentSource === 'whatsapp' ? 'WhatsApp' : 'registro'}${l.followUpConsentAt ? `, ${dateTime(l.followUpConsentAt)}` : ''})` : 'No consta'],
                  ...(l.lostReason ? [['Motivo de la pérdida', l.lostReason]] : []),
                ] as [string, string][]).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="whitespace-pre-line">{v}</dd></div>)}
              </dl>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 font-medium">Historial</h2>
            <form
              className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                void run('act', () => api(`/platform/sales/leads/${l.id}/activities`, { method: 'POST', body: { type: act.type, body: act.body.trim() } }), 'Registrado en el historial', () => setAct({ ...act, body: '' }));
              }}
            >
              <Field label="Tipo" className="sm:w-36">
                <Select value={act.type} onChange={(e) => setAct({ ...act, type: e.target.value })}>
                  {['NOTE', 'CALL', 'WHATSAPP', 'EMAIL', 'MEETING'].map((t) => <option key={t} value={t}>{ACTIVITY[t]}</option>)}
                </Select>
              </Field>
              <Field label="Detalle" className="flex-1"><Input value={act.body} onChange={(e) => setAct({ ...act, body: e.target.value })} maxLength={5000} required placeholder="Qué se habló, qué pidió…" /></Field>
              <Button type="submit" loading={busy === 'act'} disabled={!act.body.trim()}>Registrar</Button>
            </form>
            <ol className="flex flex-col gap-3 border-l border-border pl-4" aria-label="Historial del prospecto">
              {l.activities.map((a) => {
                const line = describe(a, ownerNames);
                return (
                  <li key={a.id} className="relative text-sm">
                    <span className="absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-surface bg-primary" />
                    <p><span className="font-medium">{ACTIVITY[a.type] ?? a.type}</span>{line ? <span className="text-muted"> · {line}</span> : null}</p>
                    {a.body && <p className="whitespace-pre-line">{a.body}</p>}
                    <p className="text-xs text-muted">{dateTime(a.createdAt)} · {a.userName ?? 'Sistema'}</p>
                  </li>
                );
              })}
            </ol>
          </Card>
          <WebChats leadId={l.id} />
        </div>

        <div className="flex flex-col gap-5">
          <Card className="flex flex-col gap-3 p-5">
            <h2 className="font-medium">Etapa</h2>
            <p className="text-sm">
              <Badge tone={LEAD_STATUS[l.status].tone}>{LEAD_STATUS[l.status].label}</Badge>
              <span className="ml-2 text-xs text-muted">desde {dateTime(l.statusChangedAt)}</span>
            </p>
            {targets.length > 0 && (
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!target) return;
                  if (target === 'LOST') return setLost(true);
                  void run('status', () => api(`/platform/sales/leads/${l.id}/status`, { method: 'POST', body: { status: target, note: statusNote.trim() || null } }), `Etapa: ${LEAD_STATUS[target].label}`, () => { setTarget(''); setStatusNote(''); });
                }}
              >
                <Field label="Mover a">
                  <Select value={target} onChange={(e) => setTarget(e.target.value as LeadStatus)}>
                    <option value="">Elige una etapa</option>
                    {targets.map((s) => <option key={s} value={s}>{LEAD_STATUS[s].label}</option>)}
                  </Select>
                </Field>
                {target && target !== 'LOST' && <Field label="Nota (opcional)"><Input value={statusNote} onChange={(e) => setStatusNote(e.target.value)} maxLength={2000} /></Field>}
                <Button type="submit" variant="secondary" loading={busy === 'status'} disabled={!target}>Cambiar etapa</Button>
              </form>
            )}
            {l.status === 'PAYMENT_PENDING' && <Button icon={<Wallet className="size-4" />} onClick={() => setPaying(true)}>Validar pago</Button>}
            {l.status === 'PAYMENT_CONFIRMED' && (
              <Link href={`/plataforma/nueva?lead=${l.id}`} className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg hover:opacity-90">
                <UserPlus className="size-4" />Convertir en cliente
              </Link>
            )}
            {l.status !== 'PAYMENT_PENDING' && l.status !== 'PAYMENT_CONFIRMED' && !closed && <p className="text-xs text-muted">Para confirmar un pago, pásalo primero a «Pendiente de pago».</p>}
            {l.tenant && (
              <div className="rounded-lg border border-border p-3 text-sm">
                <p className="flex items-center gap-2 font-medium"><Building2 className="size-4" />{l.tenant.name}</p>
                <p className="text-xs text-muted">{l.tenant.status === 'ACTIVE' ? `Activa desde ${dateTime(l.tenant.activatedAt)}` : l.tenant.status === 'ONBOARDING' ? 'En preparación: al activarla, el prospecto pasa a «Cliente activo»' : 'Suspendida'}</p>
                <Link href={`/plataforma?empresa=${l.tenant.id}`} className="text-xs text-primary underline">Abrir la ficha de la empresa</Link>
              </div>
            )}
          </Card>

          <Card className="flex flex-col gap-3 p-5">
            <h2 className="font-medium">Responsable</h2>
            <Select
              aria-label="Responsable"
              value={l.ownerId ?? ''}
              disabled={busy === 'owner'}
              onChange={(e) => void run('owner', () => api(`/platform/sales/leads/${l.id}/owner`, { method: 'POST', body: { ownerId: e.target.value || null } }), 'Responsable actualizado')}
            >
              <option value="">Sin responsable</option>
              {owners.data?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </Card>

          <Card className="flex flex-col gap-3 p-5">
            <h2 className="flex items-center gap-2 font-medium"><AlarmClock className="size-4" />Próxima acción</h2>
            {l.nextAction && (
              <div className={cn('rounded-lg border p-3 text-sm', isOverdue(l) ? 'border-danger/50 bg-danger/5' : 'border-border')}>
                <p className="font-medium">{l.nextAction}</p>
                <p className={cn('text-xs', isOverdue(l) ? 'font-medium text-danger' : 'text-muted')}>{isOverdue(l) ? 'Vencida: ' : ''}{dateTime(l.nextActionAt)}</p>
                <div className="mt-2 flex gap-2">
                  <Input value={doneNote} onChange={(e) => setDoneNote(e.target.value)} placeholder="Resultado (opcional)" aria-label="Resultado de la acción" maxLength={2000} />
                  <Button size="sm" variant="secondary" icon={<CheckCircle2 className="size-4" />} loading={busy === 'done'} onClick={() => void run('done', () => api(`/platform/sales/leads/${l.id}/next-action/done`, { method: 'POST', body: { note: doneNote.trim() || null } }), 'Acción marcada como hecha', () => { setDoneNote(''); setNext(null); })}>Hecha</Button>
                </div>
              </div>
            )}
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run('next', () => api(`/platform/sales/leads/${l.id}/next-action`, { method: 'PUT', body: { text: nextForm.text.trim(), dueAt: new Date(nextForm.at).toISOString() } }), 'Próxima acción guardada', () => setNext(null));
              }}
            >
              <Field label={l.nextAction ? 'Cambiar por' : 'Qué hay que hacer'}><Input value={nextForm.text} onChange={(e) => setNext({ ...nextForm, text: e.target.value })} maxLength={300} required /></Field>
              <Field label="Cuándo"><Input type="datetime-local" value={nextForm.at} onChange={(e) => setNext({ ...nextForm, at: e.target.value })} required /></Field>
              <Button type="submit" variant="secondary" loading={busy === 'next'}>Guardar próxima acción</Button>
            </form>
          </Card>
        </div>
      </div>
      <LostDialog lead={lost ? l : null} onClose={() => setLost(false)} onDone={() => { toast.success('Marcado como perdido'); setTarget(''); refresh(); }} />
      {paying && <PaymentDialog lead={l} open onClose={() => setPaying(false)} onDone={() => { toast.success('Pago validado: ya puedes convertirlo en cliente'); refresh(); }} />}
    </>
  );
}

interface Chat { id: string; createdAt: string; messageCount: number; handoffAt: string | null; handoffReason: string | null; messages: { role: 'VISITOR' | 'AGENT'; text: string; tools: string[]; createdAt: string }[] }

/** Conversaciones del chat de la página comercial (agente comercial) */
function WebChats({ leadId }: { leadId: string }) {
  const q = useQuery({ queryKey: ['sales-lead-chats', leadId], queryFn: () => api<Chat[]>(`/platform/commercial/leads/${leadId}/chats`) });
  if (!q.data?.length) return null;
  return (
    <Card className="p-5">
      <h2 className="mb-3 font-medium">Chat de la página web</h2>
      <div className="flex flex-col gap-3">
        {q.data.map((c) => (
          <details key={c.id} className="rounded-lg border border-border p-3" open={q.data.length === 1}>
            <summary className="cursor-pointer text-sm">{dateTime(c.createdAt)} · {c.messageCount} mensajes{c.handoffAt ? ` · pidió un vendedor (${c.handoffReason ?? ''})` : ''}</summary>
            <ol className="mt-3 flex flex-col gap-2" aria-label="Mensajes del chat web">
              {c.messages.map((m, i) => (
                <li key={i} className={cn('max-w-[85%] rounded-lg p-2 text-sm', m.role === 'VISITOR' ? 'bg-surface-2' : 'ml-auto bg-primary/10')}>
                  <p className="text-xs text-muted">{m.role === 'VISITOR' ? 'Visitante' : 'Agente'} · {dateTime(m.createdAt)}{m.tools.length ? ` · ${m.tools.join(', ')}` : ''}</p>
                  <p className="whitespace-pre-line">{m.text}</p>
                </li>
              ))}
            </ol>
          </details>
        ))}
      </div>
    </Card>
  );
}

export default function LeadPage() {
  return <RequirePermission permission="platform:manage"><LeadDetail /></RequirePermission>;
}
