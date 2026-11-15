'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { RequirePermission } from '@/components/guard';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Input, Loading, PageHeader, Select, Table, Td, Th, cn } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { api, download } from '@/lib/api';
import { DEPLOYMENT_MODE, MODULE_LABEL, PAYMENT_METHOD, date, dateTime, money } from '@/lib/format';
import { CatalogTab } from './catalog';
import { SettingsTab } from './config';
import { INSTALL_STATUS, ORDER_STATUS, QUOTE_STATUS, entryNo, installNo, orderNo, quoteNo } from './shared';

const TABS = [
  ['cotizaciones', 'Cotizaciones'],
  ['pagos', 'Pagos'],
  ['instalaciones', 'Instalaciones'],
  ['ingresos', 'Ingresos'],
  ['catalogo', 'Catálogo'],
  ['configuracion', 'Configuración'],
] as const;
type Tab = (typeof TABS)[number][0];

interface LeadRef { id: string; number: number; name: string; company: string | null }
interface QuoteRow { id: string; number: number; status: string; currency: string; totalOneTime: string; totalMonthly: string; validUntil: string | null; sentAt: string | null; acceptedAt: string | null; createdAt: string; lead: LeadRef; paymentOrders: { id: string; number: number; status: string }[] }
interface OrderRow { id: string; number: number; concept: string; amount: string; currency: string; status: string; proofSubmittedAt: string | null; paidAt: string | null; createdAt: string; lead: LeadRef; quote: { id: string; number: number } | null }
interface InstallRow {
  id: string; number: number; status: string; deploymentMode: string | null; planCode: string | null; users: number | null; modules: string[]; serverResources: string | null; notes: string | null; createdAt: string;
  lead: LeadRef & { status: string }; quote: { id: string; number: number } | null; paymentOrder: { id: string; number: number }; tenant: { id: string; name: string; status: string } | null;
}
interface Ledger { entries: { id: string; number: number; entryDate: string; description: string; currency: string; gross: string; tax: string; net: string; method: string | null; reference: string | null; lead: LeadRef | null }[]; totals: { currency: string; count: number; gross: string; tax: string; net: string }[] }

const leadLabel = (l: LeadRef) => l.company ?? l.name;
const PLAN: Record<string, string> = { BASIC: 'Básico', PROFESSIONAL: 'Profesional', ENTERPRISE: 'Empresarial' };

function Commerce() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = (TABS.find(([k]) => k === params.get('tab'))?.[0] ?? 'cotizaciones') as Tab;
  return (
    <>
      <PageHeader
        title="Cotizaciones y pagos"
        description="Propuestas para prospectos, aceptación con contrato, órdenes de pago, ingresos registrados y órdenes de instalación. Nada se instala sin un pago validado."
        actions={<Link href="/plataforma/ventas" className="inline-flex h-10 items-center gap-2 rounded-lg border border-border px-4 text-sm hover:bg-surface-2"><FileText className="size-4" />Nueva cotización desde un prospecto</Link>}
      />
      <div role="tablist" aria-label="Secciones" className="mb-5 flex flex-wrap gap-1 border-b border-border">
        {TABS.map(([k, label]) => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={tab === k}
            onClick={() => router.replace(`/plataforma/cotizaciones?tab=${k}`)}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm', tab === k ? 'border-primary font-medium text-text' : 'border-transparent text-muted hover:text-text')}
          >{label}</button>
        ))}
      </div>
      {tab === 'cotizaciones' && <QuotesTab />}
      {tab === 'pagos' && <OrdersTab />}
      {tab === 'instalaciones' && <InstallationsTab />}
      {tab === 'ingresos' && <LedgerTab />}
      {tab === 'catalogo' && <CatalogTab />}
      {tab === 'configuracion' && <SettingsTab />}
    </>
  );
}

