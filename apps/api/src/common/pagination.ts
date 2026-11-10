import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export const paged = <T>(items: T[], total: number, page: number, pageSize: number) => ({
  items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)),
});

/** Decimal monetario: acepta número o string, máx. 2 decimales, >= 0 */
export const money = z
  .union([z.number(), z.string()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,10}(\.\d{1,2})?$/.test(v), 'Importe inválido (máx. 2 decimales)');
