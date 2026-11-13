'use client';

import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Copy, KeyRound, Plus, RefreshCw, RotateCcw, Send, Trash2, Webhook } from 'lucide-react';
import { api } from '@/lib/api';
import { fieldErrors } from '@/lib/form';
import { dateTime } from '@/lib/format';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Field, Input, Loading, Pagination, Table, Td, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';

type Status = 'connected' | 'error' | 'not_configured' | 'pending' | 'managed';
interface Check { ok: boolean; detail: string | null; at: string }
interface Service {
  key: string; name: string; status: Status; detail: string; howTo: string; testable: boolean; lastCheck: Check | null;
  ownKey?: { hint: string | null; status: string; lastError: string | null; lastCheckedAt: string | null } | null;
}
interface CheckResult { ok: boolean; ms: number; detail: string }

export const SERVICE_STATUS: Record<Status, { label: string; tone: 'success' | 'danger' | 'neutral' | 'warning' | 'info' }> = {
  connected: { label: 'Conectado', tone: 'success' },
  error: { label: 'Con errores', tone: 'danger' },
  not_configured: { label: 'Sin configurar', tone: 'neutral' },
  pending: { label: 'Pendiente', tone: 'warning' },
  managed: { label: 'Gestionado por la plataforma', tone: 'info' },
};

function LastCheck({ c }: { c: Check | null }) {
  if (!c) return <p className="text-xs text-muted">Aún no se ha probado</p>;
  return (
    <p className={c.ok ? 'text-xs text-muted' : 'text-xs text-danger'}>
      Última prueba {dateTime(c.at)}: {c.ok ? 'correcta' : 'falló'}{c.detail ? ` · ${c.detail}` : ''}
    </p>
  );
}

/** Resumen de todas las integraciones con su estado real y el botón «Probar» */
export function IntegrationsOverview() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => api<Service[]>('/integrations'), staleTime: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  async function test(s: Service) {
    setBusy(s.key);
    try {
      const r = await api<CheckResult>(`/integrations/${s.key}/test`, { method: 'POST' });
      if (r.ok) toast.success(r.detail);
      else toast.error(r.detail);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
      qc.invalidateQueries({ queryKey: ['integrations'] });
      qc.invalidateQueries({ queryKey: ['integration-checks'] });
    }
  }
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {q.data!.map((s) => {
        const st = SERVICE_STATUS[s.status];
        return (
          <Card key={s.key} className="flex flex-col gap-2 p-4">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-medium">{s.name}</h3>
              <Badge tone={st.tone}>{st.label}</Badge>
            </div>
            <p className="text-sm text-muted">{s.detail}</p>
            <LastCheck c={s.lastCheck} />
            <p className="text-xs text-muted">{s.howTo}</p>
            {s.testable && (
              <div className="mt-auto pt-1">
                <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} loading={busy === s.key} onClick={() => test(s)} aria-label={`Probar ${s.name}`}>Probar</Button>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

/** Historial de comprobaciones fallidas de la empresa */
export function IntegrationErrors() {
  const q = useQuery({ queryKey: ['integration-checks', 'errors'], queryFn: () => api<{ id: string; service: string; detail: string | null; createdAt: string }[]>('/integrations/checks?ok=false'), staleTime: 0 });
  if (q.isLoading || q.error || !q.data?.length) return null;
  return (
    <details className="mt-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium">Errores recientes en las pruebas ({q.data.length})</summary>
      <ul className="mt-2 flex flex-col gap-1.5">
        {q.data.map((c) => (
          <li key={c.id} className="text-muted"><span className="text-text">{dateTime(c.createdAt)}</span> · {c.service} · {c.detail}</li>
        ))}
      </ul>
    </details>
  );
}

/** Clave propia de Gemini: se valida con Google al guardarla y después solo se muestra el final */
export function GeminiKeyCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => api<Service[]>('/integrations'), staleTime: 0 });
  const ai = q.data?.find((s) => s.key === 'ai');
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['integrations'] });
    qc.invalidateQueries({ queryKey: ['integration-checks'] });
    qc.invalidateQueries({ queryKey: ['ai-settings'] });
  };
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ hint: string }>('/integrations/ai/key', { method: 'PUT', body: { apiKey: key.trim() } });
      toast.success(`Google aceptó la clave (${r.hint}). Se guardó cifrada.`);
      setOpen(false);
      setKey('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      refresh();
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await api('/integrations/ai/key', { method: 'DELETE' });
      toast.success('Clave propia eliminada');
      setConfirm(false);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
      refresh();
    }
  }
  if (!ai) return null;
  const own = ai.ownKey;
  return (
    <Card className="p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-indigo-500/10 p-2 text-indigo-600 dark:text-indigo-300"><KeyRound className="size-5" /></div>
          <div>
            <p className="font-medium">Clave propia de Gemini</p>
            {own ? (
              <>
                <p className="text-sm text-muted">Guardada: <span className="font-mono">{own.hint ?? '…'}</span>{own.lastCheckedAt ? ` · comprobada ${dateTime(own.lastCheckedAt)}` : ''}</p>
                <div className="mt-2"><Badge tone={own.status === 'CONNECTED' ? 'success' : 'danger'}>{own.status === 'CONNECTED' ? 'Válida' : 'Con errores'}</Badge></div>
                {own.lastError && <p className="mt-2 text-sm text-danger">{own.lastError}</p>}
              </>
            ) : (
              <p className="max-w-xl text-sm text-muted">
                Opcional. Sin clave propia, el asistente usa la de la plataforma{ai.status === 'not_configured' ? ' (que aún no está configurada)' : ''}. Con la tuya, el consumo se factura en tu cuenta de Google.
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <Button size="sm" variant="secondary" icon={<KeyRound className="size-4" />} onClick={() => { setError(null); setOpen(true); }}>{own ? 'Cambiar clave' : 'Usar mi clave'}</Button>
          {own && <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setConfirm(true)}>Quitar</Button>}
        </div>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title="Clave propia de Gemini" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancelar</Button><Button type="submit" form="gemini-key" loading={busy} disabled={key.trim().length < 20}>Validar y guardar</Button></>}>
        <form id="gemini-key" onSubmit={save} className="flex flex-col gap-4">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>Entra a <b className="text-text">aistudio.google.com</b> con la cuenta de Google de tu empresa.</li>
            <li>Pulsa <b className="text-text">Get API key → Create API key</b> y cópiala.</li>
            <li>Pégala aquí. La probamos con Google antes de guardarla y se guarda cifrada; después solo verás sus últimos 4 caracteres.</li>
          </ol>
          <ErrorBox error={error} />
          <Field label="Clave de API" error={errors.apiKey}>
            <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} invalid={!!errors.apiKey} />
          </Field>
        </form>
      </Dialog>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title="¿Quitar la clave propia?" footer={<><Button variant="secondary" onClick={() => setConfirm(false)}>Cancelar</Button><Button variant="danger" loading={busy} onClick={remove}>Quitar</Button></>}>
        <p className="text-sm text-muted">El asistente volverá a usar la clave de la plataforma. Si la plataforma no tiene una, los mensajes los atenderá tu equipo.</p>
      </Dialog>
    </Card>
  );
}

