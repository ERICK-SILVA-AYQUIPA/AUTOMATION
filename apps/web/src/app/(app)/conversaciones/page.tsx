'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Bot, Check, CheckCheck, CheckCircle2, Clock, MessagesSquare, PauseCircle, RotateCcw, Search, SendHorizontal, StickyNote, Tag, X, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { customerLabel, dateTime, phoneLabel } from '@/lib/format';
import { Badge, Button, Card, EmptyState, ErrorBox, Input, Loading, Select, Textarea, cn } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';
import { OpenInChatwoot } from '@/components/chatwoot';
import type { CustomerRef, Paged } from '@/lib/types';

interface ConversationRow {
  id: string; status: 'OPEN' | 'RESOLVED'; lastMessageAt: string | null; botStatus: 'ACTIVE' | 'PAUSED'; tags: string[]; assignedUserId: string | null;
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
  handoffReason: string | null; handoffAt: string | null;
  notes: { id: string; body: string; authorId: string | null; createdAt: string }[];
  people: Record<string, string>;
}
interface TeamUser { id: string; name: string; status: string }

const HANDOFF_REASON: Record<string, string> = {
  agent_reply: 'respondió una persona del equipo',
  manual: 'pausada desde el panel',
  keyword: 'el cliente pidió hablar con una persona',
  plan_limit: 'se alcanzó el límite de conversaciones con IA del plan',
};

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

