'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Monitor } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { BUSINESS_TYPE, PAYMENT_METHOD, dateTime, date, money, num } from '@/lib/format';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Select, Textarea } from '@/components/ui';
import type { Branch, SubscriptionAccess } from '@/lib/types';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';

interface Tenant {
  id: string; name: string; slug: string; currency: string; timezone: string; status: string; createdAt: string;
  legalName: string | null; taxId: string | null; country: string; address: string | null; phone: string | null; contactEmail: string | null;
  businessType: string; logoUrl: string | null; brandColor: string | null; customDomain: string | null; deploymentMode: string;
  subscription: { status: string; trialEndsAt: string | null; currentPeriodEnd: string | null; plan: { code: string; name: string; priceMonthly: string; currency: string }; access: SubscriptionAccess } | null;
  limits: { maxUsers: number; maxWhatsappNumbers: number; maxConversationsPerMonth: number; maxProducts: number; maxBranches: number; features: string[] };
  usage: { period: string; users: number; products: number; whatsappNumbers: number; conversations?: number };
}
interface Profile {
  name: string; currency: string; timezone: string; country: string; businessType: string; legalName: string; taxId: string;
  address: string; phone: string; contactEmail: string; logoUrl: string; brandColor: string; useColor: boolean;
}
interface Session { id: string; userAgent: string | null; ip: string | null; createdAt: string; expiresAt: string; current: boolean }

