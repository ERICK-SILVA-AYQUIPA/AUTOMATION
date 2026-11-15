'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { DEPLOYMENT_MODE, MODULE_LABEL } from '@/lib/format';
import { Button, Dialog, ErrorBox, Field, Input, Select, Textarea } from '@/components/ui';

/** Tipos y textos del centro comercial (ADR 047) */
export type LeadStatus = 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'DEMO_REQUESTED' | 'QUOTE_SENT' | 'NEGOTIATION' | 'PAYMENT_PENDING' | 'PAYMENT_CONFIRMED' | 'INSTALLATION_PENDING' | 'ACTIVE_CLIENT' | 'LOST';
export interface Lead {
  id: string; number: number; name: string; company: string | null; phone: string | null; email: string | null; sector: string | null; need: string | null;
  source: string; sourceDetail: string | null; estimatedBudget: string | null; budgetCurrency: string; interestMode: string | null; interestPlan: string | null; interestModules: string[];
  status: LeadStatus; ownerId: string | null; owner: { id: string; name: string; email: string } | null; nextAction: string | null; nextActionAt: string | null;
  lostReason: string | null; tenantId: string | null; convertedAt: string | null; statusChangedAt: string; createdAt: string; updatedAt: string;
  followUpConsent?: boolean; followUpConsentAt?: string | null; followUpConsentSource?: string | null;
}
export interface Owner { id: string; name: string; email: string }

export const LEAD_STATUS: Record<LeadStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; hint?: string }> = {
  NEW: { label: 'Nuevo prospecto', tone: 'neutral' },
  CONTACTED: { label: 'Contactado', tone: 'info' },
  QUALIFIED: { label: 'Calificado', tone: 'info' },
  DEMO_REQUESTED: { label: 'Demostración solicitada', tone: 'info' },
  QUOTE_SENT: { label: 'Cotización enviada', tone: 'info' },
  NEGOTIATION: { label: 'Negociación', tone: 'warning' },
  PAYMENT_PENDING: { label: 'Pendiente de pago', tone: 'warning' },
  PAYMENT_CONFIRMED: { label: 'Pago confirmado', tone: 'success', hint: 'Solo con «Validar pago» (ingreso visto en la cuenta)' },
  INSTALLATION_PENDING: { label: 'Instalación pendiente', tone: 'success', hint: 'Al convertirlo en cliente (se crea su empresa)' },
  ACTIVE_CLIENT: { label: 'Cliente activo', tone: 'success', hint: 'Al activar su empresa' },
  LOST: { label: 'Perdido', tone: 'danger' },
};
export const STATUS_ORDER = Object.keys(LEAD_STATUS) as LeadStatus[];
export const MANUAL: LeadStatus[] = ['NEW', 'CONTACTED', 'QUALIFIED', 'DEMO_REQUESTED', 'QUOTE_SENT', 'NEGOTIATION', 'PAYMENT_PENDING', 'LOST'];
export const SOURCE: Record<string, string> = { WEBSITE: 'Página web', WHATSAPP: 'WhatsApp', REFERRAL: 'Recomendación', SOCIAL: 'Redes sociales', EVENT: 'Evento', OUTBOUND: 'Contacto directo', OTHER: 'Otra' };
export const SECTOR: Record<string, string> = { RETAIL: 'Tienda / comercio', RESTAURANT: 'Restaurante', DISTRIBUTOR: 'Distribuidora', SERVICES: 'Servicios', OTHER: 'Otro' };
export const PLAN: Record<string, string> = { BASIC: 'Básico', PROFESSIONAL: 'Profesional', ENTERPRISE: 'Empresarial' };
export const ACTIVITY: Record<string, string> = {
  CREATED: 'Prospecto registrado', NOTE: 'Nota', CALL: 'Llamada', WHATSAPP: 'WhatsApp', EMAIL: 'Correo', MEETING: 'Reunión', UPDATED: 'Datos modificados',
  STATUS_CHANGED: 'Cambio de etapa', OWNER_CHANGED: 'Cambio de responsable', NEXT_ACTION_SET: 'Próxima acción', NEXT_ACTION_DONE: 'Acción hecha',
  PAYMENT_VALIDATED: 'Pago validado', CONVERTED: 'Convertido en cliente', ACTIVATED: 'Empresa activada',
};
export const leadNo = (n: number) => `P-${String(n).padStart(4, '0')}`;
export const isOverdue = (l: Pick<Lead, 'nextActionAt' | 'status'>) => !!l.nextActionAt && new Date(l.nextActionAt) < new Date() && l.status !== 'ACTIVE_CLIENT' && l.status !== 'LOST';
/** datetime-local ⇄ ISO en la zona del navegador */
export const toLocalInput = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');

export function useOwners() {
  return useQuery({ queryKey: ['sales-owners'], queryFn: () => api<Owner[]>('/platform/sales/owners'), staleTime: 60_000 });
}

