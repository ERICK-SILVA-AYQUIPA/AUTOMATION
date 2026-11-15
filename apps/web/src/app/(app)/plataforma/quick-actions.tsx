'use client';

import { CirclePlus } from 'lucide-react';
import Link from 'next/link';
import { Card } from '@/components/ui';

/** Pantalla principal del equipo (§14): el botón principal y los accesos de cada día */
const LINKS: [string, string][] = [
  ['Nuevo prospecto', '/plataforma/ventas?nuevo=1'],
  ['Nueva cotización', '/plataforma/venta'],
  ['Nueva empresa', '/plataforma/nueva'],
  ['Nueva instalación', '/plataforma/aprovisionamiento'],
  ['Conectar proveedor', '/plataforma/infraestructura?tab=proveedores'],
  ['Ver servidores', '/plataforma/infraestructura?tab=servidores'],
  ['Ver pagos', '/plataforma/cotizaciones?tab=pagos'],
  ['Ver entregas', '/plataforma/aprovisionamiento?estado=entregadas'],
  ['Ver errores', '/plataforma/aprovisionamiento?estado=problemas'],
  ['Casos de soporte', '/plataforma/soporte'],
  ['Renovaciones', '/plataforma/soporte?vista=renovaciones'],
  ['Rentabilidad', '/plataforma/rentabilidad'],
];

export function QuickActions() {
  return (
    <Card className="mb-6 flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
      <Link href="/plataforma/venta" className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-5 font-semibold uppercase tracking-wide text-primary-fg hover:opacity-90">
        <CirclePlus className="size-5" />Nueva venta e instalación
      </Link>
      <nav aria-label="Accesos rápidos" className="flex flex-wrap gap-2 text-sm">
        {LINKS.map(([label, href]) => <Link key={label} href={href} className="rounded-lg border border-border px-3 py-1.5 hover:bg-surface-2">{label}</Link>)}
      </nav>
    </Card>
  );
}
