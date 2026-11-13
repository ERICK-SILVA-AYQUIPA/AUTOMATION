'use client';

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, FileText, Plus, RotateCcw, Send, Trash2, Upload, User, Wrench } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { fieldErrors } from '@/lib/form';
import { dateTime, num } from '@/lib/format';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Select, Textarea, cn } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';
import { DEFAULT_WEEK as EMPTY_WEEK, WeekGrid, type Day, type Range } from '@/components/weekly-hours';

interface Profile {
  assistantName: string; tone: string; useEmojis: boolean; language: 'es' | 'en' | 'pt'; matchCustomerLanguage: boolean;
  welcomeMessage: string; businessInfo: string; hours: Record<Day, Range[]> | null; outsideHours: 'ANSWER' | 'MESSAGE'; outsideHoursMessage: string;
  paymentMethods: string[]; deliveryMethods: string[]; deliveryInfo: string; returnPolicy: string; faqs: { question: string; answer: string }[];
  qualifyingQuestions: string[]; handoffKeywords: string[]; handoffMessage: string; handoffOutsideHoursMessage: string; extraInstructions: string;
}
interface AiSettings {
  isEnabled: boolean; published: Profile; draft: Profile | null; hasUnpublishedChanges: boolean; draftUpdatedAt: string | null; draftTestedAt: string | null;
  publishedAt: string | null; testRequired: boolean; monthlyTokenCap: number | null;
  usage: { period: string; tokens: number; replies: number; planTokenLimit: number | null; effectiveCap: number | null };
  knowledge: { maxDocs: number; budgetChars: number }; provider: { configured: boolean; source: 'tenant' | 'platform' | null; mode: 'MANAGED' | 'OWN' | 'SERVER' | null; name: string | null; model: string | null };
}
interface Doc { id: string; title: string; content: string; chars: number; updatedAt: string; state: 'new' | 'modified' | 'published' | 'pending_delete' }
interface ChatLine { role: 'customer' | 'assistant'; text: string; tools?: string[]; handoff?: string | null }

const TOOL_LABEL: Record<string, string> = { buscar_productos: 'consultó el catálogo', ver_pedidos_del_cliente: 'consultó pedidos', crear_pedido: 'intentó crear un pedido', derivar_a_humano: 'derivó a una persona' };
const DOC_STATE: Record<Doc['state'], { label: string; tone: 'success' | 'info' | 'warning' | 'danger' }> = {
  published: { label: 'Publicado', tone: 'success' }, new: { label: 'Nuevo, sin publicar', tone: 'info' }, modified: { label: 'Editado, sin publicar', tone: 'warning' }, pending_delete: { label: 'Se quitará al publicar', tone: 'danger' },
};
const SECTIONS = [['personalidad', 'Personalidad'], ['horario', 'Horario'], ['ventas', 'Ventas y políticas'], ['faq', 'Preguntas frecuentes'], ['derivacion', 'Derivación']] as const;

const splitComma = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const splitLines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

/** Formulario: las listas se editan como texto y se convierten al guardar */
function toForm(p: Profile) {
  return { ...p, paymentText: p.paymentMethods.join(', '), deliveryText: p.deliveryMethods.join(', '), keywordsText: p.handoffKeywords.join(', '), qualifyingText: p.qualifyingQuestions.join('\n') };
}
type Form = ReturnType<typeof toForm>;
function fromForm(f: Form): Profile {
  const { paymentText, deliveryText, keywordsText, qualifyingText, ...rest } = f;
  return { ...rest, paymentMethods: splitComma(paymentText), deliveryMethods: splitComma(deliveryText), handoffKeywords: splitComma(keywordsText), qualifyingQuestions: splitLines(qualifyingText) };
}

