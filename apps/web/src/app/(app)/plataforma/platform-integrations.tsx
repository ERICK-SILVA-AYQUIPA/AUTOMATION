'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { dateTime, num } from '@/lib/format';
import { Badge, Button, Card, ErrorBox, Loading, StatCard } from '@/components/ui';
import { useToast } from '@/components/ui/toast';

interface PlatformService {
  key: string; name: string; env: string[]; doc: string; configured: boolean;
  lastCheck: { ok: boolean; detail: string | null; ms: number | null; at: string } | null;
}
interface Overview {
  services: PlatformService[];
  payments: { provider: string | null; detail: string };
  whatsapp: { numbers: Record<string, number>; errors: { tenant: { id: string; name: string }; displayPhone: string | null; error: string | null; at: string }[] };
  last7Days: { failedAutomations: number; failedWebhooks: number };
  recentErrors: { id: string; service: string; detail: string | null; createdAt: string }[];
}

/** Estado de los servicios del servidor: comprobación real y qué variables de entorno faltan */
export function PlatformIntegrations() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['platform-integrations'], queryFn: () => api<Overview>('/platform/integrations'), staleTime: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  async function test(s: PlatformService) {
    setBusy(s.key);
    try {
      const r = await api<{ ok: boolean; detail: string }>(`/platform/integrations/${s.key}/test`, { method: 'POST' });
      if (r.ok) toast.success(`${s.name}: ${r.detail}`);
      else toast.error(`${s.name}: ${r.detail}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
      qc.invalidateQueries({ queryKey: ['platform-integrations'] });
    }
  }
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const wa = d.whatsapp.numbers;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Números de WhatsApp" value={num(Object.values(wa).reduce((a, b) => a + b, 0))} tone={wa.ERROR ? 'danger' : undefined}
          hint={`${num(wa.CONNECTED ?? 0)} con credenciales válidas · ${num(wa.PENDING ?? 0)} pendientes · ${num(wa.ERROR ?? 0)} con error`} />
        <StatCard label="Automatizaciones fallidas" value={num(d.last7Days.failedAutomations)} tone={d.last7Days.failedAutomations ? 'warning' : undefined} hint="Últimos 7 días, todas las empresas" />
        <StatCard label="Webhooks fallidos" value={num(d.last7Days.failedWebhooks)} tone={d.last7Days.failedWebhooks ? 'warning' : undefined} hint="Entregas a sistemas de las empresas, 7 días" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {d.services.map((s) => {
          const c = s.lastCheck;
          const tone = !s.configured ? 'neutral' : !c ? 'warning' : c.ok ? 'success' : 'danger';
          const label = !s.configured ? 'Sin configurar' : !c ? 'Sin probar' : c.ok ? 'Funciona' : 'Con errores';
          return (
            <Card key={s.key} className="flex flex-col gap-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-medium">{s.name}</h3>
                <Badge tone={tone}>{label}</Badge>
              </div>
              {c && <p className={c.ok ? 'text-xs text-muted' : 'text-xs text-danger'}>Última prueba {dateTime(c.at)}{c.ms != null ? ` (${c.ms} ms)` : ''}: {c.detail}</p>}
              <p className="text-xs text-muted">
                Variables: {s.env.map((v, i) => <span key={v}>{i ? ', ' : ''}<code className="text-text">{v}</code></span>)} · Guía: <code className="text-text">{s.doc}</code>
              </p>
              <div className="mt-auto pt-1">
                <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} loading={busy === s.key} onClick={() => test(s)} aria-label={`Probar ${s.name}`}>Probar</Button>
              </div>
            </Card>
          );
        })}
        <Card className="flex flex-col gap-2 p-4">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-medium">Pagos</h3>
            <Badge>{d.payments.provider ?? 'Sin proveedor'}</Badge>
          </div>
          <p className="text-sm text-muted">{d.payments.detail}</p>
        </Card>
      </div>

      {!!d.whatsapp.errors.length && (
        <Card className="p-4">
          <h3 className="mb-2 font-medium">Números de WhatsApp con error</h3>
          <ul className="flex flex-col gap-1.5 text-sm">
            {d.whatsapp.errors.map((e, i) => (
              <li key={i}><span className="font-medium">{e.tenant.name || e.tenant.id}</span> · {e.displayPhone ?? '—'} · <span className="text-danger">{e.error ?? 'error'}</span> <span className="text-muted">({dateTime(e.at)})</span></li>
            ))}
          </ul>
        </Card>
      )}

      {!!d.recentErrors.length && (
        <Card className="p-4">
          <h3 className="mb-2 font-medium">Errores recientes de las pruebas del servidor</h3>
          <ul className="flex flex-col gap-1.5 text-sm">
            {d.recentErrors.map((e) => <li key={e.id}><span className="text-muted">{dateTime(e.createdAt)}</span> · {e.service} · {e.detail}</li>)}
          </ul>
        </Card>
      )}
    </div>
  );
}
