'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Button, Card, Dialog, ErrorBox, Field, Input, Loading, Select, Textarea } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { PAYMENT_METHOD, dateTime } from '@/lib/format';
import type { PaymentMethodConfig } from './shared';

interface Settings { legalName: string | null; taxId: string | null; address: string | null; taxName: string | null; taxRate: string | null; pricesIncludeTax: boolean; quoteValidityDays: number; quoteTerms: string | null; contactEmail: string | null }
interface Contract { id: string; version: number; title: string; body: string; createdAt: string }

const errorsOf = (e: unknown) => (e instanceof ApiError && e.errors?.length ? Object.fromEntries(e.errors.map((x) => [x.path.split('.')[0]!, x.message])) : {});
const list = (v: string) => v.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

/** Emisor, impuestos, condiciones, métodos de pago y versiones del contrato */
export function SettingsTab() {
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <IssuerCard />
      <div className="flex flex-col gap-6">
        <MethodsCard />
        <ContractsCard />
      </div>
    </div>
  );
}

function IssuerCard() {
  const q = useQuery({ queryKey: ['commerce-settings'], queryFn: () => api<Settings>('/platform/commerce/settings') });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return <IssuerForm key={JSON.stringify(q.data)} s={q.data!} />;
}

function IssuerForm({ s }: { s: Settings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ legalName: s.legalName ?? '', taxId: s.taxId ?? '', address: s.address ?? '', taxName: s.taxName ?? '', taxRate: s.taxRate ?? '', pricesIncludeTax: s.pricesIncludeTax, quoteValidityDays: String(s.quoteValidityDays), quoteTerms: s.quoteTerms ?? '' });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<Settings>('/platform/commerce/settings', { method: 'PUT', body: { ...f, taxRate: f.taxRate.trim() || null, quoteValidityDays: Number(f.quoteValidityDays) } });
      setErrors({});
      qc.setQueryData(['commerce-settings'], r);
      toast.success('Configuración guardada');
    } catch (err) {
      setErrors(errorsOf(err));
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="p-5">
      <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Emisor e impuestos">
        <h2 className="font-semibold">Emisor, impuestos y condiciones</h2>
        <p className="text-sm text-muted">Aparecen en cada cotización enviada y en su PDF. Una cotización enviada conserva los datos con los que salió.</p>
        <Field label="Razón social" error={errors.legalName}><Input value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} maxLength={200} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="RUC / ID fiscal" error={errors.taxId}><Input value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value })} maxLength={30} /></Field>
          <Field label="Vigencia por defecto (días)" error={errors.quoteValidityDays}><Input type="number" min={1} max={180} value={f.quoteValidityDays} onChange={(e) => setF({ ...f, quoteValidityDays: e.target.value })} required /></Field>
        </div>
        <Field label="Dirección" error={errors.address}><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} maxLength={300} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Impuesto (nombre)" hint="Ej.: IGV. Vacío si no aplica." error={errors.taxName}><Input value={f.taxName} onChange={(e) => setF({ ...f, taxName: e.target.value })} maxLength={30} /></Field>
          <Field label="Tasa (%)" error={errors.taxRate}><Input inputMode="decimal" value={f.taxRate} onChange={(e) => setF({ ...f, taxRate: e.target.value })} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.pricesIncludeTax} onChange={(e) => setF({ ...f, pricesIncludeTax: e.target.checked })} />Los precios del catálogo ya incluyen el impuesto</label>
        <Field label="Condiciones generales" hint="Se usan cuando la cotización no trae condiciones propias." error={errors.quoteTerms}><Textarea value={f.quoteTerms} onChange={(e) => setF({ ...f, quoteTerms: e.target.value })} maxLength={10000} rows={6} /></Field>
        <p className="text-xs text-muted">Correo y WhatsApp del emisor se toman de la Página comercial{s.contactEmail ? ` (${s.contactEmail})` : ''}.</p>
        <Button type="submit" className="self-start" loading={busy} icon={<Save className="size-4" />}>Guardar</Button>
      </form>
    </Card>
  );
}

type MethodForm = { kind: string; name: string; instructions: string; countries: string; currencies: string; isActive: boolean; sort: string };

