'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Star } from 'lucide-react';
import { RequirePermission } from '@/components/guard';
import { SupportThread } from '@/components/support-thread';
import { Badge, Button, Card, ErrorBox, Field, Loading, PageHeader, Textarea, cn } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { KIND, PRIORITY, STATUS, ticketNo, type TicketDetail } from '@/lib/support';

function Rating({ ticket, onDone }: { ticket: TicketDetail; onDone: (t: TicketDetail) => void }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api<TicketDetail>(`/support/tickets/${ticket.id}/rating`, { method: 'POST', body: { rating, ...(comment.trim() ? { comment: comment.trim() } : {}) } }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="p-4">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="font-medium">¿Cómo te atendimos?</p>
        <p className="text-sm text-muted">Al calificar, el caso se cierra. Si el problema sigue, mejor respóndenos abajo y lo reabrimos.</p>
        <ErrorBox error={error} />
        <div className="flex gap-1" role="radiogroup" aria-label="Calificación">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} de 5`} onClick={() => setRating(n)} className="rounded p-1 hover:bg-surface-2">
              <Star className={cn('size-6', n <= rating ? 'fill-amber-400 text-amber-500' : 'text-muted')} />
            </button>
          ))}
        </div>
        <Field label="Comentario (opcional)"><Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} maxLength={2000} /></Field>
        <div><Button type="submit" loading={busy} disabled={!rating}>Enviar calificación</Button></div>
      </form>
    </Card>
  );
}

function TicketView() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['support-ticket', id], queryFn: () => api<TicketDetail>(`/support/tickets/${id}`) });
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (t: TicketDetail) => {
    qc.setQueryData(['support-ticket', id], t);
    void qc.invalidateQueries({ queryKey: ['support-tickets'] });
  };
  async function reply(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      set(await api<TicketDetail>(`/support/tickets/${id}/messages`, { method: 'POST', body: { body } }));
      setBody('');
      toast.success('Mensaje enviado');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const t = q.data!;
  return (
    <div className="flex flex-col gap-6">
      <Link href="/soporte" className="flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft className="size-4" /> Soporte</Link>
      <PageHeader title={`${ticketNo(t.number)} · ${t.subject}`} description={`${KIND[t.kind]} · prioridad ${PRIORITY[t.priority].label.toLowerCase()} · abierto el ${dateTime(t.createdAt)}`} actions={<Badge tone={STATUS[t.status].tone}>{STATUS[t.status].label}</Badge>} />
      <SupportThread messages={t.messages} />
      {t.status === 'RESOLVED' && !t.ratedAt && <Rating ticket={t} onDone={(r) => { set(r); toast.success('Gracias por tu calificación'); }} />}
      {t.ratedAt && <Card className="p-4 text-sm">Calificaste la atención con {t.rating} de 5{t.ratingComment ? `: “${t.ratingComment}”` : ''}.</Card>}
      {t.status === 'CLOSED' ? (
        <p className="text-sm text-muted">El caso está cerrado. Si necesitas algo más, <Link href="/soporte" className="text-primary hover:underline">abre un caso nuevo</Link>.</p>
      ) : (
        <form onSubmit={reply} className="flex flex-col gap-2">
          <Field label={t.status === 'RESOLVED' ? 'Responder (reabre el caso)' : 'Responder'}>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={10000} required />
          </Field>
          <div><Button type="submit" loading={busy}>Enviar</Button></div>
        </form>
      )}
    </div>
  );
}

export default function TicketPage() {
  return <RequirePermission permission="support:use"><TicketView /></RequirePermission>;
}
