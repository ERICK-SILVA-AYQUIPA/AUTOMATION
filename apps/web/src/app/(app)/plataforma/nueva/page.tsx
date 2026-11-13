'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check } from 'lucide-react';
import { api } from '@/lib/api';
import { BUSINESS_TYPE, DEPLOYMENT_MODE, MODULE_LABEL, money } from '@/lib/format';
import { Button, Card, ErrorBox, Field, Input, PageHeader, Select, Textarea, cn } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';

export interface SectorTemplate { key: string; version: number; name: string; description: string; businessType: string; includes: string[]; modules: string[]; categories: string[] }
interface PlanRow { code: string; name: string; priceMonthly: string; currency: string }
interface Draft {
  key: string;
  name: string; legalName: string; taxId: string; country: string; currency: string; timezone: string; address: string; phone: string; contactEmail: string; businessType: string;
  logoUrl: string; brandColor: string; useColor: boolean; customDomain: string; deploymentMode: string; enabledModules: string[];
  planCode: string; startsAt: string; endsAt: string;
  /** '' = sin plantilla */
  templateKey: string; templateCategories: boolean;
  adminName: string; adminEmail: string;
}

const STORAGE = 'aisa:alta-empresa';
const STEPS = ['Sector', 'Empresa', 'Marca y modalidad', 'Plan y periodo', 'Administrador', 'Revisar'];
const TIMEZONES = ['America/Lima', 'America/Bogota', 'America/Mexico_City', 'America/Santiago', 'America/Argentina/Buenos_Aires', 'America/La_Paz', 'America/Guayaquil', 'America/Caracas', 'Europe/Madrid', 'UTC'];
/** Sin plantilla: todo menos reservas, que solo tienen sentido en restaurantes y servicios */
const GENERAL_MODULES = Object.keys(MODULE_LABEL).filter((m) => m !== 'reservations');
const iso = (d: Date) => d.toISOString().slice(0, 10);

function fresh(): Draft {
  const today = new Date();
  return {
    key: crypto.randomUUID(),
    name: '', legalName: '', taxId: '', country: 'PE', currency: 'PEN', timezone: 'America/Lima', address: '', phone: '', contactEmail: '', businessType: 'RETAIL',
    logoUrl: '', brandColor: '#2563eb', useColor: false, customDomain: '', deploymentMode: 'SAAS', enabledModules: GENERAL_MODULES,
    planCode: 'BASIC', startsAt: iso(today), endsAt: iso(new Date(today.getTime() + 14 * 86_400_000)),
    adminName: '', adminEmail: '', templateKey: '', templateCategories: true,
  };
}

/** Guarda el borrador (con su clave) para retomar el alta si se recarga la página o falla la red. */
function load(): Draft {
  try {
    const raw = sessionStorage.getItem(STORAGE);
    if (raw) return { ...fresh(), ...JSON.parse(raw) };
  } catch {
    /* sin almacenamiento: se empieza de cero */
  }
  return fresh();
}

