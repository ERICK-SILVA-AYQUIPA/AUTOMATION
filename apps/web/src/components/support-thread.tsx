'use client';

import { Lock } from 'lucide-react';
import { cn } from '@/components/ui';
import { dateTime } from '@/lib/format';
import type { TicketMessage } from '@/lib/support';

/** Historial de un caso de soporte. `staff` cambia quién es "nosotros" y muestra las notas internas */
export function SupportThread({ messages, staff }: { messages: TicketMessage[]; staff?: boolean }) {
  return (
    <ol className="flex flex-col gap-3" aria-label="Mensajes del caso">
      {messages.map((m) => {
        if (m.authorKind === 'SYSTEM') {
          return <li key={m.id} className="text-center text-xs text-muted">{m.body} · {dateTime(m.createdAt)}</li>;
        }
        const ours = staff ? m.authorKind === 'STAFF' : m.authorKind === 'CLIENT';
        const who = m.authorKind === 'STAFF' ? (staff ? (m.author?.name ?? 'Equipo') : 'Equipo de soporte') : (m.author?.name ?? 'Cliente');
        return (
          <li key={m.id} className={cn('flex flex-col gap-1', ours ? 'items-end' : 'items-start')}>
            <div className={cn('max-w-[min(42rem,100%)] whitespace-pre-wrap rounded-xl border px-4 py-3 text-sm',
              m.internal ? 'border-amber-500/40 bg-amber-500/10' : ours ? 'border-transparent bg-primary/10' : 'border-border bg-surface')}>
              {m.internal && <p className="mb-1 flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300"><Lock className="size-3" /> Nota interna: la empresa no la ve</p>}
              {m.body}
            </div>
            <span className="text-xs text-muted">{who} · {dateTime(m.createdAt)}</span>
          </li>
        );
      })}
    </ol>
  );
}
