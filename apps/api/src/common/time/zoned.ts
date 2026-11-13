/** Fechas en la zona horaria de la empresa (sin dependencias externas). */

/** Desfase (ms) de la zona respecto de UTC en un instante dado */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(instant / 1000) * 1000;
}

/** Instante UTC de una fecha (YYYY-MM-DD) y hora (HH:MM) locales de la zona */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offsetAt(guess, timeZone);
  t = guess - offsetAt(t, timeZone); // corrige si cruza un cambio de horario
  return new Date(t);
}

/** Fecha, hora y día de la semana locales de un instante */
export function localParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(instant);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}`, weekday: g('weekday').toLowerCase().slice(0, 3) };
}

/** Día de la semana (mon…sun) de una fecha local */
export function weekdayOf(date: string): 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun' {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const)[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

export const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
