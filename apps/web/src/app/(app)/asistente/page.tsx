'use client';

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, RotateCcw, Send, User, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Textarea, cn } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';

interface AiSettings {
  isEnabled: boolean;
  assistantName: string;
  tone: string;
  welcomeMessage: string | null;
  businessInfo: string | null;
  handoffKeywords: string[];
  provider: { configured: boolean; model: string };
}
interface ChatLine { role: 'customer' | 'assistant'; text: string; tools?: string[]; handoff?: string | null }
const TOOL_LABEL: Record<string, string> = {
  buscar_productos: 'consultó el catálogo',
  ver_pedidos_del_cliente: 'consultó pedidos',
  crear_pedido: 'intentó crear un pedido',
  derivar_a_humano: 'derivó a una persona',
};

function Settings({ data }: { data: AiSettings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    isEnabled: data.isEnabled,
    assistantName: data.assistantName,
    tone: data.tone,
    welcomeMessage: data.welcomeMessage ?? '',
    businessInfo: data.businessInfo ?? '',
    keywords: data.handoffKeywords.join(', '),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/ai/settings', {
        method: 'PUT',
        body: {
          isEnabled: f.isEnabled, assistantName: f.assistantName, tone: f.tone, welcomeMessage: f.welcomeMessage, businessInfo: f.businessInfo,
          handoffKeywords: f.keywords.split(',').map((k) => k.trim()).filter(Boolean),
        },
      });
      toast.success('Asistente guardado');
      qc.invalidateQueries({ queryKey: ['ai-settings'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Configuración</h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={f.isEnabled} onChange={(e) => setF({ ...f, isEnabled: e.target.checked })} />
            Responder automáticamente por WhatsApp
          </label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre del asistente"><Input value={f.assistantName} onChange={(e) => setF({ ...f, assistantName: e.target.value })} required maxLength={60} /></Field>
          <Field label="Tono"><Input value={f.tone} onChange={(e) => setF({ ...f, tone: e.target.value })} required minLength={2} maxLength={120} /></Field>
        </div>
        <Field label="Información del negocio" hint="Horarios, zonas y costo de envío, medios de pago, cambios y devoluciones. No pongas precios ni stock: el asistente los consulta en tu catálogo.">
          <Textarea rows={7} value={f.businessInfo} onChange={(e) => setF({ ...f, businessInfo: e.target.value })} maxLength={6000} />
        </Field>
        <Field label="Saludo (opcional)"><Input value={f.welcomeMessage} onChange={(e) => setF({ ...f, welcomeMessage: e.target.value })} maxLength={500} /></Field>
        <Field label="Palabras que pasan la conversación a una persona" hint="Separadas por comas. Si el cliente escribe una, el asistente avisa y deja de responder.">
          <Input value={f.keywords} onChange={(e) => setF({ ...f, keywords: e.target.value })} />
        </Field>
        <ErrorBox error={error} />
        <Button type="submit" className="self-end" loading={busy}>Guardar</Button>
      </Card>
    </form>
  );
}

function TestChat({ configured }: { configured: boolean }) {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const end = useRef<HTMLDivElement>(null);

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
      const r = await api<{ reply: string; tools: string[]; handoff: string | null }>('/ai/test', {
        method: 'POST',
        body: { messages: next.slice(-20).map((l) => ({ role: l.role, text: l.text })) },
      });
      setLines([...next, { role: 'assistant', text: r.reply || '(sin respuesta)', tools: r.tools, handoff: r.handoff }]);
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
      <p className="mb-3 text-sm text-muted">Escribe como si fueras un cliente. Usa tu catálogo real y la configuración guardada; no envía nada por WhatsApp ni crea pedidos.</p>
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
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={configured ? 'Mensaje del cliente' : 'Disponible cuando el servidor tenga la clave de Gemini'} disabled={!configured} maxLength={2000} aria-label="Mensaje de prueba" />
        <Button type="submit" icon={<Send className="size-4" />} loading={busy} disabled={!configured || !text.trim()}>Enviar</Button>
      </form>
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
        actions={d.provider.configured ? <Badge tone={d.isEnabled ? 'success' : 'neutral'}>{d.isEnabled ? 'Activo' : 'Desactivado'}</Badge> : <Badge tone="warning">Sin conectar</Badge>}
      />
      {!d.provider.configured && (
        <div role="status" className="mb-6 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          La IA todavía no está conectada en el servidor: falta la clave de Gemini (GEMINI_API_KEY). Mientras tanto los mensajes se reciben y los atiende tu equipo. Puedes dejar la configuración lista.
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Settings key={JSON.stringify(d)} data={d} />
        <TestChat configured={d.provider.configured} />
      </div>
      <p className="mt-4 text-xs text-muted">Modelo: {d.provider.model}. Los mensajes de los clientes se envían a Google (Gemini API) para generar la respuesta.</p>
    </>
  );
}

export default function AsistentePage() {
  return <RequirePermission permission="ai:configure"><Assistant /></RequirePermission>;
}
