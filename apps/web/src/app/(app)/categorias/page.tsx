'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fieldErrors } from '@/lib/form';
import type { Category } from '@/lib/types';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Field, Input, Loading, PageHeader, Table, Td, Textarea, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';

function Categories() {
  const { can } = useAuth();
  const canWrite = can('products:write');
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['categories'], queryFn: () => api<Category[]>('/categories') });
  const [edit, setEdit] = useState<Category | 'new' | null>(null);
  const [del, setDel] = useState<Category | null>(null);
  const [f, setF] = useState({ name: '', description: '', isActive: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const open = (c: Category | 'new') => {
    setEdit(c);
    setError(null);
    setF(c === 'new' ? { name: '', description: '', isActive: true } : { name: c.name, description: c.description ?? '', isActive: c.isActive });
  };
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name: f.name.trim(), description: f.description.trim() || undefined, isActive: f.isActive };
      if (edit === 'new') await api('/categories', { method: 'POST', body });
      else await api(`/categories/${edit!.id}`, { method: 'PATCH', body });
      qc.invalidateQueries({ queryKey: ['categories'] });
      toast.success('Categoría guardada');
      setEdit(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    try {
      await api(`/categories/${del!.id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['categories'] });
      qc.invalidateQueries({ queryKey: ['products'] });
      toast.success('Categoría eliminada');
    } catch (err) {
      toast.error(err);
    }
    setDel(null);
  }

  return (
    <>
      <PageHeader title="Categorías" description="Agrupa tus productos. El asistente las usa para orientar al cliente." actions={canWrite && <Button icon={<Plus className="size-4" />} onClick={() => open('new')}>Nueva categoría</Button>} />
      <Card>
        <ErrorBox error={list.error} />
        {list.isLoading ? <Loading /> : !list.data?.length ? (
          <EmptyState icon={<Tags className="size-5" />} title="Sin categorías" description="Crea categorías como “Bebidas” o “Ropa de niño”." action={canWrite && <Button icon={<Plus className="size-4" />} onClick={() => open('new')}>Nueva categoría</Button>} />
        ) : (
          <Table>
            <thead><tr><Th>Nombre</Th><Th>Descripción</Th><Th className="text-right">Productos</Th><Th>Estado</Th><Th /></tr></thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id}>
                  <Td className="font-medium">{c.name}</Td>
                  <Td className="text-muted">{c.description ?? '—'}</Td>
                  <Td className="text-right"><Link className="hover:underline" href={`/productos?categoryId=${c.id}`}>{c.productCount ?? 0}</Link></Td>
                  <Td>{c.isActive ? <Badge tone="success">Activa</Badge> : <Badge>Inactiva</Badge>}</Td>
                  <Td className="whitespace-nowrap text-right">
                    {canWrite && (
                      <>
                        <Button size="sm" variant="ghost" aria-label={`Editar ${c.name}`} icon={<Pencil className="size-4" />} onClick={() => open(c)} />
                        <Button size="sm" variant="ghost" aria-label={`Eliminar ${c.name}`} icon={<Trash2 className="size-4 text-danger" />} onClick={() => setDel(c)} />
                      </>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Dialog open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'Nueva categoría' : 'Editar categoría'} footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancelar</Button><Button type="submit" form="cat-form" loading={busy}>Guardar</Button></>}>
        <form id="cat-form" onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Nombre" error={fieldErrors(error).name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={80} autoFocus /></Field>
          <Field label="Descripción (opcional)"><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={500} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Activa</label>
          <ErrorBox error={error} />
        </form>
      </Dialog>
      <Dialog open={!!del} onClose={() => setDel(null)} title="¿Eliminar categoría?" footer={<><Button variant="secondary" onClick={() => setDel(null)}>Cancelar</Button><Button variant="danger" onClick={remove}>Eliminar</Button></>}>
        <p className="text-sm text-muted">Se eliminará “{del?.name}”. Sus {del?.productCount ?? 0} producto(s) no se borran: quedan sin categoría.</p>
      </Dialog>
    </>
  );
}

export default function CategoriasPage() {
  return <RequirePermission permission="products:read"><Categories /></RequirePermission>;
}
