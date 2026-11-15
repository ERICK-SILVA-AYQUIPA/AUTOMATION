'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, RefreshCw } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/guard';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Field, Input, Loading, PageHeader, Select, Table, Td, Th, cn } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { fieldErrors } from '@/lib/form';
import { RequestsTab, ServersTab } from './servers';
import { STATUS, eur, type Catalog, type Provider } from './shared';

const TABS = [['proveedores', 'Proveedores'], ['solicitudes', 'Solicitudes'], ['servidores', 'Servidores'], ['claves', 'Claves SSH']] as const;
type Tab = (typeof TABS)[number][0];

function Infra() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = (TABS.find(([k]) => k === params.get('tab'))?.[0] ?? 'proveedores') as Tab;
  return (
    <>
      <PageHeader
        title="Infraestructura"
        description="Proveedores de servidores conectados por su API oficial. Todo lo que genera costo pasa por una solicitud y una aprobación explícita dentro del presupuesto; ningún asistente de IA puede crear, apagar ni eliminar servidores."
      />
      <div role="tablist" aria-label="Secciones" className="mb-5 flex flex-wrap gap-1 border-b border-border">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => router.replace(`/plataforma/infraestructura?tab=${k}`)}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm', tab === k ? 'border-primary font-medium text-text' : 'border-transparent text-muted hover:text-text')}>{label}</button>
        ))}
      </div>
      {tab === 'proveedores' && <ProvidersTab />}
      {tab === 'solicitudes' && <RequestsTab />}
      {tab === 'servidores' && <ServersTab />}
      {tab === 'claves' && <KeysTab />}
    </>
  );
}

type LimitsForm = { label: string; monthlyBudget: string; maxServers: string; allowedLocations: string; allowedServerTypes: string; defaultImage: string; sshSourceCidrs: string };
const split = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
const limitsOf = (p?: Provider): LimitsForm => ({
  label: p?.label ?? 'Hetzner Cloud', monthlyBudget: p?.monthlyBudget ?? '', maxServers: p?.maxServers != null ? String(p.maxServers) : '', allowedLocations: p?.allowedLocations.join(', ') ?? '',
  allowedServerTypes: p?.allowedServerTypes.join(', ') ?? '', defaultImage: p?.defaultImage ?? 'ubuntu-24.04', sshSourceCidrs: p?.sshSourceCidrs.join(', ') ?? '',
});
const limitsBody = (f: LimitsForm) => ({
  label: f.label.trim(), monthlyBudget: f.monthlyBudget.trim() || null, maxServers: f.maxServers.trim() ? Number(f.maxServers) : null,
  allowedLocations: split(f.allowedLocations), allowedServerTypes: split(f.allowedServerTypes), defaultImage: f.defaultImage.trim(), sshSourceCidrs: split(f.sshSourceCidrs),
});
const errorsOf = (e: unknown) => (e instanceof ApiError && e.errors?.length ? Object.fromEntries(e.errors.map((x) => [x.path.split('.')[0]!, x.message])) : {});

function LimitsFields({ f, set, errors }: { f: LimitsForm; set: (p: Partial<LimitsForm>) => void; errors: Record<string, string> }) {
  return (
    <>
      <Field label="Nombre" error={errors.label}><Input value={f.label} onChange={(e) => set({ label: e.target.value })} maxLength={80} required /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Presupuesto mensual (sin impuestos)" hint="Sin presupuesto no se crea ningún servidor" error={errors.monthlyBudget}><Input inputMode="decimal" value={f.monthlyBudget} onChange={(e) => set({ monthlyBudget: e.target.value })} /></Field>
        <Field label="Máximo de servidores" error={errors.maxServers}><Input type="number" min={0} max={1000} value={f.maxServers} onChange={(e) => set({ maxServers: e.target.value })} /></Field>
      </div>
      <Field label="Regiones permitidas" hint="Códigos separados por coma (fsn1, nbg1…). Vacío: todas" error={errors.allowedLocations}><Input value={f.allowedLocations} onChange={(e) => set({ allowedLocations: e.target.value })} /></Field>
      <Field label="Tamaños permitidos" hint="Códigos separados por coma (cx23, cx33…). Vacío: todos" error={errors.allowedServerTypes}><Input value={f.allowedServerTypes} onChange={(e) => set({ allowedServerTypes: e.target.value })} /></Field>
      <Field label="Imagen por defecto" error={errors.defaultImage}><Input value={f.defaultImage} onChange={(e) => set({ defaultImage: e.target.value })} /></Field>
      <Field label="Direcciones con acceso SSH (CIDR)" hint="Ej.: 203.0.113.10/32. Vacío: el puerto 22 queda cerrado en el firewall" error={errors.sshSourceCidrs}><Input value={f.sshSourceCidrs} onChange={(e) => set({ sshSourceCidrs: e.target.value })} /></Field>
    </>
  );
}