function Summary({ d, plan, tpl }: { d: Draft; plan?: PlanRow; tpl?: SectorTemplate }) {
  const rows: [string, string][] = [
    ['Plantilla', tpl ? `${tpl.name}${tpl.categories.length ? (d.templateCategories ? ' (con categorías sugeridas)' : ' (sin categorías)') : ''}` : 'Sin plantilla'],
    ['Nombre comercial', d.name], ['Razón social', d.legalName || '—'], [d.country === 'PE' ? 'RUC' : 'Identificador fiscal', d.taxId || '—'],
    ['País, moneda y zona', `${d.country} · ${d.currency} · ${d.timezone}`], ['Contacto', [d.contactEmail, d.phone].filter(Boolean).join(' · ') || '—'],
    ['Tipo de negocio', BUSINESS_TYPE[d.businessType]], ['Modalidad', DEPLOYMENT_MODE[d.deploymentMode]], ['Dominio propio', d.customDomain || '—'],
    ['Módulos', d.enabledModules.map((m) => MODULE_LABEL[m]).join(', ')],
    ['Plan', plan ? `${plan.name} (${money(plan.priceMonthly, plan.currency)}/mes)` : d.planCode], ['Periodo inicial', `${d.startsAt} → ${d.endsAt}`],
    ['Administrador', `${d.adminName} · ${d.adminEmail}`],
  ];
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
      {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

function Wizard() {
  const router = useRouter();
  const toast = useToast();
  const [d, setD] = useState<Draft | null>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Límites de fechas fijados al abrir el asistente
  const [bounds] = useState(() => ({ today: iso(new Date()), tomorrow: iso(new Date(Date.now() + 86_400_000)) }));
  const plans = useQuery({ queryKey: ['platform-plans'], queryFn: () => api<PlanRow[]>('/platform/plans') });
  const templates = useQuery({ queryKey: ['platform-templates'], queryFn: () => api<SectorTemplate[]>('/platform/templates') });
  // sessionStorage solo existe en el navegador: el borrador se lee al montar
  // eslint-disable-next-line react-hooks/set-state-in-effect -- lectura única del borrador guardado
  useEffect(() => setD(load()), []);
  useEffect(() => {
    if (!d) return;
    try {
      sessionStorage.setItem(STORAGE, JSON.stringify(d));
    } catch {
      /* sin almacenamiento */
    }
  }, [d]);
  if (!d) return null;
  const set = (p: Partial<Draft>) => setD({ ...d, ...p });
  const plan = plans.data?.find((p) => p.code === d.planCode);
  const tpl = templates.data?.find((t) => t.key === d.templateKey);
  // Elegir una plantilla deja preparados el tipo de negocio y los módulos (se pueden cambiar en los pasos siguientes)
  const pick = (t: SectorTemplate | null) => set(t ? { templateKey: t.key, businessType: t.businessType, enabledModules: [...t.modules] } : { templateKey: '', enabledModules: GENERAL_MODULES });

  function next(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (step < STEPS.length - 1) return setStep(step + 1);
    void create();
  }

  async function create() {
    if (!d) return;
    setBusy(true);
    setError(null);
    const n = (v: string) => (v.trim() ? v.trim() : null);
    try {
      const r = await api<{ tenant: { id: string; name: string }; created: boolean; invitation: { sent: boolean; error?: string } }>('/platform/tenants', {
        method: 'POST',
        body: {
          idempotencyKey: d.key,
          name: d.name.trim(), legalName: n(d.legalName), taxId: n(d.taxId), country: d.country.toUpperCase(), currency: d.currency, timezone: d.timezone,
          address: n(d.address), phone: n(d.phone), contactEmail: n(d.contactEmail), businessType: d.businessType,
          logoUrl: n(d.logoUrl), brandColor: d.useColor ? d.brandColor : null, customDomain: n(d.customDomain), deploymentMode: d.deploymentMode, enabledModules: d.enabledModules,
          planCode: d.planCode, startsAt: new Date(`${d.startsAt}T00:00:00`).toISOString(), endsAt: new Date(`${d.endsAt}T23:59:59`).toISOString(),
          admin: { name: d.adminName.trim(), email: d.adminEmail.trim() },
          templateKey: d.templateKey || null, templateCategories: d.templateCategories,
        },
      });
      try {
        sessionStorage.removeItem(STORAGE);
      } catch {
        /* sin almacenamiento */
      }
      if (!r.created) toast.success(`${r.tenant.name} ya estaba creada: se abre su ficha`);
      else if (r.invitation.sent) toast.success(`${r.tenant.name} creada. Invitación enviada a ${d.adminEmail.trim()}`);
      else toast.error(r.invitation.error ?? 'La empresa se creó, pero no se pudo enviar la invitación');
      router.push(`/plataforma?empresa=${r.tenant.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Nueva empresa"
        description="Alta completa desde la plataforma. La empresa nace en preparación: su equipo puede configurarla, pero el asistente no responde a clientes hasta que la actives."
        actions={<Link href="/plataforma" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft className="size-4" />Empresas</Link>}
      />
      <ol className="mb-6 flex flex-wrap gap-2 text-sm" aria-label="Pasos">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? 'step' : undefined}>
            <button type="button" disabled={i > step} onClick={() => setStep(i)} className={cn('flex items-center gap-1.5 rounded-full px-3 py-1', i === step ? 'bg-primary text-primary-fg' : i < step ? 'bg-surface-2 text-text' : 'text-muted')}>
              {i < step ? <Check className="size-3.5" /> : <span className="tabular-nums">{i + 1}</span>}{s}
            </button>
          </li>
        ))}
      </ol>
      <form onSubmit={next}>
        <Card className="flex max-w-3xl flex-col gap-4 p-5">
          {step === 0 && (
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-1 text-sm text-muted">Elige el sector: deja preparados módulos, reglas, automatizaciones e indicaciones del asistente. La empresa puede personalizarlo después.</legend>
              <ErrorBox error={templates.error} />
              <div className="grid gap-3 sm:grid-cols-2">
                {templates.data?.map((t) => (
                  <label key={t.key} className={cn('flex cursor-pointer flex-col gap-2 rounded-xl border p-4 text-sm transition', d.templateKey === t.key ? 'border-primary ring-1 ring-primary' : 'border-border hover:bg-surface-2/60')}>
                    <span className="flex items-center gap-2 font-medium"><input type="radio" name="template" className="accent-[var(--primary)]" checked={d.templateKey === t.key} onChange={() => pick(t)} />{t.name}</span>
                    <span className="text-muted">{t.description}</span>
                    <ul className="list-disc pl-5 text-xs text-muted">{t.includes.map((x) => <li key={x}>{x}</li>)}</ul>
                  </label>
                ))}
                <label className={cn('flex cursor-pointer flex-col gap-2 rounded-xl border p-4 text-sm transition', !d.templateKey ? 'border-primary ring-1 ring-primary' : 'border-border hover:bg-surface-2/60')}>
                  <span className="flex items-center gap-2 font-medium"><input type="radio" name="template" className="accent-[var(--primary)]" checked={!d.templateKey} onChange={() => pick(null)} />Sin plantilla</span>
                  <span className="text-muted">Todos los módulos encendidos y reglas generales. Se puede aplicar una plantilla más adelante.</span>
                </label>
              </div>
              {tpl && tpl.categories.length > 0 && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={d.templateCategories} onChange={(e) => set({ templateCategories: e.target.checked })} />
                  Crear categorías sugeridas: {tpl.categories.join(', ')}
                </label>
              )}
            </fieldset>
          )}
          {step === 1 && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nombre comercial"><Input value={d.name} onChange={(e) => set({ name: e.target.value })} required minLength={2} maxLength={120} autoFocus /></Field>
              <Field label="Razón social"><Input value={d.legalName} onChange={(e) => set({ legalName: e.target.value })} maxLength={200} /></Field>
              <Field label="País" hint="Código de 2 letras"><Input value={d.country} onChange={(e) => set({ country: e.target.value.toUpperCase() })} required pattern="[A-Za-z]{2}" maxLength={2} /></Field>
              <Field label={d.country === 'PE' ? 'RUC' : 'Identificador fiscal'} hint={d.country === 'PE' ? '11 dígitos' : undefined}>
                <Input value={d.taxId} onChange={(e) => set({ taxId: e.target.value })} maxLength={30} pattern={d.country === 'PE' ? '(10|15|17|20)[0-9]{9}' : undefined} title={d.country === 'PE' ? 'El RUC tiene 11 dígitos y empieza por 10, 15, 17 o 20' : undefined} />
              </Field>
              <Field label="Moneda">
                <Select value={d.currency} onChange={(e) => set({ currency: e.target.value })}>{['PEN', 'USD', 'MXN', 'COP', 'CLP', 'ARS', 'BOB', 'EUR'].map((c) => <option key={c}>{c}</option>)}</Select>
              </Field>
              <Field label="Zona horaria">
                <Select value={d.timezone} onChange={(e) => set({ timezone: e.target.value })}>{TIMEZONES.map((z) => <option key={z}>{z}</option>)}</Select>
              </Field>
              <Field label="Tipo de negocio">
                <Select value={d.businessType} onChange={(e) => set({ businessType: e.target.value })}>{Object.entries(BUSINESS_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
              </Field>
              <Field label="Teléfono"><Input type="tel" value={d.phone} onChange={(e) => set({ phone: e.target.value })} maxLength={30} /></Field>
              <Field label="Correo de contacto"><Input type="email" value={d.contactEmail} onChange={(e) => set({ contactEmail: e.target.value })} maxLength={200} /></Field>
              <Field label="Dirección"><Textarea rows={2} value={d.address} onChange={(e) => set({ address: e.target.value })} maxLength={300} /></Field>
            </div>
          )}
          {step === 2 && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Modalidad">
                  <Select value={d.deploymentMode} onChange={(e) => set({ deploymentMode: e.target.value })}>{Object.entries(DEPLOYMENT_MODE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
                </Field>
                <Field label="Dominio propio (opcional)" hint="Solo se registra: el DNS y el certificado se configuran en el servidor">
                  <Input value={d.customDomain} onChange={(e) => set({ customDomain: e.target.value })} maxLength={253} placeholder="ventas.miempresa.pe" />
                </Field>
                <Field label="Logotipo (URL https, opcional)"><Input type="url" pattern="https://.*" value={d.logoUrl} onChange={(e) => set({ logoUrl: e.target.value })} maxLength={500} /></Field>
                <div className="flex items-center gap-3 pt-6 text-sm">
                  <label className="flex items-center gap-2"><input type="checkbox" className="size-4 accent-[var(--primary)]" checked={d.useColor} onChange={(e) => set({ useColor: e.target.checked })} />Color de marca</label>
                  {d.useColor && <input type="color" aria-label="Color de marca" value={d.brandColor} onChange={(e) => set({ brandColor: e.target.value })} className="h-8 w-12 cursor-pointer rounded border border-border bg-transparent" />}
                </div>
              </div>
              <fieldset>
                <legend className="mb-1 text-sm font-medium">Módulos</legend>
                <div className="grid gap-1 text-sm sm:grid-cols-2">
                  {Object.entries(MODULE_LABEL).map(([k, l]) => (
                    <label key={k} className="flex items-center gap-2">
                      <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={d.enabledModules.includes(k)} onChange={(e) => set({ enabledModules: e.target.checked ? [...d.enabledModules, k] : d.enabledModules.filter((x) => x !== k) })} />{l}
                    </label>
                  ))}
                </div>
                {!d.enabledModules.length && <p className="mt-1 text-xs text-danger">Elige al menos un módulo.</p>}
              </fieldset>
            </>
          )}
          {step === 3 && (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Plan" hint={plan ? `${money(plan.priceMonthly, plan.currency)} al mes` : undefined}>
                  <Select value={d.planCode} onChange={(e) => set({ planCode: e.target.value })}>{plans.data?.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</Select>
                </Field>
                <Field label="Inicio del periodo"><Input type="date" value={d.startsAt} max={bounds.today} onChange={(e) => set({ startsAt: e.target.value })} required /></Field>
                <Field label="Fin del periodo"><Input type="date" value={d.endsAt} min={bounds.tomorrow} onChange={(e) => set({ endsAt: e.target.value })} required /></Field>
              </div>
              <p className="rounded-lg bg-surface-2 p-3 text-sm text-muted">Es un periodo de prueba o cortesía: no registra ningún cobro. Cuando la empresa pague, regístralo en «Cobro» y el plan se activa desde esa fecha.</p>
            </>
          )}
          {step === 4 && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Nombre del administrador"><Input value={d.adminName} onChange={(e) => set({ adminName: e.target.value })} required minLength={2} maxLength={120} /></Field>
                <Field label="Correo del administrador"><Input type="email" value={d.adminEmail} onChange={(e) => set({ adminEmail: e.target.value })} required maxLength={200} /></Field>
              </div>
              <p className="rounded-lg bg-surface-2 p-3 text-sm text-muted">Recibirá un correo para crear su propia contraseña (vale 7 días). Nadie más la conoce ni se muestra en pantalla.</p>
            </>
          )}
          {step === 5 && <Summary d={d} plan={plan} tpl={tpl} />}
          <ErrorBox error={error} />
          <div className="flex justify-between gap-2">
            <Button type="button" variant="ghost" onClick={() => (step ? setStep(step - 1) : router.push('/plataforma'))}>{step ? 'Atrás' : 'Cancelar'}</Button>
            <Button type="submit" loading={busy} disabled={step === 2 && !d.enabledModules.length}>{step < STEPS.length - 1 ? 'Siguiente' : 'Crear empresa y enviar invitación'}</Button>
          </div>
        </Card>
      </form>
    </>
  );
}

export default function NuevaEmpresaPage() {
  return <RequirePermission permission="platform:manage"><Wizard /></RequirePermission>;
}
