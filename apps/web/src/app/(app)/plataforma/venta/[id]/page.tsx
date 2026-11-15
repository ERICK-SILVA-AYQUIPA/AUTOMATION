'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Ban, Check, Circle, CircleDot, MinusCircle } from 'lucide-react';
import Link from 'next/link';
import { use } from 'react';
import { RequirePermission } from '@/components/guard';
import { Badge, Card, ErrorBox, Loading, PageHeader, cn } from '@/components/ui';
import { api } from '@/lib/api';
import { leadNo } from '../../ventas/shared';
import type { Journey, StepState } from '../shared';

const STATE: Record<StepState, { label: string; tone: 'success' | 'info' | 'neutral' | 'warning' }> = {
  done: { label: 'Hecho', tone: 'success' }, current: { label: 'Paso actual', tone: 'info' }, pending: { label: 'Pendiente', tone: 'warning' },
  blocked: { label: 'Espera el pago', tone: 'neutral' }, skipped: { label: 'No aplica', tone: 'neutral' },
};
const ICON: Record<StepState, React.ReactNode> = {
  done: <Check className="size-4 text-success" />, current: <CircleDot className="size-4 text-primary" />, pending: <Circle className="size-4 text-warning" />,
  blocked: <Ban className="size-4 text-muted" />, skipped: <MinusCircle className="size-4 text-muted" />,
};

function Wizard({ id }: { id: string }) {
  // Se actualiza solo mientras avanza la instalación o se valida el pago
  const q = useQuery({ queryKey: ['journey', id], queryFn: () => api<Journey>(`/platform/journey/${id}`), refetchInterval: 15_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const j = q.data!;
  const pct = Math.round((j.done / j.steps.length) * 100);
  return (
    <div className="flex flex-col gap-6">
      <Link href="/plataforma/venta" className="flex items-center gap-1 text-sm text-muted"><ArrowLeft className="size-4" />Nueva venta e instalación</Link>
      <PageHeader title={`Venta e instalación · ${j.lead.company ?? j.lead.name}`} description={`${leadNo(j.lead.number)}${j.tenant ? ` · empresa ${j.tenant.name}` : ''}`} />
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-sm"><span>{j.done === j.steps.length ? 'Venta entregada' : `Paso ${j.current} de ${j.steps.length}`}</span><span className="text-muted">{j.done} de {j.steps.length} pasos completos</span></div>
        <div className="h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="Progreso de la venta" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><div className="h-full bg-primary" style={{ width: `${pct}%` }} /></div>
      </div>
      <ol className="flex flex-col gap-3" aria-label="Pasos de la venta">
        {j.steps.map((s) => (
          <li key={s.key} aria-current={s.state === 'current' ? 'step' : undefined}>
            <Card className={cn('flex flex-col gap-2 p-4 text-sm', s.state === 'current' && 'border-primary/60', (s.state === 'blocked' || s.state === 'skipped') && 'opacity-70')}>
              <div className="flex flex-wrap items-center gap-2">
                {ICON[s.state]}
                <h2 className="font-medium">Paso {s.n}: {s.title}</h2>
                <Badge tone={STATE[s.state].tone}>{STATE[s.state].label}</Badge>
                {s.action && s.state !== 'blocked' && (
                  <Link href={s.action.href} className={cn('ml-auto inline-flex h-8 items-center rounded-lg px-3 text-sm', s.state === 'current' ? 'bg-primary font-medium text-primary-fg hover:opacity-90' : 'border border-border hover:bg-surface-2')}>{s.action.label}</Link>
                )}
              </div>
              <p className="text-muted">{s.detail}</p>
              {s.missing.length > 0 && s.state !== 'done' && (
                <ul className="flex flex-col gap-0.5" aria-label={`Falta en el paso ${s.n}`}>
                  {s.missing.map((m) => <li key={m} className="text-warning">• {m}</li>)}
                </ul>
              )}
            </Card>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function SaleWizardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequirePermission permission="platform:manage"><Wizard id={id} /></RequirePermission>;
}
