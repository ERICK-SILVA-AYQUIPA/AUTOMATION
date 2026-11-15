'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock } from 'lucide-react';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { PublicDoc } from '@/components/commercial/public-doc';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, money } from '@/lib/format';

interface PayOrder {
  code: string; concept: string; amount: string; currency: string; status: 'PENDING' | 'PROOF_SUBMITTED' | 'PAID' | 'CANCELLED'; proofSubmittedAt: string | null; paidAt: string | null;
  quote: { code: string } | null; methods: { id: string; kind: string; name: string; instructions: string }[];
  issuer: { legalName: string | null; email: string | null; whatsapp: string | null } | null;
}
const STATUS = {
  PENDING: { label: 'Pendiente de pago', tone: 'warning' }, PROOF_SUBMITTED: { label: 'Pago informado, por validar', tone: 'info' },
  PAID: { label: 'Pagada', tone: 'success' }, CANCELLED: { label: 'Anulada', tone: 'neutral' },
} as const;
/** Fecha de hoy en Lima (la API no acepta fechas futuras en esa zona) */
const todayLima = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());

function PayView() {
  const { id } = useParams<{ id: string }>();
  const token = useSearchParams().get('t') ?? '';
  const q = useQuery({ queryKey: ['pay-order', id, token], queryFn: () => api<PayOrder>(`/public/payments/${id}`, { query: { t: token } }), retry: false, enabled: token.length >= 20 });
  if (token.length < 20) return <PublicDoc><ErrorBox error={new Error('El enlace no es válido. Pide uno nuevo a tu asesor.')} /></PublicDoc>;
  if (q.isLoading) return <PublicDoc><Loading /></PublicDoc>;
  if (q.error) return <PublicDoc><ErrorBox error={q.error} /></PublicDoc>;
  const o = q.data!;
  const contact = [o.issuer?.email, o.issuer?.whatsapp].filter(Boolean).join(' o ');
  return (
    <PublicDoc issuer={o.issuer?.legalName}>
      <Card className="flex flex-col gap-3 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Orden de pago {o.code}</h1>
            <p className="text-sm text-muted">{o.concept}</p>
          </div>
          <Badge tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Badge>
        </div>
        <p className="text-3xl font-semibold tabular-nums">{money(o.amount, o.currency)}</p>
      </Card>

      {o.status === 'PAID' && (
        <Card className="flex items-start gap-3 p-6 text-sm">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
          <p>Recibimos y validamos tu pago{o.paidAt ? ` del ${dateTime(o.paidAt)}` : ''}. Tu asesor te escribirá para coordinar la instalación.</p>
        </Card>
      )}
      {o.status === 'CANCELLED' && <Card className="p-6 text-sm"><p>Esta orden fue anulada. Si necesitas pagar, pide una nueva a tu asesor{contact ? ` (${contact})` : ''}.</p></Card>}
      {o.status === 'PROOF_SUBMITTED' && (
        <Card className="flex items-start gap-3 p-6 text-sm">
          <Clock className="mt-0.5 size-5 shrink-0 text-info" />
          <p>Recibimos los datos de tu pago el {dateTime(o.proofSubmittedAt)}. Lo confirmaremos cuando veamos el ingreso en nuestra cuenta; la instalación empieza después de esa validación.</p>
        </Card>
      )}

      {(o.status === 'PENDING' || o.status === 'PROOF_SUBMITTED') && (
        <>
          <Card className="flex flex-col gap-3 p-6">
            <h2 className="font-semibold">Cómo pagar</h2>
            {o.methods.length ? o.methods.map((m) => (
              <div key={m.id} className="rounded-lg border border-border p-4 text-sm">
                <p className="font-medium">{m.name}</p>
                <p className="mt-1 whitespace-pre-line">{m.instructions}</p>
              </div>
            )) : <p className="text-sm text-muted">Aún no hay un medio de pago disponible para esta orden. Escríbenos{contact ? ` a ${contact}` : ''} y te enviamos los datos.</p>}
            <p className="text-xs text-muted">Paga exactamente {money(o.amount, o.currency)}. Después informa la operación aquí abajo.</p>
          </Card>
          {o.methods.length > 0 && <ProofForm id={id} token={token} o={o} />}
        </>
      )}
    </PublicDoc>
  );
}

function ProofForm({ id, token, o }: { id: string; token: string; o: PayOrder }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ methodId: o.methods[0]!.id, reference: '', payer: '', paidAt: todayLima(), amount: o.amount, note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/public/payments/${id}/proof`, { method: 'POST', body: { token, methodId: f.methodId, reference: f.reference.trim(), payer: f.payer.trim(), paidAt: f.paidAt, amount: f.amount.trim(), note: f.note.trim() || null } });
      await qc.invalidateQueries({ queryKey: ['pay-order', id, token] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="p-6">
      <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Informar el pago">
        <h2 className="font-semibold">{o.status === 'PROOF_SUBMITTED' ? 'Corregir los datos del pago' : 'Ya pagué'}</h2>
        <ErrorBox error={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Medio usado">
            <Select value={f.methodId} onChange={(e) => setF({ ...f, methodId: e.target.value })}>
              {o.methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
          <Field label="Número de operación"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} maxLength={120} required /></Field>
          <Field label="Nombre de quien pagó"><Input value={f.payer} onChange={(e) => setF({ ...f, payer: e.target.value })} maxLength={160} required /></Field>
          <Field label="Fecha del pago"><Input type="date" value={f.paidAt} max={todayLima()} onChange={(e) => setF({ ...f, paidAt: e.target.value })} required /></Field>
          <Field label={`Importe pagado (${o.currency})`}><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required /></Field>
        </div>
        <Field label="Comentario (opcional)"><Textarea value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={1000} rows={2} /></Field>
        <p className="text-xs text-muted">Estos datos nos ayudan a ubicar tu pago. El pago se confirma cuando lo vemos en nuestra cuenta.</p>
        <Button type="submit" className="self-start" loading={busy}>Informar el pago</Button>
      </form>
    </Card>
  );
}

export default function PayPage() {
  return <Suspense fallback={<Loading />}><PayView /></Suspense>;
}
