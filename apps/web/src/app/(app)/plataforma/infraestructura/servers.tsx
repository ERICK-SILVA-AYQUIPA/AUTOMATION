'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Power, PowerOff, RefreshCw, RotateCw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Field, Input, Loading, Select, Textarea } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { OPERATION, REQUEST_STATUS, SERVER_STATUS, eur, type Catalog, type Operation, type Provider } from './shared';

const installNo = (n: number) => `OI-${String(n).padStart(5, '0')}`;

interface Req {
  id: string; number: number; purpose: string; name: string; serverType: string; location: string; image: string; priceHourly: string; priceMonthly: string; currency: string; status: string;
  decisionNote: string | null; error: string | null; createdAt: string; decidedAt: string | null;
  provider: { id: string; label: string }; installationOrder: { id: string; number: number; status: string; lead: { name: string; company: string | null } } | null; server: { id: string; name: string; status: string } | null;
}
interface Server {
  id: string; name: string; status: string; serverType: string; location: string; image: string | null; ipv4: string | null; ipv6: string | null; priceMonthly: string | null; currency: string | null;
  imported: boolean; providerCreatedAt: string; lastSyncedAt: string | null; deletedAt: string | null; deleteReason: string | null;
  provider: { id: string; label: string }; installationOrder: { id: string; number: number; lead: { name: string; company: string | null } } | null; tenant: { id: string; name: string } | null; request: { number: number } | null;
}

