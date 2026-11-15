'use client';

import { ArrowRight, Check, CircleHelp, LogIn, Mail, MessageCircle, MessageSquareText, Send, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api } from '@/lib/api';
import { Badge, Button, Card, Field, Input, Select, Textarea, cn } from '@/components/ui';

export interface PublicCommercial {
  headline: string;
  subheadline: string | null;
  problems: { title: string; text: string }[];
  benefits: { title: string; text: string }[];
  testimonials: { name: string; company: string | null; quote: string }[];
  contact: { email: string | null; whatsapp: string | null };
  showPrices: boolean;
  chat: { available: boolean; agentName: string | null };
  modules: { key: string; name: string; description: string }[];
  sectors: { key: string; name: string; description: string; includes: string[] }[];
  deployment: { key: string; name: string; description: string }[];
  plans: { code: string; name: string; price: { monthly: string; currency: string } | null; limits: { users: number; whatsappNumbers: number; conversationsPerMonth: number; products: number; branches: number } | null; features: string[] }[];
  faqs: { q: string; a: string }[];
}

type Intent = 'DEMO' | 'PROPOSAL' | 'CONTACT';
const INTENT: Record<Intent, string> = { DEMO: 'Quiero una demostración', PROPOSAL: 'Quiero una propuesta', CONTACT: 'Quiero que me contacten' };

const NAV = [
  ['#funciones', 'Funciones'],
  ['#sectores', 'Sectores'],
  ['#planes', 'Planes'],
  ['#preguntas', 'Preguntas'],
  ['#contacto', 'Contacto'],
] as const;

