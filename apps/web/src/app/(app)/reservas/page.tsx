'use client';

import { useState } from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fieldErrors } from '@/lib/form';
import { customerLabel, dayIn, phoneLabel, RESERVATION_ACTIONS, RESERVATION_STATUS, timeIn, todayIn } from '@/lib/format';
import { useTenantSettings } from '@/lib/settings';
import type { Availability, Paged, Product, Reservation } from '@/lib/types';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Field, Input, Loading, PageHeader, Pagination, Select, Table, Td, Textarea, Th } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { RequirePermission } from '@/components/guard';

function Reservations() {
  const { me, can } = useAuth();
  const settings = useTenantSettings().reservations;
  const tz = me?.tenant?.timezone ?? 'America/Lima';
  const qc = useQueryClient();
  const toast = useToast();
  const [day, setDay] = useState(() => todayIn(tz));
  const [upcoming, setUpcoming] = useState(false);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const appointment = settings.kind === 'APPOINTMENT';
  const configured = !!settings.hours && !!settings.capacity;

  const list = useQuery({
    queryKey: ['reservations', upcoming ? null : day, status, page],
    queryFn: () => api<Paged<Reservation>>('/reservations', { query: { date: upcoming ? undefined : day, status: status || undefined, page, pageSize: 50 } }),
    placeholderData: keepPreviousData,
  });
  const slots = useQuery({
    queryKey: ['reservation-availability', day],
    enabled: !upcoming,
    queryFn: () => api<Availability>('/reservations/availability', { query: { date: day } }),
  });

  const move = async (r: Reservation, to: string) => {
    setBusy(`${r.id}:${to}`);
    try {
      await api(`/reservations/${r.id}/status`, { method: 'PATCH', body: { status: to } });
      toast.success(`Reserva #${r.number}: ${RESERVATION_STATUS[to]?.label.toLowerCase()}`);
      await qc.invalidateQueries({ queryKey: ['reservations'] });
      await qc.invalidateQueries({ queryKey: ['reservation-availability'] });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title={appointment ? 'Citas' : 'Reservas'}
        description={appointment ? 'Citas agendadas desde el panel o por WhatsApp. El cupo se controla por horario.' : 'Reservas de mesa desde el panel o por WhatsApp. El aforo se controla por horario.'}
        actions={can('reservations:write') && configured && <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>{appointment ? 'Nueva cita' : 'Nueva reserva'}</Button>}
      />
      {!configured && (
        <div className="mb-4 rounded-xl border border-warning/40 bg-amber-500/5 px-4 py-3 text-sm" role="status">
          <p className="font-medium">Falta configurar las reservas</p>
          <p className="mt-1 text-muted">
            Indica el horario y la capacidad reales de tu negocio. Mientras falten, ni el panel ni el asistente aceptan reservas.
            {can('tenant:settings') && <> <Link href="/configuracion#operacion" className="text-primary underline">Configurar ahora</Link></>}
          </p>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <Card>
          <div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row sm:items-center">
            <Input type="date" className="sm:w-44" value={day} disabled={upcoming} onChange={(e) => { if (e.target.value) { setDay(e.target.value); setPage(1); } }} aria-label="Día" />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={upcoming} onChange={(e) => { setUpcoming(e.target.checked); setPage(1); }} />
              Todas las próximas
            </label>
            <Select className="sm:ml-auto sm:w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Estado">
              <option value="">Todos los estados</option>
              {Object.entries(RESERVATION_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
          </div>
          <ErrorBox error={list.error} />
          {list.isLoading ? <Loading /> : !list.data?.items.length ? (
            <EmptyState icon={<CalendarDays className="size-5" />} title={upcoming ? 'No hay reservas próximas' : 'No hay reservas este día'} description={status ? 'Prueba con otro estado.' : undefined} />
          ) : (
            <>
              <Table>
                <thead><tr><Th>Hora</Th><Th>N.º</Th><Th>Cliente</Th><Th>{appointment ? 'Servicio' : 'Personas'}</Th><Th>Canal</Th><Th>Estado</Th><Th className="text-right">Acciones</Th></tr></thead>
                <tbody>
                  {list.data.items.map((r) => (
                    <tr key={r.id}>
                      <Td className="whitespace-nowrap font-medium tabular-nums">
                        {timeIn(r.startsAt, tz)}–{timeIn(r.endsAt, tz)}
                        {upcoming && <span className="block text-xs font-normal text-muted">{dayIn(r.startsAt, tz)}</span>}
                      </Td>
                      <Td>#{r.number}</Td>
                      <Td>
                        <Link href={`/clientes/${r.customer.id}`} className="hover:underline">{customerLabel(r.customer)}</Link>
                        <span className="block text-xs text-muted">{phoneLabel(r.customer.phone)}</span>
                        {r.notes && <span className="block max-w-xs truncate text-xs text-muted" title={r.notes}>{r.notes}</span>}
                      </Td>
                      <Td>{appointment ? (r.serviceName ?? '—') : r.partySize}</Td>
                      <Td><Badge tone={r.channel === 'WHATSAPP' ? 'success' : 'neutral'}>{r.channel === 'WHATSAPP' ? 'WhatsApp' : 'Manual'}</Badge></Td>
                      <Td><Badge tone={RESERVATION_STATUS[r.status]?.tone}>{RESERVATION_STATUS[r.status]?.label ?? r.status}</Badge></Td>
                      <Td className="text-right">
                        {can('reservations:write') && (
                          <div className="flex flex-wrap justify-end gap-1">
                            {(RESERVATION_ACTIONS[r.status] ?? []).map((a) => (
                              <Button key={a.to} size="sm" variant={a.to === 'CANCELLED' || a.to === 'NO_SHOW' ? 'ghost' : 'secondary'} loading={busy === `${r.id}:${a.to}`} disabled={!!busy} onClick={() => move(r, a.to)}>{a.label}</Button>
                            ))}
                          </div>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} onPage={setPage} />
            </>
          )}
        </Card>
        {!upcoming && configured && (
          <Card className="h-fit p-4">
            <h2 className="text-sm font-semibold">Horarios libres</h2>
            <p className="mt-0.5 text-xs text-muted">{appointment ? 'Cupos por horario' : `Aforo libre (de ${settings.capacity} personas)`}</p>
            <div className="mt-3">
              {slots.isLoading ? <Loading /> : slots.error ? <ErrorBox error={slots.error} /> : !slots.data?.slots.length ? (
                <p className="text-sm text-muted">{slots.data?.reason ?? 'Sin horarios libres'}</p>
              ) : (
                <ul className="grid grid-cols-3 gap-1.5 text-sm" aria-label="Horarios libres">
                  {slots.data.slots.map((s) => (
                    <li key={s.time} className="rounded-lg border border-border px-2 py-1 text-center tabular-nums">
                      {s.time}
                      <span className="block text-[11px] text-muted">{s.remaining} libre{s.remaining === 1 ? '' : 's'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        )}
      </div>
      {creating && <CreateDialog day={day} onClose={() => setCreating(false)} onCreated={(r, date) => { setCreating(false); setUpcoming(false); setDay(date); toast.success(`${appointment ? 'Cita' : 'Reserva'} #${r.number} registrada`); }} />}
    </>
  );
}

function CreateDialog({ day, onClose, onCreated }: { day: string; onClose: () => void; onCreated: (r: Reservation, date: string) => void }) {
  const settings = useTenantSettings().reservations;
  const appointment = settings.kind === 'APPOINTMENT';
  const qc = useQueryClient();
  const [f, setF] = useState({ phone: '', name: '', date: day, time: '', partySize: 2, productId: '', notes: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  // Una sola clave por diálogo: un doble clic no crea dos reservas
  const [key] = useState(() => `panel:${crypto.randomUUID()}`);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const partySize = appointment ? 1 : f.partySize;

  const services = useQuery({
    queryKey: ['services'],
    enabled: appointment,
    queryFn: () => api<Paged<Product>>('/products', { query: { trackStock: 'false', status: 'ACTIVE', pageSize: 200 } }),
  });
  const slots = useQuery({
    queryKey: ['reservation-availability', f.date, partySize, f.productId],
    enabled: !!f.date && partySize > 0,
    queryFn: () => api<Availability>('/reservations/availability', { query: { date: f.date, partySize, productId: f.productId || undefined } }),
  });

  const save = async () => {
    setSaving(true);
    setErrors({});
    setError(null);
    try {
      const r = await api<Reservation>('/reservations', {
        method: 'POST',
        body: {
          customer: { phone: f.phone, ...(f.name.trim() ? { name: f.name.trim() } : {}) },
          date: f.date, time: f.time, partySize, productId: f.productId || null, notes: f.notes.trim() || null, idempotencyKey: key,
        },
      });
      await qc.invalidateQueries({ queryKey: ['reservations'] });
      await qc.invalidateQueries({ queryKey: ['reservation-availability'] });
      onCreated(r, f.date);
    } catch (e) {
      const fe = fieldErrors(e);
      setErrors({ ...fe, phone: fe['customer.phone'] ?? fe.phone });
      if (!Object.keys(fe).length) setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={appointment ? 'Nueva cita' : 'Nueva reserva'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={save} loading={saving} disabled={!f.phone || !f.time || (appointment && !f.productId)}>Registrar</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Teléfono del cliente" error={errors.phone} hint="Con código de país, p. ej. 51987654321">
            <Input inputMode="tel" value={f.phone} onChange={(e) => set({ phone: e.target.value })} invalid={!!errors.phone} />
          </Field>
          <Field label="Nombre" hint="Si es un cliente nuevo">
            <Input value={f.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} />
          </Field>
        </div>
        {appointment ? (
          <Field label="Servicio" error={errors.productId}>
            <Select value={f.productId} onChange={(e) => set({ productId: e.target.value, time: '' })}>
              <option value="">Elige un servicio</option>
              {services.data?.items.map((p) => <option key={p.id} value={p.id}>{p.name}{p.durationMinutes ? ` (${p.durationMinutes} min)` : ''}</option>)}
            </Select>
          </Field>
        ) : (
          <Field label="Personas" error={errors.partySize} hint={`Máximo ${settings.maxPartySize} por reserva`}>
            <Input type="number" min={1} max={settings.maxPartySize} value={f.partySize} onChange={(e) => set({ partySize: Math.max(1, Number(e.target.value) || 1), time: '' })} />
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Fecha" error={errors.date}>
            <Input type="date" value={f.date} onChange={(e) => set({ date: e.target.value, time: '' })} />
          </Field>
          <Field label="Hora" error={errors.time ?? (slots.data && !slots.data.slots.length ? (slots.data.reason ?? undefined) : undefined)}>
            <Select value={f.time} onChange={(e) => set({ time: e.target.value })} disabled={!slots.data?.slots.length}>
              <option value="">{slots.isLoading ? 'Buscando horarios…' : 'Elige la hora'}</option>
              {slots.data?.slots.map((s) => <option key={s.time} value={s.time}>{s.time} · {s.remaining} libre{s.remaining === 1 ? '' : 's'}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Notas" hint="Opcional">
          <Textarea rows={2} maxLength={1000} value={f.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
        <ErrorBox error={error} />
      </div>
    </Dialog>
  );
}

export default function ReservasPage() {
  return <RequirePermission permission="reservations:read"><Reservations /></RequirePermission>;
}