export function RequestsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['infra-requests'], queryFn: () => api<Req[]>('/platform/infra/requests') });
  const [creating, setCreating] = useState(false);
  const [approve, setApprove] = useState<Req | null>(null);
  const [close, setClose] = useState<{ r: Req; kind: 'reject' | 'cancel'; note: string } | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['infra-requests'] });
    void qc.invalidateQueries({ queryKey: ['infra-servers'] });
    void qc.invalidateQueries({ queryKey: ['infra-providers'] });
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted">Pedir un servidor no crea nada. Al aprobarlo se vuelve a comprobar el presupuesto, los límites y la orden de instalación, y recién entonces se crea con su firewall y las claves SSH registradas.</p>
        <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Pedir servidor</Button>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? <EmptyState title="Sin solicitudes" /> : (
        <div className="flex flex-col gap-3">
          {q.data!.map((r) => (
            <Card key={r.id} className="flex flex-col gap-2 p-4 text-sm" >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-medium">#{r.number} · {r.name}</span>
                <Badge tone={REQUEST_STATUS[r.status]?.tone}>{REQUEST_STATUS[r.status]?.label ?? r.status}</Badge>
                <span className="text-xs text-muted">{r.provider.label} · {dateTime(r.createdAt)}</span>
              </div>
              <p>{r.serverType} en {r.location} · {r.image} · <strong>{eur(r.priceMonthly, r.currency)}/mes</strong> sin impuestos</p>
              <p className="text-muted">{r.purpose}{r.installationOrder ? ` · orden ${installNo(r.installationOrder.number)} (${r.installationOrder.lead.company ?? r.installationOrder.lead.name})` : ' · uso interno'}</p>
              {r.decisionNote && <p className="text-muted">Nota: {r.decisionNote}</p>}
              {r.error && <p className="text-danger">{r.error}</p>}
              {r.server && <p>Servidor: <Link href="/plataforma/infraestructura?tab=servidores" className="text-primary underline">{r.server.name}</Link></p>}
              {r.status === 'PENDING_APPROVAL' && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setApprove(r)}>Aprobar y crear</Button>
                  <Button size="sm" variant="secondary" onClick={() => setClose({ r, kind: 'reject', note: '' })}>Rechazar</Button>
                  <Button size="sm" variant="ghost" onClick={() => setClose({ r, kind: 'cancel', note: '' })}>Cancelar</Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      {creating && <NewRequest onClose={() => setCreating(false)} onDone={refresh} />}
      {approve && <ApproveDialog r={approve} onClose={() => setApprove(null)} onDone={refresh} />}
      <Dialog
        open={!!close}
        onClose={() => setClose(null)}
        title={close?.kind === 'reject' ? `Rechazar #${close.r.number}` : `Cancelar #${close?.r.number}`}
        footer={<><Button variant="secondary" onClick={() => setClose(null)}>Volver</Button><Button variant="danger" disabled={(close?.note.trim().length ?? 0) < 3} onClick={async () => {
          try {
            await api(`/platform/infra/requests/${close!.r.id}/${close!.kind}`, { method: 'POST', body: { note: close!.note.trim() } });
            toast.success('Solicitud cerrada');
            setClose(null);
            refresh();
          } catch (e) {
            toast.error(e);
          }
        }}>Confirmar</Button></>}
      >
        <Field label="Motivo"><Input value={close?.note ?? ''} onChange={(e) => setClose(close && { ...close, note: e.target.value })} maxLength={1000} /></Field>
      </Dialog>
    </div>
  );
}

function NewRequest({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const providers = useQuery({ queryKey: ['infra-providers'], queryFn: () => api<Provider[]>('/platform/infra/providers') });
  const installs = useQuery({ queryKey: ['infra-installs'], queryFn: () => api<{ id: string; number: number; deploymentMode: string | null; serverResources: string | null; lead: { name: string; company: string | null } }[]>('/platform/infra/installation-options') });
  const [f, setF] = useState({ providerId: '', installationOrderId: '', purpose: '', name: '', location: '', serverType: '', image: '' });
  const providerId = f.providerId || providers.data?.find((p) => !p.disabledAt)?.id || '';
  const catalog = useQuery({ queryKey: ['infra-catalog', providerId], queryFn: () => api<Catalog>(`/platform/infra/providers/${providerId}/catalog`), enabled: !!providerId });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const types = (catalog.data?.serverTypes ?? []).filter((t) => t.allowed && !t.deprecated && (!f.location || t.availableIn.includes(f.location)));
  const chosen = catalog.data?.serverTypes.find((t) => t.name === f.serverType)?.prices.find((x) => x.location === f.location);
  const io = installs.data?.find((i) => i.id === f.installationOrderId);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/platform/infra/requests', { method: 'POST', body: { ...f, providerId, installationOrderId: f.installationOrderId || null, image: f.image.trim() || undefined } });
      toast.success('Solicitud registrada: falta aprobarla');
      onDone();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.errors?.length) setErrors(Object.fromEntries(err.errors.map((x) => [x.path, x.message])));
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} wide title="Pedir servidor" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="request-form" loading={busy}>Registrar solicitud</Button></>}>
      <form id="request-form" onSubmit={submit} className="flex flex-col gap-4">
        <ErrorBox error={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Proveedor">
            <Select value={providerId} onChange={(e) => setF({ ...f, providerId: e.target.value, location: '', serverType: '' })}>
              {(providers.data ?? []).filter((p) => !p.disabledAt).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
          </Field>
          <Field label="Orden de instalación (pagada)">
            <Select value={f.installationOrderId} onChange={(e) => setF({ ...f, installationOrderId: e.target.value })}>
              <option value="">Uso interno (sin cliente)</option>
              {installs.data?.map((i) => <option key={i.id} value={i.id}>{installNo(i.number)} · {i.lead.company ?? i.lead.name}</option>)}
            </Select>
          </Field>
        </div>
        {io?.serverResources && <p className="text-sm text-muted">Recursos cotizados: {io.serverResources}</p>}
        <Field label="Para qué es" error={errors.purpose}><Textarea value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} maxLength={500} rows={2} required /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre del servidor" hint="Minúsculas, números y guiones" error={errors.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value.toLowerCase() })} maxLength={63} required /></Field>
          <Field label="Imagen" hint="Vacío: la del proveedor"><Input value={f.image} onChange={(e) => setF({ ...f, image: e.target.value })} placeholder="ubuntu-24.04" /></Field>
          <Field label="Región">
            <Select value={f.location} onChange={(e) => setF({ ...f, location: e.target.value, serverType: '' })} required>
              <option value="">Elige</option>
              {catalog.data?.locations.filter((l) => l.allowed).map((l) => <option key={l.name} value={l.name}>{l.name} · {l.city}, {l.country}</option>)}
            </Select>
          </Field>
          <Field label="Tamaño">
            <Select value={f.serverType} onChange={(e) => setF({ ...f, serverType: e.target.value })} required disabled={!f.location}>
              <option value="">{f.location ? (types.length ? 'Elige' : 'Ninguno disponible en esa región') : 'Primero la región'}</option>
              {types.map((t) => <option key={t.name} value={t.name}>{t.name} · {t.cores} vCPU, {t.memoryGb} GB, {t.diskGb} GB · {eur(t.prices.find((x) => x.location === f.location)?.monthly.net, catalog.data!.currency)}/mes</option>)}
            </Select>
          </Field>
        </div>
        {catalog.error && <ErrorBox error={catalog.error} />}
        {chosen && <p className="text-sm">Costo: <strong>{eur(chosen.monthly.net, catalog.data!.currency)} por mes</strong> ({eur(chosen.hourly.net, catalog.data!.currency)} por hora), sin impuestos.</p>}
      </form>
    </Dialog>
  );
}

