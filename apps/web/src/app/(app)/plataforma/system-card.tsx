'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { dateTime, num } from '@/lib/format';
import { Badge, Card, EmptyState, ErrorBox, Loading, StatCard, Table, Td, Th } from '@/components/ui';

interface SystemUpdate {
  id: string; fromVersion: string; toVersion: string; status: 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK';
  migrations: string[]; backupPath: string | null; detail: string | null; startedAt: string; finishedAt: string;
}
interface SystemStatus {
  version: string;
  migrations: { applied: number; last: { name: string; at: string } | null; failed: { name: string; startedAt: string }[] };
  updates: SystemUpdate[];
  installationsBehind: { tenantId: string; tenant: string; number: number; version: string; deliveredAt: string | null }[];
}

const STATUS = {
  SUCCEEDED: { label: 'Correcta', tone: 'success' },
  FAILED: { label: 'Fallida', tone: 'danger' },
  ROLLED_BACK: { label: 'Revertida', tone: 'warning' },
} as const;

/** Versión, migraciones e historial de actualizaciones (ADR 045) */
export function SystemCard() {
  const q = useQuery({ queryKey: ['platform-system'], queryFn: () => api<SystemStatus>('/platform/system'), staleTime: 0 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const m = d.migrations;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Versión instalada" value={d.version} hint="Versión de la aplicación en marcha en esta instalación" />
        <StatCard label="Migraciones aplicadas" value={num(m.applied)} tone={m.failed.length ? 'danger' : undefined}
          hint={m.failed.length ? `${m.failed.length} sin terminar: ${m.failed.map((f) => f.name).join(', ')}` : m.last ? `Última: ${m.last.name} · ${dateTime(m.last.at)}` : 'Ninguna'} />
        <StatCard label="Instalaciones por actualizar" value={num(d.installationsBehind.length)} tone={d.installationsBehind.length ? 'warning' : undefined}
          hint="Empresas con su propio servidor entregadas con una versión anterior" />
      </div>

      {d.installationsBehind.length > 0 && (
        <Card className="p-4">
          <h3 className="mb-1 font-medium">Instalaciones independientes con una versión anterior</h3>
          <p className="mb-3 text-xs text-muted">
            Para actualizarlas: en la ficha de la empresa prepara una entrega nueva (versión {d.version}), descarga el paquete y en su servidor ejecuta <code className="text-text">./actualizar.sh &lt;carpeta instalada&gt; --verificar</code> y luego sin <code className="text-text">--verificar</code>. Respalda antes, conserva lo personalizado y vuelve atrás solo si algo falla.
          </p>
          <ul className="text-sm">
            {d.installationsBehind.map((i) => <li key={i.tenantId}>{i.tenant}: entrega n.º {i.number} con la versión {i.version}{i.deliveredAt ? ` · entregada ${dateTime(i.deliveredAt)}` : ''}</li>)}
          </ul>
        </Card>
      )}

      <Card>
        <div className="p-4 pb-2">
          <h3 className="font-medium">Historial de actualizaciones</h3>
          <p className="text-xs text-muted">Lo registran <code className="text-text">deploy.sh</code> y <code className="text-text">actualizar.sh</code> después de comprobar la salud, con el respaldo hecho antes de actualizar.</p>
        </div>
        {d.updates.length === 0 ? <EmptyState title="Sin actualizaciones registradas" description="Aparecerán aquí la próxima vez que se actualice esta instalación." /> : (
          <Table>
            <thead><tr><Th>Fecha</Th><Th>Versión</Th><Th>Resultado</Th><Th>Migraciones</Th><Th>Respaldo previo y detalle</Th></tr></thead>
            <tbody>
              {d.updates.map((u) => (
                <tr key={u.id} className="border-t border-border align-top">
                  <Td className="whitespace-nowrap">{dateTime(u.finishedAt)}</Td>
                  <Td className="whitespace-nowrap">{u.fromVersion} → {u.toVersion}</Td>
                  <Td><Badge tone={STATUS[u.status].tone}>{STATUS[u.status].label}</Badge></Td>
                  <Td className="text-xs">{u.migrations.length ? u.migrations.join(', ') : '—'}</Td>
                  <Td className="text-xs text-muted"><span className="break-all font-mono">{u.backupPath ?? '—'}</span>{u.detail ? <p className="mt-1">{u.detail}</p> : null}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
