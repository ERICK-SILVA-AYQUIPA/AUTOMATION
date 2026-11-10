'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Check, CheckCheck, Clock, MessagesSquare, PauseCircle, Search, SendHorizontal, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { customerLabel, dateTime, phoneLabel } from '@/lib/format';
import { Badge, Button, Card, EmptyState, ErrorBox, Input, Loading, Textarea, cn } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';
import { OpenInChatwoot } from '@/components/chatwoot';
import type { CustomerRef, Paged } from '@/lib/types';

interface ConversationRow {
  id: string; status: 'OPEN' | 'RESOLVED'; lastMessageAt: string | null;
  customer: CustomerRef; whatsappNumber: { id: string; displayPhone: string | null; label: string | null } | null;
  messages: { content: string; direction: 'INBOUND' | 'OUTBOUND'; createdAt: string; status: string | null }[];
}
interface Msg {
  id: string; direction: 'INBOUND' | 'OUTBOUND'; senderType: 'CUSTOMER' | 'BOT' | 'AGENT' | 'SYSTEM'; type: string; content: string;
  status: string | null; errorCode: string | null; errorMessage: string | null; createdAt: string;
}
interface ConversationDetail extends Omit<ConversationRow, 'messages'> {
  customer: CustomerRef & { waUserId: string | null };
  whatsappNumber: { id: string; displayPhone: string | null; label: string | null; isActive: boolean } | null;
  messages: Msg[]; serviceWindowEndsAt: string | null;
  botStatus: 'ACTIVE' | 'PAUSED'; handoffReason: string | null; handoffAt: string | null;
}

const time = (v: string) => new Intl.DateTimeFormat('es-PE', { hour: '2-digit', minute: '2-digit' }).format(new Date(v));

function StatusIcon({ m }: { m: Msg }) {
  if (m.direction !== 'OUTBOUND') return null;
  const s = m.status;
  const [Icon, label, cls] =
    s === 'failed' ? [XCircle, 'No entregado', 'text-danger']
    : s === 'read' || s === 'played' ? [CheckCheck, 'Leído', 'text-sky-500']
    : s === 'delivered' ? [CheckCheck, 'Entregado', '']
    : s === 'sent' ? [Check, 'Enviado', '']
    : [Clock, 'En cola', ''];
  return <span role="img" aria-label={label} title={label} className="inline-flex"><Icon className={cn('size-3.5', cls)} aria-hidden /></span>;
}

const SENDER: Record<Msg['senderType'], string> = { CUSTOMER: '', BOT: 'Asistente IA', AGENT: 'Agente', SYSTEM: 'Sistema' };