function ProvidersTab() {
  const q = useQuery({ queryKey: ['infra-providers'], queryFn: () => api<Provider[]>('/platform/infra/providers') });
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted">Usa un proyecto de Hetzner dedicado a los servidores de clientes y un token de ese proyecto. El token se guarda cifrado, se prueba antes de guardarlo y no se vuelve a mostrar. Hetzner no ofrece la factura por API: los costos son estimados con su lista de precios.</p>
        <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Agregar proveedor</Button>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? (
        <EmptyState title="Sin proveedores" description="Agrega Hetzner Cloud con un token de su consola (Proyecto › Seguridad › Tokens de API)." />
      ) : q.data!.map((p) => <ProviderCard key={p.id} p={p} />)}
      {adding && <AddProvider onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddProvider({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [token, setToken] = useState('');
  const [f, setF] = useState<LimitsForm>(limitsOf());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/platform/infra/providers', { method: 'POST', body: { kind: 'HETZNER', token: token.trim(), ...limitsBody(f) } });
      toast.success('Proveedor conectado: el token funcionó');
      void qc.invalidateQueries({ queryKey: ['infra-providers'] });
      onClose();
    } catch (err) {
      setErrors(errorsOf(err));
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} wide title="Agregar proveedor" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="provider-form" loading={busy}>Probar y guardar</Button></>}>
      <form id="provider-form" onSubmit={submit} className="flex flex-col gap-4" autoComplete="off">
        <ErrorBox error={error} />
        <Field label="Proveedor"><Select value="HETZNER" disabled><option value="HETZNER">Hetzner Cloud</option></Select></Field>
        <Field label="Token de API" hint="Lectura y escritura para crear servidores; uno de solo lectura sirve para consultar. Se prueba antes de guardarlo." error={errors.token}>
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="new-password" />
        </Field>
        <LimitsFields f={f} set={(p) => setF({ ...f, ...p })} errors={errors} />
      </form>
    </Dialog>
  );
}

function ProviderCard({ p }: { p: Provider }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'limits' | 'rotate' | 'catalog' | 'remote' | null>(null);
  const st = STATUS[p.status] ?? { label: p.status, tone: 'neutral' as const };
  const refresh = () => void qc.invalidateQueries({ queryKey: ['infra-providers'] });
  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
      refresh();
    }
  }
  const pct = p.monthlyBudget ? Math.min(100, (Number(p.costs.committedMonthly) / Number(p.monthlyBudget)) * 100) : 0;
  return (
    <Card className="flex flex-col gap-3 p-5" >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">{p.label}</h2>
        <Badge tone={st.tone}>{st.label}</Badge>
        <span className="font-mono text-xs text-muted">token {p.secretHint}</span>
        {p.lastCheckedAt && <span className="text-xs text-muted">probado {dateTime(p.lastCheckedAt)}</span>}
      </div>
      {p.lastError && <p className="text-sm text-danger">{p.lastError}</p>}
      <div className="grid gap-3 text-sm sm:grid-cols-3">
        <div><p className="text-muted">Gasto estimado del mes</p><p className="text-lg font-semibold tabular-nums">{eur(p.costs.monthToDate, p.currency)}</p></div>
        <div>
          <p className="text-muted">Comprometido por mes / presupuesto</p>
          <p className="text-lg font-semibold tabular-nums">{eur(p.costs.committedMonthly, p.currency)} / {p.monthlyBudget ? eur(p.monthlyBudget, p.currency) : 'sin presupuesto'}</p>
          {p.monthlyBudget && <div className="mt-1 h-1.5 rounded bg-surface-2" aria-hidden><div className={cn('h-1.5 rounded', pct > 90 ? 'bg-danger' : 'bg-primary')} style={{ width: `${pct}%` }} /></div>}
        </div>
        <div><p className="text-muted">Servidores activos</p><p className="text-lg font-semibold">{p.costs.activeServers}{p.maxServers != null ? ` de ${p.maxServers}` : ''}</p></div>
      </div>
      <p className="text-xs text-muted">{p.costs.basis}.{p.costs.unknownPrice ? ` ${p.costs.unknownPrice} servidor(es) sin precio conocido.` : ''} Regiones: {p.allowedLocations.join(', ') || 'todas'} · Tamaños: {p.allowedServerTypes.join(', ') || 'todos'} · SSH: {p.sshSourceCidrs.join(', ') || 'cerrado'}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} loading={busy === 'test'} onClick={() => void run('test', async () => {
          const r = await api<{ ok: boolean; message: string }>(`/platform/infra/providers/${p.id}/test`, { method: 'POST' });
          if (r.ok) toast.success(r.message); else toast.error(r.message);
        })}>Probar conexión</Button>
        <Button size="sm" variant="secondary" onClick={() => setDialog('catalog')}>Regiones y precios</Button>
        <Button size="sm" variant="secondary" onClick={() => setDialog('remote')}>Servidores en la cuenta</Button>
        <Button size="sm" variant="secondary" onClick={() => setDialog('limits')}>Límites y presupuesto</Button>
        <Button size="sm" variant="secondary" onClick={() => setDialog('rotate')}>Cambiar token</Button>
        <Button size="sm" variant="ghost" loading={busy === 'dis'} onClick={() => void run('dis', async () => { await api(`/platform/infra/providers/${p.id}/disabled`, { method: 'POST', body: { disabled: !p.disabledAt } }); toast.success(p.disabledAt ? 'Proveedor activado' : 'Proveedor desactivado'); })}>{p.disabledAt ? 'Activar' : 'Desactivar'}</Button>
      </div>
      {dialog === 'limits' && <LimitsDialog p={p} onClose={() => setDialog(null)} />}
      {dialog === 'rotate' && <RotateDialog p={p} onClose={() => setDialog(null)} />}
      {dialog === 'catalog' && <CatalogDialog p={p} onClose={() => setDialog(null)} />}
      {dialog === 'remote' && <RemoteDialog p={p} onClose={() => setDialog(null)} />}
    </Card>
  );
}

