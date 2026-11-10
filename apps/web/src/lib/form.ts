import { ApiError } from './api';

/** Convierte los errores de validación de la API ({ path, message }[]) en un mapa campo → mensaje */
export function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError) || !e.errors) return {};
  const out: Record<string, string> = {};
  for (const x of e.errors) out[x.path] ??= x.message;
  return out;
}

/** "Talla: M, Color: Rojo" ⇄ { Talla: 'M', Color: 'Rojo' } */
export const parseAttributes = (s: string) =>
  Object.fromEntries(
    s
      .split(',')
      .map((p) => p.split(':').map((x) => x.trim()))
      .filter((p) => p.length === 2 && p[0] && p[1]) as [string, string][],
  );
export const formatAttributes = (a: Record<string, string>) => Object.entries(a).map(([k, v]) => `${k}: ${v}`).join(', ');

/** Cadena vacía → null (para campos opcionales) */
export const orNull = (s: string) => (s.trim() === '' ? null : s.trim());
