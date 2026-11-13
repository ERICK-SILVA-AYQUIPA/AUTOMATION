'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { MODULE_LABEL } from '@/lib/format';
import { Badge, Button, ErrorBox, Loading, Select } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import type { SectorTemplate } from './nueva/page';

type Section = 'modules' | 'settings' | 'automations' | 'ai' | 'categories';
interface Change { section: Section; field: string; from: unknown; to: unknown; note?: string }
interface Plan { template: { key: string; version: number; name: string }; current: { key: string | null; version: number | null }; changes: Change[]; blocked: Change[] }

const SECTION: Record<Section, { label: string; hint?: string }> = {
  modules: { label: 'Módulos' },
  settings: { label: 'Reglas de operación' },
  automations: { label: 'Automatizaciones' },
  ai: { label: 'Asistente IA', hint: 'Va al borrador: la empresa lo prueba y lo publica' },
  categories: { label: 'Categorías sugeridas', hint: 'Solo se crean las que faltan' },
};

const show = (v: unknown): string => {
  if (v == null) return '—';
  if (typeof v === 'boolean') return v ? 'sí' : 'no';
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'string' ? (MODULE_LABEL[x] ?? x) : JSON.stringify(x))).join(', ') : '(vacío)';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/**
 * Plantilla del sector de una empresa existente: primero se ve qué cambiaría
 * (con el estado real) y solo se aplican las secciones marcadas. Nada se
 * sobrescribe sin verlo antes.
 */
export function TemplateCard({ tenantId, businessType, onApplied }: { tenantId: string; businessType: string; onApplied: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const templates = useQuery({ queryKey: ['platform-templates'], queryFn: () => api<SectorTemplate[]>('/platform/templates') });
  const [key, setKey] = useState<string | null>(null);
  const chosen = key ?? templates.data?.find((t) => t.businessType === businessType)?.key ?? templates.data?.[0]?.key ?? '';
  const plan = useQuery({
    queryKey: ['platform-template-plan', tenantId, chosen],
    enabled: !!chosen,
    queryFn: () => api<Plan>(`/platform/tenants/${tenantId}/template`, { query: { key: chosen } }),
  });
  const [off, setOff] = useState<Section[]>([]);
  const [busy, setBusy] = useState(false);
  const p = plan.data;
  const sections = p ? ([...new Set(p.changes.map((c) => c.section))] as Section[]) : [];
  const selected = sections.filter((s) => !off.includes(s));

  async function apply() {
    setBusy(true);
    try {
      await api(`/platform/tenants/${tenantId}/template`, { method: 'POST', body: { key: chosen, sections: selected.length ? selected : ['settings'] } }); // sin cambios: solo registra la plantilla y su versión
      toast.success(`Plantilla «${p?.template.name}» aplicada`);
      setOff([]);
      await qc.invalidateQueries({ queryKey: ['platform-template-plan', tenantId] });
      onApplied();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Plantilla del sector</h3>
        {p && (p.current.key ? <Badge tone="info">Aplicada: {templates.data?.find((t) => t.key === p.current.key)?.name ?? p.current.key} v{p.current.version}</Badge> : <Badge>Sin plantilla</Badge>)}
      </div>
      <ErrorBox error={templates.error ?? plan.error} />
      <div className="mb-3 max-w-xs">
        <Select value={chosen} onChange={(e) => { setKey(e.target.value); setOff([]); }} aria-label="Plantilla">
          {templates.data?.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
        </Select>
      </div>
      {plan.isLoading ? <Loading /> : p && (
        <>
          {!p.changes.length ? (
            <p className="text-muted">La empresa ya coincide con esta plantilla{p.current.key === p.template.key && p.current.version !== p.template.version ? '; se registrará la versión nueva al aplicarla' : ''}.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {sections.map((s) => (
                <fieldset key={s} className="rounded-lg bg-surface-2/60 p-3">
                  <legend className="sr-only">{SECTION[s].label}</legend>
                  <label className="flex items-center gap-2 font-medium">
                    <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={!off.includes(s)} onChange={(e) => setOff(e.target.checked ? off.filter((x) => x !== s) : [...off, s])} />
                    {SECTION[s].label}
                    {SECTION[s].hint && <span className="text-xs font-normal text-muted">· {SECTION[s].hint}</span>}
                  </label>
                  <ul className="mt-2 flex flex-col gap-1 text-xs">
                    {p.changes.filter((c) => c.section === s).map((c) => (
                      <li key={c.field} className="break-words">
                        <span className="font-medium">{c.field}</span>
                        {s === 'categories' ? ' (nueva)' : <>: <span className="text-muted line-through">{show(c.from)}</span> → {show(c.to)}</>}
                      </li>
                    ))}
                  </ul>
                </fieldset>
              ))}
            </div>
          )}
          {p.blocked.length > 0 && (
            <div className="mt-3 text-xs">
              <p className="font-medium">No se aplicará:</p>
              <ul className="text-muted">{p.blocked.map((b) => <li key={b.field}>{b.field}: {b.note}</li>)}</ul>
            </div>
          )}
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" loading={busy} disabled={!p.changes.length ? p.current.key === p.template.key && p.current.version === p.template.version : !selected.length} onClick={apply}>
              Aplicar {selected.length && selected.length < sections.length ? 'lo marcado' : 'plantilla'}
            </Button>
            <span className="text-xs text-muted">Queda registrado en la auditoría. Los ajustes que no estén marcados no se tocan.</span>
          </div>
        </>
      )}
    </div>
  );
}