const ACCESS: Record<SubscriptionAccess['state'], { label: string; tone: 'info' | 'success' | 'warning' | 'danger' }> = {
  TRIAL: { label: 'Periodo de prueba', tone: 'info' },
  ACTIVE: { label: 'Activa', tone: 'success' },
  GRACE: { label: 'Vencida (en gracia)', tone: 'warning' },
  EXPIRED: { label: 'Solo lectura', tone: 'danger' },
  CANCELED: { label: 'Cancelada', tone: 'danger' },
};
interface Payment { id: string; amount: string; currency: string; months: number; method: string; reference: string | null; paidAt: string; periodEnd: string; plan: { name: string } }
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
  const { can, reload, me } = useAuth();
  const edit = can('tenant:settings');
  const qc = useQueryClient();
  const toast = useToast();
  const t = useQuery({ queryKey: ['tenant'], queryFn: () => api<Tenant>('/tenant') });
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<Session[]>('/auth/sessions') });
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api<Branch[]>('/branches') });
  const payments = useQuery({ queryKey: ['tenant-payments'], queryFn: () => api<Payment[]>('/tenant/payments'), enabled: can('tenant:settings') });
  const [draft, setDraft] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const n = (v: string) => (v.trim() ? v.trim() : null);
      await api('/tenant', {
        method: 'PATCH',
        body: {
          name: f.name, currency: f.currency, timezone: f.timezone, country: f.country.toUpperCase(), businessType: f.businessType,
          legalName: n(f.legalName), taxId: n(f.taxId), address: n(f.address), phone: n(f.phone), contactEmail: n(f.contactEmail),
          logoUrl: n(f.logoUrl), brandColor: f.useColor ? f.brandColor : null,
        },
      });
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
  const f: Profile = draft ?? {
    name: d.name, currency: d.currency, timezone: d.timezone, country: d.country, businessType: d.businessType,
    legalName: d.legalName ?? '', taxId: d.taxId ?? '', address: d.address ?? '', phone: d.phone ?? '', contactEmail: d.contactEmail ?? '',
    logoUrl: d.logoUrl ?? '', brandColor: d.brandColor ?? '#2563eb', useColor: !!d.brandColor,
  };
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
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nombre comercial"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={!edit} required minLength={2} maxLength={120} /></Field>
              <Field label="Razón social"><Input value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} disabled={!edit} maxLength={200} /></Field>
              <Field label={f.country === 'PE' ? 'RUC' : 'Identificador fiscal'} hint={f.country === 'PE' ? '11 dígitos' : undefined}>
                <Input value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value })} disabled={!edit} maxLength={30} inputMode={f.country === 'PE' ? 'numeric' : undefined} pattern={f.country === 'PE' ? '(10|15|17|20)[0-9]{9}' : undefined} title={f.country === 'PE' ? 'El RUC tiene 11 dígitos y empieza por 10, 15, 17 o 20' : undefined} />
              </Field>
              <Field label="País" hint="Código de 2 letras (PE, CO, MX…)"><Input value={f.country} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} disabled={!edit} required pattern="[A-Za-z]{2}" maxLength={2} /></Field>
              <Field label="Tipo de negocio">
                <Select value={f.businessType} onChange={(e) => setF({ ...f, businessType: e.target.value })} disabled={!edit}>
                  {Object.entries(BUSINESS_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </Select>
              </Field>
              <Field label="Teléfono"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} disabled={!edit} maxLength={30} type="tel" /></Field>
              <Field label="Correo de contacto"><Input value={f.contactEmail} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} disabled={!edit} maxLength={200} type="email" /></Field>
              <Field label="Logotipo (URL https)"><Input value={f.logoUrl} onChange={(e) => setF({ ...f, logoUrl: e.target.value })} disabled={!edit} maxLength={500} type="url" pattern="https://.*" placeholder="https://…" /></Field>
            </div>
            <Field label="Dirección"><Textarea rows={2} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} disabled={!edit} maxLength={300} /></Field>
            <div className="flex items-center gap-3 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" className="size-4 accent-[var(--primary)]" checked={f.useColor} onChange={(e) => setF({ ...f, useColor: e.target.checked })} disabled={!edit} />Color de marca</label>
              {f.useColor && <input type="color" aria-label="Color de marca" value={f.brandColor} onChange={(e) => setF({ ...f, brandColor: e.target.value })} disabled={!edit} className="h-8 w-12 cursor-pointer rounded border border-border bg-transparent" />}
              {f.useColor && <span className="font-mono text-xs text-muted">{f.brandColor}</span>}
            </div>
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
            <p className="text-xs text-muted">Identificador: {d.slug} · creada el {date(d.createdAt)}{d.customDomain && ` · dominio ${d.customDomain}`}</p>
            <ErrorBox error={error} />
            {edit && <Button type="submit" className="self-end" loading={busy}>Guardar</Button>}
          </Card>
        </form>

        <Card className="flex flex-col gap-4 p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Plan {sub?.plan.name}</h2>
            {sub && <Badge tone={ACCESS[sub.access.state].tone}>{ACCESS[sub.access.state].label}</Badge>}
          </div>
          {sub && (
            <p className="text-sm text-muted">
              {sub.access.state === 'TRIAL' && `Tu prueba gratuita termina el ${date(sub.access.endsAt)}.`}
              {sub.access.state === 'ACTIVE' && `Pagado hasta el ${date(sub.access.endsAt)}.`}
              {sub.access.state === 'GRACE' && `Venció el ${date(sub.access.endsAt)}; renueva antes del ${date(sub.access.graceEndsAt)}.`}
              {(sub.access.state === 'EXPIRED' || sub.access.state === 'CANCELED') && 'La cuenta está en solo lectura: puedes consultar tus datos, pero no modificarlos.'}
            </p>
          )}
          <Usage label="Usuarios" used={d.usage.users} max={d.limits.maxUsers} />
          <Usage label="Productos" used={d.usage.products} max={d.limits.maxProducts} />
          <Usage label="Números de WhatsApp" used={d.usage.whatsappNumbers} max={d.limits.maxWhatsappNumbers} />
          <Usage label={`Conversaciones (${d.usage.period})`} used={d.usage.conversations ?? 0} max={d.limits.maxConversationsPerMonth} />
          {branches.data && <Usage label="Sucursales" used={branches.data.length} max={d.limits.maxBranches} />}
          <div className="flex flex-wrap gap-1">
            {Object.entries(FEATURE_LABEL).map(([k, l]) => <Badge key={k} tone={d.limits.features.includes(k) ? 'success' : 'neutral'}>{d.limits.features.includes(k) ? '✓' : '—'} {l}</Badge>)}
          </div>
          <p className="rounded-lg bg-surface-2 p-3 text-xs text-muted">
            El plan se paga por adelantado y no hay cobros automáticos. {me?.billingContact ? `Para pagar o cambiar de plan: ${me.billingContact}` : 'Para pagar o cambiar de plan, contacta al administrador de la plataforma.'}
          </p>
          {payments.data && payments.data.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium">Pagos registrados</h3>
              <ul className="flex flex-col gap-1 text-sm">
                {payments.data.slice(0, 6).map((p) => (
                  <li key={p.id} className="flex justify-between gap-2">
                    <span>{date(p.paidAt)} · {p.plan.name} · {p.months} {p.months === 1 ? 'mes' : 'meses'} <span className="text-muted">({PAYMENT_METHOD[p.method] ?? p.method})</span></span>
                    <span className="tabular-nums">{money(p.amount, p.currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
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
