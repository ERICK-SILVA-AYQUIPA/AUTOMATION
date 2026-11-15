'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Button, Dialog, ErrorBox, Field, Input, Select } from '@/components/ui';
import { LEAD_STATUS, LeadFields, duplicatesOf, emptyForm, leadNo, payloadOf, useOwners, type Lead } from './shared';

/** Registro de un prospecto (Ventas y asistente «Nueva venta e instalación») */
export function NewLeadDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const owners = useOwners();
  const [f, setF] = useState(emptyForm);
  const [ownerId, setOwnerId] = useState<string>('me');
  const [nextAction, setNextAction] = useState('');
  const [nextAt, setNextAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dups = duplicatesOf(error);
  async function submit(e: React.FormEvent, allowDuplicate = false) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<Lead>('/platform/sales/leads', {
        method: 'POST',
        body: {
          ...payloadOf(f), ...(ownerId === 'me' ? {} : { ownerId: ownerId || null }),
          ...(nextAction.trim() && nextAt ? { nextAction: nextAction.trim(), nextActionAt: new Date(nextAt).toISOString() } : {}),
          ...(allowDuplicate ? { allowDuplicate: true } : {}),
        },
      });
      setF(emptyForm());
      setNextAction('');
      setNextAt('');
      onCreated(r.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} wide title="Nuevo prospecto" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="lead-form" loading={busy}>Registrar prospecto</Button></>}>
      <form id="lead-form" onSubmit={(e) => submit(e)} className="flex flex-col gap-4">
        {dups ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm" role="alert">
            <p className="font-medium">Ya hay un prospecto con ese correo o teléfono</p>
            <ul className="mt-1 list-disc pl-5">
              {dups.map((d) => <li key={d.id}><Link className="underline" href={`/plataforma/ventas/${d.id}`}>{leadNo(d.number)} · {d.name}{d.company ? ` (${d.company})` : ''}</Link> · {LEAD_STATUS[d.status].label}</li>)}
            </ul>
            <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={(e) => submit(e as unknown as React.FormEvent, true)}>Registrar de todos modos</Button>
          </div>
        ) : <ErrorBox error={error} />}
        <LeadFields f={f} set={(p) => setF({ ...f, ...p })} />
        <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-3">
          <Field label="Responsable">
            <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="me">Yo</option>
              <option value="">Sin responsable</option>
              {owners.data?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </Field>
          <Field label="Próxima acción (opcional)"><Input value={nextAction} onChange={(e) => setNextAction(e.target.value)} maxLength={300} placeholder="Llamar para agendar demo" /></Field>
          <Field label="Fecha de la próxima acción"><Input type="datetime-local" value={nextAt} onChange={(e) => setNextAt(e.target.value)} required={!!nextAction.trim()} /></Field>
        </div>
      </form>
    </Dialog>
  );
}