function Controls({ c }: { c: ConversationDetail }) {
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [tag, setTag] = useState('');
  const canAssign = can('conversations:assign');
  const team = useQuery({ queryKey: ['users'], queryFn: () => api<TeamUser[]>('/users'), enabled: canAssign, staleTime: 60_000 });

  async function patch(what: string, body: Record<string, unknown>, ok: string) {
    setBusy(what);
    try {
      await api(`/conversations/${c.id}`, { method: 'PATCH', body });
      toast.success(ok);
      qc.invalidateQueries({ queryKey: ['conversation', c.id] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }
  const myId = me?.id;
  const assignedName = c.assignedUserId ? (c.people[c.assignedUserId] ?? 'Otra persona') : null;
  const addTag = (e: React.FormEvent) => {
    e.preventDefault();
    const t = tag.trim().toLowerCase();
    if (!t || c.tags.includes(t)) return setTag('');
    setTag('');
    void patch('tags', { tags: [...c.tags, t] }, 'Etiqueta añadida');
  };

  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {c.status === 'OPEN' && (c.botStatus === 'PAUSED' ? (
          <Button size="sm" variant="secondary" icon={<Bot className="size-4" />} loading={busy === 'bot'} onClick={() => patch('bot', { botStatus: 'ACTIVE' }, 'La IA vuelve a responder esta conversación')}>Reactivar IA</Button>
        ) : (
          <Button size="sm" variant="secondary" icon={<PauseCircle className="size-4" />} loading={busy === 'bot'} onClick={() => patch('bot', { botStatus: 'PAUSED' }, 'IA en pausa: atiende una persona')}>Pausar IA</Button>
        ))}
        {c.status === 'OPEN' ? (
          <Button size="sm" variant="secondary" icon={<CheckCircle2 className="size-4" />} loading={busy === 'status'} onClick={() => patch('status', { status: 'RESOLVED' }, 'Conversación cerrada')}>Cerrar conversación</Button>
        ) : (
          <Button size="sm" variant="secondary" icon={<RotateCcw className="size-4" />} loading={busy === 'status'} onClick={() => patch('status', { status: 'OPEN' }, 'Conversación reabierta')}>Reabrir</Button>
        )}
        {canAssign ? (
          <span className="w-56"><Select aria-label="Asignar a" className="h-8 py-0 text-sm" value={c.assignedUserId ?? ''} disabled={busy === 'assign'}
            onChange={(e) => patch('assign', { assignedUserId: e.target.value || null }, e.target.value ? 'Conversación asignada' : 'Asignación quitada')}>
            <option value="">Sin asignar</option>
            {c.assignedUserId && !team.data?.some((u) => u.id === c.assignedUserId) && <option value={c.assignedUserId}>{assignedName}</option>}
            {team.data?.filter((u) => u.status === 'ACTIVE').map((u) => <option key={u.id} value={u.id}>{u.name}{u.id === myId ? ' (yo)' : ''}</option>)}
          </Select></span>
        ) : c.assignedUserId === myId ? (
          <Button size="sm" variant="ghost" loading={busy === 'assign'} onClick={() => patch('assign', { assignedUserId: null }, 'Ya no la tienes asignada')}>Soltar</Button>
        ) : !c.assignedUserId ? (
          <Button size="sm" variant="ghost" loading={busy === 'assign'} onClick={() => patch('assign', { assignedUserId: myId }, 'Ahora la atiendes tú')}>Tomar</Button>
        ) : (
          <span className="text-muted">Asignada a {assignedName}</span>
        )}
      </div>
      {c.botStatus === 'PAUSED' && c.handoffReason && (
        <p className="text-xs text-muted">IA en pausa: {HANDOFF_REASON[c.handoffReason] ?? c.handoffReason}{c.handoffAt && ` (${dateTime(c.handoffAt)})`}</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag className="size-3.5 text-muted" aria-hidden />
        {c.tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs">
            {t}
            <button type="button" aria-label={`Quitar etiqueta ${t}`} className="text-muted hover:text-text" onClick={() => patch('tags', { tags: c.tags.filter((x) => x !== t) }, 'Etiqueta quitada')}><X className="size-3" /></button>
          </span>
        ))}
        {c.tags.length < 10 && (
          <form onSubmit={addTag} className="inline-flex">
            <input aria-label="Nueva etiqueta" value={tag} onChange={(e) => setTag(e.target.value)} maxLength={30} placeholder="Añadir etiqueta" className="w-32 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-xs outline-none focus:border-border" />
          </form>
        )}
      </div>
    </div>
  );
}

function Notes({ c }: { c: ConversationDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  // Abierto si ya hay notas; después lo decide quien la usa (no se cierra al guardar)
  const [open, setOpen] = useState(c.notes.length > 0);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      await api(`/conversations/${c.id}/notes`, { method: 'POST', body: { body: body.trim() } });
      setBody('');
      qc.invalidateQueries({ queryKey: ['conversation', c.id] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="border-b border-border px-4 py-2 text-sm" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="flex cursor-pointer items-center gap-1.5 text-muted"><StickyNote className="size-3.5" aria-hidden />Notas internas ({c.notes.length}) · el cliente no las ve</summary>
      <ul className="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
        {c.notes.map((n) => (
          <li key={n.id} className="rounded-md bg-warning/10 px-2 py-1.5">
            <p className="whitespace-pre-wrap break-words">{n.body}</p>
            <p className="mt-0.5 text-xs text-muted">{n.authorId ? (c.people[n.authorId] ?? 'Usuario') : 'Sistema'} · {dateTime(n.createdAt)}</p>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="mt-2 flex gap-2">
        <Input aria-label="Nueva nota interna" value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} placeholder="Escribe una nota para tu equipo" />
        <Button type="submit" size="sm" loading={busy} disabled={!body.trim()}>Guardar</Button>
      </form>
    </details>
  );
}

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
        {c.botStatus === 'PAUSED' && (
          <span title={c.handoffAt ? `Atendida por una persona desde ${dateTime(c.handoffAt)}` : undefined}><Badge tone="warning"><PauseCircle className="mr-1 size-3" aria-hidden />Atención humana</Badge></span>
        )}
        <Badge tone={c.status === 'OPEN' ? 'info' : 'neutral'}>{c.status === 'OPEN' ? 'Abierta' : 'Resuelta'}</Badge>
        <span className="hidden sm:inline-flex"><OpenInChatwoot /></span>
      </div>
      {canReply && <Controls c={c} />}
      <Notes c={c} />
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
  const [view, setView] = useState<'' | 'human' | 'mine' | 'unassigned'>('');
  const [tag, setTag] = useState('');
  const [dtag, setDtag] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDtag(tag.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [tag]);
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const list = useQuery({
    queryKey: ['conversations', dq, status, view, dtag],
    queryFn: () => api<Paged<ConversationRow>>('/conversations', { query: { q: dq, status: status || undefined, view: view || undefined, tag: dtag || undefined, pageSize: 50 } }),
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
          <div className="grid grid-cols-[1fr_7rem] gap-2">
            <Select aria-label="Filtrar bandeja" value={view} onChange={(e) => setView(e.target.value as typeof view)} className="h-8 py-0 text-sm">
              <option value="">Todas las bandejas</option>
              <option value="human">Atención humana</option>
              <option value="mine">Asignadas a mí</option>
              <option value="unassigned">Sin asignar</option>
            </Select>
            <Input aria-label="Filtrar por etiqueta" placeholder="Etiqueta" value={tag} onChange={(e) => setTag(e.target.value)} className="h-8 text-sm" />
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
                  {(c.botStatus === 'PAUSED' || c.tags.length > 0) && (
                    <span className="flex flex-wrap gap-1 pt-0.5">
                      {c.botStatus === 'PAUSED' && <span className="rounded bg-warning/15 px-1.5 text-[11px] text-warning">Humano</span>}
                      {c.tags.slice(0, 3).map((t) => <span key={t} className="rounded bg-surface-2 px-1.5 text-[11px] text-muted">{t}</span>)}
                    </span>
                  )}
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
