'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { PublicDoc } from '@/components/commercial/public-doc';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { date, dateTime, money } from '@/lib/format';

interface Proposal {
  number: number; code: string; status: string; currency: string; sentAt: string | null; validUntil: string | null;
  issuer: { legalName: string | null; taxId: string | null; address: string | null; email: string | null; whatsapp: string | null } | null;
  client: { name: string; company: string | null; email: string | null; phone: string | null; country: string | null } | null;
  planName: string | null; users: number | null; modules: string[]; deploymentMode: string | null; serverResources: string | null; initialSetup: string | null; integrations: string | null;
  support: string | null; maintenance: string | null; notes: string | null;
  lines: { description: string; billing: 'ONE_TIME' | 'MONTHLY'; quantity: string; unitPrice: string; total: string }[];
  taxName: string | null; taxRate: string | null; pricesIncludeTax: boolean;
  subtotalOneTime: string; taxOneTime: string; totalOneTime: string; subtotalMonthly: string; taxMonthly: string; totalMonthly: string;
  initialPayment: 'ONE_TIME' | 'ONE_TIME_AND_FIRST_MONTH'; initialAmount: string; terms: string | null;
  contract: { version: number; title: string; body: string } | null;
  accepted: { at: string; name: string | null } | null;
}

const MODE: Record<string, string> = { SAAS: 'En nuestra plataforma', DEDICATED: 'Instancia dedicada', CUSTOM: 'Solución a medida' };
const STATUS: Record<string, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  SENT: { label: 'Pendiente de respuesta', tone: 'info' }, ACCEPTED: { label: 'Aceptada', tone: 'success' }, REJECTED: { label: 'Rechazada', tone: 'danger' },
  EXPIRED: { label: 'Vencida', tone: 'warning' }, CANCELLED: { label: 'Anulada', tone: 'neutral' },
};

