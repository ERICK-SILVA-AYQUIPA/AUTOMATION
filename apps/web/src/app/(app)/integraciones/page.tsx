'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Copy, KeyRound, Link2, MessageCircle, Plus, Power, RefreshCw, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { fieldErrors } from '@/lib/form';
import { dateTime } from '@/lib/format';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Field, Input, Loading, PageHeader } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';
import { ChatwootCard } from '@/components/chatwoot';
import { GeminiKeyCard, IntegrationErrors, IntegrationsOverview, WebhooksSection } from './center';

interface WaNumber {
  id: string; provider: 'CLOUD_API' | 'EVOLUTION'; label: string | null; displayPhone: string | null; phoneNumberId: string | null; wabaId: string | null;
  status: 'PENDING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR'; lastError: string | null; isActive: boolean; lastWebhookAt: string | null;
  createdAt: string; hasAccessToken: boolean; hasAppSecret: boolean; webhookUrl: string; verifiedName?: string | null;
}
interface WebhookConfig { webhookUrl: string; verifyToken: string | null; field: string }

const STATUS = {
  PENDING: { label: 'Pendiente', tone: 'warning' },
  CONNECTED: { label: 'Credenciales válidas', tone: 'success' },
  DISCONNECTED: { label: 'Desconectado', tone: 'neutral' },
  ERROR: { label: 'Error', tone: 'danger' },
} as const;

/** Meta solo entrega webhooks a URLs HTTPS públicas */
const publicHttps = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
};

function CopyField({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <Input readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button
          variant="secondary"
          aria-label={`Copiar ${label}`}
          icon={<Copy className="size-4" />}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              toast.success('Copiado');
            } catch {
              toast.error('No se pudo copiar; selecciona el texto y cópialo manualmente');
            }
          }}
        />
      </div>
    </Field>
  );
}

function WebhookDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['wa-webhook', id], queryFn: () => api<WebhookConfig>(`/whatsapp/numbers/${id}/webhook`), staleTime: 0, gcTime: 0 });
  return (
    <Dialog open onClose={onClose} title="Configurar el webhook en Meta" wide footer={<Button onClick={onClose}>Listo</Button>}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : q.data && (
        <div className="flex flex-col gap-4 text-sm">
          {!publicHttps(q.data.webhookUrl) && (
            <div className="flex gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>Esta URL no es HTTPS pública, así que Meta no podrá llamarla. En producción define <code>API_PUBLIC_URL</code> con tu dominio HTTPS (o usa un túnel en pruebas).</p>
            </div>
          )}
          <CopyField label="URL de devolución de llamada (Callback URL)" value={q.data.webhookUrl} />
          {q.data.verifyToken && <CopyField label="Token de verificación (Verify token)" value={q.data.verifyToken} />}
          <ol className="list-decimal space-y-1.5 pl-5 text-muted">
            <li>En <b className="text-text">developers.facebook.com</b>, abre tu app y entra a <b className="text-text">WhatsApp → Configuración</b>.</li>
            <li>En <b className="text-text">Webhook</b> pulsa <b className="text-text">Editar</b>, pega la URL y el token de arriba y pulsa <b className="text-text">Verificar y guardar</b>.</li>
            <li>En los campos del webhook, suscríbete a <code className="text-text">{q.data.field}</code>.</li>
            <li>Escribe al número desde otro WhatsApp. Aquí verás la hora del último aviso recibido.</li>
          </ol>
          <p className="text-xs text-muted">El token de verificación es secreto: solo lo ven los administradores de tu empresa.</p>
        </div>
      )}
    </Dialog>
  );
}

const emptyNew = { label: '', phoneNumberId: '', wabaId: '', accessToken: '', appSecret: '' };

function NewNumberDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (n: WaNumber) => void }) {
  const [f, setF] = useState(emptyNew);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const n = await api<WaNumber>('/whatsapp/numbers', {
        method: 'POST',
        body: { phoneNumberId: f.phoneNumberId, accessToken: f.accessToken, appSecret: f.appSecret, ...(f.label.trim() ? { label: f.label } : {}), ...(f.wabaId.trim() ? { wabaId: f.wabaId } : {}) },
      });
      onCreated(n);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="Conectar número de WhatsApp" wide footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="wa-form" loading={busy}>Verificar y guardar</Button></>}>
      <form id="wa-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <p className="text-sm text-muted sm:col-span-2">
          Copia estos datos desde tu app en developers.facebook.com. Comprobamos las credenciales con Meta antes de guardarlas, y se guardan cifradas.
        </p>
        <div className="sm:col-span-2"><ErrorBox error={error} /></div>
        <Field label="Nombre interno (opcional)" error={errors.label}><Input value={f.label} onChange={set('label')} maxLength={60} placeholder="Ventas Lima" /></Field>
        <Field label="Phone number ID" error={errors.phoneNumberId} hint="WhatsApp → Configuración de la API"><Input required value={f.phoneNumberId} onChange={set('phoneNumberId')} inputMode="numeric" invalid={!!errors.phoneNumberId} /></Field>
        <Field label="WhatsApp Business Account ID (opcional)" error={errors.wabaId}><Input value={f.wabaId} onChange={set('wabaId')} inputMode="numeric" invalid={!!errors.wabaId} /></Field>
        <Field label="App Secret" error={errors.appSecret} hint="Configuración de la app → Básica. Sirve para validar la firma de cada aviso."><Input required type="password" autoComplete="off" value={f.appSecret} onChange={set('appSecret')} invalid={!!errors.appSecret} /></Field>
        <Field label="Token de acceso" error={errors.accessToken} hint="Usa un token permanente de usuario del sistema; el temporal caduca en 24 h." className="sm:col-span-2">
          <Input required type="password" autoComplete="off" value={f.accessToken} onChange={set('accessToken')} invalid={!!errors.accessToken} />
        </Field>
      </form>
    </Dialog>
  );
}

function CredentialsDialog({ n, onClose, onSaved }: { n: WaNumber; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ accessToken: '', appSecret: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/whatsapp/numbers/${n.id}`, { method: 'PATCH', body: { ...(f.accessToken.trim() ? { accessToken: f.accessToken } : {}), ...(f.appSecret.trim() ? { appSecret: f.appSecret } : {}) } });
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title="Actualizar credenciales" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="wa-cred" loading={busy} disabled={!f.accessToken.trim() && !f.appSecret.trim()}>Guardar</Button></>}>
      <form id="wa-cred" onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-muted">Deja en blanco lo que no cambie. Un token nuevo se comprueba con Meta antes de guardarse.</p>
        <ErrorBox error={error} />
        <Field label="Nuevo token de acceso" error={errors.accessToken}><Input type="password" autoComplete="off" value={f.accessToken} onChange={(e) => setF({ ...f, accessToken: e.target.value })} /></Field>
        <Field label="Nuevo App Secret" error={errors.appSecret}><Input type="password" autoComplete="off" value={f.appSecret} onChange={(e) => setF({ ...f, appSecret: e.target.value })} /></Field>
      </form>
    </Dialog>
  );
}

function TestDialog({ n, onClose }: { n: WaNumber; onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ to: '', template: '', language: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/whatsapp/numbers/${n.id}/test-message`, { method: 'POST', body: f });
      toast.success('WhatsApp aceptó el mensaje. Revisa el teléfono de destino.');
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title="Enviar mensaje de prueba" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="wa-test" loading={busy}>Enviar</Button></>}>
      <form id="wa-test" onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-muted">Para iniciar una conversación WhatsApp exige una plantilla aprobada. Usa el nombre y el idioma exactos que aparecen en tu administrador de plantillas de Meta.</p>
        <ErrorBox error={error} />
        <Field label="Teléfono de destino" error={errors.to} hint="Con código de país, p. ej. 51987654321"><Input required inputMode="tel" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <Field label="Nombre de la plantilla" error={errors.template}><Input required value={f.template} onChange={(e) => setF({ ...f, template: e.target.value })} /></Field>
        <Field label="Código de idioma" error={errors.language} hint="p. ej. es, es_PE o en_US"><Input required value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })} /></Field>
      </form>
    </Dialog>
  );
}