// ───────────────────────── Webhooks salientes ─────────────────────────

interface Endpoint {
  id: string; url: string; description: string | null; events: string[]; isActive: boolean; secretHint: string;
  lastDeliveryAt: string | null; lastStatus: number | null; lastError: string | null; createdAt: string;
}
interface Delivery { id: string; event: string; status: 'PENDING' | 'SENT' | 'FAILED'; attempts: number; responseStatus: number | null; lastError: string | null; createdAt: string; sentAt: string | null; nextAttemptAt: string }
const DELIVERY: Record<Delivery['status'], { label: string; tone: 'warning' | 'success' | 'danger' }> = {
  PENDING: { label: 'Pendiente', tone: 'warning' },
  SENT: { label: 'Entregado', tone: 'success' },
  FAILED: { label: 'Fallido', tone: 'danger' },
};

function SecretShown({ secret, onClose }: { secret: string; onClose: () => void }) {
  const toast = useToast();
  return (
    <Dialog open onClose={onClose} title="Secreto de firma" footer={<Button onClick={onClose}>Ya lo guardé</Button>}>
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>Cópialo ahora y guárdalo en tu sistema: no se volverá a mostrar. Si lo pierdes, genera uno nuevo.</p>
        </div>
        <div className="flex gap-2">
          <Input readOnly value={secret} className="font-mono text-xs" aria-label="Secreto de firma" onFocus={(e) => e.currentTarget.select()} />
          <Button variant="secondary" aria-label="Copiar secreto" icon={<Copy className="size-4" />} onClick={async () => {
            try {
              await navigator.clipboard.writeText(secret);
              toast.success('Copiado');
            } catch {
              toast.error('No se pudo copiar; selecciona el texto y cópialo manualmente');
            }
          }} />
        </div>
        <p className="text-muted">Tu sistema debe calcular HMAC-SHA256 con este secreto sobre <code className="text-text">{'{t}.{cuerpo}'}</code> y compararlo con <code className="text-text">v1</code> de la cabecera <code className="text-text">X-AISA-Signature</code>.</p>
      </div>
    </Dialog>
  );
}

