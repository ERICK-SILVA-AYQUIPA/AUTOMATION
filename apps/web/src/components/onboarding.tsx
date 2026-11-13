'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, Rocket } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Card, cn } from '@/components/ui';

export interface OnboardingTask { key: string; label: string; done: boolean; required: boolean; hint: string }
export interface Onboarding { status: 'ACTIVE' | 'SUSPENDED' | 'ONBOARDING'; activatedAt: string | null; tasks: OnboardingTask[]; canActivate: boolean }

/** Dónde hace la empresa cada tarea (solo en su propio panel) */
const TENANT_LINK: Record<string, string> = {
  profile: '/configuracion', whatsapp_verified: '/integraciones', whatsapp_webhook: '/integraciones', catalog: '/productos', ai_settings: '/asistente',
};

/** Lista de puesta en marcha calculada por la API: nada se marca a mano. */
export function OnboardingTasks({ tasks, links = false }: { tasks: OnboardingTask[]; links?: boolean }) {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {tasks.map((t) => {
        const href = links && !t.done ? TENANT_LINK[t.key] : undefined;
        return (
          <li key={t.key} className="flex items-start gap-2">
            {t.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Hecho" /> : <Circle className={cn('mt-0.5 size-4 shrink-0', t.required ? 'text-warning' : 'text-muted')} aria-label="Pendiente" />}
            <span>
              {href ? <Link href={href} className="hover:underline">{t.label}</Link> : t.label}
              {!t.required && <span className="text-muted"> (recomendado)</span>}
              {!t.done && t.hint && <span className="block text-xs text-muted">{t.hint}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Tarjeta de Inicio para una empresa dada de alta por la plataforma que aún no está activa. */
export function OnboardingCard() {
  const { me } = useAuth();
  const onboarding = me?.tenant?.status === 'ONBOARDING';
  const q = useQuery({ queryKey: ['tenant-onboarding'], queryFn: () => api<Onboarding>('/tenant/onboarding'), enabled: onboarding, refetchInterval: 60_000 });
  if (!onboarding || !q.data) return null;
  const pending = q.data.tasks.filter((t) => t.required && !t.done).length;
  return (
    <Card className="mb-6 flex flex-col gap-3 border-primary/30 p-5">
      <div className="flex items-center gap-2">
        <Rocket className="size-5 text-primary" aria-hidden />
        <h2 className="font-medium">Puesta en marcha</h2>
      </div>
      <p className="text-sm text-muted">
        Tu cuenta está en preparación: puedes configurarlo todo, pero el asistente no responde a tus clientes hasta que la plataforma la active.
        {pending ? ` Faltan ${pending} ${pending === 1 ? 'tarea obligatoria' : 'tareas obligatorias'}.` : ' Ya está todo listo: la plataforma puede activarla.'}
      </p>
      <OnboardingTasks tasks={q.data.tasks} links />
    </Card>
  );
}

export function OnboardingBanner() {
  const { me } = useAuth();
  if (me?.tenant?.status !== 'ONBOARDING') return null;
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
      <Rocket className="size-4 text-primary" aria-hidden />
      Cuenta en preparación: el asistente aún no responde a tus clientes.
      <Link href="/inicio" className="font-medium text-primary hover:underline">Ver lo que falta</Link>
    </div>
  );
}