function NumberCard({ n, onWebhook, onCreds, onTest }: { n: WaNumber; onWebhook: () => void; onCreds: () => void; onTest: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<'check' | 'toggle' | null>(null);
  const st = STATUS[n.status];
  async function run(kind: 'check' | 'toggle') {
    setBusy(kind);
    try {
      if (kind === 'check') {
        const r = await api<WaNumber>(`/whatsapp/numbers/${n.id}/check`, { method: 'POST' });
        if (r.status === 'CONNECTED') toast.success('Meta aceptó las credenciales');
        else toast.error(r.lastError ?? 'Meta rechazó las credenciales');
      } else {
        await api(`/whatsapp/numbers/${n.id}`, { method: 'PATCH', body: { isActive: !n.isActive } });
        toast.success(n.isActive ? 'Número desactivado: los mensajes que lleguen se ignorarán' : 'Número activado');
      }
      qc.invalidateQueries({ queryKey: ['wa-numbers'] });
      qc.invalidateQueries({ queryKey: ['integrations'] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card className="p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-green-500/10 p-2 text-green-700 dark:text-green-400"><MessageCircle className="size-5" /></div>
          <div>
            <p className="font-medium">{n.label ?? n.displayPhone ?? 'Número de WhatsApp'}</p>
            <p className="text-sm text-muted">{n.displayPhone ?? '—'} · Phone number ID {n.phoneNumberId}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {n.isActive ? <Badge tone={st.tone}>{st.label}</Badge> : <Badge>Desactivado</Badge>}
              {n.lastWebhookAt ? (
                <Badge tone="success"><CheckCircle2 className="mr-1 size-3" />Último aviso de Meta: {dateTime(n.lastWebhookAt)}</Badge>
              ) : (
                <Badge tone="warning">Aún no llega ningún aviso de Meta</Badge>
              )}
            </div>
            {n.lastError && <p className="mt-2 text-sm text-danger">{n.lastError}</p>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <Button size="sm" variant="secondary" icon={<Link2 className="size-4" />} onClick={onWebhook}>Webhook</Button>
          <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} loading={busy === 'check'} onClick={() => run('check')}>Comprobar</Button>
          <Button size="sm" variant="secondary" icon={<Send className="size-4" />} onClick={onTest} disabled={!n.isActive}>Prueba</Button>
          <Button size="sm" variant="secondary" icon={<KeyRound className="size-4" />} onClick={onCreds}>Credenciales</Button>
          <Button size="sm" variant={n.isActive ? 'ghost' : 'secondary'} icon={<Power className="size-4" />} loading={busy === 'toggle'} onClick={() => run('toggle')}>{n.isActive ? 'Desactivar' : 'Activar'}</Button>
        </div>
      </div>
    </Card>
  );
}

function Integrations() {
  const qc = useQueryClient();
  const toast = useToast();
  // Siempre fresco y con refresco periódico: así se ve llegar el primer aviso de Meta sin recargar
  const list = useQuery({ queryKey: ['wa-numbers'], queryFn: () => api<WaNumber[]>('/whatsapp/numbers'), staleTime: 0, refetchInterval: 15_000 });
  const [dlg, setDlg] = useState<{ kind: 'new' } | { kind: 'webhook' | 'creds' | 'test'; n: WaNumber } | null>(null);
  const close = () => setDlg(null);

  return (
    <>
      <PageHeader
        title="Integraciones"
        description="Estado real de cada servicio que usa tu empresa, con su última prueba. Las claves se guardan cifradas y nunca se muestran completas."
      />
      <IntegrationsOverview />
      <IntegrationErrors />

      <div className="mb-3 mt-8 flex items-end justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Números de WhatsApp</h2>
        <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setDlg({ kind: 'new' })}>Conectar número</Button>
      </div>
      {list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : !list.data?.length ? (
        <Card>
          <EmptyState
            icon={<MessageCircle className="size-5" />}
            title="Aún no hay números conectados"
            description="Necesitas una app de Meta con el producto WhatsApp, el Phone number ID, un token de acceso permanente y el App Secret."
            action={<Button icon={<Plus className="size-4" />} onClick={() => setDlg({ kind: 'new' })}>Conectar número</Button>}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {list.data.map((n) => (
            <NumberCard key={n.id} n={n} onWebhook={() => setDlg({ kind: 'webhook', n })} onCreds={() => setDlg({ kind: 'creds', n })} onTest={() => setDlg({ kind: 'test', n })} />
          ))}
        </div>
      )}

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-muted">Atención humana</h2>
      <ChatwootCard />

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-muted">Asistente IA</h2>
      <GeminiKeyCard />

      <h2 className="mb-1 mt-8 text-sm font-semibold uppercase tracking-wide text-muted">Webhooks</h2>
      <p className="mb-3 text-sm text-muted">Cada entrega va firmada (HMAC-SHA256) y se reintenta hasta 6 veces con espera creciente si tu sistema no responde 2xx.</p>
      <WebhooksSection />

      {dlg?.kind === 'new' && (
        <NewNumberDialog
          onClose={close}
          onCreated={(n) => {
            qc.invalidateQueries({ queryKey: ['wa-numbers'] });
            qc.invalidateQueries({ queryKey: ['integrations'] });
            toast.success(`Número ${n.displayPhone ?? ''} verificado y guardado`);
            // Siguiente paso obligatorio: configurar el webhook en Meta
            setDlg({ kind: 'webhook', n });
          }}
        />
      )}
      {dlg?.kind === 'webhook' && <WebhookDialog id={dlg.n.id} onClose={close} />}
      {dlg?.kind === 'creds' && (
        <CredentialsDialog n={dlg.n} onClose={close} onSaved={() => { qc.invalidateQueries({ queryKey: ['wa-numbers'] }); toast.success('Credenciales actualizadas'); close(); }} />
      )}
      {dlg?.kind === 'test' && <TestDialog n={dlg.n} onClose={close} />}
    </>
  );
}

export default function IntegracionesPage() {
  return <RequirePermission permission="integrations:manage"><Integrations /></RequirePermission>;
}
