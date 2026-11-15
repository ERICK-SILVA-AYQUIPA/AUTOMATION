'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, Download, Link2, Plus, Save, Send, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/guard';
import { Badge, Button, Card, Dialog, ErrorBox, Field, Input, Loading, PageHeader, Select, Table, Td, Textarea, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, download } from '@/lib/api';
import { DEPLOYMENT_MODE, MODULE_LABEL, date, dateTime, money } from '@/lib/format';
import { BILLING, KIND, LinkDialog, ORDER_STATUS, QUOTE_STATUS, orderNo, quoteNo, type Item, type Line, type Quote } from '../shared';

const PLAN: Record<string, string> = { BASIC: 'Básico', PROFESSIONAL: 'Profesional', ENTERPRISE: 'Empresarial' };
const INITIAL: Record<string, string> = { ONE_TIME: 'Solo el pago único', ONE_TIME_AND_FIRST_MONTH: 'Pago único y primera mensualidad' };

interface LeadInfo { id: string; number: number; name: string; company: string | null; email: string | null; phone: string | null; status: string; interestMode: string | null; interestPlan: string | null; interestModules: string[]; budgetCurrency: string }
type Form = {
  currency: string; country: string; planCode: string; users: string; modules: string[]; deploymentMode: string; serverResources: string; initialSetup: string; integrations: string;
  support: string; maintenance: string; notes: string; initialPayment: 'ONE_TIME' | 'ONE_TIME_AND_FIRST_MONTH'; validUntil: string; terms: string; lines: Line[];
};

const formOfQuote = (q: Quote): Form => ({
  currency: q.currency, country: q.country ?? '', planCode: q.planCode ?? '', users: q.users ? String(q.users) : '', modules: q.modules, deploymentMode: q.deploymentMode ?? '',
  serverResources: q.serverResources ?? '', initialSetup: q.initialSetup ?? '', integrations: q.integrations ?? '', support: q.support ?? '', maintenance: q.maintenance ?? '', notes: q.notes ?? '',
  initialPayment: q.initialPayment, validUntil: q.validUntil?.slice(0, 10) ?? '', terms: q.terms ?? '',
  lines: q.lines.map((l) => ({ itemId: l.itemId, kind: l.kind, billing: l.billing, description: l.description, quantity: String(Number(l.quantity)), unitPrice: l.unitPrice })),
});
const formOfLead = (l: LeadInfo): Form => ({
  currency: l.budgetCurrency || 'PEN', country: 'PE', planCode: l.interestPlan ?? '', users: '', modules: l.interestModules, deploymentMode: l.interestMode ?? '', serverResources: '', initialSetup: '',
  integrations: '', support: '', maintenance: '', notes: '', initialPayment: 'ONE_TIME_AND_FIRST_MONTH', validUntil: '', terms: '', lines: [],
});
const payload = (f: Form) => ({
  ...f, country: f.country.trim() || null, planCode: f.planCode || null, users: f.users ? Number(f.users) : null, deploymentMode: f.deploymentMode || null, validUntil: f.validUntil || null,
  lines: f.lines.map((l) => ({ itemId: l.itemId, kind: l.kind, billing: l.billing, description: l.description.trim(), quantity: l.quantity.trim(), unitPrice: l.unitPrice.trim() })),
});
/** Total de la línea con centavos exactos (como la API) */
const lineTotal = (l: Line) => {
  const q = Number(l.quantity);
  const p = Number(l.unitPrice);
  return Number.isFinite(q) && Number.isFinite(p) ? Math.round(q * p * 100) / 100 : 0;
};

function QuotePage() {
  const { id } = useParams<{ id: string }>();
  const leadId = useSearchParams().get('lead');
  if (id === 'nueva') return leadId ? <NewQuote leadId={leadId} /> : <ErrorBox error={new Error('Abre «Nueva cotización» desde la ficha de un prospecto')} />;
  return <ExistingQuote id={id} />;
}

