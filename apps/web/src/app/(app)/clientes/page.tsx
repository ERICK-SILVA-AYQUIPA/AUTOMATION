'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus, Search, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime } from '@/lib/format';
import type { Customer, Paged } from '@/lib/types';
import { Badge, Button, Card, EmptyState, ErrorBox, Input, Loading, PageHeader, Pagination, Table, Td, Th } from '@/components/ui';
import { RequirePermission } from '@/components/guard';
import { CustomerDialog } from '@/components/customer-dialog';

function Customers() {
  const { can } = useAuth();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => { setDq(q.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);
  const list = useQuery({ queryKey: ['customers', dq, page], queryFn: () => api<Paged<Customer>>('/customers', { query: { q: dq, page, pageSize: 25 } }), placeholderData: keepPreviousData });

  return (
    <>
      <PageHeader title="Clientes" description="Se crean automáticamente al escribir por WhatsApp o al registrar un pedido." actions={can('customers:write') && <Button icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>Nuevo cliente</Button>} />
      <Card>
        <div className="border-b border-border p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input className="pl-9" placeholder="Nombre, teléfono, correo o documento" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar clientes" />
          </div>
        </div>
        <ErrorBox error={list.error} />
        {list.isLoading ? <Loading /> : !list.data?.items.length ? (
          <EmptyState icon={<Users className="size-5" />} title={dq ? 'Ningún cliente coincide' : 'Aún no tienes clientes'} />
        ) : (
          <>
            <Table>
              <thead><tr><Th>Cliente</Th><Th>Teléfono</Th><Th>Etiquetas</Th><Th className="text-right">Pedidos</Th><Th>Último contacto</Th></tr></thead>
              <tbody>
                {list.data.items.map((c) => (
                  <tr key={c.id} className="cursor-pointer hover:bg-surface-2/60" onClick={() => router.push(`/clientes/${c.id}`)}>
                    <Td><Link href={`/clientes/${c.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline">{c.name ?? 'Sin nombre'}</Link>{c.email && <span className="block text-xs text-muted">{c.email}</span>}</Td>
                    <Td className="tabular-nums">+{c.phone}</Td>
                    <Td><div className="flex flex-wrap gap-1">{c.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div></Td>
                    <Td className="text-right tabular-nums">{c._count?.orders ?? 0}</Td>
                    <Td className="text-muted">{dateTime(c.lastContactAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
      {open && <CustomerDialog open onClose={() => setOpen(false)} onSaved={(c) => router.push(`/clientes/${c.id}`)} />}
    </>
  );
}

export default function ClientesPage() {
  return <RequirePermission permission="customers:read"><Customers /></RequirePermission>;
}
