import { MessageSquareText } from 'lucide-react';
import type { ReactNode } from 'react';

/** Marco de las páginas que abre el cliente con su enlace (propuesta y pago) */
export function PublicDoc({ issuer, children }: { issuer?: string | null; children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg px-4 py-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <p className="flex items-center gap-2 font-semibold">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-fg"><MessageSquareText className="size-4" /></span>
          {issuer ?? 'AI Sales Assistant'}
        </p>
        {children}
      </div>
    </div>
  );
}
