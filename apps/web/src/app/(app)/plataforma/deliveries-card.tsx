'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, PackageCheck, RefreshCw } from 'lucide-react';
import { api, download } from '@/lib/api';
import { fieldErrors } from '@/lib/form';
import { DEPLOYMENT_MODE, MODULE_LABEL, dateTime } from '@/lib/format';
import { Badge, Button, ErrorBox, Field, Input, Loading, Textarea } from '@/components/ui';
import { useToast } from '@/components/ui/toast';

interface Manifest {
  modules: string[];
  plan: { name: string; limits: { features: string[] } };
  requirements: { key: string; label: string; detail: string; required: boolean }[];
  integrations: { key: string; name: string; status: string; detail: string; pending: boolean }[];
  initialAccess: { panelUrl: string; admins: { name: string; email: string; status: string }[] };
}
interface Delivery {
  id: string; number: number; systemName: string; deploymentMode: string; appVersion: string; domain: string | null; supportContact: string; notes: string | null;
  status: 'DRAFT' | 'GENERATED' | 'DELIVERED'; packageSha256: string | null; packageBytes: number | null; generatedAt: string | null; deliveredAt: string | null; createdAt: string;
  manifest?: Manifest;
}

const STATUS = { DRAFT: { label: 'Preparada', tone: 'neutral' }, GENERATED: { label: 'Paquete generado', tone: 'info' }, DELIVERED: { label: 'Entregada', tone: 'success' } } as const;

function Detail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['platform-delivery', id], queryFn: () => api<Delivery>(`/platform/deliveries/${id}`) });
  const m = q.data?.manifest;
  if (!m) return q.isLoading ? <Loading /> : <ErrorBox error={q.error} />;
  const pending = m.integrations.filter((i) => i.pending);
  return (
    <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
      <div>
        <p className="mb-1 font-medium">Módulos y plan</p>
        <p className="text-muted">{m.modules.map((x) => MODULE_LABEL[x] ?? x).join(', ')} · plan {m.plan.name}</p>
        <p className="mb-1 mt-2 font-medium">Acceso inicial</p>
        <p className="text-muted">{m.initialAccess.panelUrl}</p>
        <ul className="text-muted">{m.initialAccess.admins.map((a) => <li key={a.email}>{a.name} · {a.email} · {a.status}</li>)}</ul>
      </div>
      <div>
        <p className="mb-1 font-medium">Integraciones pendientes ({pending.length})</p>
        {pending.length ? <ul className="text-muted">{pending.map((i) => <li key={i.key}>{i.name}: {i.detail}</li>)}</ul> : <p className="text-muted">Ninguna</p>}
      </div>
      <div className="sm:col-span-2">
        <p className="mb-1 font-medium">Requisitos</p>
        <ul className="text-muted">{m.requirements.map((r) => <li key={r.key}>{r.required ? '• ' : '◦ '}<span className="text-text">{r.label}</span>{r.required ? '' : ' (opcional)'}: {r.detail}</li>)}</ul>
      </div>
    </div>
  );
}

/**
 * Entrega de sistemas (ADR 044): preparar la foto de la empresa, revisar
 * requisitos e integraciones pendientes y descargar el paquete reproducible.
 */
