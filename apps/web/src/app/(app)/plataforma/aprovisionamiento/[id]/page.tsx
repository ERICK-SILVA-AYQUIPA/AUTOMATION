'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Circle, CircleAlert, CircleDot, RotateCw, X } from 'lucide-react';
import Link from 'next/link';
import { use, useState } from 'react';
import { RequirePermission } from '@/components/guard';
import { Badge, Button, Card, Dialog, ErrorBox, Field, Input, Loading, PageHeader, Textarea, cn } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { eur } from '../../infraestructura/shared';
import { ACTIVE, RUN_STATUS, installNo, type RunDetail } from '../shared';

const SOURCE: Record<string, string> = { engine: 'Plataforma', user: 'Persona', agent: 'Servidor' };

function Steps({ r }: { r: RunDetail }) {
  const current = r.stoppedAt ?? r.status;
  const idx = r.status === 'DELIVERED' ? r.flow.length : r.flow.indexOf(current);
  const steps = r.flow.filter((s) => s !== 'PAYMENT_PENDING' || current === 'PAYMENT_PENDING');
  return (
    <ol className="flex flex-col gap-1.5 text-sm" aria-label="Pasos de la instalación">
      {steps.map((s) => {
        const i = r.flow.indexOf(s);
        const done = i < idx;
        const here = i === idx && r.status !== 'CANCELLED';
        const stopped = here && !!r.stoppedAt;
        return (
          <li key={s} className={cn('flex items-center gap-2', !done && !here && 'text-muted')} aria-current={here ? 'step' : undefined}>
            {done ? <Check className="size-4 text-success" /> : stopped ? <CircleAlert className="size-4 text-danger" /> : here ? <CircleDot className="size-4 text-primary" /> : <Circle className="size-4" />}
            <span className={cn(here && 'font-medium')}>{RUN_STATUS[s]?.label ?? s}</span>
          </li>
        );
      })}
      <li className={cn('flex items-center gap-2', r.status !== 'DELIVERED' && 'text-muted')}>
        {r.status === 'DELIVERED' ? <Check className="size-4 text-success" /> : <Circle className="size-4" />}<span>Entregada</span>
      </li>
    </ol>
  );
}

function CancelDialog({ r, onClose, onDone }: { r: RunDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const server = r.server && !r.server.deletedAt ? r.server : null;
  const [reason, setReason] = useState('');
  const [release, setRelease] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      await api(`/platform/provisioning/runs/${r.id}/cancel`, { method: 'POST', body: { reason, ...(release ? { releaseServer: { confirmName: name } } : {}) } });
      toast.success('Instalación cancelada');
      onDone();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title={`Cancelar la instalación #${r.number}`} footer={<><Button variant="secondary" onClick={onClose}>Volver</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 5 || (release && name !== server?.name)} onClick={go}>Cancelar instalación</Button></>}>
      <div className="flex flex-col gap-4">
        <ErrorBox error={error} />
        <Field label="Motivo"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000} /></Field>
        {r.serverRequest?.status === 'PENDING_APPROVAL' && <p className="text-sm text-muted">La solicitud de servidor #{r.serverRequest.number} pendiente se cancela también.</p>}
        {server && (
          <>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={release} onChange={(e) => setRelease(e.target.checked)} /><span>Eliminar también el servidor {server.name} (deja de generar costo; no se puede deshacer)</span></label>
            {release && <Field label={`Escribe el nombre del servidor (${server.name})`}><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>}
            {!release && <p className="text-sm text-warning">Si no lo eliminas, el servidor sigue activo y generando costo.</p>}
          </>
        )}
      </div>
    </Dialog>
  );
}

