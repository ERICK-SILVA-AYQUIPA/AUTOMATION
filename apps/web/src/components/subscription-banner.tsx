'use client';

import { AlertTriangle, Clock, Lock } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { date } from '@/lib/format';
import { cn } from '@/components/ui';

/**
 * Aviso de la suscripción en todas las pantallas de la empresa:
 * prueba por terminar, plan vencido en gracia, o cuenta en solo lectura.
 * El bloqueo real lo aplica la API (HTTP 402); esto solo informa.
 */
export function SubscriptionBanner() {
  const { me } = useAuth();
  const sub = me?.tenant?.subscription;
  if (!sub) return null;
  const a = sub.access;
  const howToPay = me?.billingContact ? `Para renovar: ${me.billingContact}` : 'Para renovar, escribe al administrador de la plataforma.';

  let tone: 'info' | 'warning' | 'danger';
  let icon = Clock;
  let text: string;
  if (a.state === 'TRIAL') {
    if (a.daysLeft > 7) return null;
    tone = a.daysLeft <= 3 ? 'warning' : 'info';
    text = `Tu prueba gratuita termina el ${date(a.endsAt)} (${a.daysLeft === 1 ? 'queda 1 día' : `quedan ${a.daysLeft} días`}). Después la cuenta quedará en solo lectura.`;
  } else if (a.state === 'ACTIVE') {
    if (a.daysLeft > 7) return null;
    tone = 'info';
    text = `Tu plan ${sub.plan.name} vence el ${date(a.endsAt)}.`;
  } else if (a.state === 'GRACE') {
    tone = 'warning';
    icon = AlertTriangle;
    text = `Tu plan venció el ${date(a.endsAt)}. Tienes hasta el ${date(a.graceEndsAt)} para renovarlo antes de que la cuenta quede en solo lectura.`;
  } else {
    tone = 'danger';
    icon = Lock;
    text =
      a.state === 'CANCELED'
        ? 'La suscripción está cancelada. Puedes consultar tus datos, pero no crear ni modificar nada.'
        : 'Tu prueba o tu plan venció: la cuenta está en solo lectura. Tus datos se conservan y puedes consultarlos; los mensajes de tus clientes se siguen recibiendo, pero no se pueden responder.';
  }
  const Icon = icon;
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'mb-6 flex items-start gap-3 rounded-lg border p-3 text-sm',
        tone === 'danger' && 'border-danger/40 bg-danger/10',
        tone === 'warning' && 'border-warning/40 bg-warning/10',
        tone === 'info' && 'border-border bg-surface-2',
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>
        {text} <span className="text-muted">{howToPay}</span>
      </p>
    </div>
  );
}