function QuotesTab() {
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['commerce-quotes', status], queryFn: () => api<QuoteRow[]>('/platform/commerce/quotes', { query: { status } }) });
  return (
    <div className="flex flex-col gap-4">
      <Field label="Estado" className="w-56">
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos</option>
          {Object.entries(QUOTE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </Select>
      </Field>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? (
        <EmptyState title="Sin cotizaciones" description="Se crean desde la ficha de un prospecto (Ventas › prospecto › Nueva cotización)." />
      ) : (
        <Table>
          <thead><tr><Th>Número</Th><Th>Cliente</Th><Th>Estado</Th><Th className="text-right">Pago único</Th><Th className="text-right">Mensual</Th><Th>Vigencia</Th><Th>Pago</Th></tr></thead>
          <tbody>
            {q.data!.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <Td><Link href={`/plataforma/cotizaciones/${r.id}`} className="font-mono text-primary underline">{quoteNo(r.number)}</Link></Td>
                <Td>{leadLabel(r.lead)}</Td>
                <Td><Badge tone={QUOTE_STATUS[r.status]?.tone}>{QUOTE_STATUS[r.status]?.label ?? r.status}</Badge></Td>
                <Td className="text-right tabular-nums">{money(r.totalOneTime, r.currency)}</Td>
                <Td className="text-right tabular-nums">{money(r.totalMonthly, r.currency)}</Td>
                <Td>{r.validUntil ? date(`${r.validUntil.slice(0, 10)}T12:00:00`) : '—'}</Td>
                <Td>{r.paymentOrders.map((o) => <Link key={o.id} href={`/plataforma/cotizaciones/pagos/${o.id}`} className="mr-2 text-primary underline">{orderNo(o.number)} · {ORDER_STATUS[o.status]?.label}</Link>)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

function OrdersTab() {
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['commerce-orders', status], queryFn: () => api<OrderRow[]>('/platform/commerce/payments', { query: { status } }) });
  return (
    <div className="flex flex-col gap-4">
      <Field label="Estado" className="w-56">
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todas</option>
          {Object.entries(ORDER_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </Select>
      </Field>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? (
        <EmptyState title="Sin órdenes de pago" description="Una orden nace cuando el cliente acepta una propuesta, o al registrar un pago desde la ficha del prospecto." />
      ) : (
        <Table>
          <thead><tr><Th>Orden</Th><Th>Cliente</Th><Th>Concepto</Th><Th className="text-right">Importe</Th><Th>Estado</Th><Th>Fecha</Th></tr></thead>
          <tbody>
            {q.data!.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <Td><Link href={`/plataforma/cotizaciones/pagos/${r.id}`} className="font-mono text-primary underline">{orderNo(r.number)}</Link></Td>
                <Td>{leadLabel(r.lead)}</Td>
                <Td>{r.concept}</Td>
                <Td className="text-right tabular-nums">{money(r.amount, r.currency)}</Td>
                <Td><Badge tone={ORDER_STATUS[r.status]?.tone}>{ORDER_STATUS[r.status]?.label ?? r.status}</Badge></Td>
                <Td>{dateTime(r.paidAt ?? r.proofSubmittedAt ?? r.createdAt)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

function InstallationsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['commerce-installs', status], queryFn: () => api<InstallRow[]>('/platform/commerce/installations', { query: { status } }) });
  async function move(r: InstallRow, to: 'IN_PROGRESS' | 'DONE' | 'CANCELLED') {
    setBusy(r.id);
    try {
      await api(`/platform/commerce/installations/${r.id}/status`, { method: 'POST', body: { status: to } });
      toast.success(`${installNo(r.number)}: ${INSTALL_STATUS[to]!.label.toLowerCase()}`);
      void qc.invalidateQueries({ queryKey: ['commerce-installs'] });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <Field label="Estado" className="w-56">
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todas</option>
          {Object.entries(INSTALL_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </Select>
      </Field>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? (
        <EmptyState title="Sin órdenes de instalación" description="Una orden de instalación nace solo cuando se valida el pago de una orden." />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {q.data!.map((r) => (
            <Card key={r.id} className="flex flex-col gap-2 p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-medium">{installNo(r.number)}</span>
                <Badge tone={INSTALL_STATUS[r.status]?.tone}>{INSTALL_STATUS[r.status]?.label ?? r.status}</Badge>
                <span className="text-xs text-muted">{dateTime(r.createdAt)}</span>
              </div>
              <p><Link href={`/plataforma/ventas/${r.lead.id}`} className="font-medium text-primary underline">{leadLabel(r.lead)}</Link>{' · '}pago <Link href={`/plataforma/cotizaciones/pagos/${r.paymentOrder.id}`} className="text-primary underline">{orderNo(r.paymentOrder.number)}</Link>{r.quote && <> · <Link href={`/plataforma/cotizaciones/${r.quote.id}`} className="text-primary underline">{quoteNo(r.quote.number)}</Link></>}</p>
              <p className="text-muted">{[r.deploymentMode && DEPLOYMENT_MODE[r.deploymentMode], r.planCode && `Plan ${PLAN[r.planCode] ?? r.planCode}`, r.users && `${r.users} usuarios`].filter(Boolean).join(' · ') || 'Sin datos de la solución (pago sin cotización)'}</p>
              {r.modules.length > 0 && <p className="text-muted">Módulos: {r.modules.map((m) => MODULE_LABEL[m] ?? m).join(', ')}</p>}
              {r.serverResources && <p className="text-muted">Servidor: {r.serverResources}</p>}
              {r.notes && <p className="whitespace-pre-line text-xs text-muted">{r.notes}</p>}
              <p>{r.tenant ? <>Empresa: <Link href={`/plataforma?empresa=${r.tenant.id}`} className="text-primary underline">{r.tenant.name}</Link></> : <span className="text-muted">Aún sin empresa: conviértelo en cliente desde la ficha del prospecto.</span>}</p>
              <div className="flex flex-wrap gap-2">
                {r.status === 'AUTHORIZED' && <Button size="sm" variant="secondary" loading={busy === r.id} onClick={() => void move(r, 'IN_PROGRESS')}>Marcar en curso</Button>}
                {r.status === 'IN_PROGRESS' && <Button size="sm" variant="secondary" loading={busy === r.id} disabled={!r.tenant} onClick={() => void move(r, 'DONE')}>Marcar terminada</Button>}
                {(r.status === 'AUTHORIZED' || r.status === 'IN_PROGRESS') && <Button size="sm" variant="ghost" loading={busy === r.id} onClick={() => void move(r, 'CANCELLED')}>Cancelar</Button>}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function LedgerTab() {
  const toast = useToast();
  const [range, setRange] = useState({ from: '', to: '' });
  const q = useQuery({ queryKey: ['commerce-ledger', range], queryFn: () => api<Ledger>('/platform/commerce/accounting', { query: range }) });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Desde"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label="Hasta"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
        <Button variant="secondary" icon={<Download className="size-4" />} onClick={() => download('/platform/commerce/accounting/export', range).catch(toast.error)}>Exportar CSV</Button>
      </div>
      <p className="text-xs text-muted">Cada pago validado genera un asiento que no se modifica ni se borra. Es el registro de ingresos de la plataforma; no reemplaza el comprobante tributario.</p>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <>
          {q.data!.totals.length > 0 && (
            <div className="flex flex-wrap gap-3">
              {q.data!.totals.map((t) => (
                <Card key={t.currency} className="p-4 text-sm">
                  <p className="text-muted">{t.count} ingresos en {t.currency}</p>
                  <p className="text-lg font-semibold tabular-nums">{money(t.gross, t.currency)}</p>
                  <p className="text-xs text-muted">Impuesto {money(t.tax, t.currency)} · neto {money(t.net, t.currency)}</p>
                </Card>
              ))}
            </div>
          )}
          {!q.data!.entries.length ? <EmptyState title="Sin ingresos en el periodo" /> : (
            <Table>
              <thead><tr><Th>Asiento</Th><Th>Fecha</Th><Th>Cliente</Th><Th>Descripción</Th><Th className="text-right">Bruto</Th><Th className="text-right">Impuesto</Th><Th className="text-right">Neto</Th><Th>Medio</Th></tr></thead>
              <tbody>
                {q.data!.entries.map((e) => (
                  <tr key={e.id} className="border-t border-border">
                    <Td className="font-mono">{entryNo(e.number)}</Td>
                    <Td>{date(`${e.entryDate.slice(0, 10)}T12:00:00`)}</Td>
                    <Td>{e.lead ? <Link href={`/plataforma/ventas/${e.lead.id}`} className="text-primary underline">{leadLabel(e.lead)}</Link> : '—'}</Td>
                    <Td>{e.description}</Td>
                    <Td className="text-right tabular-nums">{money(e.gross, e.currency)}</Td>
                    <Td className="text-right tabular-nums">{money(e.tax, e.currency)}</Td>
                    <Td className="text-right tabular-nums">{money(e.net, e.currency)}</Td>
                    <Td>{e.method ? PAYMENT_METHOD[e.method] ?? e.method : '—'}{e.reference ? ` · ${e.reference}` : ''}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </>
      )}
    </div>
  );
}

export default function CommercePage() {
  return (
    <RequirePermission permission="platform:manage">
      <Suspense fallback={<Loading />}>
        <Commerce />
      </Suspense>
    </RequirePermission>
  );
}
