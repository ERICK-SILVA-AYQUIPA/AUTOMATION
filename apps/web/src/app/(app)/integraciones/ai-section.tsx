'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { Badge, Button, Card, Dialog, ErrorBox, Field, Input, Loading, Select } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { CredentialDialog, CredentialsTable, MODE_LABEL, PROFILE_LABEL, UsageTable, type Credential, type ProviderCard, type Usage } from '@/components/api-center';

interface Overview {
  providers: ProviderCard[];
  credentials: Credential[];
  assignment: {
    provider: string; mode: 'MANAGED' | 'OWN'; model: string | null; profile: string; monthlyTokenLimit: number | null; isActive: boolean;
    credentialId: string | null; managedCredential: { label: string; status: string; secretHint: string } | null; hasFallback: boolean;
  } | null;
  effective: { label: string | null; provider?: string; model?: string; mode?: string; reason?: string; code?: string };
  usage: Usage;
}

/**
 * IA de la empresa (Centro de APIs, ADR 046): qué proveedor y modelo usa el
 * asistente, sus claves propias y la prueba real. Claude, Gemini, OpenAI o DeepSeek.
 */
export function AiProviderSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['ai-center'], queryFn: () => api<Overview>('/integrations/ai'), staleTime: 0 });
  const [adding, setAdding] = useState(false);
  const [assigning, setAssigning] = useState<Credential | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['ai-center'] });
    qc.invalidateQueries({ queryKey: ['integrations'] });
    qc.invalidateQueries({ queryKey: ['integration-checks'] });
    qc.invalidateQueries({ queryKey: ['ai-settings'] });
  };
  async function test() {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; detail: string }>('/integrations/ai/assignment/test', { method: 'POST' });
      if (r.ok) toast.success(r.detail);
      else toast.error(r.detail);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
      refresh();
    }
  }
  async function unassign() {
    setBusy(true);
    try {
      await api('/integrations/ai/assignment', { method: 'DELETE' });
      toast.success('El asistente ya no usa tu clave propia');
      setConfirmRemove(false);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
      refresh();
    }
  }
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const a = d.assignment;
  return (
    <Card className="flex flex-col gap-5 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-indigo-500/10 p-2 text-indigo-600 dark:text-indigo-300"><Bot className="size-5" /></div>
          <div>
            <p className="font-medium">Proveedor del asistente</p>
            {d.effective.label ? (
              <p className="text-sm">{d.effective.label}</p>
            ) : (
              <p className="text-sm text-danger">{d.effective.code === 'NOT_CONFIGURED' ? 'Sin proveedor de IA: los mensajes los atiende tu equipo.' : `No disponible: ${d.effective.reason}.`}</p>
            )}
            {a && (
              <p className="mt-1 text-xs text-muted">
                {MODE_LABEL[a.mode]}{a.managedCredential ? ` (${a.managedCredential.label} ${a.managedCredential.secretHint})` : ''} · Perfil {PROFILE_LABEL[a.profile] ?? a.profile}
                {a.monthlyTokenLimit ? ` · tope ${num(a.monthlyTokenLimit)} tokens/mes` : ''}{a.hasFallback ? ' · con respaldo' : ''}
                {!a.isActive ? ' · desactivada' : ''}
              </p>
            )}
            {!a && d.effective.mode === 'SERVER' && <p className="mt-1 text-xs text-muted">Usa la clave que configuró la plataforma en el servidor.</p>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          {d.effective.label && <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} loading={busy} onClick={test}>Probar IA</Button>}
          {a?.mode === 'OWN' && <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setConfirmRemove(true)}>Dejar de usar mi clave</Button>}
        </div>
      </div>
      <p className="text-xs text-muted">«Probar IA» envía una petición real y muy corta al modelo (consume unos pocos tokens). Los mensajes de tus clientes se envían al proveedor elegido para generar cada respuesta.</p>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Tus claves propias</h3>
          <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Conectar clave</Button>
        </div>
        {d.credentials.length ? (
          <CredentialsTable
            items={d.credentials}
            base="/integrations/ai/credentials"
            providers={d.providers}
            onChanged={refresh}
            extra={(c) => !c.disabledAt && (c.status === 'CONNECTED' || c.status === 'CONNECTED_WITH_WARNINGS') ? (
              <Button size="sm" variant={a?.credentialId === c.id ? 'secondary' : 'primary'} onClick={() => setAssigning(c)}>{a?.credentialId === c.id ? 'Cambiar modelo' : 'Usar en el asistente'}</Button>
            ) : null}
          />
        ) : (
          <p className="text-sm text-muted">Opcional. Con tu propia clave de Claude, Gemini, OpenAI o DeepSeek el consumo se factura en tu cuenta del proveedor.</p>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium">Consumo de este mes</h3>
        <UsageTable usage={d.usage} />
      </div>

      <CredentialDialog open={adding} onClose={() => setAdding(false)} providers={d.providers} endpoint="/integrations/ai/credentials" onSaved={refresh} />
      {assigning && <AssignOwnDialog cred={assigning} current={a} onClose={() => setAssigning(null)} onSaved={refresh} providers={d.providers} />}
      <Dialog open={confirmRemove} onClose={() => setConfirmRemove(false)} title="¿Dejar de usar tu clave?" footer={<><Button variant="secondary" onClick={() => setConfirmRemove(false)}>Cancelar</Button><Button variant="danger" loading={busy} onClick={unassign}>Dejar de usarla</Button></>}>
        <p className="text-sm text-muted">La clave sigue guardada. El asistente usará la IA que asigne la plataforma; si no hay ninguna, los mensajes los atenderá tu equipo.</p>
      </Dialog>
    </Card>
  );
}