function LimitsDialog({ p, onClose }: { p: Provider; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState(limitsOf(p));
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/platform/infra/providers/${p.id}`, { method: 'PUT', body: limitsBody(f) });
      toast.success('Límites guardados');
      void qc.invalidateQueries({ queryKey: ['infra-providers'] });
      onClose();
    } catch (err) {
      setErrors(errorsOf(err));
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} wide title="Límites y presupuesto" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="limits-form" loading={busy}>Guardar</Button></>}>
      <form id="limits-form" onSubmit={submit} className="flex flex-col gap-4"><LimitsFields f={f} set={(x) => setF({ ...f, ...x })} errors={errors} /></form>
    </Dialog>
  );
}

function RotateDialog({ p, onClose }: { p: Provider; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/platform/infra/providers/${p.id}/rotate`, { method: 'POST', body: { token: token.trim() } });
      toast.success('Token reemplazado');
      void qc.invalidateQueries({ queryKey: ['infra-providers'] });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title="Cambiar token" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="rotate-form" loading={busy}>Probar y reemplazar</Button></>}>
      <form id="rotate-form" onSubmit={submit} className="flex flex-col gap-4" autoComplete="off">
        <ErrorBox error={error} />
        <p className="text-sm text-muted">El token actual ({p.secretHint}) sigue en uso hasta que el nuevo funcione. Después revoca el anterior en la consola del proveedor.</p>
        <Field label="Token nuevo"><Input type="password" value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="new-password" /></Field>
      </form>
    </Dialog>
  );
}

