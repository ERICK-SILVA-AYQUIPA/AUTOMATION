'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button, ErrorBox, Field, Input } from '@/components/ui';
import { api } from '@/lib/api';

export default function ForgotPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return sent ? (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">Revisa tu correo</h1>
      <p className="text-sm text-muted">Si <b>{email}</b> está registrado, recibirás un enlace válido por 30 minutos.</p>
      <Link href="/login" className="text-sm font-medium text-primary">Volver</Link>
    </div>
  ) : (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api('/auth/forgot-password', { method: 'POST', body: { email } });
          setSent(true);
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1 className="text-lg font-semibold">Recuperar contraseña</h1>
      <ErrorBox error={error} />
      <Field label="Correo">
        <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Button type="submit" loading={busy}>Enviar enlace</Button>
      <Link href="/login" className="text-center text-sm text-muted">Volver</Link>
    </form>
  );
}