function AssignOwnDialog({ cred, current, onClose, onSaved, providers }: { cred: Credential; current: Overview['assignment']; onClose: () => void; onSaved: () => void; providers: ProviderCard[] }) {
  const toast = useToast();
  const models = useQuery({ queryKey: ['ai-models', cred.id], queryFn: () => api<{ id: string; displayName?: string }[]>(`/integrations/ai/credentials/${cred.id}/models`) });
  const same = current?.credentialId === cred.id;
  const [model, setModel] = useState(same ? (current?.model ?? '') : '');
  const [profile, setProfile] = useState(same ? (current?.profile ?? 'ECONOMY') : 'ECONOMY');
  const [maxTokens, setMaxTokens] = useState('2048');
  const [limit, setLimit] = useState(same && current?.monthlyTokenLimit ? String(current.monthlyTokenLimit) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/integrations/ai/assignment', { method: 'PUT', body: { credentialId: cred.id, model, profile, ...(profile === 'CUSTOM' ? { params: { maxOutputTokens: Number(maxTokens) } } : {}), monthlyTokenLimit: limit ? Number(limit) : null } });
      toast.success(`El asistente usará ${model}. Pruébalo con «Probar IA».`);
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title={`Usar ${cred.label} en el asistente`} footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="assign-own" loading={busy} disabled={!model}>Guardar</Button></>}>
      <form id="assign-own" onSubmit={submit} className="flex flex-col gap-4">
        <ErrorBox error={error ?? models.error} />
        <Field label="Modelo" hint={`Lista real que ${providers.find((p) => p.key === cred.provider)?.name ?? 'el proveedor'} ofrece a esta clave`}>
          {models.isLoading ? <Loading label="Leyendo modelos…" /> : (
            <Select value={model} onChange={(e) => setModel(e.target.value)} required>
              <option value="">Elige un modelo</option>
              {models.data?.map((m) => <option key={m.id} value={m.id}>{m.displayName ? `${m.displayName} (${m.id})` : m.id}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Perfil" hint="Económico: respuestas cortas (1024 tokens). Avanzado: hasta 4096. Personalizado: tú decides.">
          <Select value={profile} onChange={(e) => setProfile(e.target.value)}>
            {Object.entries(PROFILE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
        {profile === 'CUSTOM' && (
          <Field label="Máximo de tokens por respuesta">
            <Input type="number" min={256} max={16000} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
          </Field>
        )}
        <Field label="Tope mensual de tokens (opcional)">
          <Input type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)} />
        </Field>
        <p className="text-xs text-muted">Al cambiar de proveedor, los mensajes de tus clientes se envían a ese proveedor a partir de ahora.</p>
        {!same && current && <Badge tone="warning">Reemplaza la configuración actual ({current.provider})</Badge>}
      </form>
    </Dialog>
  );
}