function ApproveDialog({ r, onClose, onDone }: { r: Req; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ confirmName: '', acceptCost: false, note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/platform/infra/requests/${r.id}/approve`, { method: 'POST', body: { confirmName: f.confirmName.trim(), acceptCost: f.acceptCost, note: f.note.trim() || null } });
      toast.success(`Servidor ${r.name} creado`);
      onDone();
      onClose();
    } catch (err) {
      setError(err);
      onDone();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title={`Aprobar #${r.number}: ${r.name}`} footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="approve-form" loading={busy} disabled={!f.acceptCost || f.confirmName.trim() !== r.name}>Aprobar y crear servidor</Button></>}>
      <form id="approve-form" onSubmit={submit} className="flex flex-col gap-4">
        <ErrorBox error={error} />
        <p className="text-sm">Se creará <strong>{r.serverType}</strong> en <strong>{r.location}</strong> en {r.provider.label}. El proveedor cobra desde que existe: <strong>{eur(r.priceMonthly, r.currency)} por mes</strong> sin impuestos, hasta eliminarlo.</p>
        <Field label={`Escribe el nombre del servidor (${r.name})`}><Input value={f.confirmName} onChange={(e) => setF({ ...f, confirmName: e.target.value })} autoComplete="off" /></Field>
        <Field label="Nota (opcional)"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={1000} /></Field>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={f.acceptCost} onChange={(e) => setF({ ...f, acceptCost: e.target.checked })} /><span>Autorizo este gasto mensual estimado</span></label>
      </form>
    </Dialog>
  );
}

export function ServersTab() {
  const [deleted, setDeleted] = useState(false);
  const q = useQuery({ queryKey: ['infra-servers', deleted], queryFn: () => api<Server[]>('/platform/infra/servers', { query: { deleted } }) });
  return (
    <div className="flex flex-col gap-4">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={deleted} onChange={(e) => setDeleted(e.target.checked)} />Incluir eliminados</label>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? <EmptyState title="Sin servidores" description="Se crean al aprobar una solicitud, o se registran los que ya existen en la cuenta (Proveedores › Servidores en la cuenta)." /> : (
        <div className="grid gap-3 xl:grid-cols-2">{q.data!.map((s) => <ServerCard key={s.id} s={s} />)}</div>
      )}
    </div>
  );
}

