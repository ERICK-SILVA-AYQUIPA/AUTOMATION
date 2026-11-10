'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { ErrorBox, Loading } from '@/components/ui';
import { api } from '@/lib/api';

function Verify() {
  const token = useSearchParams().get('token') ?? '';
  const router = useRouter();
  const [error, setError] = useState<unknown>(null);
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    api('/auth/verify-email', { method: 'POST', body: { token } })
      .then(() => router.replace('/login?verificado=1'))
      .catch(setError);
  }, [token, router]);
  return error ? (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">No se pudo verificar</h1>
      <ErrorBox error={error} />
      <Link href="/login" className="text-sm font-medium text-primary">Volver a iniciar sesión</Link>
    </div>
  ) : (
    <Loading label="Verificando tu correo…" />
  );
}

export default function Page() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}
