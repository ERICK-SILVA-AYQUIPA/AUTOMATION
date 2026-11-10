'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MailPlus, Pencil, Send, UserPlus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fieldErrors } from '@/lib/form';
import { dateTime, ROLE_LABEL } from '@/lib/format';
import { Badge, Button, Card, Dialog, ErrorBox, Field, Input, Loading, PageHeader, Select, Table, Td, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';

interface User { id: string; email: string; name: string; role: string; status: 'INVITED' | 'ACTIVE' | 'DISABLED'; lastLoginAt: string | null; createdAt: string }
const STATUS = { INVITED: { label: 'Invitado', tone: 'warning' }, ACTIVE: { label: 'Activo', tone: 'success' }, DISABLED: { label: 'Desactivado', tone: 'neutral' } } as const;
const ROLE_HINT: Record<string, string> = {
  TENANT_ADMIN: 'Todo: catálogo, inventario, usuarios, integraciones y configuración.',
  SUPERVISOR: 'Ve todo, gestiona pedidos y clientes, asigna conversaciones y ve reportes. No edita catálogo ni usuarios.',
  SELLER: 'Atiende conversaciones, registra pedidos y clientes. Solo lectura de catálogo e inventario.',
};

function Users() {
  const { me, can } = useAuth();
  const manage = can('users:manage');
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/users') });
  const [dlg, setDlg] = useState<User | 'new' | null>(null);
  const [f, setF] = useState({ email: '', name: '', role: 'SELLER', status: 'ACTIVE' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const open = (u: User | 'new') => {
    setError(null);
    setDlg(u);
    setF(u === 'new' ? { email: '', name: '', role: 'SELLER', status: 'ACTIVE' } : { email: u.email, name: u.name, role: u.role, status: u.status });
  };
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (dlg === 'new') {
        await api('/users', { method: 'POST', body: { email: f.email, name: f.name, role: f.role } });
        toast.success(`Invitación enviada a ${f.email}`);
      } else {
        const u = dlg!;
        const body: Record<string, string> = {};
        if (f.name !== u.name) body.name = f.name;
        if (f.role !== u.role) body.role = f.role;
        if (u.status !== 'INVITED' && f.status !== u.status) body.status = f.status;
        if (Object.keys(body).length) await api(`/users/${u.id}`, { method: 'PATCH', body });
        toast.success('Usuario actualizado');
      }
      qc.invalidateQueries({ queryKey: ['users'] });
      setDlg(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function resend(u: User) {
    try {
      await api(`/users/${u.id}/resend-invitation`, { method: 'POST' });
      toast.success(`Invitación reenviada a ${u.email}`);
    } catch (err) {
      toast.error(err);
    }
  }
  const self = dlg !== 'new' && dlg?.id === me?.id;

  return (
    <>
      <PageHeader title="Usuarios" description="Personas de tu empresa con acceso al panel. El número de usuarios depende de tu plan." actions={manage && <Button icon={<UserPlus className="size-4" />} onClick={() => open('new')}>Invitar usuario</Button>} />
      <Card>
        <ErrorBox error={list.error} />
        {list.isLoading ? <Loading /> : (
          <Table>
            <thead><tr><Th>Nombre</Th><Th>Rol</Th><Th>Estado</Th><Th>Último acceso</Th><Th /></tr></thead>
            <tbody>
              {list.data?.map((u) => (
                <tr key={u.id}>
                  <Td><span className="font-medium">{u.name}</span>{u.id === me?.id && <span className="text-xs text-muted"> (tú)</span>}<span className="block text-xs text-muted">{u.email}</span></Td>
                  <Td>{ROLE_LABEL[u.role] ?? u.role}</Td>
                  <Td><Badge tone={STATUS[u.status].tone}>{STATUS[u.status].label}</Badge></Td>
                  <Td className="text-muted">{dateTime(u.lastLoginAt)}</Td>
                  <Td className="whitespace-nowrap text-right">
                    {manage && u.status === 'INVITED' && <Button size="sm" variant="ghost" icon={<Send className="size-4" />} onClick={() => resend(u)}>Reenviar</Button>}
                    {manage && <Button size="sm" variant="ghost" aria-label={`Editar ${u.name}`} icon={<Pencil className="size-4" />} onClick={() => open(u)} />}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Dialog open={!!dlg} onClose={() => setDlg(null)} title={dlg === 'new' ? 'Invitar usuario' : 'Editar usuario'} footer={<><Button variant="secondary" onClick={() => setDlg(null)}>Cancelar</Button><Button type="submit" form="user-form" loading={busy} icon={dlg === 'new' ? <MailPlus className="size-4" /> : undefined}>{dlg === 'new' ? 'Enviar invitación' : 'Guardar'}</Button></>}>
        <form id="user-form" onSubmit={submit} className="flex flex-col gap-4">
          {dlg === 'new' && <Field label="Correo" error={fieldErrors(error).email}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>}
          <Field label="Nombre" error={fieldErrors(error).name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={120} /></Field>
          <Field label="Rol" hint={self ? 'No puedes cambiar tu propio rol.' : ROLE_HINT[f.role]}>
            <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} disabled={self}>
              <option value="TENANT_ADMIN">{ROLE_LABEL.TENANT_ADMIN}</option>
              <option value="SUPERVISOR">{ROLE_LABEL.SUPERVISOR}</option>
              <option value="SELLER">{ROLE_LABEL.SELLER}</option>
            </Select>
          </Field>
          {dlg !== 'new' && dlg?.status !== 'INVITED' && (
            <Field label="Estado" hint={self ? 'No puedes desactivarte a ti mismo.' : 'Desactivar cierra sus sesiones y bloquea el acceso.'}>
              <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} disabled={self}>
                <option value="ACTIVE">Activo</option>
                <option value="DISABLED">Desactivado</option>
              </Select>
            </Field>
          )}
          {dlg === 'new' && <p className="text-xs text-muted">Recibirá un correo con un enlace válido por 7 días para crear su contraseña.</p>}
          <ErrorBox error={error} />
        </form>
      </Dialog>
    </>
  );
}

export default function UsuariosPage() {
  return <RequirePermission permission="users:read"><Users /></RequirePermission>;
}