function ServerCard({ s }: { s: Server }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [del, setDel] = useState<{ confirmName: string; reason: string } | null>(null);
  const [details, setDetails] = useState(false);
  const st = SERVER_STATUS[s.status] ?? { label: s.status, tone: 'neutral' as const };
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['infra-servers'] });
    void qc.invalidateQueries({ queryKey: ['infra-server', s.id] });
    void qc.invalidateQueries({ queryKey: ['infra-providers'] });
  };
  async function run(key: string, fn: () => Promise<void>, ok: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
      refresh();
    }
  }
  const power = (action: string, ok: string) => run(action, async () => { await api(`/platform/infra/servers/${s.id}/power`, { method: 'POST', body: { action } }); }, ok);
  return (
    <Card className="flex flex-col gap-2 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{s.name}</span>
        <Badge tone={st.tone}>{st.label}</Badge>
        {s.imported && <Badge>Registrado</Badge>}
        <span className="text-xs text-muted">{s.provider.label}{s.request ? ` · solicitud #${s.request.number}` : ''}</span>
      </div>
      <p>{s.serverType} · {s.location} · {s.image ?? '—'} · {s.priceMonthly ? `${eur(s.priceMonthly, s.currency)}/mes` : 'precio desconocido'}</p>
      <p className="font-mono text-xs">{s.ipv4 ?? 'sin IPv4'} · {s.ipv6 ?? 'sin IPv6'}</p>
      <p className="text-muted">{s.installationOrder ? `Orden ${installNo(s.installationOrder.number)} · ${s.installationOrder.lead.company ?? s.installationOrder.lead.name}` : 'Uso interno'}{s.tenant ? ` · empresa ${s.tenant.name}` : ''} · creado {dateTime(s.providerCreatedAt)}{s.lastSyncedAt ? ` · leído ${dateTime(s.lastSyncedAt)}` : ''}</p>
      {s.deletedAt && <p className="text-muted">Eliminado {dateTime(s.deletedAt)}: {s.deleteReason}</p>}
      {!s.deletedAt && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} loading={busy === 'sync'} onClick={() => void run('sync', async () => { await api(`/platform/infra/servers/${s.id}/refresh`, { method: 'POST' }); }, 'Estado actualizado')}>Actualizar</Button>
          {s.status === 'off' && <Button size="sm" variant="secondary" icon={<Power className="size-4" />} loading={busy === 'poweron'} onClick={() => void power('poweron', 'Encendido')}>Encender</Button>}
          {s.status === 'running' && <>
            <Button size="sm" variant="secondary" icon={<RotateCw className="size-4" />} loading={busy === 'reboot'} onClick={() => void power('reboot', 'Reiniciado')}>Reiniciar</Button>
            <Button size="sm" variant="secondary" icon={<PowerOff className="size-4" />} loading={busy === 'shutdown'} onClick={() => void power('shutdown', 'Apagado')}>Apagar</Button>
            <Button size="sm" variant="ghost" loading={busy === 'poweroff'} onClick={() => void power('poweroff', 'Apagado forzado')}>Forzar apagado</Button>
          </>}
          <Button size="sm" variant="ghost" onClick={() => setDetails(true)}>Consumo e historial</Button>
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setDel({ confirmName: '', reason: '' })}>Eliminar</Button>
        </div>
      )}
      <p className="text-xs text-muted">Un servidor apagado se sigue cobrando: solo eliminarlo detiene el cobro.</p>
      {details && <ServerDetails id={s.id} name={s.name} onClose={() => setDetails(false)} />}
      <Dialog
        open={!!del}
        onClose={() => setDel(null)}
        title={`Eliminar ${s.name}`}
        footer={<><Button variant="secondary" onClick={() => setDel(null)}>Volver</Button><Button variant="danger" loading={busy === 'del'} disabled={del?.confirmName.trim() !== s.name || (del?.reason.trim().length ?? 0) < 5} onClick={() => void run('del', async () => { await api(`/platform/infra/servers/${s.id}/delete`, { method: 'POST', body: { confirmName: del!.confirmName.trim(), reason: del!.reason.trim() } }); setDel(null); }, 'Servidor eliminado')}>Eliminar definitivamente</Button></>}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm">Se borra el servidor y <strong>todos sus datos</strong> en el proveedor. No se puede deshacer. Queda el registro de quién, cuándo y por qué.</p>
          <Field label={`Escribe el nombre (${s.name})`}><Input value={del?.confirmName ?? ''} onChange={(e) => setDel(del && { ...del, confirmName: e.target.value })} autoComplete="off" /></Field>
          <Field label="Motivo"><Input value={del?.reason ?? ''} onChange={(e) => setDel(del && { ...del, reason: e.target.value })} maxLength={1000} /></Field>
        </div>
      </Dialog>
    </Card>
  );
}

function ServerDetails({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const d = useQuery({ queryKey: ['infra-server', id], queryFn: () => api<{ operations: Operation[] }>(`/platform/infra/servers/${id}`) });
  const m = useQuery({ queryKey: ['infra-metrics', id], queryFn: () => api<{ step: number; series: Record<string, [number, string][]> }>(`/platform/infra/servers/${id}/metrics`), retry: false });
  const cpu = m.data?.series.cpu ?? [];
  const avg = cpu.length ? cpu.reduce((a, [, v]) => a + Number(v), 0) / cpu.length : null;
  const max = cpu.length ? Math.max(...cpu.map(([, v]) => Number(v))) : null;
  return (
    <Dialog open onClose={onClose} wide title={`Consumo e historial · ${name}`}>
      <div className="flex flex-col gap-4 text-sm">
        <section>
          <h3 className="mb-1 font-medium">Últimas 24 horas</h3>
          {m.isLoading ? <Loading /> : m.error ? <ErrorBox error={m.error} /> : avg == null ? <p className="text-muted">Sin datos de CPU todavía.</p> : <p>CPU promedio {avg.toFixed(1)} %, máximo {max!.toFixed(1)} % ({cpu.length} mediciones)</p>}
        </section>
        <section>
          <h3 className="mb-1 font-medium">Operaciones</h3>
          {d.isLoading ? <Loading /> : (
            <ol className="flex flex-col gap-2 border-l border-border pl-4" aria-label="Operaciones del servidor">
              {d.data?.operations.map((o) => (
                <li key={o.id}>
                  <p className={o.ok ? '' : 'text-danger'}>{OPERATION[o.kind] ?? o.kind}{o.ok ? '' : ' (error)'}</p>
                  {typeof o.detail.reason === 'string' && <p className="text-muted">{o.detail.reason}</p>}
                  {typeof o.detail.error === 'string' && <p className="text-muted">{o.detail.error}</p>}
                  <p className="text-xs text-muted">{dateTime(o.createdAt)}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </Dialog>
  );
}
