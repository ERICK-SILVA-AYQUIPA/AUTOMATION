'use client';

import { useState } from 'react';
import { PlugZap, RefreshCw, RotateCcw, Trash2, Unplug } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { dateTime, num } from '@/lib/format';
import { Badge, Button, Dialog, ErrorBox, Field, Input, Select, Table, Td, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';

/** Tipos compartidos del Centro de APIs (ADR 046) */
export type CredentialStatus = 'CONNECTED' | 'CONNECTED_WITH_WARNINGS' | 'AUTH_ERROR' | 'PERMISSION_DENIED' | 'UNAVAILABLE' | 'INCOMPLETE' | 'PENDING_AUTHORIZATION' | 'DISABLED';
export interface ProviderCard { key: string; name: string; fields: { key: string; label: string; secret: boolean; required: boolean; hint: string | null }[] }
export interface Credential {
  id: string; tenantId: string | null; provider: string; label: string; config: Record<string, string>; secretHint: string; status: CredentialStatus;
  lastError: string | null; lastCheckedAt: string | null; connectedAt: string | null; rotatedAt: string | null; disabledAt: string | null; monthlyTokenLimit: number | null;
}
export interface UsageRow { tenantId?: string; provider: string; model: string; mode: string; service: string; calls: number; inputTokens: number; outputTokens: number; cost: string | null; costCurrency: string | null }
export interface Usage { since: string; errors: number; unpricedCalls: number; rows: UsageRow[] }

export const CRED_STATUS: Record<CredentialStatus, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }> = {
  CONNECTED: { label: 'Conectado', tone: 'success' },
  CONNECTED_WITH_WARNINGS: { label: 'Conectado con advertencias', tone: 'warning' },
  AUTH_ERROR: { label: 'Error de autenticación', tone: 'danger' },
  PERMISSION_DENIED: { label: 'Sin permisos', tone: 'danger' },
  UNAVAILABLE: { label: 'Servicio no disponible', tone: 'warning' },
  INCOMPLETE: { label: 'Configuración incompleta', tone: 'neutral' },
  PENDING_AUTHORIZATION: { label: 'Pendiente de autorización', tone: 'info' },
  DISABLED: { label: 'Desconectado', tone: 'neutral' },
};
export const MODE_LABEL: Record<string, string> = { MANAGED: 'Administrada', OWN: 'Clave propia', SERVER: 'Clave del servidor' };
export const PROFILE_LABEL: Record<string, string> = { ECONOMY: 'Económico', ADVANCED: 'Avanzado', CUSTOM: 'Personalizado' };

export function StatusBadge({ s }: { s: CredentialStatus }) {
  const x = CRED_STATUS[s];
  return <Badge tone={x.tone}>{x.label}</Badge>;
}

/**
 * Formulario universal: solo los campos que pide el proveedor elegido. Los
 * secretos se escriben una vez; la API los valida con el proveedor y después
 * solo devuelve sus últimos caracteres.
 */
