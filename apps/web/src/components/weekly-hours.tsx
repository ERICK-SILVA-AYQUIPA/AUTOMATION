'use client';

import { Button, Input } from '@/components/ui';
import type { WeeklyHours } from '@/lib/types';

export const DAYS = [['mon', 'Lunes'], ['tue', 'Martes'], ['wed', 'Miércoles'], ['thu', 'Jueves'], ['fri', 'Viernes'], ['sat', 'Sábado'], ['sun', 'Domingo']] as const;
export type Day = (typeof DAYS)[number][0];
export type Range = { open: string; close: string };
/** Punto de partida al activar un horario (la empresa lo ajusta) */
export const DEFAULT_WEEK: WeeklyHours = {
  mon: [{ open: '09:00', close: '18:00' }], tue: [{ open: '09:00', close: '18:00' }], wed: [{ open: '09:00', close: '18:00' }],
  thu: [{ open: '09:00', close: '18:00' }], fri: [{ open: '09:00', close: '18:00' }], sat: [{ open: '09:00', close: '13:00' }], sun: [],
};

/** Horario semanal: hasta dos turnos por día (lo usan el asistente y las reservas) */
export function WeekGrid({ hours, onChange, label = 'Abierto' }: { hours: WeeklyHours; onChange: (h: WeeklyHours) => void; label?: string }) {
  const setDay = (day: Day, ranges: Range[]) => onChange({ ...hours, [day]: ranges });
  return (
    <div className="flex flex-col gap-2">
      {DAYS.map(([k, name]) => (
        <div key={k} className="grid grid-cols-[6.5rem_1fr] items-center gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={hours[k].length > 0} onChange={(e) => setDay(k, e.target.checked ? [{ open: '09:00', close: '18:00' }] : [])} aria-label={`${label} el ${name.toLowerCase()}`} />
            {name}
          </label>
          {hours[k].length === 0 ? (
            <span className="text-muted">Cerrado</span>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {hours[k].map((r, i) => (
                <span key={i} className="flex items-center gap-1">
                  <span className="w-28"><Input type="time" value={r.open} aria-label={`${name}: abre`} onChange={(e) => setDay(k, hours[k].map((x, j) => (j === i ? { ...x, open: e.target.value } : x)))} /></span>
                  –
                  <span className="w-28"><Input type="time" value={r.close} aria-label={`${name}: cierra`} onChange={(e) => setDay(k, hours[k].map((x, j) => (j === i ? { ...x, close: e.target.value } : x)))} /></span>
                </span>
              ))}
              {hours[k].length < 2 ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => setDay(k, [...hours[k], { open: '15:00', close: '19:00' }])}>+ turno</Button>
              ) : (
                <Button type="button" size="sm" variant="ghost" onClick={() => setDay(k, hours[k].slice(0, 1))}>Quitar turno</Button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
