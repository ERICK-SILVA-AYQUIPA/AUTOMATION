'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, CheckCircle2, Link2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/guard';
import { Badge, Button, Card, Dialog, ErrorBox, Field, Input, Loading, PageHeader, Select, Textarea } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { PAYMENT_METHOD, date, dateTime, money } from '@/lib/format';
import { INSTALL_STATUS, LinkDialog, ORDER_STATUS, entryNo, installNo, orderNo, quoteNo } from '../../shared';

interface Proof { methodId: string; reference: string; payer: string; paidAt: string; amount: string; note: string | null }
interface Order {
  id: string; number: number; concept: string; amount: string; currency: string; country: string | null; status: string; allowedMethodIds: string[]; proof: Proof | null; proofSubmittedAt: string | null;
  paidAt: string | null; method: string | null; reference: string | null; validatedAt: string | null; gatewayProvider: string | null; cancelReason: string | null; createdAt: string;
  lead: { id: string; number: number; name: string; company: string | null; status: string }; quote: { id: string; number: number } | null;
  events: { id: string; type: string; data: Record<string, unknown>; userId: string | null; createdAt: string }[];
  accounting: { id: string; number: number; gross: string; tax: string; net: string; entryDate: string } | null;
  installation: { id: string; number: number; status: string } | null;
  methods: { id: string; name: string; kind: string }[];
}