function Detail({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['prov-run', id], queryFn: () => api<RunDetail>(`/platform/provisioning/runs/${id}`), refetchInterval: (query) => (query.state.data && ACTIVE.includes(query.state.data.status) ? 4000 : false) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const r = q.data!;
  const st = RUN_STATUS[r.status] ?? { label: r.status, tone: 'neutral' as const };
  const reload = () => void qc.invalidateQueries({ queryKey: ['prov-run', id] });
  const closed = r.status === 'DELIVERED' || r.status === 'CANCELLED';
  const dnsStep = r.server?.ipv4 && ['SERVER_READY', 'CONFIGURING_SERVER'].includes(r.stoppedAt ?? r.status);
  async function retry() {
    setBusy(true);
    try {
      await api(`/platform/provisioning/runs/${id}/retry`, { method: 'POST' });
      toast.success('Reintentando');
      reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-6">
      <Link href="/plataforma/aprovisionamiento" className="flex items-center gap-1 text-sm text-muted"><ArrowLeft className="size-4" />Instalaciones automáticas</Link>
      <PageHeader
        title={`Instalación #${r.number} · ${r.domain}`}
        description={`${installNo(r.installationOrder.number)} · ${r.installationOrder.lead.company ?? r.installationOrder.lead.name}${r.installationOrder.tenant ? ` · empresa ${r.installationOrder.tenant.name}` : ''}`}
        actions={<>
          {r.stoppedAt && <Button icon={<RotateCw className="size-4" />} loading={busy} onClick={retry}>Reintentar</Button>}
          {!closed && <Button variant="secondary" icon={<X className="size-4" />} onClick={() => setCancelling(true)}>Cancelar</Button>}
        </>}
      />
      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <Card className="flex flex-col gap-4 p-5">
          <div className="flex flex-wrap items-center gap-2"><Badge tone={st.tone}>{st.label}</Badge>{r.attempts > 0 && !closed && <span className="text-xs text-muted">intento {r.attempts}</span>}</div>
          <Steps r={r} />
        </Card>
        <div className="flex flex-col gap-4">
          {r.stoppedAt && (
            <Card className="border-danger/50 p-5 text-sm">
              <h2 className="mb-1 font-semibold">Qué pasó y qué hacer</h2>
              <p>{r.lastError}</p>
              {r.needs && <p className="mt-1">{r.needs}</p>}
            </Card>
          )}
          {r.status === 'CREATING_INFRA' && r.serverRequest?.status === 'PENDING_APPROVAL' && (
            <Card className="border-warning/50 p-5 text-sm">
              <p>El servidor espera tu aprobación: solicitud #{r.serverRequest.number} ({r.serverRequest.name}, {eur(r.serverRequest.priceMonthly, r.serverRequest.currency)} por mes).</p>
              <Link href="/plataforma/infraestructura?tab=solicitudes" className="text-primary underline">Aprobar en Infraestructura</Link>
            </Card>
          )}
          {dnsStep && (
            <Card className="p-5 text-sm">
              <h2 className="mb-1 font-semibold">Apunta el dominio al servidor</h2>
              <p>Crea en el DNS del dominio un registro <strong>A</strong>: <code className="font-mono">{r.domain}</code> → <code className="font-mono">{r.server!.ipv4}</code>. El servidor espera hasta 3 horas a que el dominio apunte a él para pedir el certificado HTTPS.</p>
            </Card>
          )}
          {r.status === 'DELIVERED' && (
            <Card className="border-success/50 p-5 text-sm">
              <p>Entregada el {dateTime(r.finishedAt!)}: <a className="text-primary underline" href={`https://${r.domain}`} target="_blank" rel="noreferrer">https://{r.domain}</a>. El administrador ({r.adminEmail}) crea su contraseña con «¿Olvidaste tu contraseña?».</p>
            </Card>
          )}
          {r.status === 'CANCELLED' && <Card className="p-5 text-sm">Cancelada: {r.cancelReason}</Card>}
          <Card className="grid gap-2 p-5 text-sm sm:grid-cols-2">
            <p><span className="text-muted">Proveedor:</span> {r.provider.label} · {r.serverType} en {r.location}</p>
            <p><span className="text-muted">Servidor:</span> {r.server ? `${r.server.name}${r.server.ipv4 ? ` · ${r.server.ipv4}` : ''}${r.server.deletedAt ? ' (eliminado)' : ''}` : 'aún no creado'}</p>
            <p><span className="text-muted">Administrador:</span> {r.adminEmail}</p>
            <p><span className="text-muted">Correo:</span> {r.settings.smtp.host}:{r.settings.smtp.port} · {r.settings.smtp.from}</p>
            <p><span className="text-muted">Último contacto del servidor:</span> {r.agentSeenAt ? dateTime(r.agentSeenAt) : 'ninguno'}</p>
            <p><span className="text-muted">Plazo del paso:</span> {r.stepDeadlineAt && !closed && !r.stoppedAt ? dateTime(r.stepDeadlineAt) : '—'}</p>
          </Card>
          <Card className="p-5">
            <h2 className="mb-3 font-semibold">Historial</h2>
            <ol className="flex flex-col gap-2 text-sm">
              {[...r.events].reverse().map((e) => (
                <li key={e.id} className="flex flex-col gap-0.5 border-b border-border pb-2 last:border-0">
                  <span className="flex flex-wrap items-center gap-2 text-xs text-muted">{dateTime(e.createdAt)} · {SOURCE[e.source]} · {RUN_STATUS[e.status]?.label ?? e.status}{e.level !== 'info' && <Badge tone={e.level === 'error' ? 'danger' : 'warning'}>{e.level === 'error' ? 'Error' : 'Aviso'}</Badge>}</span>
                  <span>{e.message}</span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
      {cancelling && <CancelDialog r={r} onClose={() => setCancelling(false)} onDone={reload} />}
    </div>
  );
}

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <RequirePermission permission="platform:manage">
      <Detail id={id} />
    </RequirePermission>
  );
}
