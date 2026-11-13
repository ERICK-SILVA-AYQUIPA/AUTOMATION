'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowUpCircle, RotateCcw, Save } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { fieldErrors } from '@/lib/form';
import { dateTime, num } from '@/lib/format';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Input, Loading, PageHeader, Pagination, Select, Table, Td, Textarea, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';

type EventStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';
interface ConfigField { key: string; label: string; type: 'number' | 'multiselect' | 'templates'; help?: string; min?: number; max?: number; options?: { value: string; label: string }[] }
interface Automation {
  key: string; name: string; description: string; executor: 'n8n' | 'backend'; audience: 'equipo' | 'cliente'; module: string;
  enabled: boolean; config: Record<string, unknown>; fields: ConfigField[]; moduleEnabled: boolean; featureAvailable: boolean;
  version: number; latestVersion: number; updateAvailable: boolean; pendingChanges: { version: number; text: string }[];
  updatedAt: string | null; stats30d: Record<EventStatus, number>;
}
interface Catalog { n8nConfigured: boolean; items: Automation[] }
interface AutomationEvent { id: string; key: string; name: string; status: EventStatus; attempts: number; lastError: string | null; createdAt: string; sentAt: string | null; nextAttemptAt: string; retriedById: string | null }
interface Paged<T> { items: T[]; total: number; page: number; pages: number }

const EVENT_STATUS: Record<EventStatus, { label: string; tone: 'info' | 'success' | 'danger' | 'neutral' }> = {
  PENDING: { label: 'En cola', tone: 'info' },
  SENT: { label: 'Ejecutada', tone: 'success' },
  FAILED: { label: 'Fallida', tone: 'danger' },
  SKIPPED: { label: 'Omitida', tone: 'neutral' },
};
const MODULE_NAME: Record<string, string> = { orders: 'Pedidos', inventory: 'Inventario', conversations: 'Conversaciones' };

function ConfigForm({ a }: { a: Automation }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [cfg, setCfg] = useState<Record<string, unknown>>(a.config);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setCfg((c) => ({ ...c, [k]: v }));

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      await api(`/automations/${a.key}`, { method: 'PATCH', body: { config: cfg } });
      toast.success(`Configuración de «${a.name}» guardada`);
      await qc.invalidateQueries({ queryKey: ['automations'] });
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(e instanceof Error ? e.message : 'No se pudo guardar');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4">
      {a.fields.map((f) => {
        if (f.type === 'number')
          return (
            <Field key={f.key} label={f.label} hint={f.help} error={errors[f.key]}>
              <span className="block w-40">
                <Input type="number" min={f.min} max={f.max} value={String(cfg[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value === '' ? '' : Number(e.target.value))} invalid={!!errors[f.key]} />
              </span>
            </Field>
          );
        if (f.type === 'multiselect') {
          const value = (cfg[f.key] as string[] | undefined) ?? [];
          return (
            <fieldset key={f.key}>
              <legend className="mb-1.5 text-sm font-medium">{f.label}</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                {f.options?.map((o) => (
                  <label key={o.value} className="flex items-center gap-2">
                    <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={value.includes(o.value)} onChange={() => set(f.key, value.includes(o.value) ? value.filter((v) => v !== o.value) : [...value, o.value])} />
                    {o.label}
                  </label>
                ))}
              </div>
              {errors[f.key] && <p className="mt-1 text-xs text-danger">{errors[f.key]}</p>}
            </fieldset>
          );
        }
        const texts = (cfg[f.key] as Record<string, string> | undefined) ?? {};
        return (
          <fieldset key={f.key} className="space-y-3">
            <legend className="mb-1 text-sm font-medium">{f.label}</legend>
            {f.help && <p className="text-xs text-muted">{f.help}</p>}
            {f.options?.map((o) => (
              <Field key={o.value} label={o.label} error={errors[`${f.key}.${o.value}`]}>
                <Textarea rows={2} maxLength={500} value={texts[o.value] ?? ''} onChange={(e) => set(f.key, { ...texts, [o.value]: e.target.value })} />
              </Field>
            ))}
          </fieldset>
        );
      })}
      <Button onClick={save} loading={busy} icon={<Save className="size-4" />}>Guardar configuración</Button>
    </div>
  );
}

