'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LifeBuoy, Plus } from 'lucide-react';
import { RequirePermission } from '@/components/guard';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Field, Input, Loading, PageHeader, Select, Table, Td, Textarea, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { KIND, PRIORITY, STATUS, ticketNo, type SupportKind, type SupportPriority, type Ticket, type TicketDetail } from '@/lib/support';

interface Info { tickets: boolean; contact: string | null; firstResponseHours: Record<SupportPriority, number> }

function NewTicket({ open, onClose, hours }: { open: boolean; onClose: () => void; hours: Info['firstResponseHours'] }) {
  const router = useRouter();
  const toast = useToast();
  const [f, setF] = useState<{ kind: SupportKind; priority: SupportPriority; subject: string; body: string }>({ kind: 'QUESTION', priority: 'NORMAL', subject: '', body: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await api<TicketDetail>('/support/tickets', { method: 'POST', body: f });
      toast.success(`Caso ${ticketNo(t.number)} enviado`);
      router.push(`/soporte/${t.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Nuevo caso" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" form="ticket-form" loading={busy}>Enviar caso</Button></>}>
      <form id="ticket-form" onSubmit={submit} className="flex flex-col gap-4">
        <ErrorBox error={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tipo">
            <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as SupportKind })}>
              {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Prioridad" hint={`Primera respuesta en ${hours[f.priority]} h como máximo`}>
            <Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as SupportPriority })}>
              {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Asunto"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} minLength={3} maxLength={200} required /></Field>
        <Field label="Detalle" hint="Qué pasó, desde cuándo y a quién afecta. No escribas contraseñas ni claves.">
          <Textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} rows={5} maxLength={10000} required />
        </Field>
      </form>
    </Dialog>
  );
}

function Support() {
  const info = useQuery({ queryKey: ['support-info'], queryFn: () => api<Info>('/support/info') });
  const list = useQuery({ queryKey: ['support-tickets'], queryFn: () => api<Ticket[]>('/support/tickets') });
  const [creating, setCreating] = useState(false);
  if (info.isLoading) return <Loading />;
  if (info.error) return <ErrorBox error={info.error} />;
  const i = info.data!;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Soporte"
        description={i.tickets ? 'Abre un caso y síguelo aquí; te avisamos por correo cuando respondamos.' : 'Tu instalación es independiente: la atención se coordina por el contacto de soporte.'}
        actions={i.tickets ? <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Nuevo caso</Button> : undefined}
      />
      {i.contact && (
        <Card className="p-4 text-sm">
          <p className="font-medium">Contacto de soporte</p>
          <p className="mt-1 whitespace-pre-line text-muted">{i.contact}</p>
        </Card>
      )}
      {!i.tickets && !i.contact && (
        <Card className="p-4 text-sm text-muted">El contacto de soporte de esta instalación aún no está configurado (variable SUPPORT_CONTACT). Pide al administrador del servidor que lo agregue.</Card>
      )}
      {i.tickets && (
        <>
          <Card className="p-4 text-sm text-muted">
            Plazos de primera respuesta: urgente {i.firstResponseHours.URGENT} h · alta {i.firstResponseHours.HIGH} h · normal {i.firstResponseHours.NORMAL} h · baja {i.firstResponseHours.LOW} h.
          </Card>
          {list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : !list.data?.length ? (
            <EmptyState icon={<LifeBuoy className="size-6" />} title="Sin casos" description="Cuando abras un caso aparecerá aquí con su estado." />
          ) : (
            <Table>
              <thead><tr><Th>Caso</Th><Th>Asunto</Th><Th>Tipo</Th><Th>Estado</Th><Th>Última actividad</Th></tr></thead>
              <tbody>
                {list.data.map((t) => (
                  <tr key={t.id}>
                    <Td className="font-mono text-xs">{ticketNo(t.number)}</Td>
                    <Td><Link href={`/soporte/${t.id}`} className="font-medium text-primary hover:underline">{t.subject}</Link></Td>
                    <Td>{KIND[t.kind]}</Td>
                    <Td><Badge tone={STATUS[t.status].tone}>{STATUS[t.status].label}</Badge>{t.status === 'RESOLVED' && !t.ratedAt && <span className="ml-2 text-xs text-muted">Califica la atención</span>}</Td>
                    <Td>{dateTime(t.lastActivityAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {creating && <NewTicket open onClose={() => setCreating(false)} hours={i.firstResponseHours} />}
        </>
      )}
    </div>
  );
}

export default function SupportPage() {
  return <RequirePermission permission="support:use"><Support /></RequirePermission>;
}
