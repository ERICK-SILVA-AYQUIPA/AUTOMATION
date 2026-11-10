'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button, ErrorBox, Field, Input } from '@/components/ui';
import { api } from '@/lib/api';

/** Formulario común para restablecer contraseña y aceptar invitación */
export function SetPasswordForm({ mode }: { mode: 'reset' | 'invite' }) {
  const token = useSearchParams().get('token') ?? '';
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (password !== confirm) return setError(new Error('Las contraseñas no coinciden'));
        setBusy(true);
        setError(null);
        try {
          await api(mode === 'reset' ? '/auth/reset-password' : '/auth/accept-invitation', { method: 'POST', body: { token, password, ...(mode === 'invite' && name ? { name } : {}) } });
          router.replace('/login');
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1 className="text-lg font-semibold">{mode === 'reset' ? 'Nueva contraseña' : 'Activa tu cuenta'}</h1>
      <ErrorBox error={error} />
      {mode === 'invite' && (
        <Field label="Tu nombre (opcional)">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      )}
      <Field label="Contraseña" hint="Mínimo 10 caracteres, con letras y números.">
        <Input type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Field label="Repite la contraseña">
        <Input type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      <Button type="submit" loading={busy}>Guardar</Button>
    </form>
  );
}
