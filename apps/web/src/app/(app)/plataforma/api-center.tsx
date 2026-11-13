'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Pencil, Plus, Power, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { dateTime, num } from '@/lib/format';
import { Badge, Button, Card, Dialog, ErrorBox, Field, Input, Loading, Select, Table, Td, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { CRED_STATUS, CredentialDialog, CredentialsTable, MODE_LABEL, PROFILE_LABEL, UsageTable, type Credential, type CredentialStatus, type ProviderCard, type Usage } from '@/components/api-center';

interface CatalogItem { key: string; name: string; category: string; managedIn: 'center' | 'whatsapp' | 'server' | 'webhooks' | 'planned'; note?: string }
interface Model { id: string; provider: string; modelId: string; displayName: string | null; source: 'PROVIDER' | 'MANUAL'; contextWindow: number | null; isEnabled: boolean; inputPricePerMTok: string | null; outputPricePerMTok: string | null; priceCurrency: string; lastSeenAt: string | null }
interface Assignment {
  id: string; tenantId: string; service: 'ASSISTANT' | 'COMMERCIAL'; provider: string; mode: 'MANAGED' | 'OWN'; model: string | null; profile: string;
  monthlyTokenLimit: number | null; isActive: boolean; fallbackModel: string | null; allowCrossProviderFallback: boolean; updatedAt: string;
  credential: { label: string; secretHint: string; status: CredentialStatus };
}
interface Overview {
  catalog: CatalogItem[]; providers: ProviderCard[]; credentials: Credential[]; models: Model[]; assignments: Assignment[];
  tenants: { id: string; name: string; status: string }[]; ownCredentials: { tenantId: string; provider: string; count: number }[]; usage: Usage;
}

const CATEGORY: Record<string, string> = { ai: 'Inteligencia artificial', messaging: 'Mensajería', automation: 'Automatización', support: 'Atención', infrastructure: 'Infraestructura', payments: 'Pagos', email: 'Correo', storage: 'Almacenamiento', dns: 'DNS' };
const SERVICE: Record<string, string> = { ASSISTANT: 'Asistente de clientes', COMMERCIAL: 'Agente comercial' };
const WHERE: Record<CatalogItem['managedIn'], string> = { center: 'Aquí', whatsapp: 'Cada empresa, en Integraciones', server: 'Variables del servidor (pestaña Integraciones)', webhooks: 'Cada empresa, en Integraciones', planned: 'Sin adaptador todavía' };

/** Centro de APIs de la plataforma (ADR 046) */
export function ApiCenter() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['api-center'], queryFn: () => api<Overview>('/platform/api-center'), staleTime: 0 });
  const [adding, setAdding] = useState(false);
  const [assign, setAssign] = useState<{ tenantId?: string; service?: 'ASSISTANT' | 'COMMERCIAL' } | null>(null);
  const [priceOf, setPriceOf] = useState<Model | null>(null);
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['api-center'] });
  const run = async (key: string, fn: () => Promise<unknown>, ok?: (r: unknown) => string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) toast.success(ok(r));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const tenantName = useMemo(() => (id: string) => q.data?.tenants.find((t) => t.id === id)?.name ?? id.slice(0, 8), [q.data]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const byCategory = Object.entries(d.catalog.reduce<Record<string, CatalogItem[]>>((acc, c) => ((acc[c.category] ??= []).push(c), acc), {}));

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-5">
        <h2 className="font-medium">Integraciones disponibles</h2>
        <p className="mb-3 text-sm text-muted">Cada integración necesita su adaptador: no basta con pegar una clave. Las marcadas «sin adaptador» todavía no se pueden conectar.</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {byCategory.map(([cat, items]) => (
            <div key={cat} className="rounded-lg border border-border p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{CATEGORY[cat] ?? cat}</p>
              <ul className="flex flex-col gap-1.5 text-sm">
                {items.map((c) => {
                  const n = d.credentials.filter((x) => x.provider === c.key && !x.disabledAt).length;
                  return (
                    <li key={c.key} className="flex items-start justify-between gap-2">
                      <span>{c.name}{c.note ? <span className="block text-xs text-muted">{c.note}</span> : null}</span>
                      {c.managedIn === 'center' ? <Badge tone={n ? 'success' : 'neutral'}>{n ? `${n} credencial(es)` : 'Sin credencial'}</Badge> : <Badge tone={c.managedIn === 'planned' ? 'neutral' : 'info'}>{WHERE[c.managedIn]}</Badge>}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-medium">Credenciales administradas</h2>
            <p className="text-sm text-muted">De la plataforma, asignables a las empresas. Las claves propias de cada empresa no se ven aquí.</p>
          </div>
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Agregar proveedor</Button>
        </div>
        {d.credentials.length ? (
          <CredentialsTable
            items={d.credentials}
            base="/platform/api-center/credentials"
            providers={d.providers}
            onChanged={refresh}
            extra={(c) => !c.disabledAt ? (
              <Button size="sm" variant="ghost" icon={<Download className="size-4" />} loading={busy === `models:${c.id}`} onClick={() => run(`models:${c.id}`, () => api<{ count: number }>(`/platform/api-center/credentials/${c.id}/models/refresh`, { method: 'POST' }), (r) => `${(r as { count: number }).count} modelo(s) leídos del proveedor`)} aria-label={`Leer modelos de ${c.label}`}>Leer modelos</Button>
            ) : null}
          />
        ) : <p className="text-sm text-muted">Aún no hay credenciales. Agrega la de Claude, Gemini, OpenAI o DeepSeek: se prueba con el proveedor antes de guardarse.</p>}
      </Card>

      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-medium">Asignación por empresa</h2>
            <p className="text-sm text-muted">Qué proveedor, credencial y modelo usa cada empresa. Un cambio de proveedor queda en la auditoría.</p>
          </div>
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAssign({})}>Asignar IA</Button>
        </div>
        {d.assignments.length ? (
          <Table>
            <thead><tr><Th>Empresa</Th><Th>Servicio</Th><Th>Proveedor · modelo</Th><Th>Credencial</Th><Th>Perfil y tope</Th><Th className="text-right">Acciones</Th></tr></thead>
            <tbody>
              {d.assignments.map((a) => (
                <tr key={a.id}>
                  <Td>{tenantName(a.tenantId)}</Td>
                  <Td>{SERVICE[a.service]}{!a.isActive && <div><Badge tone="danger">Desactivada</Badge></div>}</Td>
                  <Td>{a.provider} · <span className="font-mono text-xs">{a.model ?? '(modelo del servidor)'}</span>{a.fallbackModel ? <p className="text-xs text-muted">Respaldo: {a.fallbackModel}{a.allowCrossProviderFallback ? ' (otro proveedor, autorizado)' : ''}</p> : null}</Td>
                  <Td>{MODE_LABEL[a.mode]} · {a.credential.label} <span className="font-mono text-xs">{a.credential.secretHint}</span><div><Badge tone={CRED_STATUS[a.credential.status].tone}>{CRED_STATUS[a.credential.status].label}</Badge></div></Td>
                  <Td>{PROFILE_LABEL[a.profile] ?? a.profile}{a.monthlyTokenLimit ? ` · ${num(a.monthlyTokenLimit)} tokens/mes` : ''}</Td>
                  <Td className="text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} loading={busy === `test:${a.id}`} onClick={() => run(`test:${a.id}`, async () => {
                        const r = await api<{ ok: boolean; detail: string }>(`/platform/api-center/tenants/${a.tenantId}/ai/${a.service}/test`, { method: 'POST' });
                        if (!r.ok) throw new Error(r.detail);
                        return r;
                      }, (r) => (r as { detail: string }).detail)} aria-label={`Probar IA de ${tenantName(a.tenantId)}`}>Probar</Button>
                      <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setAssign({ tenantId: a.tenantId, service: a.service })}>Cambiar</Button>
                      <Button size="sm" variant="ghost" icon={<Power className="size-4" />} loading={busy === `toggle:${a.id}`} onClick={() => run(`toggle:${a.id}`, () => api(`/platform/api-center/tenants/${a.tenantId}/ai/${a.service}/${a.isActive ? 'disable' : 'enable'}`, { method: 'POST' }), () => (a.isActive ? 'Asignación desactivada' : 'Asignación activada'))}>{a.isActive ? 'Desactivar' : 'Activar'}</Button>
                      <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} loading={busy === `del:${a.id}`} onClick={() => run(`del:${a.id}`, () => api(`/platform/api-center/tenants/${a.tenantId}/ai/${a.service}`, { method: 'DELETE' }), () => 'Asignación quitada')} aria-label={`Quitar asignación de ${tenantName(a.tenantId)}`} />
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="text-sm text-muted">Ninguna empresa tiene IA asignada. Sin asignación, el asistente usa la clave de Gemini del servidor si existe.</p>}
      </Card>

      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-medium">Catálogo de modelos</h2>
            <p className="text-sm text-muted">Leídos de cada proveedor con «Leer modelos». Sin precio no se calcula costo.</p>
          </div>
          <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setManual(true)}>Agregar a mano</Button>
        </div>
        {d.models.length ? (
          <Table>
            <thead><tr><Th>Proveedor</Th><Th>Modelo</Th><Th>Origen</Th><Th className="text-right">Precio por millón (entrada / salida)</Th><Th>Estado</Th><Th className="text-right">Acciones</Th></tr></thead>
            <tbody>
              {d.models.map((m) => (
                <tr key={m.id}>
                  <Td>{m.provider}</Td>
                  <Td><span className="font-mono text-xs">{m.modelId}</span>{m.displayName ? <p className="text-xs text-muted">{m.displayName}{m.contextWindow ? ` · ${num(m.contextWindow)} tokens de contexto` : ''}</p> : null}</Td>
                  <Td className="text-xs">{m.source === 'PROVIDER' ? `Proveedor (${dateTime(m.lastSeenAt)})` : 'Manual'}</Td>
                  <Td className="text-right tabular-nums">{m.inputPricePerMTok && m.outputPricePerMTok ? `${m.inputPricePerMTok} / ${m.outputPricePerMTok} ${m.priceCurrency}` : <span className="text-muted">sin precio</span>}</Td>
                  <Td><Badge tone={m.isEnabled ? 'success' : 'neutral'}>{m.isEnabled ? 'Habilitado' : 'Deshabilitado'}</Badge></Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setPriceOf(m)}>Precio</Button>
                      <Button size="sm" variant="ghost" loading={busy === `model:${m.id}`} onClick={() => run(`model:${m.id}`, () => api(`/platform/api-center/models/${m.id}`, { method: 'PATCH', body: { isEnabled: !m.isEnabled } }))}>{m.isEnabled ? 'Deshabilitar' : 'Habilitar'}</Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="text-sm text-muted">Sin modelos todavía.</p>}
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 font-medium">Consumo de IA este mes</h2>
        <UsageTable usage={d.usage} tenantName={tenantName} />
      </Card>

      <CredentialDialog open={adding} onClose={() => setAdding(false)} providers={d.providers} endpoint="/platform/api-center/credentials" withLimit onSaved={refresh} />
      {assign && <AssignDialog d={d} initial={assign} onClose={() => setAssign(null)} onSaved={refresh} />}
      {priceOf && <PriceDialog m={priceOf} onClose={() => setPriceOf(null)} onSaved={refresh} />}
      {manual && <ManualModelDialog providers={d.providers} onClose={() => setManual(false)} onSaved={refresh} />}
    </div>
  );
}

function AssignDialog({ d, initial, onClose, onSaved }: { d: Overview; initial: { tenantId?: string; service?: 'ASSISTANT' | 'COMMERCIAL' }; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const current = d.assignments.find((a) => a.tenantId === initial.tenantId && a.service === initial.service);
  const [tenantId, setTenantId] = useState(initial.tenantId ?? '');
  const [service, setService] = useState<'ASSISTANT' | 'COMMERCIAL'>(initial.service ?? 'ASSISTANT');
  const creds = useQuery({ queryKey: ['api-center', 'tenant-creds', tenantId], enabled: !!tenantId, queryFn: () => api<{ id: string; tenantId: string | null; provider: string; label: string; secretHint: string; status: CredentialStatus }[]>(`/platform/api-center/tenants/${tenantId}/credentials`) });
  const [credentialId, setCredentialId] = useState('');
  const [model, setModel] = useState(current?.model ?? '');
  const [profile, setProfile] = useState(current?.profile ?? 'ECONOMY');
  const [maxTokens, setMaxTokens] = useState('2048');
  const [limit, setLimit] = useState(current?.monthlyTokenLimit ? String(current.monthlyTokenLimit) : '');
  const [fallbackId, setFallbackId] = useState('');
  const [fallbackModel, setFallbackModel] = useState('');
  const [cross, setCross] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const cred = creds.data?.find((c) => c.id === credentialId);
  const fb = creds.data?.find((c) => c.id === fallbackId);
  const modelsOf = (provider?: string) => d.models.filter((m) => m.provider === provider && m.isEnabled);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/platform/api-center/tenants/${tenantId}/ai/${service}`, {
        method: 'PUT',
        body: {
          credentialId, model, profile, ...(profile === 'CUSTOM' ? { params: { maxOutputTokens: Number(maxTokens) } } : {}), monthlyTokenLimit: limit ? Number(limit) : null,
          ...(fallbackId ? { fallbackCredentialId: fallbackId, fallbackModel, allowCrossProviderFallback: cross } : { fallbackCredentialId: null, fallbackModel: null }),
        },
      });
      toast.success('Asignación guardada. Pruébala con «Probar».');
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title="Asignar IA a una empresa" wide footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="assign-ai" loading={busy} disabled={!tenantId || !credentialId || !model}>Guardar</Button></>}>
      <form id="assign-ai" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><ErrorBox error={error ?? creds.error} /></div>
        <Field label="Empresa">
          <Select value={tenantId} onChange={(e) => { setTenantId(e.target.value); setCredentialId(''); setFallbackId(''); }} required>
            <option value="">Elige una empresa</option>
            {d.tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label="Servicio">
          <Select value={service} onChange={(e) => setService(e.target.value as 'ASSISTANT' | 'COMMERCIAL')}>
            {Object.entries(SERVICE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Credencial" hint="Administradas de la plataforma o claves propias de esa empresa">
          <Select value={credentialId} onChange={(e) => { setCredentialId(e.target.value); setModel(''); }} required disabled={!tenantId}>
            <option value="">Elige una credencial</option>
            {creds.data?.map((c) => <option key={c.id} value={c.id} disabled={c.status !== 'CONNECTED' && c.status !== 'CONNECTED_WITH_WARNINGS'}>{c.tenantId ? 'Propia' : 'Administrada'} · {c.label} {c.secretHint} ({CRED_STATUS[c.status].label})</option>)}
          </Select>
        </Field>
        <Field label="Modelo" hint={cred && !modelsOf(cred.provider).length ? 'Sin modelos de este proveedor en el catálogo: usa «Leer modelos»' : undefined}>
          <Select value={model} onChange={(e) => setModel(e.target.value)} required disabled={!cred}>
            <option value="">Elige un modelo</option>
            {modelsOf(cred?.provider).map((m) => <option key={m.id} value={m.modelId}>{m.displayName ? `${m.displayName} (${m.modelId})` : m.modelId}</option>)}
          </Select>
        </Field>
        <Field label="Perfil">
          <Select value={profile} onChange={(e) => setProfile(e.target.value)}>
            {Object.entries(PROFILE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
        {profile === 'CUSTOM' ? (
          <Field label="Máximo de tokens por respuesta"><Input type="number" min={256} max={16000} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} /></Field>
        ) : <div />}
        <Field label="Tope mensual de tokens de la empresa (opcional)"><Input type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)} /></Field>
        <div />
        <Field label="Respaldo (opcional)" hint="Se usa solo si el principal falla por un error temporal">
          <Select value={fallbackId} onChange={(e) => { setFallbackId(e.target.value); setFallbackModel(''); setCross(false); }} disabled={!cred}>
            <option value="">Sin respaldo</option>
            {creds.data?.filter((c) => c.id !== credentialId && c.tenantId === cred?.tenantId).map((c) => <option key={c.id} value={c.id}>{c.label} {c.secretHint} ({c.provider})</option>)}
          </Select>
        </Field>
        <Field label="Modelo del respaldo">
          <Select value={fallbackModel} onChange={(e) => setFallbackModel(e.target.value)} disabled={!fb} required={!!fb}>
            <option value="">Elige un modelo</option>
            {modelsOf(fb?.provider).map((m) => <option key={m.id} value={m.modelId}>{m.modelId}</option>)}
          </Select>
        </Field>
        {fb && cred && fb.provider !== cred.provider && (
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={cross} onChange={(e) => setCross(e.target.checked)} className="mt-1" />
            <span>Autorizo que, si {cred.provider} falla, los mensajes de esta empresa se envíen a <b>{fb.provider}</b> (otro proveedor). Sin esta autorización no se guarda.</span>
          </label>
        )}
      </form>
    </Dialog>
  );
}

function PriceDialog({ m, onClose, onSaved }: { m: Model; onClose: () => void; onSaved: () => void }) {
  const [input, setInput] = useState(m.inputPricePerMTok ?? '');
  const [output, setOutput] = useState(m.outputPricePerMTok ?? '');
  const [currency, setCurrency] = useState(m.priceCurrency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/platform/api-center/models/${m.id}`, { method: 'PATCH', body: { inputPricePerMTok: input.trim() || null, outputPricePerMTok: output.trim() || null, priceCurrency: currency } });
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title={`Precio de ${m.modelId}`} footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="price" loading={busy}>Guardar</Button></>}>
      <form id="price" onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-muted">Copia el precio de la página oficial de precios del proveedor. Vacío = sin precio (no se calcula costo).</p>
        <ErrorBox error={error} />
        <Field label="Entrada (por millón de tokens)"><Input inputMode="decimal" value={input} onChange={(e) => setInput(e.target.value)} /></Field>
        <Field label="Salida (por millón de tokens)"><Input inputMode="decimal" value={output} onChange={(e) => setOutput(e.target.value)} /></Field>
        <Field label="Moneda"><Input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></Field>
      </form>
    </Dialog>
  );
}

function ManualModelDialog({ providers, onClose, onSaved }: { providers: ProviderCard[]; onClose: () => void; onSaved: () => void }) {
  const [provider, setProvider] = useState(providers[0]?.key ?? '');
  const [modelId, setModelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/platform/api-center/models', { method: 'POST', body: { provider, modelId: modelId.trim() } });
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title="Agregar modelo a mano" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="manual-model" loading={busy} disabled={!modelId.trim()}>Agregar</Button></>}>
      <form id="manual-model" onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-muted">Solo si el proveedor no lo devuelve en su lista. Queda marcado como «Manual». Después de asignarlo, usa «Probar»: la prueba real confirma si el proveedor lo acepta.</p>
        <ErrorBox error={error} />
        <Field label="Proveedor"><Select value={provider} onChange={(e) => setProvider(e.target.value)}>{providers.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</Select></Field>
        <Field label="Identificador exacto del modelo"><Input value={modelId} onChange={(e) => setModelId(e.target.value)} /></Field>
      </form>
    </Dialog>
  );
}
