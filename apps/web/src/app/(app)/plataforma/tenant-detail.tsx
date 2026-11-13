'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { OnboardingTasks, type Onboarding } from '@/components/onboarding';
import { api } from '@/lib/api';
import { BUSINESS_TYPE, DEPLOYMENT_MODE, MODULE_LABEL, date, dateTime, num } from '@/lib/format';
import type { SubscriptionAccess } from '@/lib/types';
import { Badge, Button, Dialog, ErrorBox, Field, Input, Loading, Select } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { TemplateCard } from './template-card';
import { DeliveriesCard } from './deliveries-card';

interface TenantDetail {
  id: string; name: string; slug: string; status: string; createdAt: string; activatedAt: string | null; currency: string; timezone: string;
  legalName: string | null; taxId: string | null; country: string; address: string | null; phone: string | null; contactEmail: string | null;
  businessType: string; logoUrl: string | null; brandColor: string | null; customDomain: string | null; deploymentMode: string; enabledModules: string[];
  subscription: { plan: { name: string }; access: SubscriptionAccess } | null;
  users: { id: string; name: string; email: string; status: string; emailVerifiedAt: string | null }[];
  _count: { users: number };
  whatsappNumbers: { id: string; displayPhone: string | null; status: string; lastError: string | null; lastWebhookAt: string | null; isActive: boolean }[];
  integrations: { type: string; status: string; lastError: string | null; updatedAt: string }[];
  usage: { period: string; counters: Record<string, number>; last30Days: { messages: number; orders: Record<string, number>; automationsFailed: number } };
}

const CONN: Record<string, string> = { CONNECTED: 'Conectado', PENDING: 'Pendiente', DISCONNECTED: 'Desconectado', ERROR: 'Error' };
const COUNTER_LABEL: Record<string, string> = { conversations: 'Conversaciones', ai_replies: 'Respuestas de IA', ai_tokens: 'Tokens de IA' };

