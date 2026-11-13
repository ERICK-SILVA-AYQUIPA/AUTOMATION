import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { money } from '../common/pagination.js';

/**
 * Precios por volumen (ADR 043): desde `minQty` unidades de una variante, cada
 * unidad cuesta `unitPrice`. Los tramos van de menor a mayor cantidad y con
 * precio cada vez más bajo. El pedido siempre los calcula el backend.
 */
export const priceTiersSchema = z
  .array(z.object({ minQty: z.number().int().min(2).max(1_000_000), unitPrice: money }).strict())
  .max(6)
  .refine((t) => t.every((x, i) => i === 0 || (x.minQty > t[i - 1]!.minQty && Number(x.unitPrice) < Number(t[i - 1]!.unitPrice))), {
    message: 'Ordena los tramos de menor a mayor cantidad, con precio cada vez más bajo',
  });
export type PriceTier = { minQty: number; unitPrice: string };

/** Lee los tramos guardados; si algo no es válido se ignoran (se cobra el precio normal). */
export function readTiers(stored: unknown): PriceTier[] {
  const r = priceTiersSchema.safeParse(stored);
  return r.success ? r.data : [];
}

/** Precio unitario para una cantidad: el tramo más alto alcanzado, o el precio base. */
export function unitPriceFor(base: Prisma.Decimal, tiers: PriceTier[], quantity: number): Prisma.Decimal {
  let unit = base;
  for (const t of tiers) if (quantity >= t.minQty) unit = new Prisma.Decimal(t.unitPrice);
  return unit;
}

/** Los tramos deben abaratar el precio base */
export function assertTiersBelow(base: string | number | Prisma.Decimal, tiers: PriceTier[]) {
  if (tiers.length && Number(tiers[0]!.unitPrice) >= Number(base)) return 'El precio por volumen debe ser menor que el precio normal';
  return null;
}
