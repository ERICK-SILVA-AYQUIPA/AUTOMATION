'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Landing, type PublicCommercial } from '@/components/commercial/landing';
import { Loading } from '@/components/ui';
import { ApiError, api } from '@/lib/api';

/**
 * Inicio público: la página comercial si la plataforma la publicó; si no, el
 * panel (como hasta 0.11.0).
 */
export default function Home() {
  const router = useRouter();
  const q = useQuery({ queryKey: ['public-commercial'], queryFn: () => api<PublicCommercial>('/public/commercial'), retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2 });
  const unpublished = q.isError;
  useEffect(() => {
    if (unpublished) router.replace('/inicio');
  }, [unpublished, router]);
  if (q.data) return <Landing c={q.data} />;
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Loading />
    </div>
  );
}