function AutomationCard({ a, n8nConfigured }: { a: Automation; n8nConfigured: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<'toggle' | 'upgrade' | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const blocked = !a.moduleEnabled ? `Requiere el módulo ${MODULE_NAME[a.module] ?? a.module}` : !a.featureAvailable ? 'Tu plan no incluye esta automatización' : null;

  const run = async (kind: 'toggle' | 'upgrade') => {
    setBusy(kind);
    try {
      if (kind === 'toggle') {
        await api(`/automations/${a.key}`, { method: 'PATCH', body: { enabled: !a.enabled } });
        toast.success(a.enabled ? `«${a.name}» desactivada` : `«${a.name}» activada`);
      } else {
        await api(`/automations/${a.key}/upgrade`, { method: 'POST' });
        toast.success(`«${a.name}» actualizada a la versión ${a.latestVersion}`);
      }
      await qc.invalidateQueries({ queryKey: ['automations'] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'No se pudo completar la acción');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">{a.name}</h2>
            {a.enabled ? <Badge tone="success">Activa</Badge> : <Badge>Inactiva</Badge>}
            <Badge tone="info">{a.audience === 'cliente' ? 'Escribe al cliente' : 'Avisa al equipo'}</Badge>
            <Badge>{a.executor === 'n8n' ? 'Correo vía n8n' : 'Backend'}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">{a.description}</p>
          <p className="mt-2 text-xs text-muted">
            Últimos 30 días: {num(a.stats30d.SENT)} ejecutadas · {num(a.stats30d.SKIPPED)} omitidas · {num(a.stats30d.FAILED)} fallidas
            {a.stats30d.PENDING > 0 && ` · ${num(a.stats30d.PENDING)} en cola`}
          </p>
          {blocked && !a.enabled && <p className="mt-2 text-xs font-medium text-warning">{blocked}</p>}
          {a.enabled && a.executor === 'n8n' && !n8nConfigured && <p className="mt-2 text-xs font-medium text-warning">n8n no está configurado en el servidor: se registra como omitida.</p>}
        </div>
        <div className="flex shrink-0 gap-2">
          {a.fields.length > 0 && (
            <Button variant="secondary" size="sm" onClick={() => setShowConfig((v) => !v)} aria-expanded={showConfig}>
              {showConfig ? 'Ocultar configuración' : 'Configurar'}
            </Button>
          )}
          <Button size="sm" variant={a.enabled ? 'secondary' : 'primary'} loading={busy === 'toggle'} disabled={!a.enabled && !!blocked} onClick={() => run('toggle')} aria-label={`${a.enabled ? 'Desactivar' : 'Activar'} ${a.name}`}>
            {a.enabled ? 'Desactivar' : 'Activar'}
          </Button>
        </div>
      </div>

      {a.updateAvailable && (
        <div className="mt-4 rounded-lg border border-border bg-surface-2/50 p-3 text-sm">
          <p className="font-medium">Versión {a.latestVersion} disponible (tienes la {a.version})</p>
          <ul className="mt-1 list-disc pl-5 text-muted">
            {a.pendingChanges.map((c) => <li key={c.version}>v{c.version}: {c.text}</li>)}
          </ul>
          <p className="mt-1 text-xs text-muted">Se conserva tu configuración; lo nuevo toma el valor por defecto.</p>
          <Button className="mt-2" size="sm" variant="secondary" loading={busy === 'upgrade'} onClick={() => run('upgrade')} icon={<ArrowUpCircle className="size-4" />}>
            Aplicar versión {a.latestVersion}
          </Button>
        </div>
      )}

      {showConfig && <ConfigForm key={JSON.stringify(a.config)} a={a} />}
    </Card>
  );
}

function History({ items }: { items: Automation[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [key, setKey] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [retrying, setRetrying] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['automations', 'events', key, status, page],
    queryFn: () => api<Paged<AutomationEvent>>('/automations/events', { query: { key, status, page, pageSize: 20 } }),
    refetchInterval: 15_000,
  });

  const retry = async (id: string) => {
    setRetrying(id);
    try {
      await api(`/automations/events/${id}/retry`, { method: 'POST' });
      toast.success('Reintento en cola');
      await qc.invalidateQueries({ queryKey: ['automations'] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'No se pudo reintentar');
    } finally {
      setRetrying(null);
    }
  };

  return (
    <section className="mt-8" aria-labelledby="historial">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <h2 id="historial" className="text-lg font-semibold">Historial</h2>
        <div className="grid grid-cols-2 gap-2 sm:w-[28rem]">
          <Select aria-label="Filtrar por automatización" value={key} onChange={(e) => { setKey(e.target.value); setPage(1); }}>
            <option value="">Todas</option>
            {items.map((a) => <option key={a.key} value={a.key}>{a.name}</option>)}
          </Select>
          <Select aria-label="Filtrar por estado" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">Cualquier estado</option>
            {Object.entries(EVENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
        </div>
      </div>
      <Card>
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <div className="p-4"><ErrorBox error={q.error} /></div>
        ) : !q.data?.items.length ? (
          <EmptyState title="Sin ejecuciones" description="Aquí aparecerá cada vez que una automatización se ejecute, se omita o falle." />
        ) : (
          <>
            <Table>
              <thead>
                <tr><Th>Fecha</Th><Th>Automatización</Th><Th>Estado</Th><Th>Intentos</Th><Th>Detalle</Th><Th /></tr>
              </thead>
              <tbody>
                {q.data.items.map((e) => (
                  <tr key={e.id}>
                    <Td className="whitespace-nowrap tabular-nums">{dateTime(e.createdAt)}</Td>
                    <Td>{e.name}</Td>
                    <Td><Badge tone={EVENT_STATUS[e.status].tone}>{EVENT_STATUS[e.status].label}</Badge></Td>
                    <Td className="tabular-nums">{e.attempts}</Td>
                    <Td className="max-w-md text-sm text-muted">
                      {e.lastError ?? (e.status === 'PENDING' && e.attempts > 0 ? `Próximo intento: ${dateTime(e.nextAttemptAt)}` : '—')}
                      {e.retriedById && <span className="block text-xs">Reintentada a mano</span>}
                    </Td>
                    <Td className="text-right">
                      {(e.status === 'FAILED' || e.status === 'SKIPPED') && (
                        <Button size="sm" variant="secondary" loading={retrying === e.id} onClick={() => retry(e.id)} icon={<RotateCcw className="size-4" />}>Reintentar</Button>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={q.data.page} pages={q.data.pages} total={q.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </section>
  );
}

function Automations() {
  const q = useQuery({ queryKey: ['automations'], queryFn: () => api<Catalog>('/automations') });
  return (
    <>
      <PageHeader title="Automatizaciones" description="Activa y ajusta las tareas automáticas de tu empresa. Las que tocan pedidos o escriben al cliente las ejecuta el sistema; los correos al equipo, n8n." />
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : (
        <>
          {!q.data!.n8nConfigured && (
            <Card className="mb-4 flex gap-3 p-4 text-sm">
              <AlertTriangle className="size-5 shrink-0 text-warning" aria-hidden />
              <p>n8n no está configurado en el servidor. Los avisos por correo al equipo se registran como omitidos hasta que el responsable técnico lo configure.</p>
            </Card>
          )}
          <div className="space-y-4">
            {q.data!.items.map((a) => <AutomationCard key={a.key} a={a} n8nConfigured={q.data!.n8nConfigured} />)}
          </div>
          <History items={q.data!.items} />
        </>
      )}
    </>
  );
}

export default function Page() {
  return (
    <RequirePermission permission="automations:manage">
      <Automations />
    </RequirePermission>
  );
}
