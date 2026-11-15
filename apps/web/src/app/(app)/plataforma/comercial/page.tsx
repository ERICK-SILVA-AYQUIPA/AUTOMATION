'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ExternalLink, Plus, Save, Send, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/guard';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Select, Textarea } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';

interface Item { title: string; text: string }
interface Faq { q: string; a: string }
interface Testimonial { name: string; company: string | null; quote: string; authorizedAt: string }
interface Settings {
  published: boolean; headline: string | null; subheadline: string | null; problems: Item[]; benefits: Item[]; faqs: Faq[]; testimonials: Testimonial[];
  contactEmail: string | null; contactWhatsapp: string | null; showPrices: boolean; chatEnabled: boolean; agentName: string | null; agentInstructions: string | null;
  houseTenantId: string | null; publishedAt: string | null; updatedAt: string;
  agent: { available: boolean; reason: string | null; label: string | null };
  tenants: { id: string; name: string; status: string }[];
}
type Form = Omit<Settings, 'agent' | 'tenants' | 'publishedAt' | 'updatedAt'>;

const formOf = (s: Settings): Form => ({
  published: s.published, headline: s.headline ?? '', subheadline: s.subheadline ?? '', problems: s.problems, benefits: s.benefits, faqs: s.faqs, testimonials: s.testimonials,
  contactEmail: s.contactEmail ?? '', contactWhatsapp: s.contactWhatsapp ?? '', showPrices: s.showPrices, chatEnabled: s.chatEnabled, agentName: s.agentName ?? '', agentInstructions: s.agentInstructions ?? '', houseTenantId: s.houseTenantId,
});

export default function CommercialPage() {
  return (
    <RequirePermission permission="platform:manage">
      <Editor />
    </RequirePermission>
  );
}

function Editor() {
  const q = useQuery({ queryKey: ['platform-commercial'], queryFn: () => api<Settings>('/platform/commercial') });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return <EditorForm key={q.data!.updatedAt} s={q.data!} />;
}