function Thread({ id, onBack }: { id: string; onBack: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  // Se actualiza solo mientras está visible; los avisos de Meta llegan por el worker
  const q = useQuery({ queryKey: ['conversation', id], queryFn: () => api<ConversationDetail>(`/conversations/${id}`), refetchInterval: 4000 });
  const [text, setText] = useState('');
  // Una clave por borrador: si la red falla y se reintenta, el servidor no duplica el envío
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const count = q.data?.messages.length ?? 0;
  // Llaves: en Chromium reciente scrollIntoView devuelve una promesa y React la tomaría por limpieza
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [count]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <div className="p-4"><ErrorBox error={q.error} /></div>;
  const c = q.data!;
  // eslint-disable-next-line react-hooks/purity -- la ventana depende de la hora actual; se recalcula en cada refresco
  const windowOpen = !!c.serviceWindowEndsAt && new Date(c.serviceWindowEndsAt).getTime() > Date.now();
  const canReply = can('conversations:reply');

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api(`/conversations/${id}/messages`, { method: 'POST', body: { text, idempotencyKey: key } });
      setText('');
      setKey(crypto.randomUUID());
      qc.invalidateQueries({ queryKey: ['conversation', id] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <button type="button" onClick={onBack} className="rounded-md p-1 text-muted hover:bg-surface-2 lg:hidden" aria-label="Volver a la lista"><ArrowLeft className="size-4" /></button>
        <div className="min-w-0 flex-1">
          <Link href={`/clientes/${c.customer.id}`} className="block truncate font-medium hover:underline">{customerLabel(c.customer)}</Link>
          <p className="truncate text-xs text-muted">{phoneLabel(c.customer.phone)}{c.whatsappNumber && ` · vía ${c.whatsappNumber.label ?? c.whatsappNumber.displayPhone ?? 'WhatsApp'}`}</p>
        </div>
        {/* El asistente IA llega en la FASE 6; aquí solo se muestra la pausa, que ya es real */}
        {c.botStatus === 'PAUSED' && (
          <span title={c.handoffAt ? `Atendida por una persona desde ${dateTime(c.handoffAt)}` : undefined}><Badge tone="warning"><PauseCircle className="mr-1 size-3" aria-hidden />Atención humana</Badge></span>
        )}
        <Badge tone={c.status === 'OPEN' ? 'info' : 'neutral'}>{c.status === 'OPEN' ? 'Abierta' : 'Resuelta'}</Badge>
        <span className="hidden sm:inline-flex"><OpenInChatwoot /></span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-surface-2/40 px-4 py-4">
        {c.messages.map((m) => (
          <div key={m.id} className={cn('flex', m.direction === 'OUTBOUND' ? 'justify-end' : 'justify-start')}>
            <div className={cn('max-w-[80%] rounded-xl px-3 py-2 text-sm shadow-sm', m.direction === 'OUTBOUND' ? 'bg-primary/10 text-text' : 'border border-border bg-surface')}>
              {SENDER[m.senderType] && <p className="mb-0.5 text-xs font-medium text-muted">{SENDER[m.senderType]}</p>}
              {/* Texto del cliente: no confiable, se muestra como texto plano (React lo escapa) */}
              <p className="whitespace-pre-wrap break-words">{m.content}</p>
              <p className="mt-1 flex items-center justify-end gap-1 text-[11px] text-muted" title={dateTime(m.createdAt)}>{time(m.createdAt)} <StatusIcon m={m} /></p>
              {m.status === 'failed' && m.errorMessage && <p className="mt-1 text-xs text-danger">{m.errorMessage}{m.errorCode && ` (código ${m.errorCode})`}</p>}
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      {canReply && (
        <div className="border-t border-border p-3">
          {!c.whatsappNumber?.isActive ? (
            <p className="flex items-center gap-2 text-sm text-muted"><AlertTriangle className="size-4" /> El número de WhatsApp de esta conversación está desactivado.</p>
          ) : !windowOpen ? (
            <p className="flex items-center gap-2 text-sm text-muted"><Clock className="size-4" /> Pasaron más de 24 h desde el último mensaje del cliente. WhatsApp solo permite responder con una plantilla aprobada.</p>
          ) : (
            <form onSubmit={send} className="flex items-end gap-2">
              <Textarea
                aria-label="Respuesta"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
                maxLength={4096}
                placeholder="Escribe una respuesta (Enter envía, Mayús+Enter nueva línea)"
                className="min-h-10 flex-1 resize-none"
                rows={2}
              />
              <Button type="submit" loading={busy} disabled={!text.trim()} aria-label="Enviar" icon={<SendHorizontal className="size-4" />} />
            </form>
          )}
        </div>
      )}
    </div>
  );
}

function Inbox() {
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get('id');
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [status, setStatus] = useState<'OPEN' | 'RESOLVED' | ''>('OPEN');
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const list = useQuery({
    queryKey: ['conversations', dq, status],
    queryFn: () => api<Paged<ConversationRow>>('/conversations', { query: { q: dq, status: status || undefined, pageSize: 50 } }),
    placeholderData: keepPreviousData,
    refetchInterval: 5000,
  });
  const pick = (id: string | null) => router.replace(id ? `/conversaciones?id=${id}` : '/conversaciones');

  return (
    <Card className="flex h-[calc(100dvh-8rem)] min-h-[28rem] overflow-hidden">
      <aside className={cn('flex w-full min-w-0 flex-col border-r border-border lg:w-80 lg:shrink-0', selected && 'hidden lg:flex')}>
        <div className="flex flex-col gap-2 border-b border-border p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input aria-label="Buscar conversación" placeholder="Buscar cliente o teléfono" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
          <div className="flex gap-1 text-sm" role="tablist">
            {([['OPEN', 'Abiertas'], ['RESOLVED', 'Resueltas'], ['', 'Todas']] as const).map(([v, l]) => (
              <button key={l} type="button" role="tab" aria-selected={status === v} onClick={() => setStatus(v)} className={cn('rounded-md px-2.5 py-1', status === v ? 'bg-surface-2 font-medium text-text' : 'text-muted hover:text-text')}>{l}</button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.isLoading ? <Loading /> : list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : !list.data?.items.length ? (
            <EmptyState icon={<MessagesSquare className="size-5" />} title={dq ? 'Sin resultados' : 'Sin conversaciones'} description={dq ? undefined : 'Aparecerán aquí cuando un cliente escriba a tu número de WhatsApp.'} />
          ) : (
            list.data.items.map((c) => {
              const last = c.messages[0];
              return (
                <button key={c.id} type="button" onClick={() => pick(c.id)} className={cn('flex w-full flex-col gap-0.5 border-b border-border px-4 py-3 text-left hover:bg-surface-2', selected === c.id && 'bg-surface-2')}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{customerLabel(c.customer)}</span>
                    {c.lastMessageAt && <span className="shrink-0 text-xs text-muted">{time(c.lastMessageAt)}</span>}
                  </span>
                  <span className="truncate text-xs text-muted">{last ? `${last.direction === 'OUTBOUND' ? 'Tú: ' : ''}${last.content}` : '—'}</span>
                </button>
              );
            })
          )}
        </div>
      </aside>
      <section className={cn('min-w-0 flex-1', !selected && 'hidden lg:block')}>
        {selected ? <Thread key={selected} id={selected} onBack={() => pick(null)} /> : (
          <EmptyState icon={<MessagesSquare className="size-5" />} title="Selecciona una conversación" />
        )}
      </section>
    </Card>
  );
}

export default function ConversacionesPage() {
  return (
    <RequirePermission permission="conversations:read">
      <Suspense fallback={<Loading />}>
        <Inbox />
      </Suspense>
    </RequirePermission>
  );
}
