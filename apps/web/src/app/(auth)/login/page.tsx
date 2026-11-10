'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Button, ErrorBox, Field, Input } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';

function LoginForm() {
  const { login, me, loading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [unverified, setUnverified] = useState(false);
  const [resent, setResent] = useState(false);

  // Solo rutas internas: evita redirecciones abiertas (?next=//sitio-externo)
  const nextParam = params.get('next');
  const home = (role: string) => (role === 'PLATFORM_ADMIN' ? '/plataforma' : nextParam && /^\/(?![/\\])/.test(nextParam) ? nextParam : '/inicio');

  useEffect(() => {
    if (!loading && me) router.replace(home(me.role));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, me, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const m = await login(email, password);
      router.replace(home(m.role));
    } catch (err) {
      setUnverified(err instanceof ApiError && err.code === 'EMAIL_NOT_VERIFIED');
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Iniciar sesión</h1>
        <p className="text-sm text-muted">Accede al panel de tu negocio.</p>
      </div>
      {params.get('expirada') && <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">Tu sesión expiró. Vuelve a iniciar sesión.</p>}
      {params.get('verificado') && <p className="rounded-lg bg-green-500/10 px-3 py-2 text-sm text-success">Correo verificado. Ya puedes iniciar sesión.</p>}
      <ErrorBox error={error} />
      {unverified && (
        <Button type="button" variant="secondary" disabled={resent} onClick={async () => { await api('/auth/resend-verification', { method: 'POST', body: { email } }); setResent(true); }}>
          {resent ? 'Correo reenviado' : 'Reenviar correo de verificación'}
        </Button>
      )}
      <Field label="Correo">
        <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Contraseña">
        <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Button type="submit" loading={busy}>Entrar</Button>
      <div className="flex justify-between text-sm">
        <Link href="/olvide-contrasena" className="text-muted hover:text-text">¿Olvidaste tu contraseña?</Link>
        <Link href="/registro" className="font-medium text-primary">Crear cuenta</Link>
      </div>
    </form>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
