'use client';

import Link from 'next/link';
import { useState } from 'react';
import { MailCheck } from 'lucide-react';
import { Button, ErrorBox, Field, Input, Select } from '@/components/ui';
import { ApiError, api } from '@/lib/api';

export default function RegisterPage() {
  const [form, setForm] = useState({ companyName: '', adminName: '', email: '', password: '', currency: 'PEN' });
  const [error, setError] = useState<unknown>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await api('/auth/register', { method: 'POST', body: { ...form, timezone } });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.errors) setFieldErrors(Object.fromEntries(err.errors.map((x) => [x.path, x.message])));
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <MailCheck className="size-10 text-success" />
        <h1 className="text-lg font-semibold">Revisa tu correo</h1>
        <p className="text-sm text-muted">Enviamos un enlace a <b>{form.email}</b> para verificar tu cuenta. Después podrás iniciar sesión.</p>
        <Link href="/login" className="text-sm font-medium text-primary">Ir a iniciar sesión</Link>
      </div>
    );

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Registra tu negocio</h1>
        <p className="text-sm text-muted">14 días de prueba del plan Básico. Sin tarjeta.</p>
      </div>
      <ErrorBox error={error} />
      <Field label="Nombre del negocio" error={fieldErrors.companyName}>
        <Input required value={form.companyName} onChange={set('companyName')} />
      </Field>
      <Field label="Tu nombre" error={fieldErrors.adminName}>
        <Input required autoComplete="name" value={form.adminName} onChange={set('adminName')} />
      </Field>
      <Field label="Correo" error={fieldErrors.email}>
        <Input type="email" required autoComplete="email" value={form.email} onChange={set('email')} />
      </Field>
      <Field label="Contraseña" error={fieldErrors.password} hint="Mínimo 10 caracteres, con letras y números.">
        <Input type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={set('password')} />
      </Field>
      <Field label="Moneda">
        <Select value={form.currency} onChange={set('currency')}>
          {['PEN', 'USD', 'MXN', 'COP', 'CLP', 'ARS', 'BOB', 'EUR'].map((c) => <option key={c}>{c}</option>)}
        </Select>
      </Field>
      <Button type="submit" loading={busy}>Crear cuenta</Button>
      <p className="text-center text-sm text-muted">¿Ya tienes cuenta? <Link href="/login" className="font-medium text-primary">Inicia sesión</Link></p>
    </form>
  );
}