const EVENT: Record<string, string> = {
  CREATED: 'Orden creada', PROOF_SUBMITTED: 'El cliente informó el pago', PROOF_REJECTED: 'Comprobante no validado', LINK_RENEWED: 'Enlace renovado', METHODS_SET: 'Métodos de pago cambiados',
  CANCELLED: 'Orden anulada', VALIDATED: 'Pago validado (ingreso visto en la cuenta)', GATEWAY_CONFIRMED: 'Pago confirmado por la pasarela', GATEWAY_IGNORED: 'Aviso de pasarela ignorado',
};
const toLocal = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['commerce-order', id], queryFn: () => api<Order>(`/platform/commerce/payments/${id}`) });
  const [link, setLink] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [reason, setReason] = useState<{ kind: 'reject' | 'cancel'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [allowed, setAllowed] = useState<string[] | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['commerce-order', id] });
    void qc.invalidateQueries({ queryKey: ['commerce-orders'] });
  };
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
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const o = q.data!;
  const open = o.status === 'PENDING' || o.status === 'PROOF_SUBMITTED';
  const methodName = (mid: unknown) => o.methods.find((m) => m.id === mid)?.name ?? '—';
  const allowedNow = allowed ?? o.allowedMethodIds;

  return (
    <>
      <Link href="/plataforma/cotizaciones?tab=pagos" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft className="size-4" />Pagos</Link>
      <PageHeader
        title={`${orderNo(o.number)} · ${money(o.amount, o.currency)}`}
        description={`${o.concept} · ${o.lead.company ?? o.lead.name}`}
        actions={<Badge tone={ORDER_STATUS[o.status]?.tone}>{ORDER_STATUS[o.status]?.label ?? o.status}</Badge>}
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-6">
          {o.proof && open && (
            <Card className="flex flex-col gap-2 border-info/40 p-5 text-sm">
              <h2 className="font-semibold">Pago informado por el cliente</h2>
              <p className="text-muted">Es una declaración del cliente: valida solo después de ver el ingreso en la cuenta.</p>
              <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
                {([
                  ['Método', methodName(o.proof.methodId)], ['Operación', o.proof.reference], ['Pagador', o.proof.payer], ['Fecha', date(`${o.proof.paidAt}T12:00:00`)],
                  ['Importe', `${money(o.proof.amount, o.currency)}${Number(o.proof.amount) !== Number(o.amount) ? ' · no coincide con la orden' : ''}`], ['Nota', o.proof.note ?? '—'], ['Informado', dateTime(o.proofSubmittedAt)],
                ] as [string, string][]).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd>{v}</dd></div>)}
              </dl>
            </Card>
          )}
          {o.status === 'PAID' && (
            <Card className="flex flex-col gap-2 p-5 text-sm">
              <h2 className="flex items-center gap-2 font-semibold"><CheckCircle2 className="size-4 text-success" />Pagada</h2>
              <p>{o.method ? PAYMENT_METHOD[o.method] ?? o.method : '—'} · operación {o.reference} · {dateTime(o.paidAt)}{o.gatewayProvider ? ` · pasarela ${o.gatewayProvider}` : ' · validada a mano'}</p>
              {o.accounting && <p>Asiento {entryNo(o.accounting.number)}: bruto {money(o.accounting.gross, o.currency)}, impuesto {money(o.accounting.tax, o.currency)}, neto {money(o.accounting.net, o.currency)}.</p>}
              {o.installation && <p>Orden de instalación <Link href="/plataforma/cotizaciones?tab=instalaciones" className="text-primary underline">{installNo(o.installation.number)}</Link> · {INSTALL_STATUS[o.installation.status]?.label}</p>}
            </Card>
          )}
          {o.status === 'CANCELLED' && <Card className="p-5 text-sm"><p>Anulada{o.cancelReason ? `: ${o.cancelReason}` : ''}.</p></Card>}
          <Card className="p-5">
            <h2 className="mb-3 font-semibold">Historial de la orden</h2>
            <ol className="flex flex-col gap-3 border-l border-border pl-4" aria-label="Historial de la orden">
              {o.events.map((e) => (
                <li key={e.id} className="text-sm">
                  <p className="font-medium">{EVENT[e.type] ?? e.type}</p>
                  {typeof e.data.reason === 'string' && <p className="text-muted">{e.data.reason}</p>}
                  {e.type === 'PROOF_SUBMITTED' && <p className="text-muted">{money(String(e.data.amount), o.currency)} · operación {String(e.data.reference)}</p>}
                  {e.type === 'VALIDATED' && <p className="text-muted">{PAYMENT_METHOD[String(e.data.method)] ?? String(e.data.method)} · operación {String(e.data.reference)}{e.data.note ? ` · ${String(e.data.note)}` : ''}</p>}
                  <p className="text-xs text-muted">{dateTime(e.createdAt)}</p>
                </li>
              ))}
            </ol>
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <Card className="flex flex-col gap-3 p-5 text-sm">
            <p><span className="text-muted">Prospecto: </span><Link href={`/plataforma/ventas/${o.lead.id}`} className="text-primary underline">{o.lead.name}</Link></p>
            {o.quote && <p><span className="text-muted">Cotización: </span><Link href={`/plataforma/cotizaciones/${o.quote.id}`} className="text-primary underline">{quoteNo(o.quote.number)}</Link></p>}
            <p><span className="text-muted">Creada: </span>{dateTime(o.createdAt)}</p>
            {open && (
              <>
                <Button icon={<CheckCircle2 className="size-4" />} onClick={() => setValidating(true)}>Validar pago</Button>
                {o.status === 'PROOF_SUBMITTED' && <Button variant="secondary" icon={<XCircle className="size-4" />} onClick={() => setReason({ kind: 'reject', text: '' })}>No validar el comprobante</Button>}
                <Button variant="secondary" icon={<Link2 className="size-4" />} loading={busy === 'link'} onClick={() => void run('link', async () => { setLink((await api<{ path: string }>(`/platform/commerce/payments/${o.id}/link`, { method: 'POST' })).path); refresh(); })}>Generar enlace nuevo</Button>
                <Button variant="ghost" icon={<Ban className="size-4" />} onClick={() => setReason({ kind: 'cancel', text: '' })}>Anular orden</Button>
              </>
            )}
          </Card>
          {open && (
            <Card className="flex flex-col gap-2 p-5 text-sm">
              <h2 className="font-semibold">Métodos que ve el cliente</h2>
              <p className="text-xs text-muted">Sin marcar ninguno, ve todos los activos para el país ({o.country ?? 'sin país'}) y la moneda ({o.currency}).</p>
              {o.methods.map((m) => (
                <label key={m.id} className="flex items-center gap-2">
                  <input type="checkbox" checked={allowedNow.includes(m.id)} onChange={(e) => setAllowed(e.target.checked ? [...allowedNow, m.id] : allowedNow.filter((x) => x !== m.id))} />
                  {m.name} <span className="text-xs text-muted">({PAYMENT_METHOD[m.kind] ?? m.kind})</span>
                </label>
              ))}
              {!o.methods.length && <p className="text-muted">No hay métodos configurados (Configuración).</p>}
              {allowed && (
                <Button size="sm" variant="secondary" loading={busy === 'methods'} onClick={() => void run('methods', async () => { await api(`/platform/commerce/payments/${o.id}/methods`, { method: 'PUT', body: { methodIds: allowed } }); setAllowed(null); toast.success('Métodos guardados'); refresh(); })}>Guardar métodos</Button>
              )}
            </Card>
          )}
        </div>
      </div>
      {validating && <ValidateDialog o={o} onClose={() => setValidating(false)} onDone={() => { setValidating(false); toast.success('Pago validado: se registró el ingreso y la orden de instalación'); refresh(); }} />}
      <Dialog
        open={!!reason}
        onClose={() => setReason(null)}
        title={reason?.kind === 'reject' ? 'No validar el comprobante' : `Anular ${orderNo(o.number)}`}
        footer={<>
          <Button variant="secondary" onClick={() => setReason(null)}>Volver</Button>
          <Button
            variant="danger"
            disabled={(reason?.text.trim().length ?? 0) < 3}
            loading={busy === 'reason'}
            onClick={() => void run('reason', async () => {
              await api(`/platform/commerce/payments/${o.id}/${reason!.kind === 'reject' ? 'reject-proof' : 'cancel'}`, { method: 'POST', body: { reason: reason!.text.trim() } });
              toast.success(reason!.kind === 'reject' ? 'La orden vuelve a «Pendiente de pago»' : 'Orden anulada');
              setReason(null);
              refresh();
            })}
          >Confirmar</Button>
        </>}
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{reason?.kind === 'reject' ? 'La orden vuelve a pendiente y el cliente puede informar el pago otra vez. Avísale el motivo.' : 'El cliente ya no podrá informar pagos con este enlace.'}</p>
          <Field label="Motivo"><Input value={reason?.text ?? ''} onChange={(e) => setReason(reason && { ...reason, text: e.target.value })} maxLength={1000} required /></Field>
        </div>
      </Dialog>
      <LinkDialog path={link} title="Enlace de pago" onClose={() => setLink(null)} />
    </>
  );
}