function CatalogDialog({ p, onClose }: { p: Provider; onClose: () => void }) {
  const q = useQuery({ queryKey: ['infra-catalog', p.id], queryFn: () => api<Catalog>(`/platform/infra/providers/${p.id}/catalog`) });
  return (
    <Dialog open onClose={onClose} wide title={`Regiones y precios · ${p.label}`}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="flex flex-col gap-4 text-sm">
          <p className="text-muted">Precios del proveedor en {q.data!.currency}, sin impuestos (IVA del proveedor: {q.data!.vatRate ?? '—'} %).</p>
          <p>{q.data!.locations.map((l) => `${l.name} (${l.city}, ${l.country})${l.allowed ? '' : ' · no permitida'}`).join(' · ')}</p>
          <Table>
            <thead><tr><Th>Tamaño</Th><Th>CPU / RAM / disco</Th><Th>Precio mensual</Th><Th>Disponible en</Th><Th>Estado</Th></tr></thead>
            <tbody>
              {q.data!.serverTypes.map((t) => (
                <tr key={t.name} className="border-t border-border">
                  <Td className="font-mono">{t.name}</Td>
                  <Td>{t.cores} vCPU · {t.memoryGb} GB · {t.diskGb} GB</Td>
                  <Td>{t.prices.map((x) => `${x.location}: ${eur(x.monthly.net, q.data!.currency)}`).join(' · ')}</Td>
                  <Td>{t.availableIn.join(', ') || '—'}</Td>
                  <Td>{t.deprecated ? <Badge>Retirado</Badge> : t.allowed ? <Badge tone="success">Permitido</Badge> : <Badge>No permitido</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </Dialog>
  );
}

interface Remote { externalId: string; name: string; status: string; serverType: string; location: string; ipv4: string | null; registeredId: string | null }

function RemoteDialog({ p, onClose }: { p: Provider; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['infra-remote', p.id], queryFn: () => api<Remote[]>(`/platform/infra/providers/${p.id}/remote-servers`) });
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Dialog open onClose={onClose} wide title={`Servidores en la cuenta · ${p.label}`}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? <p className="text-sm text-muted">La cuenta no tiene servidores.</p> : (
        <Table>
          <thead><tr><Th>Nombre</Th><Th>Estado</Th><Th>Tamaño</Th><Th>Región</Th><Th>IPv4</Th><Th /></tr></thead>
          <tbody>
            {q.data!.map((r) => (
              <tr key={r.externalId} className="border-t border-border">
                <Td>{r.name}</Td><Td>{r.status}</Td><Td>{r.serverType}</Td><Td>{r.location}</Td><Td className="font-mono">{r.ipv4 ?? '—'}</Td>
                <Td>{r.registeredId ? <Badge tone="success">Registrado</Badge> : (
                  <Button size="sm" variant="secondary" loading={busy === r.externalId} onClick={async () => {
                    setBusy(r.externalId);
                    try {
                      await api(`/platform/infra/providers/${p.id}/import`, { method: 'POST', body: { externalId: r.externalId } });
                      toast.success(`${r.name} registrado`);
                      void q.refetch();
                      void qc.invalidateQueries({ queryKey: ['infra-providers'] });
                      void qc.invalidateQueries({ queryKey: ['infra-servers'] });
                    } catch (e) {
                      toast.error(e);
                    } finally {
                      setBusy(null);
                    }
                  }}>Registrar</Button>
                )}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Dialog>
  );
}

interface SshKey { id: string; name: string; fingerprint: string; isActive: boolean; createdAt: string }

function KeysTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['infra-keys'], queryFn: () => api<SshKey[]>('/platform/infra/ssh-keys') });
  const [f, setF] = useState({ name: '', publicKey: '' });
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrs({});
    try {
      await api('/platform/infra/ssh-keys', { method: 'POST', body: f });
      toast.success('Clave registrada');
      setF({ name: '', publicKey: '' });
      void qc.invalidateQueries({ queryKey: ['infra-keys'] });
    } catch (err) {
      setErrs(fieldErrors(err));
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="p-5">
        <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Agregar clave SSH">
          <h2 className="flex items-center gap-2 font-semibold"><KeyRound className="size-4" />Agregar clave pública</h2>
          <p className="text-sm text-muted">Los servidores se crean con estas claves y sin contraseña de root. Pega solo la clave <strong>pública</strong> (el archivo .pub); la privada nunca sale de tu computadora.</p>
          <Field label="Nombre" error={errs.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} required placeholder="Laptop de Rick" /></Field>
          <Field label="Clave pública" error={errs.publicKey}><Input value={f.publicKey} onChange={(e) => setF({ ...f, publicKey: e.target.value })} required placeholder="ssh-ed25519 AAAA… usuario@equipo" /></Field>
          <Button type="submit" className="self-start" loading={busy}>Agregar</Button>
        </form>
      </Card>
      <Card className="p-5">
        <h2 className="mb-3 font-semibold">Claves registradas</h2>
        {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? <p className="text-sm text-muted">Sin claves: no se puede aprobar ningún servidor.</p> : (
          <ul className="flex flex-col gap-2 text-sm">
            {q.data!.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-3">
                <span><span className="font-medium">{k.name}</span> {!k.isActive && <Badge>Inactiva</Badge>}<span className="block font-mono text-xs text-muted">{k.fingerprint}</span></span>
                <Button size="sm" variant="ghost" onClick={async () => {
                  try {
                    await api(`/platform/infra/ssh-keys/${k.id}/active`, { method: 'POST', body: { isActive: !k.isActive } });
                    void qc.invalidateQueries({ queryKey: ['infra-keys'] });
                  } catch (e) {
                    toast.error(e);
                  }
                }}>{k.isActive ? 'Desactivar' : 'Activar'}</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function InfraPage() {
  return (
    <RequirePermission permission="platform:manage">
      <Suspense fallback={<Loading />}>
        <Infra />
      </Suspense>
    </RequirePermission>
  );
}