function PublishBar({ d }: { d: AiSettings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<'publish' | 'discard' | null>(null);
  const run = async (kind: 'publish' | 'discard') => {
    setBusy(kind);
    try {
      if (kind === 'publish') {
        await api('/ai/settings/publish', { method: 'POST' });
        toast.success('Publicado: el asistente ya usa esta configuración con tus clientes');
      } else {
        await api('/ai/settings/draft', { method: 'DELETE' });
        toast.success('Cambios descartados');
      }
      await qc.invalidateQueries({ queryKey: ['ai-settings'] });
      await qc.invalidateQueries({ queryKey: ['ai-knowledge'] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'No se pudo completar la acción');
    } finally {
      setBusy(null);
    }
  };
  const tested = !!d.draftTestedAt;
  return (
    <Card className={cn('mb-6 flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between', d.hasUnpublishedChanges && 'border-warning/50')}>
      <div className="text-sm">
        {d.hasUnpublishedChanges ? (
          <>
            <p className="font-medium">Tienes cambios sin publicar</p>
            <p className="text-muted">
              Tus clientes siguen viendo la versión publicada{d.publishedAt ? ` el ${dateTime(d.publishedAt)}` : ''}.{' '}
              {d.testRequired ? (tested ? 'Borrador probado: ya puedes publicarlo.' : 'Pruébalo en el chat de la derecha (modo Borrador) antes de publicar.') : 'Sin clave de IA en el servidor no se puede probar; puedes publicarlo igualmente.'}
            </p>
          </>
        ) : (
          <p className="text-muted">Todo publicado{d.publishedAt ? ` (${dateTime(d.publishedAt)})` : ''}. Los cambios se guardan como borrador hasta que los publiques.</p>
        )}
      </div>
      {d.hasUnpublishedChanges && (
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" size="sm" loading={busy === 'discard'} onClick={() => run('discard')}>Descartar cambios</Button>
          <Button size="sm" loading={busy === 'publish'} disabled={d.testRequired && !tested} onClick={() => run('publish')}>Publicar</Button>
        </div>
      )}
    </Card>
  );
}

function HoursEditor({ f, set }: { f: Form; set: (p: Partial<Form>) => void }) {
  const hours = f.hours;
  return (
    <div className="flex flex-col gap-4">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={!!hours} onChange={(e) => set({ hours: e.target.checked ? EMPTY_WEEK : null, ...(e.target.checked ? {} : { outsideHours: 'ANSWER' as const }) })} />
        Tengo horario de atención
      </label>
      {hours && (
        <>
          <WeekGrid hours={hours} onChange={(h) => set({ hours: h })} />
          <Field label="Fuera de horario">
            <Select value={f.outsideHours} onChange={(e) => set({ outsideHours: e.target.value as Form['outsideHours'] })}>
              <option value="ANSWER">Atender igual y avisar que el equipo confirma al abrir</option>
              <option value="MESSAGE">Solo enviar un aviso (una vez cada 12 h)</option>
            </Select>
          </Field>
          <Field label="Aviso fuera de horario" hint={f.outsideHours === 'MESSAGE' ? 'Obligatorio en este modo' : 'Opcional'}>
            <Textarea rows={2} maxLength={500} value={f.outsideHoursMessage} onChange={(e) => set({ outsideHoursMessage: e.target.value })} />
          </Field>
        </>
      )}
    </div>
  );
}

function ProfileEditor({ d }: { d: AiSettings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const base = d.draft ?? d.published;
  const [f, setF] = useState<Form>(() => toForm(base));
  const [tab, setTab] = useState<(typeof SECTIONS)[number][0]>('personalidad');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const dirty = JSON.stringify(fromForm(f)) !== JSON.stringify(base);
  const errs = fieldErrors(error);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/ai/settings/draft', { method: 'PUT', body: fromForm(f) });
      toast.success('Borrador guardado. Pruébalo y publícalo cuando esté listo.');
      await qc.invalidateQueries({ queryKey: ['ai-settings'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      <Card className="flex flex-col gap-4 p-5">
        <div role="tablist" aria-label="Secciones de la configuración" className="-mx-1 flex flex-wrap gap-1 border-b border-border pb-3">
          {SECTIONS.map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn('rounded-md px-3 py-1.5 text-sm', tab === k ? 'bg-primary/10 font-medium text-primary' : 'text-muted hover:bg-surface-2')}>
              {l}
            </button>
          ))}
        </div>

        {tab === 'personalidad' && (
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nombre del asistente" error={errs.assistantName}><Input value={f.assistantName} onChange={(e) => set({ assistantName: e.target.value })} required maxLength={60} /></Field>
              <Field label="Tono" hint="Ej.: cercano y alegre, formal" error={errs.tone}><Input value={f.tone} onChange={(e) => set({ tone: e.target.value })} required minLength={2} maxLength={120} /></Field>
              <Field label="Idioma principal">
                <Select value={f.language} onChange={(e) => set({ language: e.target.value as Form['language'] })}>
                  <option value="es">Español</option><option value="en">Inglés</option><option value="pt">Portugués</option>
                </Select>
              </Field>
              <div className="flex flex-col justify-end gap-2 pb-1 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" className="size-4 accent-[var(--primary)]" checked={f.matchCustomerLanguage} onChange={(e) => set({ matchCustomerLanguage: e.target.checked })} />Responder en el idioma del cliente</label>
                <label className="flex items-center gap-2"><input type="checkbox" className="size-4 accent-[var(--primary)]" checked={f.useEmojis} onChange={(e) => set({ useEmojis: e.target.checked })} />Usar emojis</label>
              </div>
            </div>
            <Field label="Saludo (opcional)"><Input value={f.welcomeMessage} onChange={(e) => set({ welcomeMessage: e.target.value })} maxLength={500} /></Field>
            <Field label="Indicaciones adicionales (opcional)" hint="Cómo quieres que atienda. No puede cambiar precios, stock ni las reglas de seguridad.">
              <Textarea rows={3} maxLength={2000} value={f.extraInstructions} onChange={(e) => set({ extraInstructions: e.target.value })} />
            </Field>
          </div>
        )}

        {tab === 'horario' && <HoursEditor f={f} set={set} />}

        {tab === 'ventas' && (
          <div className="flex flex-col gap-4">
            <Field label="Medios de pago" hint="Separados por comas. Ej.: Yape, Plin, transferencia BCP, efectivo"><Input value={f.paymentText} onChange={(e) => set({ paymentText: e.target.value })} /></Field>
            <Field label="Formas de entrega" hint="Separadas por comas. Ej.: delivery, recojo en tienda"><Input value={f.deliveryText} onChange={(e) => set({ deliveryText: e.target.value })} /></Field>
            <Field label="Detalles de entrega" hint="Zonas, costos y plazos"><Textarea rows={3} maxLength={2000} value={f.deliveryInfo} onChange={(e) => set({ deliveryInfo: e.target.value })} /></Field>
            <Field label="Cambios y devoluciones"><Textarea rows={3} maxLength={2000} value={f.returnPolicy} onChange={(e) => set({ returnPolicy: e.target.value })} /></Field>
            <Field label="Información general" hint="Dirección, redes, lo que el cliente suele preguntar. No pongas precios ni stock: los consulta en tu catálogo.">
              <Textarea rows={4} maxLength={6000} value={f.businessInfo} onChange={(e) => set({ businessInfo: e.target.value })} />
            </Field>
            <Field label="Preguntas antes de recomendar" hint="Una por línea (máx. 8). Ej.: ¿Para qué ocasión es?">
              <Textarea rows={3} value={f.qualifyingText} onChange={(e) => set({ qualifyingText: e.target.value })} />
            </Field>
          </div>
        )}

        {tab === 'faq' && (
          <div className="flex flex-col gap-3">
            {f.faqs.length === 0 && <p className="text-sm text-muted">Agrega las preguntas que más te hacen y la respuesta exacta que quieres que dé el asistente.</p>}
            {f.faqs.map((q, i) => (
              <div key={i} className="grid gap-2 rounded-lg border border-border p-3">
                <div className="flex items-end gap-2">
                  <Field label={`Pregunta ${i + 1}`} className="flex-1"><Input value={q.question} maxLength={200} onChange={(e) => set({ faqs: f.faqs.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)) })} /></Field>
                  <Button type="button" variant="ghost" size="sm" aria-label={`Quitar pregunta ${i + 1}`} icon={<Trash2 className="size-4" />} onClick={() => set({ faqs: f.faqs.filter((_, j) => j !== i) })} />
                </div>
                <Field label="Respuesta"><Textarea rows={2} maxLength={1000} value={q.answer} onChange={(e) => set({ faqs: f.faqs.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)) })} /></Field>
              </div>
            ))}
            {f.faqs.length < 40 && <Button type="button" variant="secondary" size="sm" className="self-start" icon={<Plus className="size-4" />} onClick={() => set({ faqs: [...f.faqs, { question: '', answer: '' }] })}>Agregar pregunta</Button>}
          </div>
        )}

        {tab === 'derivacion' && (
          <div className="flex flex-col gap-4">
            <Field label="Palabras que pasan la conversación a una persona" hint="Separadas por comas. Si el cliente escribe una, se envía el mensaje de abajo y el asistente deja de responder.">
              <Input value={f.keywordsText} onChange={(e) => set({ keywordsText: e.target.value })} />
            </Field>
            <Field label="Mensaje al derivar" error={errs.handoffMessage}><Textarea rows={2} required minLength={5} maxLength={500} value={f.handoffMessage} onChange={(e) => set({ handoffMessage: e.target.value })} /></Field>
            <Field label="Mensaje al derivar fuera de horario (opcional)" hint="Si lo dejas vacío se usa el de arriba"><Textarea rows={2} maxLength={500} value={f.handoffOutsideHoursMessage} onChange={(e) => set({ handoffOutsideHoursMessage: e.target.value })} /></Field>
          </div>
        )}

        <ErrorBox error={error} />
        <div className="flex items-center justify-end gap-3">
          {dirty && <span className="text-xs text-muted">Cambios sin guardar</span>}
          <Button type="submit" loading={busy} disabled={!dirty}>Guardar borrador</Button>
        </div>
      </Card>
    </form>
  );
}