function NewQuote({ leadId }: { leadId: string }) {
  const lead = useQuery({ queryKey: ['sales-lead', leadId], queryFn: () => api<LeadInfo>(`/platform/sales/leads/${leadId}`) });
  if (lead.isLoading) return <Loading />;
  if (lead.error) return <ErrorBox error={lead.error} />;
  const l = lead.data!;
  return (
    <>
      <Link href={`/plataforma/ventas/${l.id}`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft className="size-4" />{l.name}</Link>
      <PageHeader title="Nueva cotización" description={`Para ${[l.name, l.company].filter(Boolean).join(' · ')}. Se guarda como borrador; nada llega al cliente hasta que la envíes.`} />
      <Editor lead={l} initial={formOfLead(l)} />
    </>
  );
}

function ExistingQuote({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['commerce-quote', id], queryFn: () => api<Quote>(`/platform/commerce/quotes/${id}`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const quote = q.data!;
  return (
    <>
      <Link href="/plataforma/cotizaciones" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft className="size-4" />Cotizaciones y pagos</Link>
      <PageHeader
        title={`${quoteNo(quote.number)} · ${quote.lead.company ?? quote.lead.name}`}
        description={[quote.lead.name, quote.lead.email, quote.lead.phone].filter(Boolean).join(' · ')}
        actions={<Badge tone={QUOTE_STATUS[quote.status]?.tone}>{QUOTE_STATUS[quote.status]?.label ?? quote.status}</Badge>}
      />
      {quote.status === 'DRAFT' ? <Editor key={quote.updatedAt} lead={quote.lead} quote={quote} initial={formOfQuote(quote)} /> : <Sent q={quote} />}
    </>
  );
}

function Editor({ lead, quote, initial }: { lead: { id: string; name: string }; quote?: Quote; initial: Form }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const items = useQuery({ queryKey: ['commerce-items'], queryFn: () => api<Item[]>('/platform/commerce/items') });
  const [f, setF] = useState<Form>(initial);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [link, setLink] = useState<string | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const setLine = (i: number, p: Partial<Line>) => set('lines', f.lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const available = (items.data ?? []).filter((i) => i.isActive && i.currency === f.currency);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);

  const sums = f.lines.reduce((a, l) => ({ ...a, [l.billing]: a[l.billing] + lineTotal(l) }), { ONE_TIME: 0, MONTHLY: 0 } as Record<string, number>);

  function addItem() {
    const it = available.find((i) => i.id === pick);
    if (!it) return;
    set('lines', [...f.lines, { itemId: it.id, kind: it.kind, billing: it.billing, description: it.name, quantity: '1', unitPrice: it.unitPrice }]);
    if (it.kind === 'PLAN' && it.planCode && !f.planCode) set('planCode', it.planCode);
    if (it.kind === 'MODULE' && it.module && !f.modules.includes(it.module)) set('modules', [...f.modules, it.module]);
    setPick('');
  }

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      if (err instanceof ApiError && err.errors?.length) setErrors(Object.fromEntries(err.errors.map((x) => [x.path, x.message])));
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }
  const save = (e?: FormEvent) => {
    e?.preventDefault();
    return run('save', async () => {
      if (quote) {
        const r = await api<Quote>(`/platform/commerce/quotes/${quote.id}`, { method: 'PUT', body: payload(f) });
        qc.setQueryData(['commerce-quote', quote.id], r);
        setErrors({});
        toast.success('Borrador guardado');
      } else {
        const r = await api<Quote>('/platform/commerce/quotes', { method: 'POST', body: { ...payload(f), leadId: lead.id } });
        toast.success(`Borrador ${quoteNo(r.number)} creado`);
        router.replace(`/plataforma/cotizaciones/${r.id}`);
      }
    });
  };

  return (
    <form onSubmit={save} aria-label="Cotización" className="grid gap-6 xl:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-6">
        <Card className="flex flex-col gap-4 p-5">
          <h2 className="font-semibold">Solución propuesta</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Moneda" error={errors.currency}><Input value={f.currency} maxLength={3} onChange={(e) => set('currency', e.target.value.toUpperCase())} required /></Field>
            <Field label="País del cliente" hint="Código de 2 letras (PE, CO…)" error={errors.country}><Input value={f.country} maxLength={2} onChange={(e) => set('country', e.target.value.toUpperCase())} /></Field>
            <Field label="Usuarios" error={errors.users}><Input type="number" min={1} value={f.users} onChange={(e) => set('users', e.target.value)} /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Plan">
              <Select value={f.planCode} onChange={(e) => set('planCode', e.target.value)}>
                <option value="">—</option>
                {Object.entries(PLAN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="Modalidad de instalación">
              <Select value={f.deploymentMode} onChange={(e) => set('deploymentMode', e.target.value)}>
                <option value="">—</option>
                {Object.entries(DEPLOYMENT_MODE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
          </div>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Módulos</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {Object.entries(MODULE_LABEL).map(([k, v]) => (
                <label key={k} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={f.modules.includes(k)} onChange={(e) => set('modules', e.target.checked ? [...f.modules, k] : f.modules.filter((m) => m !== k))} />{v}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Recursos de servidor"><Textarea value={f.serverResources} onChange={(e) => set('serverResources', e.target.value)} maxLength={1000} rows={2} /></Field>
            <Field label="Configuración inicial"><Textarea value={f.initialSetup} onChange={(e) => set('initialSetup', e.target.value)} maxLength={2000} rows={2} /></Field>
            <Field label="Integraciones"><Textarea value={f.integrations} onChange={(e) => set('integrations', e.target.value)} maxLength={2000} rows={2} /></Field>
            <Field label="Soporte"><Textarea value={f.support} onChange={(e) => set('support', e.target.value)} maxLength={1000} rows={2} /></Field>
            <Field label="Mantenimiento"><Textarea value={f.maintenance} onChange={(e) => set('maintenance', e.target.value)} maxLength={1000} rows={2} /></Field>
            <Field label="Observaciones"><Textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} maxLength={4000} rows={2} /></Field>
          </div>
        </Card>

        <Card className="flex flex-col gap-4 p-5">
          <h2 className="font-semibold">Conceptos y precios</h2>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Agregar del catálogo" className="min-w-64 flex-1">
              <Select value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">{available.length ? 'Elige un concepto' : `Sin conceptos activos en ${f.currency}`}</option>
                {available.map((i) => <option key={i.id} value={i.id}>{i.name} · {money(i.unitPrice, i.currency)} {BILLING[i.billing].toLowerCase()}</option>)}
              </Select>
            </Field>
            <Button variant="secondary" icon={<Plus className="size-4" />} disabled={!pick} onClick={addItem}>Agregar</Button>
            <Button variant="ghost" icon={<Plus className="size-4" />} onClick={() => set('lines', [...f.lines, { itemId: null, kind: 'OTHER', billing: 'ONE_TIME', description: '', quantity: '1', unitPrice: '' }])}>Concepto libre</Button>
          </div>
          {errors.lines && <p className="text-xs text-danger" role="alert">{errors.lines}</p>}
          {f.lines.length > 0 && (
            <div className="flex flex-col gap-3">
              {f.lines.map((l, i) => (
                <div key={i} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_9rem_5rem_8rem_7rem_auto] sm:items-center">
                  <Input aria-label={`Descripción ${i + 1}`} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} maxLength={500} required placeholder="Descripción" className="sm:col-span-6" />
                  {!l.itemId ? (
                    <Select aria-label={`Tipo ${i + 1}`} value={l.kind} onChange={(e) => setLine(i, { kind: e.target.value })}>
                      {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </Select>
                  ) : <p className="self-center text-xs text-muted">{KIND[l.kind]} · del catálogo</p>}
                  <Select aria-label={`Cobro ${i + 1}`} value={l.billing} disabled={!!l.itemId} onChange={(e) => setLine(i, { billing: e.target.value as Line['billing'] })}>
                    {Object.entries(BILLING).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                  <Input aria-label={`Cantidad ${i + 1}`} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} required />
                  <Input aria-label={`Precio unitario ${i + 1}`} inputMode="decimal" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} required placeholder="Precio unitario" />
                  <p className="self-center text-sm tabular-nums">{money(lineTotal(l), f.currency)}</p>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => set('lines', f.lines.filter((_, j) => j !== i))}>Quitar</Button>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="flex flex-col gap-4 p-5">
          <h2 className="font-semibold">Condiciones</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Pago inicial para activar">
              <Select value={f.initialPayment} onChange={(e) => set('initialPayment', e.target.value as Form['initialPayment'])}>
                {Object.entries(INITIAL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="Válida hasta" hint="Vacío: la vigencia por defecto al enviarla" error={errors.validUntil}><Input type="date" value={f.validUntil} onChange={(e) => set('validUntil', e.target.value)} /></Field>
          </div>
          <Field label="Condiciones de esta cotización" hint="Vacío: se usan las condiciones generales de la configuración"><Textarea value={f.terms} onChange={(e) => set('terms', e.target.value)} maxLength={10000} rows={4} /></Field>
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <Card className="sticky top-4 flex flex-col gap-3 p-5 text-sm">
          <h2 className="font-semibold">Resumen</h2>
          <p className="flex justify-between"><span className="text-muted">Pago único</span><span className="tabular-nums">{money(sums.ONE_TIME, f.currency)}</span></p>
          <p className="flex justify-between"><span className="text-muted">Mensual</span><span className="tabular-nums">{money(sums.MONTHLY, f.currency)}</span></p>
          {quote && !dirty && quote.taxName && (
            <p className="text-xs text-muted">Con {quote.taxName} {Number(quote.taxRate)} %{quote.pricesIncludeTax ? ' incluido' : ''}: único {money(quote.totalOneTime, quote.currency)}, mensual {money(quote.totalMonthly, quote.currency)}.</p>
          )}
          {quote && !dirty && <p className="font-medium">Pago inicial: {money(quote.initialAmount, quote.currency)}</p>}
          {dirty && <p className="text-xs text-muted">Guarda para calcular impuestos y el pago inicial.</p>}
          <Button type="submit" loading={busy === 'save'} disabled={!f.lines.length} icon={<Save className="size-4" />}>{quote ? 'Guardar borrador' : 'Crear borrador'}</Button>
          {quote && (
            <>
              <Button variant="secondary" icon={<Download className="size-4" />} disabled={dirty} onClick={() => download(`/platform/commerce/quotes/${quote.id}/pdf`).catch(toast.error)}>Vista previa PDF</Button>
              <Button variant="secondary" icon={<Send className="size-4" />} disabled={dirty} onClick={() => setConfirmSend(true)}>Enviar al cliente</Button>
              <Button
                variant="ghost"
                icon={<Trash2 className="size-4" />}
                loading={busy === 'del'}
                onClick={() => void run('del', async () => {
                  await api(`/platform/commerce/quotes/${quote.id}`, { method: 'DELETE' });
                  toast.success('Borrador eliminado');
                  router.replace(`/plataforma/ventas/${lead.id}`);
                })}
              >Eliminar borrador</Button>
              {dirty && <p className="text-xs text-muted">Hay cambios sin guardar.</p>}
            </>
          )}
        </Card>
      </div>

      {quote && (
        <Dialog
          open={confirmSend}
          onClose={() => setConfirmSend(false)}
          title={`Enviar ${quoteNo(quote.number)}`}
          footer={<>
            <Button variant="secondary" onClick={() => setConfirmSend(false)}>Cancelar</Button>
            <Button
              loading={busy === 'send'}
              onClick={() => void run('send', async () => {
                const r = await api<{ path: string; emailed: boolean }>(`/platform/commerce/quotes/${quote.id}/send`, { method: 'POST' });
                setConfirmSend(false);
                toast.success(r.emailed ? 'Enviada: el cliente recibió el enlace por correo' : 'Enviada: comparte el enlace con el cliente');
                setLink(r.path);
              })}
            >Enviar</Button>
          </>}
        >
          <p className="text-sm">Al enviarla, la cotización queda congelada (no se puede editar), toma el contrato vigente y la vigencia, y el prospecto pasa a «Cotización enviada». Se genera un enlace para que el cliente la vea, la descargue y la acepte.</p>
        </Dialog>
      )}
      <LinkDialog
        path={link}
        title="Enlace de la propuesta"
        onClose={() => {
          setLink(null);
          if (quote) void qc.invalidateQueries({ queryKey: ['commerce-quote', quote.id] });
        }}
      />
    </form>
  );
}

function Sent({ q }: { q: Quote }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [link, setLink] = useState<string | null>(null);
  const [cancel, setCancel] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['commerce-quote', q.id] });
  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }
  const rows: [string, string | null][] = [
    ['Plan', q.planCode ? PLAN[q.planCode] ?? q.planCode : null],
    ['Usuarios', q.users ? String(q.users) : null],
    ['Módulos', q.modules.map((m) => MODULE_LABEL[m] ?? m).join(', ') || null],
    ['Modalidad', q.deploymentMode ? DEPLOYMENT_MODE[q.deploymentMode] ?? q.deploymentMode : null],
    ['Recursos de servidor', q.serverResources], ['Configuración inicial', q.initialSetup], ['Integraciones', q.integrations], ['Soporte', q.support], ['Mantenimiento', q.maintenance], ['Observaciones', q.notes],
  ];
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-6">
        <Card className="p-5">
          <h2 className="mb-3 font-semibold">Solución propuesta</h2>
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[11rem_1fr]">
            {rows.filter(([, v]) => v).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="whitespace-pre-line">{v}</dd></div>)}
          </dl>
        </Card>
        <Card className="p-5">
          <h2 className="mb-3 font-semibold">Detalle</h2>
          <Table>
            <thead><tr><Th>Descripción</Th><Th>Cobro</Th><Th className="text-right">Cant.</Th><Th className="text-right">P. unitario</Th><Th className="text-right">Total</Th></tr></thead>
            <tbody>
              {q.lines.map((l) => (
                <tr key={l.id} className="border-t border-border">
                  <Td>{l.description}</Td><Td>{BILLING[l.billing]}</Td><Td className="text-right tabular-nums">{Number(l.quantity)}</Td>
                  <Td className="text-right tabular-nums">{money(l.unitPrice, q.currency)}</Td><Td className="text-right tabular-nums">{money(l.total ?? 0, q.currency)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="mt-4 grid gap-1 text-sm sm:ml-auto sm:w-80">
            <Totals label="Pago único" sub={q.subtotalOneTime} tax={q.taxOneTime} total={q.totalOneTime} q={q} />
            <Totals label="Mensualidad" sub={q.subtotalMonthly} tax={q.taxMonthly} total={q.totalMonthly} q={q} />
            <p className="mt-2 flex justify-between border-t border-border pt-2 font-semibold"><span>Pago inicial</span><span className="tabular-nums">{money(q.initialAmount, q.currency)}</span></p>
          </div>
        </Card>
        <Card className="p-5">
          <h2 className="mb-2 font-semibold">Condiciones</h2>
          <p className="whitespace-pre-line text-sm">{q.terms}</p>
          {q.contractVersion && <p className="mt-2 text-sm text-muted">Contrato: «{q.contractVersion.title}», versión {q.contractVersion.version}.</p>}
        </Card>
      </div>
      <div className="flex flex-col gap-4">
        <Card className="flex flex-col gap-3 p-5 text-sm">
          <h2 className="font-semibold">Seguimiento</h2>
          <p><span className="text-muted">Prospecto: </span><Link href={`/plataforma/ventas/${q.lead.id}`} className="text-primary underline">{q.lead.name}</Link></p>
          <p><span className="text-muted">Enviada: </span>{dateTime(q.sentAt)}</p>
          <p><span className="text-muted">Válida hasta: </span>{q.validUntil ? date(`${q.validUntil.slice(0, 10)}T12:00:00`) : '—'}</p>
          {q.acceptedAt && <p className="rounded-lg bg-success/10 p-2">Aceptada por <strong>{q.acceptedName}</strong>{q.acceptedDocument ? ` (${q.acceptedDocument})` : ''} el {dateTime(q.acceptedAt)}{q.acceptedIp ? ` desde ${q.acceptedIp}` : ''}.</p>}
          {q.rejectedAt && <p className="rounded-lg bg-danger/10 p-2">Rechazada el {dateTime(q.rejectedAt)}{q.rejectionReason ? `: ${q.rejectionReason}` : ''}</p>}
          {q.status === 'CANCELLED' && q.rejectionReason && <p className="text-muted">Motivo de la anulación: {q.rejectionReason}</p>}
          {q.paymentOrders.map((o) => (
            <Link key={o.id} href={`/plataforma/cotizaciones/pagos/${o.id}`} className="flex items-center justify-between rounded-lg border border-border p-2 hover:bg-surface-2">
              <span className="font-mono">{orderNo(o.number)}</span><Badge tone={ORDER_STATUS[o.status]?.tone}>{ORDER_STATUS[o.status]?.label}</Badge>
            </Link>
          ))}
          <Button variant="secondary" icon={<Download className="size-4" />} onClick={() => download(`/platform/commerce/quotes/${q.id}/pdf`).catch(toast.error)}>Descargar PDF</Button>
          {(q.status === 'SENT' || q.status === 'ACCEPTED') && (
            <Button variant="secondary" icon={<Link2 className="size-4" />} loading={busy === 'link'} onClick={() => void run('link', async () => setLink((await api<{ path: string }>(`/platform/commerce/quotes/${q.id}/link`, { method: 'POST' })).path))}>Generar enlace nuevo</Button>
          )}
          {q.status === 'SENT' && <Button variant="ghost" icon={<Ban className="size-4" />} onClick={() => setCancel('')}>Anular</Button>}
          {q.status !== 'SENT' && q.status !== 'ACCEPTED' && <Link href={`/plataforma/cotizaciones/nueva?lead=${q.lead.id}`} className="text-center text-primary underline">Nueva cotización para este prospecto</Link>}
        </Card>
      </div>
      <Dialog
        open={cancel !== null}
        onClose={() => setCancel(null)}
        title={`Anular ${quoteNo(q.number)}`}
        footer={<><Button variant="secondary" onClick={() => setCancel(null)}>Volver</Button><Button variant="danger" loading={busy === 'cancel'} onClick={() => void run('cancel', async () => { await api(`/platform/commerce/quotes/${q.id}/cancel`, { method: 'POST', body: { reason: cancel?.trim() || null } }); setCancel(null); toast.success('Cotización anulada'); refresh(); })}>Anular</Button></>}
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">El enlace del cliente deja de permitir aceptarla. La cotización queda en el historial.</p>
          <Field label="Motivo (opcional)"><Input value={cancel ?? ''} onChange={(e) => setCancel(e.target.value)} maxLength={1000} /></Field>
        </div>
      </Dialog>
      <LinkDialog path={link} title="Nuevo enlace de la propuesta" onClose={() => setLink(null)} />
    </div>
  );
}

function Totals({ label, sub, tax, total, q }: { label: string; sub: string; tax: string; total: string; q: Quote }) {
  if (Number(total) === 0) return null;
  return (
    <>
      <p className="flex justify-between text-muted"><span>{label}: subtotal</span><span className="tabular-nums">{money(sub, q.currency)}</span></p>
      {q.taxName && <p className="flex justify-between text-muted"><span>{q.taxName} {Number(q.taxRate)} %{q.pricesIncludeTax ? ' (incluido)' : ''}</span><span className="tabular-nums">{money(tax, q.currency)}</span></p>}
      <p className="flex justify-between font-medium"><span>{label}: total</span><span className="tabular-nums">{money(total, q.currency)}</span></p>
    </>
  );
}

export default function Page() {
  return (
    <RequirePermission permission="platform:manage">
      <Suspense fallback={<Loading />}>
        <QuotePage />
      </Suspense>
    </RequirePermission>
  );
}