/** Página comercial pública (ADR 048): todo lo que muestra viene de la base de datos */
export function Landing({ c }: { c: PublicCommercial }) {
  const [pre, setPre] = useState<{ intent?: Intent; sector?: string; plan?: string; n: number }>({ n: 0 });
  const choose = (p: { intent?: Intent; sector?: string; plan?: string }) => {
    setPre((x) => ({ ...p, n: x.n + 1 }));
    document.getElementById('contacto')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="min-h-dvh bg-bg text-text">
      <header className="sticky top-0 z-20 border-b border-border bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <span className="flex items-center gap-2 font-semibold">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-fg"><MessageSquareText className="size-4" /></span>
            AI Sales Assistant
          </span>
          <nav aria-label="Secciones" className="ml-auto hidden gap-5 text-sm text-muted md:flex">
            {NAV.map(([h, l]) => <a key={h} href={h} className="hover:text-text">{l}</a>)}
          </nav>
          <Link href="/login" className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2 md:ml-0"><LogIn className="size-4" />Entrar</Link>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-4 py-16 sm:py-24">
          <h1 className="max-w-3xl text-3xl font-semibold tracking-tight sm:text-5xl">{c.headline}</h1>
          {c.subheadline && <p className="mt-4 max-w-2xl text-lg text-muted">{c.subheadline}</p>}
          <div className="mt-8 flex flex-wrap gap-3">
            <Button onClick={() => choose({ intent: 'DEMO' })} icon={<ArrowRight className="size-4" />}>Solicitar demostración</Button>
            <a href="#planes" className="inline-flex h-10 items-center rounded-lg border border-border bg-surface px-4 text-sm font-medium hover:bg-surface-2">Ver planes</a>
          </div>
        </section>

        {(c.problems.length > 0 || c.benefits.length > 0) && (
          <section className="mx-auto grid max-w-6xl gap-8 px-4 pb-16 md:grid-cols-2" aria-label="Problemas y beneficios">
            {c.problems.length > 0 && (
              <div>
                <h2 className="text-xl font-semibold">Lo que resuelve</h2>
                <ul className="mt-4 space-y-3">
                  {c.problems.map((p) => (
                    <li key={p.title} className="rounded-xl border border-border bg-surface p-4"><p className="font-medium">{p.title}</p><p className="mt-1 text-sm text-muted">{p.text}</p></li>
                  ))}
                </ul>
              </div>
            )}
            {c.benefits.length > 0 && (
              <div>
                <h2 className="text-xl font-semibold">Beneficios</h2>
                <ul className="mt-4 space-y-3">
                  {c.benefits.map((b) => (
                    <li key={b.title} className="flex gap-3 rounded-xl border border-border bg-surface p-4"><Check className="mt-0.5 size-5 shrink-0 text-success" /><div><p className="font-medium">{b.title}</p><p className="mt-1 text-sm text-muted">{b.text}</p></div></li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        <Section id="funciones" title="Funciones" lead="Lo que el sistema hace hoy. No listamos funciones en desarrollo.">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {c.modules.map((m) => (
              <Card key={m.key} className="p-4"><h3 className="font-medium">{m.name}</h3><p className="mt-1 text-sm text-muted">{m.description}</p></Card>
            ))}
          </div>
        </Section>

        <Section id="sectores" title="Elige tu sector" lead="Cada sector parte de una plantilla con lo que ese negocio necesita. Elige el tuyo y cuéntanos tu caso.">
          <div className="grid gap-3 sm:grid-cols-2">
            {c.sectors.map((s) => (
              <Card key={s.key} className="flex flex-col p-4">
                <h3 className="font-medium">{s.name}</h3>
                <p className="mt-1 text-sm text-muted">{s.description}</p>
                <ul className="mt-3 flex-1 space-y-1 text-sm">{s.includes.map((i) => <li key={i} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" />{i}</li>)}</ul>
                <Button variant="secondary" size="sm" className="mt-4 self-start" onClick={() => choose({ sector: s.key, intent: 'DEMO' })}>Es mi sector</Button>
              </Card>
            ))}
          </div>
        </Section>

        <Section id="modalidades" title="Cómo se instala" lead="Tres formas de tenerlo, según el tamaño y las reglas de tu empresa.">
          <div className="grid gap-3 md:grid-cols-3">
            {c.deployment.map((d) => <Card key={d.key} className="p-4"><h3 className="font-medium">{d.name}</h3><p className="mt-1 text-sm text-muted">{d.description}</p></Card>)}
          </div>
        </Section>

        <Section id="planes" title="Planes" lead={c.showPrices ? 'Precios mensuales vigentes.' : 'El precio depende de la modalidad y de lo que necesites: te lo enviamos en la propuesta.'}>
          <div className="grid gap-3 md:grid-cols-3">
            {c.plans.map((p) => (
              <Card key={p.code} className="flex flex-col p-5">
                <h3 className="text-lg font-semibold">{p.name}</h3>
                <p className="mt-2 text-2xl font-semibold">{p.price ? <>{p.price.currency} {p.price.monthly}<span className="text-sm font-normal text-muted"> / mes</span></> : <span className="text-base font-medium text-muted">Precio en la propuesta</span>}</p>
                {p.limits && (
                  <ul className="mt-4 space-y-1 text-sm">
                    <li>{p.limits.users} usuarios</li>
                    <li>{p.limits.whatsappNumbers} número{p.limits.whatsappNumbers === 1 ? '' : 's'} de WhatsApp</li>
                    <li>{p.limits.conversationsPerMonth.toLocaleString('es-PE')} conversaciones al mes</li>
                    <li>{p.limits.products.toLocaleString('es-PE')} productos</li>
                    <li>{p.limits.branches} sucursal{p.limits.branches === 1 ? '' : 'es'}</li>
                  </ul>
                )}
                {p.features.length > 0 && <ul className="mt-3 flex-1 space-y-1 text-sm">{p.features.map((f) => <li key={f} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" />{f}</li>)}</ul>}
                <Button variant="secondary" className="mt-5" onClick={() => choose({ plan: p.code, intent: 'PROPOSAL' })}>Pedir propuesta</Button>
              </Card>
            ))}
          </div>
        </Section>

        <Section id="contratar" title="Cómo contratar" lead="Sin sorpresas: nada se cobra ni se instala antes de que aceptes la propuesta.">
          <ol className="grid gap-3 md:grid-cols-5">
            {['Nos cuentas tu necesidad', 'Ves una demostración', 'Recibes la propuesta con precio', 'Aceptas y pagas', 'Instalamos y configuramos'].map((s, i) => (
              <li key={s} className="rounded-xl border border-border bg-surface p-4 text-sm"><span className="text-xs font-semibold text-primary">Paso {i + 1}</span><p className="mt-1 font-medium">{s}</p></li>
            ))}
          </ol>
        </Section>

        {c.testimonials.length > 0 && (
          <Section id="testimonios" title="Lo que dicen nuestros clientes">
            <div className="grid gap-3 md:grid-cols-2">
              {c.testimonials.map((t) => (
                <figure key={t.name + t.quote} className="rounded-xl border border-border bg-surface p-5">
                  <blockquote className="text-sm">“{t.quote}”</blockquote>
                  <figcaption className="mt-3 text-sm font-medium">{t.name}{t.company && <span className="font-normal text-muted"> · {t.company}</span>}</figcaption>
                </figure>
              ))}
            </div>
          </Section>
        )}

        {c.faqs.length > 0 && (
          <Section id="preguntas" title="Preguntas frecuentes">
            <div className="divide-y divide-border rounded-xl border border-border bg-surface">
              {c.faqs.map((f) => (
                <details key={f.q} className="group p-4">
                  <summary className="flex cursor-pointer list-none items-center gap-2 font-medium"><CircleHelp className="size-4 text-muted" />{f.q}</summary>
                  <p className="mt-2 whitespace-pre-line pl-6 text-sm text-muted">{f.a}</p>
                </details>
              ))}
            </div>
          </Section>
        )}

        <Section id="contacto" title="Hablemos" lead="Déjanos tus datos y un asesor te responde. También puedes escribirnos directamente.">
          <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
            <LeadForm key={pre.n} c={c} pre={pre} />
            <div className="space-y-3 text-sm">
              {c.contact.whatsapp && <a className="flex items-center gap-2 rounded-xl border border-border bg-surface p-4 hover:bg-surface-2" href={`https://wa.me/${c.contact.whatsapp.replace(/^\+/, '')}`} target="_blank" rel="noopener noreferrer"><MessageCircle className="size-4 text-success" />WhatsApp {c.contact.whatsapp}</a>}
              {c.contact.email && <a className="flex items-center gap-2 rounded-xl border border-border bg-surface p-4 hover:bg-surface-2" href={`mailto:${c.contact.email}`}><Mail className="size-4" />{c.contact.email}</a>}
            </div>
          </div>
        </Section>
      </main>

      <footer className="border-t border-border py-8 text-center text-sm text-muted">AI Sales Assistant · <Link href="/login" className="hover:text-text">Acceso de clientes</Link></footer>
      {c.chat.available && <ChatWidget agentName={c.chat.agentName} />}
    </div>
  );
}

function Section({ id, title, lead, children }: { id: string; title: string; lead?: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-t`} className="mx-auto max-w-6xl scroll-mt-20 px-4 py-12">
      <h2 id={`${id}-t`} className="text-2xl font-semibold">{title}</h2>
      {lead && <p className="mt-2 max-w-2xl text-muted">{lead}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

function LeadForm({ c, pre }: { c: PublicCommercial; pre: { intent?: Intent; sector?: string; plan?: string } }) {
  const [f, setF] = useState({ intent: pre.intent ?? 'DEMO', name: '', company: '', phone: '', email: '', sector: pre.sector ?? '', interestPlan: pre.plan ?? '', interestMode: '', need: '', preferredTime: '', acceptPrivacy: false, followUpConsent: false, website: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      await api('/public/leads', {
        method: 'POST',
        body: {
          ...f,
          sector: f.sector || undefined, interestPlan: f.interestPlan || undefined, interestMode: f.interestMode || undefined,
          preferredTime: f.intent === 'DEMO' && f.preferredTime ? f.preferredTime : undefined, website: f.website || undefined,
        },
      });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.errors?.length) setErrors(Object.fromEntries(err.errors.map((x) => [x.path, x.message])));
      else setError(err instanceof Error ? err.message : 'No se pudo enviar');
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <Card className="p-6" >
        <p role="status" className="flex items-center gap-2 font-medium"><Check className="size-5 text-success" />Recibimos tu solicitud.</p>
        <p className="mt-2 text-sm text-muted">Un asesor te contactará por el medio que dejaste. {f.intent === 'DEMO' ? 'Te confirmará el día y la hora de la demostración.' : ''}</p>
      </Card>
    );

  return (
    <Card className="p-5">
      <form onSubmit={submit} aria-label="Formulario de contacto" className="grid gap-4 sm:grid-cols-2" noValidate>
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium">¿Qué necesitas?</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {(Object.keys(INTENT) as Intent[]).map((k) => (
              <label key={k} className={cn('cursor-pointer rounded-lg border px-3 py-1.5 text-sm', f.intent === k ? 'border-primary bg-primary/10' : 'border-border')}>
                <input type="radio" name="intent" className="sr-only" checked={f.intent === k} onChange={() => set('intent', k)} />
                {INTENT[k]}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Nombre" error={errors.name}><Input value={f.name} onChange={(e) => set('name', e.target.value)} autoComplete="name" required /></Field>
        <Field label="Empresa"><Input value={f.company} onChange={(e) => set('company', e.target.value)} autoComplete="organization" /></Field>
        <Field label="Teléfono o WhatsApp" error={errors.phone}><Input value={f.phone} onChange={(e) => set('phone', e.target.value)} autoComplete="tel" inputMode="tel" /></Field>
        <Field label="Correo" error={errors.email}><Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} autoComplete="email" /></Field>
        <Field label="Sector">
          <Select value={f.sector} onChange={(e) => set('sector', e.target.value)}>
            <option value="">Elegir…</option>
            {c.sectors.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
            <option value="OTHER">Otro</option>
          </Select>
        </Field>
        <Field label="Plan de interés">
          <Select value={f.interestPlan} onChange={(e) => set('interestPlan', e.target.value)}>
            <option value="">Aún no sé</option>
            {c.plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Modalidad" className="sm:col-span-2">
          <Select value={f.interestMode} onChange={(e) => set('interestMode', e.target.value)}>
            <option value="">Aún no sé</option>
            {c.deployment.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
          </Select>
        </Field>
        <Field label="Cuéntanos tu necesidad" error={errors.need} className="sm:col-span-2"><Textarea value={f.need} onChange={(e) => set('need', e.target.value)} placeholder="Qué vendes, cuántas personas atienden y qué quieres resolver" /></Field>
        {f.intent === 'DEMO' && <Field label="¿Cuándo prefieres la demostración?" hint="Un asesor te confirma el día y la hora." className="sm:col-span-2"><Input value={f.preferredTime} onChange={(e) => set('preferredTime', e.target.value)} placeholder="Por ejemplo: martes por la tarde" /></Field>}
        {/* Campo trampa para bots: oculto a las personas y a los lectores de pantalla */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
          <label>Sitio web<input tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => set('website', e.target.value)} /></label>
        </div>
        <div className="space-y-2 text-sm sm:col-span-2">
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={f.acceptPrivacy} onChange={(e) => set('acceptPrivacy', e.target.checked)} />Acepto que usen estos datos para responder esta solicitud.</label>
          {errors.acceptPrivacy && <p className="text-xs text-danger" role="alert">{errors.acceptPrivacy}</p>}
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={f.followUpConsent} onChange={(e) => set('followUpConsent', e.target.checked)} />Acepto que me contacten después con novedades sobre mi solicitud (opcional).</label>
        </div>
        {error && <p className="text-sm text-danger sm:col-span-2" role="alert">{error}</p>}
        <div className="sm:col-span-2"><Button type="submit" loading={busy} icon={<Send className="size-4" />}>Enviar solicitud</Button></div>
      </form>
    </Card>
  );
}

interface ChatMsg { role: 'VISITOR' | 'AGENT' | 'SYSTEM'; text: string }
const STORE = 'aisa_sales_chat';

function ChatWidget({ agentName }: { agentName: string | null }) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<{ id: string; token: string } | null>(null);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const name = agentName || 'Asesor virtual';

  useEffect(() => {
    // Sin devolver nada: en Chromium reciente scrollIntoView devuelve una promesa y React la tomaría como limpieza
    void end.current?.scrollIntoView({ block: 'end' });
  }, [msgs]);

  const start = async () => {
    try {
      const saved = sessionStorage.getItem(STORE);
      if (saved) return JSON.parse(saved) as { id: string; token: string };
    } catch {
      /* sin almacenamiento: se empieza otra conversación */
    }
    const s = await api<{ id: string; token: string }>('/public/chat', { method: 'POST' });
    try {
      sessionStorage.setItem(STORE, JSON.stringify({ id: s.id, token: s.token }));
    } catch {
      /* ídem */
    }
    return s;
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setText('');
    setMsgs((m) => [...m, { role: 'VISITOR', text: t }]);
    setBusy(true);
    try {
      const s = session ?? (await start());
      setSession(s);
      const r = await api<{ reply: string; handoff: boolean; remaining: number }>(`/public/chat/${s.id}/messages`, { method: 'POST', body: { token: s.token, text: t } });
      setMsgs((m) => [...m, { role: 'AGENT', text: r.reply }]);
      if (r.remaining === 0) setClosed('Llegaste al máximo de mensajes de esta conversación. Usa el formulario para que un asesor te contacte.');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CHAT_SESSION') {
        try { sessionStorage.removeItem(STORE); } catch { /* ídem */ }
        setSession(null);
      }
      const msg = err instanceof Error ? err.message : 'No se pudo enviar';
      if (err instanceof ApiError && (err.code === 'CHAT_LIMIT' || err.code === 'CHAT_DISABLED')) setClosed(msg);
      setMsgs((m) => [...m, { role: 'SYSTEM', text: msg }]);
    } finally {
      setBusy(false);
    }
  };

  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="fixed bottom-4 right-4 z-30 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-medium text-primary-fg shadow-lg hover:opacity-90">
        <MessageCircle className="size-5" />Chatear con {name}
      </button>
    );

  return (
    <section role="dialog" aria-label={`Chat con ${name}`} className="fixed bottom-4 right-4 z-30 flex h-[min(560px,calc(100dvh-2rem))] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <MessageCircle className="size-5 text-primary" />
        <div className="flex-1"><p className="text-sm font-medium">{name}</p><p className="text-xs text-muted">Asistente con IA · un asesor humano revisa tu caso</p></div>
        <button type="button" onClick={() => setOpen(false)} aria-label="Cerrar chat" className="rounded p-1 hover:bg-surface-2"><X className="size-4" /></button>
      </header>
      <div className="flex-1 space-y-2 overflow-y-auto p-3" aria-live="polite" aria-label="Mensajes del chat">
        <p className="rounded-xl bg-surface-2 p-3 text-sm">Hola, soy {name}. Te ayudo a conocer el sistema, comparar planes y pedir una demostración. ¿Qué vende tu negocio?</p>
        {msgs.map((m, i) => (
          <p key={i} className={cn('max-w-[85%] whitespace-pre-line rounded-xl p-3 text-sm', m.role === 'VISITOR' ? 'ml-auto bg-primary text-primary-fg' : m.role === 'AGENT' ? 'bg-surface-2' : 'border border-warning/40 text-warning')}>{m.text}</p>
        ))}
        {busy && <p className="text-xs text-muted">{name} está escribiendo…</p>}
        <div ref={end} />
      </div>
      {closed ? (
        <p className="border-t border-border p-3 text-xs text-muted"><Badge tone="warning">Chat cerrado</Badge> {closed}</p>
      ) : (
        <form onSubmit={send} className="flex gap-2 border-t border-border p-3">
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribe tu mensaje" aria-label="Mensaje para el asesor" maxLength={1000} />
          <Button type="submit" aria-label="Enviar mensaje" disabled={!text.trim()} loading={busy} icon={<Send className="size-4" />} />
        </form>
      )}
      <p className="px-3 pb-2 text-[11px] text-muted">El asistente no confirma precios no publicados, contratos ni pagos: eso lo hace un asesor.</p>
    </section>
  );
}