function EditorForm({ s }: { s: Settings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<Form>(() => formOf(s));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => api<Settings>('/platform/commercial', { method: 'PUT', body: { ...f, houseTenantId: f.houseTenantId || null } }),
    onSuccess: (r) => {
      setErrors({});
      qc.setQueryData(['platform-commercial'], r);
      toast.success(r.published ? 'Página guardada y publicada' : 'Cambios guardados (la página no está publicada)');
    },
    onError: (e) => {
      if (e instanceof ApiError && e.errors?.length) setErrors(Object.fromEntries([...e.errors].reverse().map((x) => [x.path.split('.')[0]!, x.path.includes('.') ? `Revisa el elemento ${Number(x.path.split('.')[1]) + 1}: ${x.message}` : x.message])));
      toast.error(e);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form onSubmit={submit} aria-label="Página comercial">
      <PageHeader
        title="Página comercial"
        description="Lo que ve un visitante en la página pública y cómo responde el agente comercial. Módulos, sectores y planes salen del sistema: aquí solo se escriben los textos de venta."
        actions={<>
          {s.published && <Link href="/" target="_blank" className="inline-flex h-10 items-center gap-2 rounded-lg border border-border px-4 text-sm hover:bg-surface-2"><ExternalLink className="size-4" />Ver página</Link>}
          <Button type="submit" loading={save.isPending} icon={<Save className="size-4" />}>Guardar</Button>
        </>}
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card className="space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="font-semibold">Publicación</h2>
              <Badge tone={s.published ? 'success' : 'neutral'}>{s.published ? 'Publicada' : 'Sin publicar'}</Badge>
              {s.publishedAt && <span className="text-xs text-muted">desde {new Date(s.publishedAt).toLocaleDateString('es-PE')}</span>}
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.published} onChange={(e) => set('published', e.target.checked)} />Publicar la página en la dirección principal</label>
            <Field label="Titular" error={errors.headline}><Input value={f.headline ?? ''} onChange={(e) => set('headline', e.target.value)} maxLength={160} /></Field>
            <Field label="Bajada"><Textarea value={f.subheadline ?? ''} onChange={(e) => set('subheadline', e.target.value)} maxLength={400} className="min-h-16" /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Correo de contacto" error={errors.contactEmail}><Input type="email" value={f.contactEmail ?? ''} onChange={(e) => set('contactEmail', e.target.value)} /></Field>
              <Field label="WhatsApp de contacto" error={errors.contactWhatsapp}><Input value={f.contactWhatsapp ?? ''} onChange={(e) => set('contactWhatsapp', e.target.value)} placeholder="+51…" /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.showPrices} onChange={(e) => set('showPrices', e.target.checked)} />Mostrar los precios de los planes (los de Planes en Empresas)</label>
          </Card>

          <ItemList title="Problemas que resuelve" items={f.problems} onChange={(v) => set('problems', v)} max={8} error={errors.problems} />
          <ItemList title="Beneficios" items={f.benefits} onChange={(v) => set('benefits', v)} max={8} error={errors.benefits} />

          <Card className="space-y-3 p-5">
            <h2 className="font-semibold">Preguntas frecuentes</h2>
            <p className="text-sm text-muted">El agente comercial responde con estas mismas respuestas.</p>
            {f.faqs.map((x, i) => (
              <div key={i} className="grid gap-2 rounded-lg border border-border p-3">
                <Input aria-label={`Pregunta ${i + 1}`} value={x.q} onChange={(e) => set('faqs', f.faqs.map((y, j) => (j === i ? { ...y, q: e.target.value } : y)))} placeholder="Pregunta" />
                <Textarea aria-label={`Respuesta ${i + 1}`} value={x.a} onChange={(e) => set('faqs', f.faqs.map((y, j) => (j === i ? { ...y, a: e.target.value } : y)))} placeholder="Respuesta" className="min-h-16" />
                <Button size="sm" variant="ghost" className="justify-self-start" icon={<Trash2 className="size-4" />} onClick={() => set('faqs', f.faqs.filter((_, j) => j !== i))}>Quitar</Button>
              </div>
            ))}
            {errors.faqs && <p className="text-xs text-danger" role="alert">{errors.faqs}</p>}
            {f.faqs.length < 20 && <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => set('faqs', [...f.faqs, { q: '', a: '' }])}>Agregar pregunta</Button>}
          </Card>

          <Card className="space-y-3 p-5">
            <h2 className="font-semibold">Testimonios</h2>
            <p className="text-sm text-muted">Solo testimonios reales de clientes que autorizaron publicarlos. Sin testimonios, la sección no aparece.</p>
            {f.testimonials.map((x, i) => {
              const upd = (p: Partial<Testimonial>) => set('testimonials', f.testimonials.map((y, j) => (j === i ? { ...y, ...p } : y)));
              return (
                <div key={i} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-2">
                  <Input aria-label={`Nombre del cliente ${i + 1}`} value={x.name} onChange={(e) => upd({ name: e.target.value })} placeholder="Nombre" />
                  <Input aria-label={`Empresa del cliente ${i + 1}`} value={x.company ?? ''} onChange={(e) => upd({ company: e.target.value || null })} placeholder="Empresa" />
                  <Textarea aria-label={`Testimonio ${i + 1}`} value={x.quote} onChange={(e) => upd({ quote: e.target.value })} placeholder="Lo que dijo" className="min-h-16 sm:col-span-2" />
                  <Field label="Fecha en que autorizó publicarlo"><Input type="date" value={x.authorizedAt} onChange={(e) => upd({ authorizedAt: e.target.value })} /></Field>
                  <Button size="sm" variant="ghost" className="self-end justify-self-start" icon={<Trash2 className="size-4" />} onClick={() => set('testimonials', f.testimonials.filter((_, j) => j !== i))}>Quitar</Button>
                </div>
              );
            })}
            {errors.testimonials && <p className="text-xs text-danger" role="alert">{errors.testimonials}</p>}
            {f.testimonials.length < 12 && <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => set('testimonials', [...f.testimonials, { name: '', company: null, quote: '', authorizedAt: '' }])}>Agregar testimonio</Button>}
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="space-y-4 p-5">
            <div className="flex items-center gap-2"><Bot className="size-5 text-primary" /><h2 className="font-semibold">Agente comercial</h2></div>
            <div role="status" className="rounded-lg bg-surface-2 p-3 text-sm">
              {s.agent.available ? <><Badge tone="success">Disponible</Badge> <span className="text-muted">{s.agent.label}</span></> : <><Badge tone="warning">No disponible</Badge> <span className="text-muted">{s.agent.reason}</span></>}
            </div>
            <Field label="Empresa interna" hint="Su WhatsApp lo atiende el agente comercial y su IA se asigna en Empresas › Centro de APIs, servicio «Agente comercial».">
              <Select value={f.houseTenantId ?? ''} onChange={(e) => set('houseTenantId', e.target.value || null)}>
                <option value="">Sin empresa interna</option>
                {s.tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.chatEnabled} onChange={(e) => set('chatEnabled', e.target.checked)} />Mostrar el chat en la página</label>
            <Field label="Nombre del agente"><Input value={f.agentName ?? ''} onChange={(e) => set('agentName', e.target.value)} maxLength={60} placeholder="Asesor virtual" /></Field>
            <Field label="Indicaciones adicionales" hint="No pueden cambiar las reglas fijas: no inventar precios, no aceptar contratos ni pagos."><Textarea value={f.agentInstructions ?? ''} onChange={(e) => set('agentInstructions', e.target.value)} maxLength={4000} /></Field>
          </Card>
          <AgentTest available={s.agent.available} />
        </div>
      </div>
    </form>
  );
}