function ProposalView() {
  const { id } = useParams<{ id: string }>();
  const token = useSearchParams().get('t') ?? '';
  const q = useQuery({ queryKey: ['proposal', id, token], queryFn: () => api<Proposal>(`/public/quotes/${id}`, { query: { t: token } }), retry: false, enabled: token.length >= 20 });
  if (token.length < 20) return <PublicDoc><ErrorBox error={new Error('El enlace no es válido. Pide uno nuevo a tu asesor.')} /></PublicDoc>;
  if (q.isLoading) return <PublicDoc><Loading /></PublicDoc>;
  if (q.error) return <PublicDoc><ErrorBox error={q.error} /></PublicDoc>;
  const p = q.data!;
  const st = STATUS[p.status] ?? { label: p.status, tone: 'neutral' as const };
  const solution: [string, string | null][] = [
    ['Plan', p.planName], ['Usuarios', p.users ? String(p.users) : null], ['Módulos', p.modules.join(', ') || null], ['Modalidad de instalación', p.deploymentMode ? MODE[p.deploymentMode] ?? p.deploymentMode : null],
    ['Recursos de servidor', p.serverResources], ['Configuración inicial', p.initialSetup], ['Integraciones', p.integrations], ['Soporte', p.support], ['Mantenimiento', p.maintenance], ['Observaciones', p.notes],
  ];
  const tax = p.taxName ? `${p.taxName} ${Number(p.taxRate)} %${p.pricesIncludeTax ? ' (incluido)' : ''}` : null;
  return (
    <PublicDoc issuer={p.issuer?.legalName}>
      <Card className="flex flex-col gap-4 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Propuesta {p.code}</h1>
            <p className="text-sm text-muted">Para {[p.client?.name, p.client?.company].filter(Boolean).join(' · ')}</p>
            <p className="text-sm text-muted">Emitida {dateTime(p.sentAt)}{p.validUntil ? ` · válida hasta el ${date(`${p.validUntil}T12:00:00`)}` : ''}</p>
          </div>
          <Badge tone={st.tone}>{st.label}</Badge>
        </div>
        {p.issuer && <p className="text-xs text-muted">{[p.issuer.legalName, p.issuer.taxId && `RUC / ID fiscal ${p.issuer.taxId}`, p.issuer.address, p.issuer.email, p.issuer.whatsapp].filter(Boolean).join(' · ')}</p>}
        <a href={`/api/v1/public/quotes/${id}/pdf?t=${encodeURIComponent(token)}`} className="inline-flex items-center gap-2 self-start rounded-lg border border-border px-4 py-2 text-sm hover:bg-surface-2"><Download className="size-4" />Descargar PDF</a>
      </Card>

      <Card className="p-6">
        <h2 className="mb-3 font-semibold">Solución propuesta</h2>
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
          {solution.filter(([, v]) => v).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="whitespace-pre-line">{v}</dd></div>)}
        </dl>
      </Card>

      <Card className="p-6">
        <h2 className="mb-3 font-semibold">Detalle</h2>
        <ul className="flex flex-col divide-y divide-border text-sm">
          {p.lines.map((l, i) => (
            <li key={i} className="flex flex-wrap justify-between gap-2 py-2">
              <span>{l.description} <span className="text-xs text-muted">· {l.billing === 'ONE_TIME' ? 'pago único' : 'mensual'} · {Number(l.quantity)} × {money(l.unitPrice, p.currency)}</span></span>
              <span className="tabular-nums">{money(l.total, p.currency)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-col gap-1 text-sm sm:ml-auto sm:w-96">
          {Number(p.totalOneTime) > 0 && <>
            <p className="flex justify-between text-muted"><span>Pago único: subtotal</span><span className="tabular-nums">{money(p.subtotalOneTime, p.currency)}</span></p>
            {tax && <p className="flex justify-between text-muted"><span>{tax}</span><span className="tabular-nums">{money(p.taxOneTime, p.currency)}</span></p>}
            <p className="flex justify-between font-medium"><span>Pago único (instalación y servicios)</span><span className="tabular-nums">{money(p.totalOneTime, p.currency)}</span></p>
          </>}
          {Number(p.totalMonthly) > 0 && <>
            <p className="flex justify-between text-muted"><span>Mensualidad: subtotal</span><span className="tabular-nums">{money(p.subtotalMonthly, p.currency)}</span></p>
            {tax && <p className="flex justify-between text-muted"><span>{tax}</span><span className="tabular-nums">{money(p.taxMonthly, p.currency)}</span></p>}
            <p className="flex justify-between font-medium"><span>Mensualidad</span><span className="tabular-nums">{money(p.totalMonthly, p.currency)}</span></p>
          </>}
          {!tax && <p className="text-xs text-muted">Importes sin impuestos aplicados.</p>}
          <p className="mt-2 flex justify-between border-t border-border pt-2 text-base font-semibold"><span>Pago inicial para activar</span><span className="tabular-nums">{money(p.initialAmount, p.currency)}</span></p>
          <p className="text-xs text-muted">{p.initialPayment === 'ONE_TIME' ? 'Corresponde al pago único.' : 'Corresponde al pago único y la primera mensualidad.'}</p>
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-6 text-sm">
        <h2 className="font-semibold">Condiciones</h2>
        <p className="whitespace-pre-line">{p.terms}</p>
        <p className="text-muted">La instalación se inicia después de validar el pago en nuestra cuenta. Un comprobante por sí solo no confirma el pago.</p>
        {p.contract && (
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer font-medium">Contrato: {p.contract.title} (versión {p.contract.version})</summary>
            <p className="mt-3 max-h-96 overflow-y-auto whitespace-pre-line">{p.contract.body}</p>
          </details>
        )}
      </Card>

      {p.status === 'SENT' && p.contract && <Respond id={id} token={token} p={p} />}
      {p.status === 'ACCEPTED' && p.accepted && (
        <Card className="flex items-start gap-3 p-6 text-sm">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
          <p>Aceptada por {p.accepted.name} el {dateTime(p.accepted.at)}. Te enviamos la orden de pago{p.client?.email ? ' por correo' : ''}; si no la tienes, pídela a tu asesor.</p>
        </Card>
      )}
      {(p.status === 'EXPIRED' || p.status === 'CANCELLED' || p.status === 'REJECTED') && (
        <Card className="p-6 text-sm"><p>Esta propuesta ya no se puede aceptar. Si te interesa, escríbenos{p.issuer?.email ? ` a ${p.issuer.email}` : ''} y te enviamos una nueva.</p></Card>
      )}
    </PublicDoc>
  );
}

function Respond({ id, token, p }: { id: string; token: string; p: Proposal }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: p.client?.name ?? '', document: '', email: p.client?.email ?? '', accept: false });
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function accept(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ paymentPath: string }>(`/public/quotes/${id}/accept`, { method: 'POST', body: { token, name: f.name.trim(), document: f.document.trim() || null, email: f.email.trim(), contractVersion: p.contract!.version, accept: f.accept } });
      router.push(r.paymentPath);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  async function reject() {
    setBusy(true);
    setError(null);
    try {
      await api(`/public/quotes/${id}/reject`, { method: 'POST', body: { token, reason: rejecting?.trim() || null } });
      await qc.invalidateQueries({ queryKey: ['proposal', id, token] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="flex flex-col gap-4 p-6">
      <h2 className="font-semibold">Aceptar la propuesta</h2>
      <ErrorBox error={error} />
      <form onSubmit={accept} className="flex flex-col gap-4" aria-label="Aceptar la propuesta">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre completo de quien acepta"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={160} required autoComplete="name" /></Field>
          <Field label="DNI / RUC (opcional)"><Input value={f.document} onChange={(e) => setF({ ...f, document: e.target.value })} maxLength={30} /></Field>
        </div>
        <Field label="Correo para recibir la orden de pago"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={200} autoComplete="email" /></Field>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={f.accept} onChange={(e) => setF({ ...f, accept: e.target.checked })} />
          <span>Acepto la propuesta {p.code} por {money(p.initialAmount, p.currency)} de pago inicial y el contrato «{p.contract!.title}», versión {p.contract!.version}.</span>
        </label>
        <p className="text-xs text-muted">Registramos tu nombre, la fecha, la hora y la dirección desde la que aceptas. Luego verás cómo pagar.</p>
        <Button type="submit" className="self-start" loading={busy && rejecting === null} disabled={!f.accept || !f.name.trim()}>Aceptar y continuar al pago</Button>
      </form>
      <div className="border-t border-border pt-4">
        {rejecting === null ? (
          <Button variant="ghost" onClick={() => setRejecting('')}>No me interesa</Button>
        ) : (
          <div className="flex flex-col gap-2">
            <Field label="¿Nos cuentas por qué? (opcional)"><Textarea value={rejecting} onChange={(e) => setRejecting(e.target.value)} maxLength={1000} rows={2} /></Field>
            <div className="flex gap-2">
              <Button variant="danger" loading={busy} onClick={() => void reject()}>Rechazar la propuesta</Button>
              <Button variant="secondary" onClick={() => setRejecting(null)}>Volver</Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

export default function ProposalPage() {
  return <Suspense fallback={<Loading />}><ProposalView /></Suspense>;
}
