'use client';

import type { ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Card, EmptyState } from './ui';

/** Oculta la pantalla si el rol no tiene el permiso. La API valida igualmente cada petición. */
export function RequirePermission({ permission, children }: { permission: string; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(permission))
    return (
      <Card>
        <EmptyState icon={<ShieldAlert className="size-5" />} title="Sin acceso" description="Tu rol no tiene permiso para ver esta sección. Pide acceso al administrador de tu empresa." />
      </Card>
    );
  return <>{children}</>;
}
