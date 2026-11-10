'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Headset, Power } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime } from '@/lib/format';
import { Badge, Button, Card, ErrorBox, Loading } from '@/components/ui';
import { useToast } from '@/components/ui/toast';

export interface ChatwootStatus {
  available: boolean;
  status: 'PENDING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  lastError: string | null;
  accountId: number | null;
  inboxId: number | null;
  updatedAt: string | null;
}

export const useChatwootStatus = (enabled = true) =>
  useQuery({ queryKey: ['chatwoot'], queryFn: () => api<ChatwootStatus>('/integrations/chatwoot'), staleTime: 30_000, enabled });

/**
 * Abre Chatwoot con inicio de sesión único. La ventana se abre en el mismo clic
 * (si se abriera después de esperar a la API, el navegador la bloquearía) y luego
 * se le asigna el enlace de un solo uso.
 */
export function OpenInChatwoot({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const { can } = useAuth();
  const toast = useToast();
  const st = useChatwootStatus(can('conversations:read'));
  const [busy, setBusy] = useState(false);
  if (!can('conversations:reply') || st.data?.status !== 'CONNECTED') return null;
  async function open() {
    const w = window.open('about:blank', '_blank');
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>('/integrations/chatwoot/sso', { method: 'POST' });
      if (w) {
        w.opener = null;
        w.location.href = url;
      } else {
        window.location.href = url;
      }
    } catch (err) {
      w?.close();
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button size={size} variant="secondary" icon={<ExternalLink className="size-4" />} loading={busy} onClick={open}>
      Abrir en Chatwoot
    </Button>
  );
}

/** Tarjeta de Integraciones: activa la bandeja de agentes (una cuenta de Chatwoot por empresa) */
export function ChatwootCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const st = useChatwootStatus();
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    try {
      const r = await api<ChatwootStatus>('/integrations/chatwoot/connect', { method: 'POST' });
      qc.setQueryData(['chatwoot'], r);
      toast.success('Bandeja de agentes activada');
    } catch (err) {
      toast.error(err);
      qc.invalidateQueries({ queryKey: ['chatwoot'] });
    } finally {
      setBusy(false);
    }
  }

  const d = st.data;
  return (
    <Card className="p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-sky-500/10 p-2 text-sky-700 dark:text-sky-400"><Headset className="size-5" /></div>
          <div>
            <p className="font-medium">Bandeja de agentes (Chatwoot)</p>
            <p className="max-w-xl text-sm text-muted">
              Copia cada conversación de WhatsApp a Chatwoot para que tu equipo responda desde ahí. Las respuestas salen por tu número de WhatsApp y, cuando un agente responde o toma la conversación, el asistente IA se pausa en ella.
            </p>
            {st.isLoading ? <Loading /> : st.error ? <ErrorBox error={st.error} /> : d && (
              <div className="mt-2 flex flex-wrap gap-2">
                {!d.available ? <Badge tone="warning">No configurado en el servidor</Badge>
                  : d.status === 'CONNECTED' ? <Badge tone="success">Activa{d.updatedAt && ` desde ${dateTime(d.updatedAt)}`}</Badge>
                  : d.status === 'ERROR' ? <Badge tone="danger">Error</Badge>
                  : <Badge>Sin activar</Badge>}
              </div>
            )}
            {d && !d.available && (
              <p className="mt-2 text-sm text-muted">El administrador de la plataforma debe definir <code>CHATWOOT_BASE_URL</code> y <code>CHATWOOT_PLATFORM_TOKEN</code> (ver services/chatwoot/README.md).</p>
            )}
            {d?.lastError && d.status !== 'CONNECTED' && <p className="mt-2 text-sm text-danger">{d.lastError}</p>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          {d?.status === 'CONNECTED' ? <OpenInChatwoot /> : (
            <Button size="sm" icon={<Power className="size-4" />} loading={busy} disabled={!d?.available} onClick={connect}>
              {d?.status === 'ERROR' ? 'Reintentar' : 'Activar'}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
