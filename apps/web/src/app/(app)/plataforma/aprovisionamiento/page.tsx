'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/guard';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Field, Input, Loading, PageHeader, Select } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { eur, type Catalog } from '../infraestructura/shared';
import { ACTIVE, RUN_STATUS, installNo, type RunDetail, type RunRow } from './shared';

interface Options {
  orders: { id: string; number: number; deploymentMode: string | null; planCode: string | null; serverResources: string | null; lead: { name: string; company: string | null; email: string | null }; tenant: { id: string; name: string; deploymentMode: string } | null }[];
  providers: { id: string; label: string; kind: string; currency: string | null }[];
  version: string;
  images: { sha256: string; bytes: number } | null;
  apiPublicUrl: string;
}

function NewRun({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const opts = useQuery({ queryKey: ['prov-options'], queryFn: () => api<Options>('/platform/provisioning/options') });
  const [f, setF] = useState({ installationOrderId: '', providerId: '', location: '', serverType: '', domain: '', adminEmail: '', systemName: '', supportContact: '', smtpHost: '', smtpPort: '587', smtpSecure: false, smtpUser: '', smtpPassword: '', smtpFrom: '' });
  const providerId = f.providerId || opts.data?.providers[0]?.id || '';
  const catalog = useQuery({ queryKey: ['infra-catalog', providerId], queryFn: () => api<Catalog>(`/platform/infra/providers/${providerId}/catalog`), enabled: !!providerId });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const order = opts.data?.orders.find((o) => o.id === f.installationOrderId);
  const types = (catalog.data?.serverTypes ?? []).filter((t) => t.allowed && !t.deprecated && (!f.location || t.availableIn.includes(f.location)));
  const price = catalog.data?.serverTypes.find((t) => t.name === f.serverType)?.prices.find((x) => x.location === f.location);
  const orders = (opts.data?.orders ?? []).filter((o) => o.deploymentMode !== 'SAAS');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      const r = await api<RunDetail>('/platform/provisioning/runs', {
        method: 'POST',
        body: {
          installationOrderId: f.installationOrderId, providerId, serverType: f.serverType, location: f.location, domain: f.domain, adminEmail: f.adminEmail, systemName: f.systemName, supportContact: f.supportContact,
          smtp: { host: f.smtpHost, port: Number(f.smtpPort), secure: f.smtpSecure, user: f.smtpUser, password: f.smtpPassword || undefined, from: f.smtpFrom },
        },
      });
      toast.success(`Instalación #${r.number} registrada`);
      router.push(`/plataforma/aprovisionamiento/${r.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.errors?.length) setErrors(Object.fromEntries(err.errors.map((x) => [x.path, x.message])));
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  if (opts.isLoading) return <Dialog open onClose={onClose} title="Nueva instalación"><Loading /></Dialog>;
  const blocked = !opts.data?.images ? `La plataforma no tiene las imágenes de la versión ${opts.data?.version}: genéralas con infrastructure/scripts/export-images.sh y define PROVISIONING_IMAGES_DIR.` : !opts.data.providers.length ? 'No hay un proveedor de infraestructura conectado (Plataforma › Infraestructura).' : !orders.length ? 'No hay órdenes de instalación pagadas con servidor propio (modalidad dedicada o personalizada) sin instalación.' : null;
  return (
    <Dialog open onClose={onClose} wide title="Nueva instalación" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="run-form" loading={busy} disabled={!!blocked}>Registrar instalación</Button></>}>
      <form id="run-form" onSubmit={submit} className="flex flex-col gap-4">
        {blocked && <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">{blocked}</p>}
        <ErrorBox error={opts.error ?? error} />
        <p className="text-sm text-muted">Registrar no crea nada que cueste: el servidor se pide como solicitud y una persona lo aprueba en Infraestructura. El resto (Docker, aplicación, migraciones, HTTPS, respaldo) lo hace el servidor solo y lo informa aquí.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Orden de instalación pagada" error={errors.installationOrderId}>
            <Select value={f.installationOrderId} onChange={(e) => { const o = opts.data?.orders.find((x) => x.id === e.target.value); set({ installationOrderId: e.target.value, systemName: f.systemName || (o ? `Ventas ${o.lead.company ?? o.lead.name}` : ''), adminEmail: f.adminEmail || o?.lead.email || '' }); }} required>
              <option value="">Elige</option>
              {orders.map((o) => <option key={o.id} value={o.id}>{installNo(o.number)} · {o.lead.company ?? o.lead.name}</option>)}
            </Select>
          </Field>
          <Field label="Proveedor">
            <Select value={providerId} onChange={(e) => set({ providerId: e.target.value, location: '', serverType: '' })}>
              {opts.data?.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
          </Field>
        </div>
        {order && <p className="text-sm text-muted">{order.tenant ? `Empresa: ${order.tenant.name}` : 'Aún sin empresa: la instalación se detendrá hasta que conviertas al prospecto en cliente.'}{order.serverResources ? ` · Recursos cotizados: ${order.serverResources}` : ''}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Región">
            <Select value={f.location} onChange={(e) => set({ location: e.target.value, serverType: '' })} required>
              <option value="">Elige</option>
              {catalog.data?.locations.filter((l) => l.allowed).map((l) => <option key={l.name} value={l.name}>{l.name} · {l.city}, {l.country}</option>)}
            </Select>
          </Field>
          <Field label="Tamaño" hint="Mínimo recomendado: 2 vCPU y 4 GB">
            <Select value={f.serverType} onChange={(e) => set({ serverType: e.target.value })} required disabled={!f.location}>
              <option value="">{f.location ? 'Elige' : 'Primero la región'}</option>
              {types.filter((t) => t.memoryGb >= 4).map((t) => <option key={t.name} value={t.name}>{t.name} · {t.cores} vCPU, {t.memoryGb} GB · {eur(t.prices.find((x) => x.location === f.location)?.monthly.net, catalog.data!.currency)}/mes</option>)}
            </Select>
          </Field>
        </div>
        {price && <p className="text-sm">Costo del servidor: <strong>{eur(price.monthly.net, catalog.data!.currency)} por mes</strong>, sin impuestos.</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Dominio del cliente" hint="Después de crear el servidor deberás apuntar su registro DNS A a la IP" error={errors.domain}><Input value={f.domain} onChange={(e) => set({ domain: e.target.value.toLowerCase() })} placeholder="ventas.cliente.pe" required /></Field>
          <Field label="Correo del administrador" hint="Administrador de la instalación y avisos de Let's Encrypt" error={errors.adminEmail}><Input type="email" value={f.adminEmail} onChange={(e) => set({ adminEmail: e.target.value })} required /></Field>
          <Field label="Nombre del sistema" error={errors.systemName}><Input value={f.systemName} onChange={(e) => set({ systemName: e.target.value })} maxLength={120} required /></Field>
          <Field label="Contacto de soporte" error={errors.supportContact}><Input value={f.supportContact} onChange={(e) => set({ supportContact: e.target.value })} maxLength={300} required placeholder="soporte@… · +51 …" /></Field>
        </div>
        <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-medium">Correo SMTP de la instalación (del cliente)</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Servidor SMTP" error={errors['smtp.host']}><Input value={f.smtpHost} onChange={(e) => set({ smtpHost: e.target.value })} required placeholder="smtp-relay.brevo.com" /></Field>
            <Field label="Puerto"><Input type="number" value={f.smtpPort} onChange={(e) => set({ smtpPort: e.target.value })} required /></Field>
            <Field label="Usuario SMTP" error={errors['smtp.user']}><Input value={f.smtpUser} onChange={(e) => set({ smtpUser: e.target.value })} /></Field>
            <Field label="Contraseña SMTP" hint="Se guarda cifrada, va una sola vez al servidor y se borra al terminar"><Input type="password" autoComplete="new-password" value={f.smtpPassword} onChange={(e) => set({ smtpPassword: e.target.value })} /></Field>
            <Field label="Remitente" error={errors['smtp.from']} className="sm:col-span-2"><Input value={f.smtpFrom} onChange={(e) => set({ smtpFrom: e.target.value })} required placeholder="Ventas <no-reply@cliente.pe>" /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.smtpSecure} onChange={(e) => set({ smtpSecure: e.target.checked })} />Conexión cifrada desde el inicio (puerto 465)</label>
        </fieldset>
      </form>
    </Dialog>
  );
}

function Runs() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['prov-runs'], queryFn: () => api<RunRow[]>('/platform/provisioning/runs'), refetchInterval: (query) => (query.state.data?.some((r) => ACTIVE.includes(r.status)) ? 5000 : false) });
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Instalaciones automáticas"
        description="Servidor propio para clientes que pagaron una instalación dedicada: se pide el servidor, se aprueba el gasto y el servidor se instala, migra, publica con HTTPS y se entrega. Cada paso queda registrado."
        actions={<Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Nueva instalación</Button>}
      />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? <EmptyState title="Sin instalaciones" description="Registra una a partir de una orden de instalación pagada." /> : (
        <div className="flex flex-col gap-3">
          {q.data!.map((r) => {
            const st = RUN_STATUS[r.status] ?? { label: r.status, tone: 'neutral' as const };
            return (
              <Card key={r.id} className="flex flex-col gap-1 p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/plataforma/aprovisionamiento/${r.id}`} className="font-medium text-primary underline">#{r.number} · {r.domain}</Link>
                  <Badge tone={st.tone}>{st.label}</Badge>
                  {r.stoppedAt && <span className="text-muted">en «{RUN_STATUS[r.stoppedAt]?.label}»</span>}
                  <span className="ml-auto text-xs text-muted">{dateTime(r.createdAt)}</span>
                </div>
                <p className="text-muted">{installNo(r.installationOrder.number)} · {r.installationOrder.lead.company ?? r.installationOrder.lead.name} · {r.serverType} en {r.location}{r.server ? ` · ${r.server.name}${r.server.ipv4 ? ` (${r.server.ipv4})` : ''}` : ''}</p>
                {r.needs && <p className="text-danger">{r.lastError}. {r.needs}</p>}
              </Card>
            );
          })}
        </div>
      )}
      {creating && <NewRun onClose={() => { setCreating(false); void qc.invalidateQueries({ queryKey: ['prov-runs'] }); }} />}
    </div>
  );
}

export default function ProvisioningPage() {
  return (
    <RequirePermission permission="platform:manage">
      <Runs />
    </RequirePermission>
  );
}