function Knowledge({ d }: { d: AiSettings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['ai-knowledge'], queryFn: () => api<Doc[]>('/ai/knowledge') });
  const [edit, setEdit] = useState<{ id: string | null; title: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const file = useRef<HTMLInputElement>(null);
  const active = q.data?.filter((x) => x.state !== 'pending_delete').length ?? 0;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['ai-knowledge'] });
    await qc.invalidateQueries({ queryKey: ['ai-settings'] });
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    setBusy(true);
    setError(null);
    try {
      await api(edit.id ? `/ai/knowledge/${edit.id}` : '/ai/knowledge', { method: edit.id ? 'PUT' : 'POST', body: { title: edit.title, content: edit.content } });
      toast.success('Documento guardado como borrador');
      setEdit(null);
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function remove(doc: Doc) {
    try {
      await api(`/ai/knowledge/${doc.id}`, { method: 'DELETE' });
      toast.success(doc.state === 'new' ? 'Documento eliminado' : 'Se quitará al publicar');
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo quitar');
    }
  }
  async function readFile(f: File | undefined) {
    if (!f) return;
    if (!/\.(txt|md)$/i.test(f.name) || f.size > 200_000) {
      toast.error('Sube un archivo .txt o .md de hasta 200 KB (para PDF o Word, copia y pega el texto)');
      return;
    }
    const text = (await f.text()).slice(0, 20_000);
    setEdit({ id: null, title: f.name.replace(/\.(txt|md)$/i, '').slice(0, 120), content: text });
  }

  return (
    <Card className="mt-6 p-5">
      <div className="mb-3 flex flex-col gap-3">
        <div>
          <h2 className="font-medium">Documentos del asistente</h2>
          <p className="text-sm text-muted">Catálogos de servicios, condiciones, guías de tallas… El asistente los lee como referencia (hasta {num(d.knowledge.budgetChars)} caracteres en total). {active} de {d.knowledge.maxDocs} en tu plan.</p>
        </div>
        {!edit && (
          <div className="flex flex-wrap gap-2">
            <input ref={file} type="file" accept=".txt,.md,text/plain,text/markdown" className="hidden" onChange={(e) => { void readFile(e.target.files?.[0]); e.target.value = ''; }} aria-label="Subir archivo de texto" />
            <Button size="sm" variant="secondary" icon={<Upload className="size-4" />} disabled={active >= d.knowledge.maxDocs} onClick={() => file.current?.click()}>Subir .txt</Button>
            <Button size="sm" icon={<Plus className="size-4" />} disabled={active >= d.knowledge.maxDocs} onClick={() => setEdit({ id: null, title: '', content: '' })}>Nuevo documento</Button>
          </div>
        )}
      </div>
      {edit && (
        <form onSubmit={save} className="mb-4 flex flex-col gap-3 rounded-lg border border-border p-4">
          <Field label="Título"><Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} required maxLength={120} /></Field>
          <Field label="Contenido" hint={`${num(edit.content.length)} / 20.000 caracteres`}><Textarea rows={8} value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} required maxLength={20_000} /></Field>
          <ErrorBox error={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => { setEdit(null); setError(null); }}>Cancelar</Button>
            <Button type="submit" loading={busy}>Guardar documento</Button>
          </div>
        </form>
      )}
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data?.length ? (
        <p className="text-sm text-muted">Aún no hay documentos.</p>
      ) : (
        <ul className="divide-y divide-border">
          {q.data.map((doc) => (
            <li key={doc.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <FileText className="size-4 shrink-0 text-muted" aria-hidden />
                  <span className={cn('truncate text-sm font-medium', doc.state === 'pending_delete' && 'line-through text-muted')}>{doc.title}</span>
                </div>
                <div className="mt-1 flex items-center gap-2 pl-6 text-xs text-muted">
                  <Badge tone={DOC_STATE[doc.state].tone}>{DOC_STATE[doc.state].label}</Badge>
                  {num(doc.chars)} caracteres
                </div>
              </div>
              {doc.state !== 'pending_delete' && (
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEdit({ id: doc.id, title: doc.title, content: doc.content })}>Editar</Button>
                  <Button size="sm" variant="ghost" aria-label={`Quitar ${doc.title}`} icon={<Trash2 className="size-4" />} onClick={() => remove(doc)} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TestChat({ d }: { d: AiSettings }) {
  const qc = useQueryClient();
  const [target, setTarget] = useState<'draft' | 'published'>(d.hasUnpublishedChanges ? 'draft' : 'published');
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const end = useRef<HTMLDivElement>(null);
  const configured = d.provider.configured;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    const next: ChatLine[] = [...lines, { role: 'customer', text: t }];
    setLines(next);
    setText('');
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ reply: string; tools: string[]; handoff: string | null }>('/ai/test', { method: 'POST', body: { target, messages: next.slice(-20).map((l) => ({ role: l.role, text: l.text })) } });
      setLines([...next, { role: 'assistant', text: r.reply || '(sin respuesta)', tools: r.tools, handoff: r.handoff }]);
      if (target === 'draft') await qc.invalidateQueries({ queryKey: ['ai-settings'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      setTimeout(() => end.current?.scrollIntoView({ block: 'nearest' }), 50);
    }
  }

  return (
    <Card className="flex flex-col p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-medium">Probar el asistente</h2>
        {lines.length > 0 && <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => { setLines([]); setError(null); }}>Nueva prueba</Button>}
      </div>
      <div role="radiogroup" aria-label="Versión a probar" className="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1 text-sm">
        {(['draft', 'published'] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={target === k} onClick={() => { setTarget(k); setLines([]); }} className={cn('rounded-md px-3 py-1.5', target === k ? 'bg-surface font-medium shadow-sm' : 'text-muted')}>
            {k === 'draft' ? 'Borrador' : 'Publicado'}
          </button>
        ))}
      </div>
      <p className="mb-3 text-sm text-muted">Escribe como si fueras un cliente. Usa tu catálogo real; no envía nada por WhatsApp ni crea pedidos. Cada prueba consume tokens de tu tope mensual.</p>
      <div className="flex min-h-64 flex-1 flex-col gap-3 overflow-y-auto rounded-lg bg-surface-2 p-3" aria-live="polite">
        {lines.length === 0 && <p className="m-auto text-sm text-muted">Ejemplo: «hola, ¿cuánto cuesta la gaseosa?»</p>}
        {lines.map((l, i) => (
          <div key={i} className={cn('flex max-w-[85%] gap-2', l.role === 'customer' ? 'self-end flex-row-reverse' : 'self-start')}>
            <span className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface text-muted">{l.role === 'customer' ? <User className="size-3.5" /> : <Bot className="size-3.5" />}</span>
            <div>
              <p className={cn('whitespace-pre-wrap rounded-lg px-3 py-2 text-sm', l.role === 'customer' ? 'bg-primary text-primary-fg' : 'bg-surface')}>{l.text}</p>
              {!!l.tools?.length && <p className="mt-1 flex items-center gap-1 text-xs text-muted"><Wrench className="size-3" />{[...new Set(l.tools)].map((t) => TOOL_LABEL[t] ?? t).join(' · ')}</p>}
              {l.handoff && <p className="mt-1 text-xs text-warning">Pasaría la conversación a una persona: {l.handoff}</p>}
            </div>
          </div>
        ))}
        {busy && <p className="self-start text-sm text-muted">Escribiendo…</p>}
        <div ref={end} />
      </div>
      <ErrorBox error={error} />
      <form onSubmit={send} className="mt-3 flex gap-2">
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={configured ? 'Mensaje del cliente' : 'Disponible cuando haya un proveedor de IA asignado'} disabled={!configured} maxLength={2000} aria-label="Mensaje de prueba" />
        <Button type="submit" icon={<Send className="size-4" />} loading={busy} disabled={!configured || !text.trim()}>Enviar</Button>
      </form>
    </Card>
  );
}

function Operation({ d }: { d: AiSettings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [cap, setCap] = useState(d.monthlyTokenCap ? String(d.monthlyTokenCap) : '');
  const [busy, setBusy] = useState<'toggle' | 'cap' | null>(null);
  const patch = async (kind: 'toggle' | 'cap', body: Record<string, unknown>, ok: string) => {
    setBusy(kind);
    try {
      await api('/ai/settings', { method: 'PATCH', body });
      toast.success(ok);
      await qc.invalidateQueries({ queryKey: ['ai-settings'] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'No se pudo guardar');
    } finally {
      setBusy(null);
    }
  };
  const u = d.usage;
  const pct = u.effectiveCap ? Math.min(100, Math.round((u.tokens / u.effectiveCap) * 100)) : null;
  return (
    <Card className="mt-6 flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-medium">Respuestas automáticas</h2>
          <p className="text-sm text-muted">{d.isEnabled ? 'El asistente responde a tus clientes por WhatsApp.' : 'Apagado: los mensajes los atiende tu equipo.'} Este interruptor es inmediato.</p>
        </div>
        <Button size="sm" variant={d.isEnabled ? 'secondary' : 'primary'} loading={busy === 'toggle'} onClick={() => patch('toggle', { isEnabled: !d.isEnabled }, d.isEnabled ? 'Asistente apagado' : 'Asistente encendido')}>
          {d.isEnabled ? 'Apagar' : 'Encender'}
        </Button>
      </div>
      <div className="border-t border-border pt-4">
        <h2 className="font-medium">Consumo de {u.period}</h2>
        <p className="mt-1 text-sm text-muted">{num(u.replies)} respuestas · {num(u.tokens)} tokens{u.effectiveCap ? ` de ${num(u.effectiveCap)}` : ''}{u.planTokenLimit ? ` (tu plan permite ${num(u.planTokenLimit)})` : ''}</p>
        {pct !== null && (
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={u.tokens} aria-valuemax={u.effectiveCap ?? undefined} aria-label="Tokens usados este mes">
            <div className={cn('h-full rounded-full', pct >= 90 ? 'bg-danger' : pct >= 75 ? 'bg-warning' : 'bg-primary')} style={{ width: `${pct}%` }} />
          </div>
        )}
        <form className="mt-3 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void patch('cap', { monthlyTokenCap: cap ? Number(cap) : null }, 'Tope guardado'); }}>
          <Field label="Tope mensual de tokens" hint="Al alcanzarlo, las conversaciones pasan a tu equipo. Vacío = solo el límite del plan." className="flex-1">
            <Input type="number" min={1000} step={1000} max={u.planTokenLimit ?? undefined} value={cap} onChange={(e) => setCap(e.target.value)} />
          </Field>
          <Button type="submit" variant="secondary" loading={busy === 'cap'}>Guardar tope</Button>
        </form>
      </div>
    </Card>
  );
}

function Assistant() {
  const q = useQuery({ queryKey: ['ai-settings'], queryFn: () => api<AiSettings>('/ai/settings') });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorBox error={q.error} />;
  const d = q.data;
  return (
    <>
      <PageHeader
        title="Asistente IA"
        description="Responde por WhatsApp con tu catálogo real. Nunca cambia precios ni stock: los pedidos quedan pendientes hasta que tu equipo los confirma."
        actions={d.provider.configured ? <Badge tone={d.isEnabled ? 'success' : 'neutral'}>{d.isEnabled ? 'Activo' : 'Apagado'}</Badge> : <Badge tone="warning">Sin conectar</Badge>}
      />
      {!d.provider.configured && (
        <div role="status" className="mb-6 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          La IA todavía no está disponible: falta un proveedor (el que te asigne la plataforma, o tu propia clave de Claude, Gemini, OpenAI o DeepSeek en Integraciones → Inteligencia artificial). Mientras tanto los mensajes se reciben y los atiende tu equipo. Puedes dejar la configuración lista.
        </div>
      )}
      <PublishBar d={d} />
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <ProfileEditor key={`${d.publishedAt ?? ''}-${d.draft ? 'borrador' : 'publicado'}`} d={d} />
          <Knowledge d={d} />
        </div>
        <div>
          <TestChat key={d.publishedAt ?? ''} d={d} />
          <Operation key={`${d.monthlyTokenCap}`} d={d} />
        </div>
      </div>
      {d.provider.configured && <p className="mt-4 text-xs text-muted">Proveedor: {d.provider.name} · modelo {d.provider.model}{d.provider.source === 'tenant' ? ' (con la clave propia de tu empresa)' : ''}. Los mensajes de los clientes y la configuración se envían a ese proveedor para generar la respuesta.</p>}
    </>
  );
}

export default function AsistentePage() {
  return <RequirePermission permission="ai:configure"><Assistant /></RequirePermission>;
}