function EndpointDialog({ events, endpoint, onClose, onSaved }: { events: Record<string, string>; endpoint: Endpoint | null; onClose: () => void; onSaved: (secret?: string) => void }) {
  const [url, setUrl] = useState(endpoint?.url ?? '');
  const [description, setDescription] = useState(endpoint?.description ?? '');
  const [sel, setSel] = useState<string[]>(endpoint?.events ?? Object.keys(events));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { url, description: description.trim() || null, events: sel };
      if (endpoint) {
        await api(`/integrations/webhooks/${endpoint.id}`, { method: 'PATCH', body });
        onSaved();
      } else {
        const r = await api<{ secret: string }>('/integrations/webhooks', { method: 'POST', body });
        onSaved(r.secret);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title={endpoint ? 'Editar webhook' : 'Nuevo webhook'} wide footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="wh-form" loading={busy} disabled={!sel.length}>Guardar</Button></>}>
      <form id="wh-form" onSubmit={submit} className="flex flex-col gap-4">
        <ErrorBox error={error} />
        <Field label="URL de tu sistema" error={errors.url} hint="Debe ser https:// y pública. Recibirá un POST con JSON por cada evento.">
          <Input required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://erp.miempresa.pe/aisa" invalid={!!errors.url} />
        </Field>
        <Field label="Descripción (opcional)" error={errors.description}><Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={120} placeholder="ERP de almacén" /></Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Eventos</legend>
          {Object.entries(events).map(([k, label]) => (
            <label key={k} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={sel.includes(k)} onChange={(e) => setSel(e.target.checked ? [...sel, k] : sel.filter((x) => x !== k))} />
              <span><code>{k}</code> <span className="text-muted">· {label}</span></span>
            </label>
          ))}
        </fieldset>
      </form>
    </Dialog>
  );
}

