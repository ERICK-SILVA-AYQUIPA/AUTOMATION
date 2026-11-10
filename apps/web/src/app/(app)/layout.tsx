'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { AppShell } from '@/components/layout/app-shell';
import { Loading } from '@/components/ui';

/** Todas las pantallas internas exigen sesión; sin ella se vuelve al login conservando la ruta. */
export default function AppLayout({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    if (loading) return;
    if (!me) router.replace(`/login?next=${encodeURIComponent(path)}`);
    else if (me.role === 'PLATFORM_ADMIN' && !path.startsWith('/plataforma')) router.replace('/plataforma');
  }, [me, loading, path, router]);

  if (loading || !me) return <Loading label="Verificando sesión…" />;
  return <AppShell>{children}</AppShell>;
}