function ItemList({ title, items, onChange, max, error }: { title: string; items: Item[]; onChange: (v: Item[]) => void; max: number; error?: string }) {
  return (
    <Card className="space-y-3 p-5">
      <h2 className="font-semibold">{title}</h2>
      {items.map((x, i) => (
        <div key={i} className="grid gap-2 rounded-lg border border-border p-3">
          <Input aria-label={`${title}: título ${i + 1}`} value={x.title} onChange={(e) => onChange(items.map((y, j) => (j === i ? { ...y, title: e.target.value } : y)))} placeholder="Título" />
          <Textarea aria-label={`${title}: texto ${i + 1}`} value={x.text} onChange={(e) => onChange(items.map((y, j) => (j === i ? { ...y, text: e.target.value } : y)))} placeholder="Texto" className="min-h-16" />
          <Button size="sm" variant="ghost" className="justify-self-start" icon={<Trash2 className="size-4" />} onClick={() => onChange(items.filter((_, j) => j !== i))}>Quitar</Button>
        </div>
      ))}
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      {items.length < max && <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => onChange([...items, { title: '', text: '' }])}>Agregar</Button>}
    </Card>
  );
}

/** Prueba del agente con lo guardado (no registra prospectos) */
function AgentTest({ available }: { available: boolean }) {
  const [msgs, setMsgs] = useState<{ role: 'customer' | 'assistant'; text: string; tools?: string[] }[]>([]);
  const [text, setText] = useState('');
  const run = useMutation({
    mutationFn: (messages: { role: 'customer' | 'assistant'; text: string }[]) => api<{ reply: string; tools: string[]; handoff: string | null }>('/platform/commercial/agent/test', { method: 'POST', body: { messages } }),
  });
  const send = () => {
    const t = text.trim();
    if (!t) return;
    const next = [...msgs, { role: 'customer' as const, text: t }];
    setMsgs(next);
    setText('');
    run.mutate(next.map(({ role, text }) => ({ role, text })), { onSuccess: (r) => setMsgs((m) => [...m, { role: 'assistant', text: r.reply || '(sin respuesta)', tools: r.tools }]) });
  };
  return (
    <Card className="space-y-3 p-5">
      <h2 className="font-semibold">Probar el agente</h2>
      <p className="text-sm text-muted">Usa lo guardado. En la prueba no se registra ningún prospecto.</p>
      <div className="max-h-80 space-y-2 overflow-y-auto" aria-label="Conversación de prueba" aria-live="polite">
        {msgs.map((m, i) => (
          <div key={i} className={m.role === 'customer' ? 'ml-8 rounded-lg bg-primary/10 p-2 text-sm' : 'mr-8 rounded-lg bg-surface-2 p-2 text-sm'}>
            <p className="whitespace-pre-line">{m.text}</p>
            {m.tools?.length ? <p className="mt-1 text-xs text-muted">Herramientas: {m.tools.join(', ')}</p> : null}
          </div>
        ))}
      </div>
      {run.error && <ErrorBox error={run.error} />}
      <div className="flex gap-2">
        <Input aria-label="Mensaje de prueba" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }} disabled={!available} placeholder={available ? 'Escribe como un visitante' : 'El agente no está disponible'} />
        <Button aria-label="Enviar prueba" onClick={send} loading={run.isPending} disabled={!available || !text.trim()} icon={<Send className="size-4" />} />
      </div>
      {msgs.length > 0 && <Button size="sm" variant="ghost" onClick={() => setMsgs([])}>Empezar de nuevo</Button>}
    </Card>
  );
}
