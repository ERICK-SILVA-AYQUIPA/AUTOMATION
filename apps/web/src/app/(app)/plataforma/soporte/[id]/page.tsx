'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { RequirePermission } from '@/components/guard';
import { SupportThread } from '@/components/support-thread';
import { Badge, Button, Card, ErrorBox, Field, Loading, PageHeader, Select, Textarea } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { DEPLOYMENT_MODE, dateTime } from '@/lib/format';
import { KIND, PRIORITY, SOURCE, STATUS, ticketNo, type SupportPriority, type SupportStatus, type TicketDetail } from '@/lib/support';
import { useOwners } from '../../ventas/shared';

interface Detail extends TicketDetail {
  tenant: { id: string; name: string; deploymentMode: string };
  assignee: { id: string; name: string } | null;
  createdBy: { name: string; email: string } | null;
  provisioningRun: { id: string; number: number; domain: string | null } | null;
}

function TicketAdmin() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const owners = useOwners();
  const q = useQuery({ queryKey: ['platform-ticket', id], queryFn: () => api<Detail>(`/platform/support/tickets/${id}`) });
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const set = (t: Detail) => {
    qc.setQueryData(['platform-ticket', id], t);
    void qc.invalidateQueries({ queryKey: ['platform-support'] });
    void qc.invalidateQueries({ queryKey: ['support-summary'] });
  };
  async function run(key: string, fn: () => Promise<Detail>, ok: string) {
    setBusy(key);
    try {
      set(await fn());
      toast.success(ok);
      return true;
    } catch (err) {
      toast.error(err);
      return false;
    } finally {
      setBusy(null);
    }
  }
  async function send(e: FormEvent, internal: boolean) {
    e.preventDefault();
    if (!body.trim()) return;
    if (await run(internal ? 'note' : 'reply', () => api<Detail>(`/platform/support/tickets/${id}/messages`, { method: 'POST', body: { body, internal } }), internal ? 'Nota interna guardada' : 'Respuesta enviada al cliente')) setBody('');
  }
  const patch = (key: string, data: Record<string, unknown>, ok: string) => run(key, () => api<Detail>(`/platform/support/tickets/${id}`, { method: 'PATCH', body: data }), ok);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const t = q.data!;
  const closed = t.status === 'CLOSED';
  return (
    <div className="flex flex-col gap-6">
      <Link href="/plataforma/soporte" className="flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft className="size-4" /> Soporte</Link>
      <PageHeader title={`${ticketNo(t.number)} · ${t.subject}`} description={`${t.tenant.name} · ${KIND[t.kind]} · ${SOURCE[t.source]} · abierto el ${dateTime(t.createdAt)}`} actions={<Badge tone={STATUS[t.status].tone}>{STATUS[t.status].staff}</Badge>} />
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="flex flex-col gap-4">
          <SupportThread messages={t.messages} staff />
          {closed ? <p className="text-sm text-muted">Caso cerrado.</p> : (
            <form onSubmit={(e) => send(e, false)} className="flex flex-col gap-2">
              <Field label="Mensaje"><Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={10000} /></Field>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" loading={busy === 'reply'} disabled={!body.trim()}>Responder al cliente</Button>
                <Button type="button" variant="secondary" loading={busy === 'note'} disabled={!body.trim()} onClick={(e) => send(e, true)}>Guardar como nota interna</Button>
              </div>
            </form>
          )}
        </div>
        <Card className="flex h-fit flex-col gap-4 p-4 text-sm">
          <Field label="Estado">
            <Select value={t.status} disabled={!!busy || closed} onChange={(e) => patch('status', { status: e.target.value }, 'Estado actualizado')}>
              {(Object.keys(STATUS) as SupportStatus[]).map((k) => <option key={k} value={k}>{STATUS[k].staff}</option>)}
            </Select>
          </Field>
          <Field label="Prioridad">
            <Select value={t.priority} disabled={!!busy || closed} onChange={(e) => patch('priority', { priority: e.target.value }, 'Prioridad actualizada')}>
              {(Object.keys(PRIORITY) as SupportPriority[]).map((k) => <option key={k} value={k}>{PRIORITY[k].label}</option>)}
            </Select>
          </Field>
          <Field label="Responsable">
            <Select value={t.assignee?.id ?? ''} disabled={!!busy || closed} onChange={(e) => patch('assignee', { assigneeId: e.target.value || null }, 'Responsable actualizado')}>
              <option value="">Sin asignar</option>
              {owners.data?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </Field>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted">Primera respuesta</dt>
            <dd>{t.firstResponseAt ? dateTime(t.firstResponseAt) : t.due.overdue ? <Badge tone="danger">Vencida ({dateTime(t.due.due)})</Badge> : `Antes del ${dateTime(t.due.due)}`}</dd>
            {t.resolvedAt && <><dt className="text-muted">Resuelto</dt><dd>{dateTime(t.resolvedAt)}</dd></>}
            {t.ratedAt && <><dt className="text-muted">Calificación</dt><dd>{t.rating} / 5{t.ratingComment ? ` · “${t.ratingComment}”` : ''}</dd></>}
            <dt className="text-muted">Modalidad</dt><dd>{DEPLOYMENT_MODE[t.tenant.deploymentMode] ?? t.tenant.deploymentMode}</dd>
            {t.createdBy && <><dt className="text-muted">Abierto por</dt><dd>{t.createdBy.name}</dd></>}
          </dl>
          <div className="flex flex-col gap-1">
            <Link href={`/plataforma?empresa=${t.tenant.id}`} className="text-primary hover:underline">Ver la empresa</Link>
            {t.provisioningRun && <Link href={`/plataforma/aprovisionamiento/${t.provisioningRun.id}`} className="text-primary hover:underline">Ver la instalación{t.provisioningRun.domain ? ` (${t.provisioningRun.domain})` : ''}</Link>}
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function PlatformTicketPage() {
  return <RequirePermission permission="platform:manage"><TicketAdmin /></RequirePermission>;
}