function EditForm({ t, onSaved }: { t: TenantDetail; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    legalName: t.legalName ?? '', taxId: t.taxId ?? '', country: t.country, businessType: t.businessType,
    customDomain: t.customDomain ?? '', deploymentMode: t.deploymentMode, enabledModules: t.enabledModules,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toggle = (m: string) => setF({ ...f, enabledModules: f.enabledModules.includes(m) ? f.enabledModules.filter((x) => x !== m) : [...f.enabledModules, m] });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/platform/tenants/${t.id}`, {
        method: 'PATCH',
        body: {
          legalName: f.legalName.trim() || null, taxId: f.taxId.trim() || null, country: f.country.toUpperCase(), businessType: f.businessType,
          customDomain: f.customDomain.trim() || null, deploymentMode: f.deploymentMode, enabledModules: f.enabledModules,
        },
      });
      toast.success('Empresa actualizada');
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form id="tenant-edit" onSubmit={save} className="flex flex-col gap-3 text-sm" aria-busy={busy}>
      <fieldset disabled={busy} className="contents">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Razón social"><Input value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} maxLength={200} /></Field>
        <Field label={f.country === 'PE' ? 'RUC' : 'Identificador fiscal'}><Input value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value })} maxLength={30} /></Field>
        <Field label="País"><Input value={f.country} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} pattern="[A-Za-z]{2}" maxLength={2} required /></Field>
        <Field label="Tipo de negocio">
          <Select value={f.businessType} onChange={(e) => setF({ ...f, businessType: e.target.value })}>
            {Object.entries(BUSINESS_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Modalidad">
          <Select value={f.deploymentMode} onChange={(e) => setF({ ...f, deploymentMode: e.target.value })}>
            {Object.entries(DEPLOYMENT_MODE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Dominio propio" hint="Solo se guarda: apuntar el DNS y el certificado es aparte">
          <Input value={f.customDomain} onChange={(e) => setF({ ...f, customDomain: e.target.value })} maxLength={253} placeholder="ventas.miempresa.pe" />
        </Field>
      </div>
      <fieldset>
        <legend className="mb-1 font-medium">Módulos activos</legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {Object.entries(MODULE_LABEL).map(([k, l]) => (
            <label key={k} className="flex items-center gap-2"><input type="checkbox" className="size-4 accent-[var(--primary)]" checked={f.enabledModules.includes(k)} onChange={() => toggle(k)} />{l}</label>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted">Un módulo desactivado desaparece del menú de la empresa y su API responde 403. Los datos no se borran.</p>
      </fieldset>
      </fieldset>
      <ErrorBox error={error} />
    </form>
  );
}

function Setup({ t, onChanged }: { t: TenantDetail; onChanged: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['platform-onboarding', t.id], queryFn: () => api<Onboarding>(`/platform/tenants/${t.id}/onboarding`) });
  const [busy, setBusy] = useState<string | null>(null);
  const ob = q.data;
  if (!ob) return q.isLoading ? <Loading /> : <ErrorBox error={q.error} />;
  const invitePending = ob.tasks.some((x) => x.key === 'admin_joined' && !x.done);

  async function run(what: 'activate' | 'resend') {
    setBusy(what);
    try {
      if (what === 'activate') {
        await api(`/platform/tenants/${t.id}/activate`, { method: 'POST' });
        toast.success(`${t.name} está activa`);
        onChanged();
      } else {
        const r = await api<{ email: string; sent: boolean; error?: string }[]>(`/platform/tenants/${t.id}/resend-invitation`, { method: 'POST' });
        const failed = r.filter((x) => !x.sent);
        if (failed.length) toast.error(failed[0]!.error ?? 'No se pudo enviar la invitación');
        else toast.success(`Invitación enviada a ${r.map((x) => x.email).join(', ')}`);
      }
      qc.invalidateQueries({ queryKey: ['platform-onboarding', t.id] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Puesta en marcha</h3>
        {ob.status === 'ONBOARDING' ? <Badge tone="info">En preparación</Badge> : ob.activatedAt ? <span className="text-xs text-muted">Activa desde {dateTime(ob.activatedAt)}</span> : null}
      </div>
      <OnboardingTasks tasks={ob.tasks} />
      <div className="mt-3 flex flex-wrap gap-2">
        {ob.status === 'ONBOARDING' && (
          <Button size="sm" loading={busy === 'activate'} disabled={!ob.canActivate} onClick={() => run('activate')} title={ob.canActivate ? undefined : 'Faltan tareas obligatorias'}>Activar empresa</Button>
        )}
        {invitePending && <Button size="sm" variant="secondary" loading={busy === 'resend'} onClick={() => run('resend')}>Reenviar invitación</Button>}
      </div>
      {ob.status === 'ONBOARDING' && !ob.canActivate && <p className="mt-2 text-xs text-muted">Se podrá activar cuando las tareas obligatorias estén hechas. Mientras tanto el asistente no responde a sus clientes.</p>}
    </div>
  );
}

export function TenantDetailDialog({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const q = useQuery({ queryKey: ['platform-tenant', id], queryFn: () => api<TenantDetail>(`/platform/tenants/${id}`), enabled: !!id });
  const t = q.data;
  return (
    <Dialog open={!!id} onClose={onClose} title={t?.name ?? 'Empresa'} wide
      footer={<><Button variant="secondary" onClick={onClose}>Cerrar</Button>{t && <Button type="submit" form="tenant-edit">Guardar cambios</Button>}</>}>
      {q.isLoading ? <Loading /> : !t ? <ErrorBox error={q.error} /> : (
        <div className="flex flex-col gap-6 text-sm">
          <Setup t={t} onChanged={() => { q.refetch(); onChanged(); }} />
          <TemplateCard tenantId={t.id} businessType={t.businessType} onApplied={() => { q.refetch(); onChanged(); }} />
          <DeliveriesCard key={t.deploymentMode} tenant={t} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-1 font-medium">Contacto</h3>
              <p className="text-muted">{t.contactEmail ?? 'Sin correo'} · {t.phone ?? 'sin teléfono'}</p>
              <p className="text-muted">{t.address ?? 'Sin dirección'}</p>
              <p className="text-muted">Alta: {date(t.createdAt)} · {t.currency} · {t.timezone}</p>
            </div>
            <div>
              <h3 className="mb-1 font-medium">Administradores</h3>
              <ul>
                {t.users.map((u) => (
                  <li key={u.id}>{u.name} <span className="text-muted">· {u.email}</span> {!u.emailVerifiedAt && <Badge tone="warning">Correo sin verificar</Badge>}</li>
                ))}
              </ul>
              <p className="text-muted">{num(t._count.users)} usuarios en total</p>
            </div>
            <div>
              <h3 className="mb-1 font-medium">Consumo ({t.usage.period})</h3>
              {Object.keys(t.usage.counters).length === 0 ? <p className="text-muted">Sin consumo este mes.</p> : (
                <ul>{Object.entries(t.usage.counters).map(([k, v]) => <li key={k}>{COUNTER_LABEL[k] ?? k}: <span className="tabular-nums">{num(v)}</span></li>)}</ul>
              )}
              <p className="text-muted">30 días: {num(t.usage.last30Days.messages)} mensajes · {num(Object.values(t.usage.last30Days.orders).reduce((a, b) => a + b, 0))} pedidos</p>
              {t.usage.last30Days.automationsFailed > 0 && <p className="text-danger">{t.usage.last30Days.automationsFailed} automatizaciones fallidas (30 días)</p>}
            </div>
            <div>
              <h3 className="mb-1 font-medium">WhatsApp e integraciones</h3>
              {t.whatsappNumbers.length === 0 && t.integrations.length === 0 && <p className="text-muted">Ninguna configurada.</p>}
              <ul>
                {t.whatsappNumbers.map((n) => (
                  <li key={n.id}>
                    {n.displayPhone ?? 'Número'} <Badge tone={n.status === 'CONNECTED' ? 'success' : n.status === 'PENDING' ? 'neutral' : 'danger'}>{CONN[n.status] ?? n.status}</Badge>
                    <span className="block text-xs text-muted">{n.lastWebhookAt ? `Último webhook: ${dateTime(n.lastWebhookAt)}` : 'Aún no recibe webhooks'}{n.lastError && ` · ${n.lastError}`}</span>
                  </li>
                ))}
                {t.integrations.map((i) => (
                  <li key={i.type}>{i.type} <Badge tone={i.status === 'CONNECTED' ? 'success' : 'neutral'}>{CONN[i.status] ?? i.status}</Badge>{i.lastError && <span className="block text-xs text-danger">{i.lastError}</span>}</li>
                ))}
              </ul>
            </div>
          </div>
          <div className="border-t border-border pt-4">
            <h3 className="mb-3 font-medium">Datos que fija la plataforma</h3>
            <EditForm key={JSON.stringify(t)} t={t} onSaved={() => { q.refetch(); onChanged(); }} />
          </div>
        </div>
      )}
    </Dialog>
  );
}
