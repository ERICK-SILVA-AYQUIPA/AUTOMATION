'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fieldErrors } from '@/lib/form';
import type { Customer } from '@/lib/types';
import { Button, Dialog, ErrorBox, Field, Input, Textarea } from './ui';
import { useToast } from './ui/toast';

export function CustomerDialog({ open, onClose, customer, onSaved }: { open: boolean; onClose: () => void; customer?: Customer | null; onSaved?: (c: Customer) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  // Se monta solo mientras está abierto, así el estado inicial siempre refleja al cliente actual
  const [f, setF] = useState(() => ({
    phone: customer?.phone ?? '', name: customer?.name ?? '', email: customer?.email ?? '', documentId: customer?.documentId ?? '',
    address: customer?.address ?? '', notes: customer?.notes ?? '', tags: customer?.tags.join(', ') ?? '',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const n = (s: string) => s.trim() || null;
    // Un contacto que llegó solo con su identificador de WhatsApp puede quedarse sin teléfono
    const body = { ...(f.phone.trim() ? { phone: f.phone } : {}), name: n(f.name), email: n(f.email), documentId: n(f.documentId), address: n(f.address), notes: n(f.notes), tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean) };
    try {
      const c = customer ? await api<Customer>(`/customers/${customer.id}`, { method: 'PATCH', body }) : await api<Customer>('/customers', { method: 'POST', body });
      qc.invalidateQueries({ queryKey: ['customers'] });
      qc.invalidateQueries({ queryKey: ['customer'] });
      toast.success('Cliente guardado');
      onSaved?.(c);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={customer ? 'Editar cliente' : 'Nuevo cliente'} footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="customer-form" loading={busy}>Guardar</Button></>}>
      <form id="customer-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Teléfono WhatsApp" error={errors.phone} hint={customer && !customer.phone ? 'WhatsApp no compartió su número. Puedes añadirlo si lo conoces.' : 'Con código de país, p. ej. 51987654321'}><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required={!customer || !!customer.phone} inputMode="tel" invalid={!!errors.phone} /></Field>
        <Field label="Nombre" error={errors.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} /></Field>
        <Field label="Correo" error={errors.email}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} invalid={!!errors.email} /></Field>
        <Field label="Documento (DNI/RUC)" error={errors.documentId}><Input value={f.documentId} onChange={(e) => setF({ ...f, documentId: e.target.value })} maxLength={30} /></Field>
        <Field label="Dirección" className="sm:col-span-2"><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} maxLength={300} /></Field>
        <Field label="Etiquetas" className="sm:col-span-2" hint="Separadas por comas: mayorista, frecuente"><Input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
        <Field label="Notas internas" className="sm:col-span-2"><Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={2000} /></Field>
        <div className="sm:col-span-2"><ErrorBox error={error} /></div>
      </form>
    </Dialog>
  );
}