function MethodsCard() {
  const q = useQuery({ queryKey: ['commerce-methods'], queryFn: () => api<PaymentMethodConfig[]>('/platform/commerce/payment-methods') });
  const [edit, setEdit] = useState<{ id: string | null; f: MethodForm } | null>(null);
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Métodos de pago</h2>
        <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEdit({ id: null, f: { kind: 'YAPE', name: '', instructions: '', countries: 'PE', currencies: 'PEN', isActive: true, sort: '0' } })}>Agregar</Button>
      </div>
      <p className="text-sm text-muted">El cliente ve los métodos activos que corresponden al país y la moneda de su orden. Los cobros automáticos con pasarela no están activados: cada pago se valida a mano viendo el ingreso en la cuenta.</p>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? <p className="text-sm text-muted">Sin métodos: el cliente no verá cómo pagar hasta que agregues al menos uno.</p> : (
        <ul className="flex flex-col gap-2">
          {q.data!.map((m) => (
            <li key={m.id} className="flex items-start justify-between gap-3 rounded-lg border border-border p-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium">{m.name} <span className="text-xs font-normal text-muted">· {PAYMENT_METHOD[m.kind] ?? m.kind}</span> {!m.isActive && <Badge>Inactivo</Badge>}</p>
                <p className="text-xs text-muted">{m.countries.length ? m.countries.join(', ') : 'Todos los países'} · {m.currencies.length ? m.currencies.join(', ') : 'todas las monedas'}</p>
                <p className="mt-1 line-clamp-2 whitespace-pre-line text-xs">{m.instructions}</p>
              </div>
              <Button size="sm" variant="ghost" aria-label={`Editar ${m.name}`} onClick={() => setEdit({ id: m.id, f: { kind: m.kind, name: m.name, instructions: m.instructions, countries: m.countries.join(', '), currencies: m.currencies.join(', '), isActive: m.isActive, sort: String(m.sort) } })}>Editar</Button>
            </li>
          ))}
        </ul>
      )}
      {edit && <MethodDialog id={edit.id} initial={edit.f} onClose={() => setEdit(null)} />}
    </Card>
  );
}

function MethodDialog({ id, initial, onClose }: { id: string | null; initial: MethodForm; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(id ? `/platform/commerce/payment-methods/${id}` : '/platform/commerce/payment-methods', { method: id ? 'PUT' : 'POST', body: { ...f, countries: list(f.countries), currencies: list(f.currencies), sort: Number(f.sort) || 0 } });
      toast.success('Método de pago guardado');
      void qc.invalidateQueries({ queryKey: ['commerce-methods'] });
      onClose();
    } catch (err) {
      setErrors(errorsOf(err));
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title={id ? 'Editar método de pago' : 'Nuevo método de pago'} footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="method-form" loading={busy}>Guardar</Button></>}>
      <form id="method-form" onSubmit={submit} className="flex flex-col gap-4">
        <ErrorBox error={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tipo">
            <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              {Object.entries(PAYMENT_METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Nombre visible" error={errors.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} required placeholder="Ej.: Transferencia BCP" /></Field>
        </div>
        <Field label="Datos para pagar" hint="Número de Yape, titular, banco, cuenta y CCI… Lo verá el cliente en su orden." error={errors.instructions}>
          <Textarea value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} maxLength={4000} rows={5} required />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Países (códigos, separados por coma)" hint="Vacío: todos" error={errors.countries}><Input value={f.countries} onChange={(e) => setF({ ...f, countries: e.target.value })} placeholder="PE, CO" /></Field>
          <Field label="Monedas" hint="Vacío: todas" error={errors.currencies}><Input value={f.currencies} onChange={(e) => setF({ ...f, currencies: e.target.value })} placeholder="PEN, USD" /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Orden"><Input type="number" min={0} max={10000} value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} /></Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />Activo</label>
        </div>
      </form>
    </Dialog>
  );
}

function ContractsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['commerce-contracts'], queryFn: () => api<Contract[]>('/platform/commerce/contracts') });
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null);
  const [view, setView] = useState<Contract | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    try {
      const c = await api<Contract>('/platform/commerce/contracts', { method: 'POST', body: draft });
      toast.success(`Contrato versión ${c.version} registrado`);
      setDraft(null);
      setErrors({});
      void qc.invalidateQueries({ queryKey: ['commerce-contracts'] });
    } catch (err) {
      setErrors(errorsOf(err));
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }
  const last = q.data?.[0];
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Contrato</h2>
        {!draft && <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setDraft({ title: last?.title ?? 'Contrato de servicio', body: last?.body ?? '' })}>Nueva versión</Button>}
      </div>
      <p className="text-sm text-muted">Las versiones no se editan ni se borran. Cada cotización enviada usa la versión vigente al enviarla, y la aceptación registra cuál aceptó el cliente.</p>
      {draft && (
        <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-border p-3" aria-label="Nueva versión del contrato">
          <Field label="Título" error={errors.title}><Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={160} required /></Field>
          <Field label="Texto completo" error={errors.body}><Textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} maxLength={100000} rows={12} required /></Field>
          <div className="flex gap-2">
            <Button type="submit" loading={busy}>Registrar versión {(last?.version ?? 0) + 1}</Button>
            <Button variant="secondary" onClick={() => setDraft(null)}>Cancelar</Button>
          </div>
        </form>
      )}
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? <p className="text-sm text-muted">Sin contrato registrado: no se puede enviar ninguna cotización hasta registrar la primera versión.</p> : (
        <ul className="flex flex-col gap-1 text-sm">
          {q.data!.map((c, i) => (
            <li key={c.id} className="flex items-center justify-between gap-2">
              <span>Versión {c.version} · {c.title} <span className="text-xs text-muted">· {dateTime(c.createdAt)}</span> {i === 0 && <Badge tone="success">Vigente</Badge>}</span>
              <Button size="sm" variant="ghost" onClick={() => setView(c)}>Ver</Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={!!view} onClose={() => setView(null)} wide title={view ? `Versión ${view.version} · ${view.title}` : ''}>
        <p className="whitespace-pre-line text-sm">{view?.body}</p>
      </Dialog>
    </Card>
  );
}