function ValidateDialog({ o, onClose, onDone }: { o: Order; onClose: () => void; onDone: () => void }) {
  const proofMethod = o.methods.find((m) => m.id === o.proof?.methodId)?.kind;
  const [f, setF] = useState({
    method: proofMethod ?? 'YAPE', reference: o.proof?.reference ?? '', paidAt: o.proof ? `${o.proof.paidAt}T00:00` : toLocal(new Date()), amount: o.amount, note: '', verified: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/platform/commerce/payments/${o.id}/validate`, { method: 'POST', body: { method: f.method, reference: f.reference.trim(), paidAt: new Date(f.paidAt).toISOString(), amount: f.amount.trim(), verifiedInAccount: f.verified, note: f.note.trim() || null } });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title={`Validar ${orderNo(o.number)}`} footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="validate-form" loading={busy} disabled={!f.verified}>Confirmar pago</Button></>}>
      <form id="validate-form" onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-muted">Confirma solo después de ver el ingreso en la cuenta. Al confirmar se registra el ingreso, nace la orden de instalación y el prospecto pasa a «Pago confirmado». Queda con tu nombre.</p>
        <ErrorBox error={error} />
        <Field label={`Importe recibido (${o.currency})`} hint={`Debe coincidir con la orden: ${money(o.amount, o.currency)}`}><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required /></Field>
        <Field label="Medio">
          <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            {Object.entries(PAYMENT_METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Número de operación"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} maxLength={120} required /></Field>
        <Field label="Fecha y hora del pago"><Input type="datetime-local" value={f.paidAt} onChange={(e) => setF({ ...f, paidAt: e.target.value })} required /></Field>
        <Field label="Nota (opcional)"><Textarea value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={2000} rows={2} /></Field>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={f.verified} onChange={(e) => setF({ ...f, verified: e.target.checked })} />
          <span>Verifiqué el ingreso en la cuenta (no solo el comprobante)</span>
        </label>
      </form>
    </Dialog>
  );
}

export default function OrderPage() {
  return <RequirePermission permission="platform:manage"><OrderDetail /></RequirePermission>;
}