export function CredentialDialog({ open, onClose, providers, endpoint, rotate, withLimit, onSaved }: {
  open: boolean; onClose: () => void; providers: ProviderCard[];
  /** POST de creación (o de rotación si `rotate`) */
  endpoint: string; rotate?: Credential; withLimit?: boolean; onSaved: () => void;
}) {
  const toast = useToast();
  const [provider, setProvider] = useState(rotate?.provider ?? providers[0]?.key ?? '');
  const [label, setLabel] = useState('');
  const [values, setValues] = useState<Record<string, string>>(rotate ? { ...rotate.config } : {});
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const card = providers.find((p) => p.key === provider);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fields = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
    try {
      const r = await api<{ secretHint: string; check: { detail: string } }>(endpoint, {
        method: 'POST',
        body: rotate ? { fields } : { provider, ...(label.trim() ? { label: label.trim() } : {}), fields, ...(withLimit && limit ? { monthlyTokenLimit: Number(limit) } : {}) },
      });
      toast.success(`${card?.name ?? 'El proveedor'} aceptó la credencial (${r.secretHint}). ${r.check.detail}`);
      setValues({});
      setLabel('');
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title={rotate ? `Rotar credencial: ${rotate.label}` : 'Conectar credencial'} footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="credential-form" loading={busy} icon={<PlugZap className="size-4" />}>Probar y guardar</Button></>}>
      <form id="credential-form" onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-muted">Antes de guardarla se hace una petición real al proveedor. Se guarda cifrada y después solo verás sus últimos 4 caracteres.</p>
        <ErrorBox error={error} />
        {!rotate && (
          <>
            <Field label="Proveedor">
              <Select value={provider} onChange={(e) => { setProvider(e.target.value); setValues({}); }}>
                {providers.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
              </Select>
            </Field>
            <Field label="Nombre (para reconocerla)" hint={card?.name}>
              <Input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder={card?.name} />
            </Field>
          </>
        )}
        {card?.fields.map((f) => (
          <Field key={f.key} label={`${f.label}${f.required ? '' : ' (opcional)'}`} hint={f.hint ?? undefined}>
            <Input type={f.secret ? 'password' : 'text'} autoComplete="off" value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} required={f.required} aria-label={f.label} />
          </Field>
        ))}
        {withLimit && !rotate && (
          <Field label="Tope mensual de tokens (opcional)" hint="Suma de todas las empresas que usen esta credencial">
            <Input type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)} />
          </Field>
        )}
      </form>
    </Dialog>
  );
}

/** Tabla de credenciales con Probar, Rotar, Desconectar y Eliminar (acciones reales de la API) */
export function CredentialsTable({ items, base, providers, onChanged, extra }: {
  items: Credential[]; base: string; providers: ProviderCard[]; onChanged: () => void;
  extra?: (c: Credential) => React.ReactNode;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [rotating, setRotating] = useState<Credential | null>(null);
  const [confirm, setConfirm] = useState<{ c: Credential; kind: 'disable' | 'delete' } | null>(null);
  const name = (k: string) => providers.find((p) => p.key === k)?.name ?? k;
  async function act(c: Credential, kind: 'test' | 'disable' | 'delete') {
    setBusy(`${c.id}:${kind}`);
    try {
      if (kind === 'test') {
        const r = await api<{ status: CredentialStatus; detail: string }>(`${base}/${c.id}/test`, { method: 'POST' });
        if (r.status === 'CONNECTED') toast.success(r.detail);
        else toast.error(`${CRED_STATUS[r.status].label}: ${r.detail}`);
      } else if (kind === 'disable') {
        const r = await api<{ assignmentsDeactivated: number }>(`${base}/${c.id}/disable`, { method: 'POST' });
        toast.success(`Desconectada. ${r.assignmentsDeactivated} asignación(es) desactivada(s).`);
      } else {
        await api(`${base}/${c.id}`, { method: 'DELETE' });
        toast.success('Credencial eliminada');
      }
      setConfirm(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : err);
    } finally {
      setBusy(null);
      onChanged();
    }
  }
  return (
    <>
      <Table>
        <thead>
          <tr><Th>Credencial</Th><Th>Proveedor</Th><Th>Estado</Th><Th>Última prueba</Th><Th className="text-right">Acciones</Th></tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <Td>
                <p className="font-medium">{c.label}</p>
                <p className="font-mono text-xs text-muted">{c.secretHint}{Object.keys(c.config).length ? ` · ${Object.values(c.config).join(' · ')}` : ''}</p>
                {c.monthlyTokenLimit ? <p className="text-xs text-muted">Tope: {num(c.monthlyTokenLimit)} tokens/mes</p> : null}
              </Td>
              <Td>{name(c.provider)}</Td>
              <Td>
                <StatusBadge s={c.status} />
                {c.lastError && c.status !== 'CONNECTED' ? <p className="mt-1 max-w-xs text-xs text-danger">{c.lastError}</p> : null}
              </Td>
              <Td className="text-xs text-muted">{dateTime(c.lastCheckedAt)}{c.rotatedAt ? <><br />Rotada {dateTime(c.rotatedAt)}</> : null}</Td>
              <Td className="text-right">
                <div className="flex flex-wrap justify-end gap-1">
                  {extra?.(c)}
                  {!c.disabledAt && <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} loading={busy === `${c.id}:test`} onClick={() => act(c, 'test')} aria-label={`Probar ${c.label}`}>Probar</Button>}
                  <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => setRotating(c)} aria-label={`Rotar ${c.label}`}>Rotar</Button>
                  {!c.disabledAt && <Button size="sm" variant="ghost" icon={<Unplug className="size-4" />} onClick={() => setConfirm({ c, kind: 'disable' })} aria-label={`Desconectar ${c.label}`}>Desconectar</Button>}
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setConfirm({ c, kind: 'delete' })} aria-label={`Eliminar ${c.label}`} />
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {rotating && <CredentialDialog open onClose={() => setRotating(null)} providers={providers} endpoint={`${base}/${rotating.id}/rotate`} rotate={rotating} onSaved={onChanged} />}
      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === 'disable' ? `¿Desconectar ${confirm.c.label}?` : `¿Eliminar ${confirm?.c.label}?`}
        footer={<><Button variant="secondary" onClick={() => setConfirm(null)}>Cancelar</Button><Button variant="danger" loading={!!busy} onClick={() => confirm && act(confirm.c, confirm.kind)}>{confirm?.kind === 'disable' ? 'Desconectar' : 'Eliminar'}</Button></>}
      >
        <p className="text-sm text-muted">
          {confirm?.kind === 'disable'
            ? 'Deja de usarse en el acto. Las empresas que la usan se quedan sin IA (se les avisa y sus conversaciones pasan a su equipo) hasta que se les asigne otra. No se cambia de proveedor por su cuenta.'
            : 'Se borra de la bóveda. Solo se puede si ninguna asignación la usa.'}
        </p>
      </Dialog>
    </>
  );
}