function Deliveries({ endpoint, onClose }: { endpoint: Endpoint; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['webhook-deliveries', endpoint.id, page],
    queryFn: () => api<{ items: Delivery[]; total: number; page: number; pageSize: number }>(`/integrations/webhooks/${endpoint.id}/deliveries?page=${page}&pageSize=10`),
    placeholderData: keepPreviousData, staleTime: 0, refetchInterval: 10_000,
  });
  async function retry(d: Delivery) {
    try {
      await api(`/integrations/webhooks/deliveries/${d.id}/retry`, { method: 'POST' });
      toast.success('Reencolada: se enviará en unos segundos');
      qc.invalidateQueries({ queryKey: ['webhook-deliveries', endpoint.id] });
    } catch (err) {
      toast.error(err);
    }
  }
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.pageSize)) : 1;
  return (
    <Dialog open onClose={onClose} title="Entregas recientes" wide footer={<Button onClick={onClose}>Cerrar</Button>}>
      <p className="mb-3 break-all text-sm text-muted">{endpoint.url}</p>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data?.items.length ? <EmptyState title="Aún no hay entregas" description="Aparecerán cuando ocurra un evento o pulses «Probar»." /> : (
        <>
          <Table>
            <thead><tr><Th>Fecha</Th><Th>Evento</Th><Th>Estado</Th><Th className="text-right">Intentos</Th><Th>Respuesta</Th><Th /></tr></thead>
            <tbody>
              {q.data.items.map((d) => (
                <tr key={d.id}>
                  <Td className="whitespace-nowrap">{dateTime(d.createdAt)}</Td>
                  <Td><code className="text-xs">{d.event}</code></Td>
                  <Td>
                    <Badge tone={DELIVERY[d.status].tone}>{DELIVERY[d.status].label}</Badge>
                    {d.status === 'PENDING' && d.attempts > 0 && <span className="block text-xs text-muted">reintento {dateTime(d.nextAttemptAt)}</span>}
                  </Td>
                  <Td className="text-right tabular-nums">{d.attempts}</Td>
                  <Td className="max-w-64 text-xs text-muted">{d.lastError ?? (d.responseStatus ? `HTTP ${d.responseStatus}` : '—')}</Td>
                  <Td className="text-right">{d.status === 'FAILED' && d.event !== 'ping' && <Button size="sm" variant="secondary" icon={<RotateCcw className="size-4" />} onClick={() => retry(d)}>Reintentar</Button>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={page} pages={pages} total={q.data.total} onPage={setPage} />
        </>
      )}
    </Dialog>
  );
}

export function WebhooksSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['webhooks'], queryFn: () => api<{ events: Record<string, string>; items: Endpoint[] }>('/integrations/webhooks'), staleTime: 0 });
  const [dlg, setDlg] = useState<{ kind: 'new' } | { kind: 'edit' | 'deliveries' | 'delete'; e: Endpoint } | { kind: 'secret'; secret: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['webhooks'] });
    qc.invalidateQueries({ queryKey: ['integrations'] });
  };
  async function act(e: Endpoint, kind: 'test' | 'rotate' | 'toggle' | 'delete') {
    setBusy(`${kind}:${e.id}`);
    try {
      if (kind === 'test') {
        const r = await api<{ ok: boolean; status: number | null; error: string | null }>(`/integrations/webhooks/${e.id}/test`, { method: 'POST' });
        if (r.ok) toast.success(`Tu sistema respondió ${r.status}`);
        else toast.error(r.error ?? 'No respondió');
      } else if (kind === 'rotate') {
        const r = await api<{ secret: string }>(`/integrations/webhooks/${e.id}/rotate-secret`, { method: 'POST' });
        setDlg({ kind: 'secret', secret: r.secret });
      } else if (kind === 'toggle') {
        await api(`/integrations/webhooks/${e.id}`, { method: 'PATCH', body: { isActive: !e.isActive } });
        toast.success(e.isActive ? 'Webhook pausado' : 'Webhook activado');
      } else {
        await api(`/integrations/webhooks/${e.id}`, { method: 'DELETE' });
        toast.success('Webhook eliminado');
        setDlg(null);
      }
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
      refresh();
    }
  }
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const { events, items } = q.data!;
  return (
    <>
      {!items.length ? (
        <Card>
          <EmptyState
            icon={<Webhook className="size-5" />}
            title="Sin webhooks"
            description="Avisa al instante a tu ERP, hoja de cálculo o sistema propio cuando entra un pedido, cambia su estado, baja el stock o un cliente pide hablar con una persona."
            action={<Button icon={<Plus className="size-4" />} onClick={() => setDlg({ kind: 'new' })}>Añadir webhook</Button>}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((e) => (
            <Card key={e.id} className="p-5">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <p className="break-all font-medium">{e.url}</p>
                  <p className="text-sm text-muted">{e.description ? `${e.description} · ` : ''}Secreto {e.secretHint}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {!e.isActive && <Badge>Pausado</Badge>}
                    {e.lastError ? <Badge tone="danger">Último envío con error</Badge> : e.lastDeliveryAt ? <Badge tone="success">Último envío {dateTime(e.lastDeliveryAt)}</Badge> : <Badge tone="warning">Sin envíos aún</Badge>}
                    {e.events.map((ev) => <Badge key={ev} tone="info">{ev}</Badge>)}
                  </div>
                  {e.lastError && <p className="mt-2 text-sm text-danger">{e.lastError}</p>}
                </div>
                <div className="flex flex-wrap gap-2 lg:justify-end">
                  <Button size="sm" variant="secondary" icon={<Send className="size-4" />} loading={busy === `test:${e.id}`} onClick={() => act(e, 'test')}>Probar</Button>
                  <Button size="sm" variant="secondary" onClick={() => setDlg({ kind: 'deliveries', e })}>Entregas</Button>
                  <Button size="sm" variant="secondary" onClick={() => setDlg({ kind: 'edit', e })}>Editar</Button>
                  <Button size="sm" variant="secondary" icon={<KeyRound className="size-4" />} loading={busy === `rotate:${e.id}`} onClick={() => act(e, 'rotate')}>Nuevo secreto</Button>
                  <Button size="sm" variant="ghost" loading={busy === `toggle:${e.id}`} onClick={() => act(e, 'toggle')}>{e.isActive ? 'Pausar' : 'Activar'}</Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setDlg({ kind: 'delete', e })} aria-label={`Eliminar ${e.url}`} />
                </div>
              </div>
            </Card>
          ))}
          {items.length < 5 && <div><Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setDlg({ kind: 'new' })}>Añadir webhook</Button></div>}
        </div>
      )}
      {(dlg?.kind === 'new' || dlg?.kind === 'edit') && (
        <EndpointDialog
          events={events}
          endpoint={dlg.kind === 'edit' ? dlg.e : null}
          onClose={() => setDlg(null)}
          onSaved={(secret) => {
            refresh();
            if (secret) setDlg({ kind: 'secret', secret });
            else { toast.success('Webhook actualizado'); setDlg(null); }
          }}
        />
      )}
      {dlg?.kind === 'secret' && <SecretShown secret={dlg.secret} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'deliveries' && <Deliveries endpoint={dlg.e} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'delete' && (
        <Dialog open onClose={() => setDlg(null)} title="¿Eliminar este webhook?" footer={<><Button variant="secondary" onClick={() => setDlg(null)}>Cancelar</Button><Button variant="danger" loading={busy === `delete:${dlg.e.id}`} onClick={() => act(dlg.e, 'delete')}>Eliminar</Button></>}>
          <p className="break-all text-sm text-muted">{dlg.e.url} dejará de recibir avisos y se borrará su historial de entregas.</p>
        </Dialog>
      )}
    </>
  );
}