export function DeliveriesCard({ tenant }: { tenant: { id: string; name: string; deploymentMode: string; customDomain: string | null } }) {
  const qc = useQueryClient();
  const toast = useToast();
  const own = tenant.deploymentMode !== 'SAAS';
  const list = useQuery({ queryKey: ['platform-deliveries', tenant.id], queryFn: () => api<Delivery[]>(`/platform/tenants/${tenant.id}/deliveries`) });
  const [f, setF] = useState({ systemName: tenant.name, domain: tenant.customDomain ?? '', supportContact: '', notes: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const errors = fieldErrors(error);
  const refresh = () => qc.invalidateQueries({ queryKey: ['platform-deliveries', tenant.id] });

  async function prepare() {
    setBusy('new');
    setError(null);
    try {
      const d = await api<Delivery>(`/platform/tenants/${tenant.id}/deliveries`, {
        method: 'POST',
        body: { systemName: f.systemName.trim(), domain: own ? f.domain.trim() || null : null, supportContact: f.supportContact.trim(), notes: f.notes.trim() || null },
      });
      toast.success(`Entrega n.º ${d.number} preparada: revisa requisitos y pendientes`);
      setOpen(d.id);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }
  async function act(d: Delivery, what: 'package' | 'refresh' | 'delivered') {
    setBusy(`${d.id}:${what}`);
    try {
      if (what === 'package') {
        await download(`/platform/deliveries/${d.id}/package`);
        toast.success(`Paquete n.º ${d.number} descargado`);
      } else {
        await api(`/platform/deliveries/${d.id}/${what}`, { method: 'POST' });
        toast.success(what === 'refresh' ? 'Datos de la entrega actualizados' : `Entrega n.º ${d.number} marcada como entregada`);
      }
      await refresh();
      await qc.invalidateQueries({ queryKey: ['platform-delivery', d.id] });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Entrega del sistema</h3>
        <Badge>{DEPLOYMENT_MODE[tenant.deploymentMode] ?? tenant.deploymentMode}</Badge>
      </div>
      <p className="mb-3 text-xs text-muted">
        El paquete incluye manuales, guías, requisitos, integraciones pendientes y datos de acceso{own ? ', más el kit de instalación (Docker Compose, HTTPS, instalador, respaldo, restauración y registros)' : ''}. Nunca contiene contraseñas ni claves, y es reproducible: se puede volver a descargar idéntico.
      </p>
      <ErrorBox error={list.error} />
      {list.data && list.data.length > 0 && (
        <ul className="mb-4 flex flex-col gap-2">
          {list.data.map((d) => (
            <li key={d.id} className="rounded-lg bg-surface-2/60 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">#{d.number} · {d.systemName}</span>
                <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge>
                <span className="text-xs text-muted">v{d.appVersion}{d.domain ? ` · ${d.domain}` : ''} · {dateTime(d.createdAt)}</span>
                <div className="ml-auto flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setOpen(open === d.id ? null : d.id)}>{open === d.id ? 'Ocultar' : 'Ver detalle'}</Button>
                  {d.status === 'DRAFT' && <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={busy === `${d.id}:refresh`} onClick={() => act(d, 'refresh')}>Actualizar datos</Button>}
                  <Button size="sm" variant="secondary" icon={<Download className="size-3.5" />} loading={busy === `${d.id}:package`} onClick={() => act(d, 'package')}>{d.status === 'DRAFT' ? 'Generar paquete' : 'Descargar'}</Button>
                  {d.status === 'GENERATED' && <Button size="sm" icon={<PackageCheck className="size-3.5" />} loading={busy === `${d.id}:delivered`} onClick={() => act(d, 'delivered')}>Marcar entregada</Button>}
                </div>
              </div>
              {d.packageSha256 && <p className="mt-1 break-all font-mono text-[11px] text-muted" title="Huella SHA-256 del ZIP">SHA-256 {d.packageSha256}{d.packageBytes ? ` · ${(d.packageBytes / 1024).toFixed(0)} KB` : ''}</p>}
              {open === d.id && <Detail id={d.id} />}
            </li>
          ))}
        </ul>
      )}
      <fieldset className="grid gap-3 sm:grid-cols-2" disabled={busy === 'new'}>
        <legend className="mb-2 text-sm font-medium">Preparar una entrega</legend>
        <Field label="Nombre del sistema" error={errors.systemName}><Input value={f.systemName} maxLength={120} onChange={(e) => setF({ ...f, systemName: e.target.value })} /></Field>
        {own && (
          <Field label="Dominio de la instalación" error={errors.domain} hint="Debe apuntar al servidor del cliente">
            <Input value={f.domain} maxLength={253} placeholder="ventas.cliente.pe" onChange={(e) => setF({ ...f, domain: e.target.value })} />
          </Field>
        )}
        <Field label="Contacto de soporte" error={errors.supportContact} hint="Correo, WhatsApp u horario de atención" className={own ? 'sm:col-span-2' : ''}>
          <Input value={f.supportContact} maxLength={300} onChange={(e) => setF({ ...f, supportContact: e.target.value })} />
        </Field>
        <Field label="Notas para el cliente (opcional)" error={errors.notes} className="sm:col-span-2">
          <Textarea rows={2} maxLength={2000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        <div className="sm:col-span-2">
          {!Object.keys(errors).length && <ErrorBox error={error} />}
          <Button size="sm" className="mt-1" loading={busy === 'new'} disabled={f.systemName.trim().length < 2 || f.supportContact.trim().length < 5} onClick={prepare}>Preparar entrega</Button>
        </div>
      </fieldset>
    </div>
  );
}
