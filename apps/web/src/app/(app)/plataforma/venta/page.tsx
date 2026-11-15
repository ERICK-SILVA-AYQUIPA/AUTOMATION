'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { RequirePermission } from '@/components/guard';
import { Badge, Button, Card, EmptyState, ErrorBox, Input, Loading, PageHeader } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { NewLeadDialog } from '../ventas/new-lead';
import { LEAD_STATUS, leadNo, type Lead } from '../ventas/shared';
import type { OpenSale } from './shared';

/** Paso 1 del asistente: seleccionar o registrar el cliente; y las ventas en curso */
function Start() {
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const term = q.trim();
  const found = useQuery({ queryKey: ['journey-search', term], queryFn: () => api<{ items: Lead[] }>('/platform/sales/leads', { query: { q: term, page: 1 } }), enabled: term.length >= 2 });
  const open = useQuery({ queryKey: ['journey-open'], queryFn: () => api<OpenSale[]>('/platform/journey') });
  const go = (id: string) => router.push(`/plataforma/venta/${id}`);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Nueva venta e instalación" description="Un asistente de 12 pasos, del cliente a la entrega. Cada paso se calcula con los datos reales y dice qué falta y dónde se hace." />
      <Card className="flex flex-col gap-3 p-5">
        <h2 className="font-semibold">Paso 1: seleccionar o registrar cliente</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input className="pl-9" placeholder="Buscar prospecto por nombre, empresa, correo o teléfono" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar prospecto" />
          </div>
          <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Registrar cliente nuevo</Button>
        </div>
        <ErrorBox error={found.error} />
        {term.length >= 2 && found.data && (
          found.data.items.length ? (
            <ul className="flex flex-col gap-1" aria-label="Prospectos encontrados">
              {found.data.items.slice(0, 10).map((l) => (
                <li key={l.id}>
                  <button type="button" onClick={() => go(l.id)} className="flex w-full items-center gap-2 rounded-lg border border-border p-2 text-left text-sm hover:bg-surface-2">
                    <span className="font-mono text-xs text-muted">{leadNo(l.number)}</span>
                    <span className="font-medium">{l.company ?? l.name}</span>
                    <span className="text-muted">{l.email ?? l.phone ?? ''}</span>
                    <Badge tone={LEAD_STATUS[l.status]?.tone}>{LEAD_STATUS[l.status]?.label ?? l.status}</Badge>
                    <ArrowRight className="ml-auto size-4 text-muted" />
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">Sin coincidencias: registra al cliente nuevo.</p>
        )}
      </Card>
      <Card className="flex flex-col gap-3 p-5">
        <h2 className="font-semibold">Ventas en curso</h2>
        <ErrorBox error={open.error} />
        {open.isLoading ? <Loading /> : !open.data?.length ? <EmptyState title="Sin ventas en curso" description="Aparecen aquí los prospectos calificados que aún no se entregan." /> : (
          <ul className="flex flex-col gap-2" aria-label="Ventas en curso">
            {open.data.map((s) => (
              <li key={s.leadId}>
                <Link href={`/plataforma/venta/${s.leadId}`} className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-3">
                  <span className="font-medium">{leadNo(s.number)} · {s.name}</span>
                  <span className="text-muted">Paso {s.current} de {s.total}: {s.step}</span>
                  {s.missing && <span className="text-xs text-warning">Falta: {s.missing}</span>}
                  <span className="ml-auto h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-surface-2" aria-hidden><span className="block h-full bg-primary" style={{ width: `${Math.round((s.done / s.total) * 100)}%` }} /></span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <NewLeadDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); toast.success('Prospecto registrado'); go(id); }} />
    </div>
  );
}

export default function NewSalePage() {
  return <RequirePermission permission="platform:manage"><Start /></RequirePermission>;
}