/** Consumo del mes (el costo solo aparece si el modelo tiene precio en el catálogo) */
export function UsageTable({ usage, tenantName }: { usage: Usage; tenantName?: (id: string) => string }) {
  if (!usage.rows.length) return <p className="text-sm text-muted">Sin consumo de IA este mes.</p>;
  return (
    <>
      <Table>
        <thead>
          <tr>{tenantName && <Th>Empresa</Th>}<Th>Proveedor · modelo</Th><Th>Credencial</Th><Th className="text-right">Llamadas</Th><Th className="text-right">Tokens (entrada / salida)</Th><Th className="text-right">Costo</Th></tr>
        </thead>
        <tbody>
          {usage.rows.map((r, i) => (
            <tr key={i}>
              {tenantName && <Td>{tenantName(r.tenantId ?? '')}</Td>}
              <Td>{r.provider} · <span className="font-mono text-xs">{r.model}</span></Td>
              <Td>{MODE_LABEL[r.mode] ?? r.mode}</Td>
              <Td className="text-right tabular-nums">{num(r.calls)}</Td>
              <Td className="text-right tabular-nums">{num(r.inputTokens)} / {num(r.outputTokens)}</Td>
              <Td className="text-right tabular-nums">{r.cost !== null ? `${Number(r.cost).toFixed(4)} ${r.costCurrency ?? ''}` : <span className="text-muted">sin precio</span>}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="mt-2 text-xs text-muted">
        Desde {dateTime(usage.since)} · {num(usage.errors)} llamada(s) con error
        {usage.unpricedCalls ? ` · ${num(usage.unpricedCalls)} llamada(s) sin precio configurado: el costo total está incompleto` : ''}
      </p>
    </>
  );
}