export interface LeadForm {
  name: string; company: string; phone: string; email: string; sector: string; need: string; source: string; sourceDetail: string;
  estimatedBudget: string; budgetCurrency: string; interestMode: string; interestPlan: string; interestModules: string[];
}
export const emptyForm = (): LeadForm => ({ name: '', company: '', phone: '', email: '', sector: '', need: '', source: 'WEBSITE', sourceDetail: '', estimatedBudget: '', budgetCurrency: 'PEN', interestMode: '', interestPlan: '', interestModules: [] });
export const formOf = (l: Lead): LeadForm => ({
  name: l.name, company: l.company ?? '', phone: l.phone ?? '', email: l.email ?? '', sector: l.sector ?? '', need: l.need ?? '', source: l.source, sourceDetail: l.sourceDetail ?? '',
  estimatedBudget: l.estimatedBudget ?? '', budgetCurrency: l.budgetCurrency, interestMode: l.interestMode ?? '', interestPlan: l.interestPlan ?? '', interestModules: l.interestModules,
});
export const payloadOf = (f: LeadForm) => {
  const n = (v: string) => (v.trim() ? v.trim() : null);
  return {
    name: f.name.trim(), company: n(f.company), phone: n(f.phone), email: n(f.email), sector: n(f.sector), need: n(f.need), source: f.source, sourceDetail: n(f.sourceDetail),
    estimatedBudget: n(f.estimatedBudget), budgetCurrency: f.budgetCurrency.trim().toUpperCase() || 'PEN', interestMode: n(f.interestMode), interestPlan: n(f.interestPlan), interestModules: f.interestModules,
  };
};

/** Campos del prospecto (alta y edición) */
export function LeadFields({ f, set }: { f: LeadForm; set: (p: Partial<LeadForm>) => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Nombre"><Input value={f.name} onChange={(e) => set({ name: e.target.value })} required maxLength={120} /></Field>
      <Field label="Empresa"><Input value={f.company} onChange={(e) => set({ company: e.target.value })} maxLength={160} /></Field>
      <Field label="Teléfono" hint="Con código de país, p. ej. +51 987 654 321"><Input value={f.phone} onChange={(e) => set({ phone: e.target.value })} inputMode="tel" maxLength={30} /></Field>
      <Field label="Correo"><Input type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} maxLength={200} /></Field>
      <Field label="Sector">
        <Select value={f.sector} onChange={(e) => set({ sector: e.target.value })}>
          <option value="">Sin indicar</option>
          {Object.entries(SECTOR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </Field>
      <Field label="Fuente de captación">
        <Select value={f.source} onChange={(e) => set({ source: e.target.value })}>
          {Object.entries(SOURCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </Field>
      <Field label="Detalle de la fuente (opcional)" hint="Campaña, quién lo recomendó, evento…"><Input value={f.sourceDetail} onChange={(e) => set({ sourceDetail: e.target.value })} maxLength={200} /></Field>
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <Field label="Presupuesto estimado"><Input inputMode="decimal" value={f.estimatedBudget} onChange={(e) => set({ estimatedBudget: e.target.value })} /></Field>
        <Field label="Moneda"><Input value={f.budgetCurrency} maxLength={3} onChange={(e) => set({ budgetCurrency: e.target.value.toUpperCase() })} /></Field>
      </div>
      <Field label="Necesidad" className="sm:col-span-2"><Textarea value={f.need} onChange={(e) => set({ need: e.target.value })} maxLength={4000} rows={3} /></Field>
      <Field label="Modalidad de interés">
        <Select value={f.interestMode} onChange={(e) => set({ interestMode: e.target.value })}>
          <option value="">Sin indicar</option>
          {Object.entries(DEPLOYMENT_MODE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </Field>
      <Field label="Plan de interés">
        <Select value={f.interestPlan} onChange={(e) => set({ interestPlan: e.target.value })}>
          <option value="">Sin indicar</option>
          {Object.entries(PLAN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </Field>
      <fieldset className="sm:col-span-2">
        <legend className="mb-1.5 text-sm font-medium">Módulos de interés</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {Object.entries(MODULE_LABEL).map(([k, v]) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" className="accent-[var(--primary)]" checked={f.interestModules.includes(k)} onChange={(e) => set({ interestModules: e.target.checked ? [...f.interestModules, k] : f.interestModules.filter((m) => m !== k) })} />
              {v}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

/** Pide el motivo antes de marcar un prospecto como perdido */
export function LostDialog({ lead, onClose, onDone }: { lead: Pick<Lead, 'id' | 'name'> | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!lead) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/platform/sales/leads/${lead.id}/status`, { method: 'POST', body: { status: 'LOST', lostReason: reason.trim() } });
      setReason('');
      onDone();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={!!lead} onClose={onClose} title={`Marcar como perdido: ${lead?.name ?? ''}`} footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="lost-form" variant="danger" loading={busy} disabled={!reason.trim()}>Marcar como perdido</Button></>}>
      <form id="lost-form" onSubmit={submit} className="flex flex-col gap-3">
        <ErrorBox error={error} />
        <Field label="Motivo de la pérdida" hint="Queda en el historial; se puede reabrir después"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required /></Field>
      </form>
    </Dialog>
  );
}

/** Coincidencias de un 409 DUPLICATE_LEAD */
export function duplicatesOf(err: unknown): { id: string; number: number; name: string; company: string | null; status: LeadStatus }[] | null {
  return err instanceof ApiError && err.code === 'DUPLICATE_LEAD' ? ((err.body?.matches as never) ?? []) : null;
}
