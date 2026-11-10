'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Monitor } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, date, num } from '@/lib/format';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Select } from '@/components/ui';
import type { Branch } from '@/lib/types';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';

interface Tenant {
  id: string; name: string; slug: string; currency: string; timezone: string; status: string; createdAt: string;
  subscription: { status: string; trialEndsAt: string | null; currentPeriodEnd: string | null; plan: { code: string; name: string; priceMonthly: string; currency: string } } | null;
  limits: { maxUsers: number; maxWhatsappNumbers: number; maxConversationsPerMonth: number; maxProducts: number; maxBranches: number; features: string[] };
  usage: { period: string; users: number; products: number; whatsappNumbers: number; conversations?: number };
}
interface Session { id: string; userAgent: string | null; ip: string | null; createdAt: string; expiresAt: string; current: boolean }

const SUB_STATUS: Record<string, string> = { TRIALING: 'Periodo de prueba', ACTIVE: 'Activa', PAST_DUE: 'Pago pendiente', CANCELED: 'Cancelada' };
const FEATURE_LABEL: Record<string, string> = {
  human_handoff: 'Transferencia a humano', reports: 'Reportes', advanced_automations: 'Automatizaciones avanzadas',
  advanced_ai: 'IA avanzada', multi_branch: 'Varias sucursales', advanced_roles: 'Roles avanzados',
};
const CURRENCIES = ['PEN', 'USD', 'MXN', 'COP', 'CLP', 'ARS', 'BOB', 'EUR'];
const TIMEZONES = ['America/Lima', 'America/Bogota', 'America/Mexico_City', 'America/Santiago', 'America/Argentina/Buenos_Aires', 'America/La_Paz', 'America/Guayaquil', 'America/Caracas', 'America/New_York', 'Europe/Madrid', 'UTC'];

function Usage({ label, used, max }: { label: string; used: number; max: number }) {
  const pct = Math.min(100, Math.round((used / max) * 100));
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm"><span>{label}</span><span className="tabular-nums text-muted">{num(used)} / {num(max)}</span></div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={used} aria-valuemax={max} aria-label={label}>
        <div className={`h-full rounded-full ${pct >= 90 ? 'bg-danger' : pct >= 75 ? 'bg-warning' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Settings() {
  const { can, reload } = useAuth();
  const edit = can('tenant:settings');
  const qc = useQueryClient();
  const toast = useToast();
  const t = useQuery({ queryKey: ['tenant'], queryFn: () => api<Tenant>('/tenant') });
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<Session[]>('/auth/sessions') });
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api<Branch[]>('/branches') });
  const [draft, setDraft] = useState<{ name: string; currency: string; timezone: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/tenant', { method: 'PATCH', body: f });
      await reload();
      await qc.invalidateQueries();
      setDraft(null);
      toast.success('Datos de la empresa guardados');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    try {
      await api(`/auth/sessions/${id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['sessions'] });
      toast.success('Sesión cerrada');
    } catch (err) {
      toast.error(err);
    }
  }

  if (t.isLoading) return <Loading />;
  if (!t.data) return <ErrorBox error={t.error} />;
  const d = t.data;
  const f = draft ?? { name: d.name, currency: d.currency, timezone: d.timezone };
  const setF = setDraft;
  const sub = d.subscription;
  const zones = TIMEZONES.includes(f.timezone) ? TIMEZONES : [f.timezone, ...TIMEZONES];

  return (
    <>
      <PageHeader title="Configuración" description="Datos de la empresa, plan y seguridad de tu cuenta." />
      <div className="grid gap-6 lg:grid-cols-2">
        <form onSubmit={save}>
          <Card className="flex flex-col gap-4 p-5">
            <h2 className="font-medium">Empresa</h2>
            <Field label="Nombre comercial"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={!edit} required minLength={2} maxLength={120} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Moneda" hint="Se usa en precios y pedidos nuevos">
                <Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} disabled={!edit}>
                  {(CURRENCIES.includes(f.currency) ? CURRENCIES : [f.currency, ...CURRENCIES]).map((c) => <option key={c}>{c}</option>)}
                </Select>
              </Field>
              <Field label="Zona horaria" hint="Para el panel y los reportes">
                <Select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} disabled={!edit}>
                  {zones.map((z) => <option key={z}>{z}</option>)}
                </Select>
              </Field>
            </div>
            <p className="text-xs text-muted">Identificador: {d.slug} · creada el {date(d.createdAt)}</p>
            <ErrorBox error={error} />
            {edit && <Button type="submit" className="self-end" loading={busy}>Guardar</Button>}
          </Card>
        </form>

        <Card className="flex flex-col gap-4 p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Plan {sub?.plan.name}</h2>
            {sub && <Badge tone={sub.status === 'ACTIVE' ? 'success' : sub.status === 'TRIALING' ? 'info' : 'warning'}>{SUB_STATUS[sub.status] ?? sub.status}</Badge>}
          </div>
          {sub?.status === 'TRIALING' && sub.trialEndsAt && <p className="text-sm text-muted">Tu prueba gratuita termina el {date(sub.trialEndsAt)}.</p>}
          <Usage label="Usuarios" used={d.usage.users} max={d.limits.maxUsers} />
          <Usage label="Productos" used={d.usage.products} max={d.limits.maxProducts} />
          <Usage label="Números de WhatsApp" used={d.usage.whatsappNumbers} max={d.limits.maxWhatsappNumbers} />
          <Usage label={`Conversaciones (${d.usage.period})`} used={d.usage.conversations ?? 0} max={d.limits.maxConversationsPerMonth} />
          {branches.data && <Usage label="Sucursales" used={branches.data.length} max={d.limits.maxBranches} />}
          <div className="flex flex-wrap gap-1">
            {Object.entries(FEATURE_LABEL).map(([k, l]) => <Badge key={k} tone={d.limits.features.includes(k) ? 'success' : 'neutral'}>{d.limits.features.includes(k) ? '✓' : '—'} {l}</Badge>)}
          </div>
          <p className="rounded-lg bg-surface-2 p-3 text-xs text-muted">
            Los pagos en línea aún no están activados: no se realiza ningún cobro. Para cambiar de plan, contacta al administrador de la plataforma.
          </p>
        </Card>

        <Card className="p-5 lg:col-span-2">
          <h2 className="mb-3 font-medium">Mis sesiones abiertas</h2>
          {sessions.isLoading ? <Loading /> : (
            <ul className="divide-y divide-border">
              {sessions.data?.map((s) => (
                <li key={s.id} className="flex items-center gap-3 py-3 text-sm">
                  <Monitor className="size-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{s.userAgent ?? 'Dispositivo desconocido'} {s.current && <Badge tone="info">Esta sesión</Badge>}</p>
                    <p className="text-xs text-muted">{s.ip ?? 'IP desconocida'} · iniciada {dateTime(s.createdAt)} · vence {date(s.expiresAt)}</p>
                  </div>
                  {!s.current && <Button size="sm" variant="secondary" icon={<LogOut className="size-4" />} onClick={() => revoke(s.id)}>Cerrar</Button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

export default function ConfiguracionPage() {
  return <RequirePermission permission="tenant:read"><Settings /></RequirePermission>;
}
