import { z } from 'zod';
import { money, paginationSchema } from '../common/pagination.js';

const sku = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._\-/]+$/, 'SKU: solo letras, números y . _ - /');
const barcode = z.string().trim().regex(/^[0-9A-Za-z-]{4,64}$/, 'Código de barras inválido');

export const categorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  parentId: z.uuid().nullish(),
  isActive: z.boolean().optional(),
});
export const updateCategorySchema = categorySchema.partial();

export const variantSchema = z.object({
  sku,
  barcode: barcode.nullish(),
  name: z.string().trim().min(1).max(120),
  attributes: z.record(z.string().max(40), z.string().max(80)).default({}),
  salePrice: money.nullish(),
  costPrice: money.nullish(),
  isActive: z.boolean().optional(),
});
export const updateVariantSchema = variantSchema.partial();

export const createProductSchema = z.object({
  sku,
  barcode: barcode.nullish(),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(5000).nullish(),
  categoryId: z.uuid().nullish(),
  salePrice: money,
  costPrice: money.nullish(),
  minStock: z.number().int().min(0).default(0),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  /** Si se omite, se crea una variante única con el mismo SKU */
  variants: z.array(variantSchema).max(200).optional(),
  /** Stock inicial en la sucursal predeterminada (solo variante única) */
  initialStock: z.number().int().min(0).max(1_000_000).optional(),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z
  .object({
    sku, barcode: barcode.nullish(), name: z.string().trim().min(1).max(160), description: z.string().trim().max(5000).nullish(),
    categoryId: z.uuid().nullish(), salePrice: money, costPrice: money.nullish(), minStock: z.number().int().min(0),
    status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nada que actualizar');
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const listProductsSchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  categoryId: z.uuid().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
  lowStock: z.enum(['true', 'false']).optional(),
  sort: z.enum(['name', '-name', 'createdAt', '-createdAt', 'salePrice', '-salePrice']).default('name'),
});
export type ListProductsQuery = z.infer<typeof listProductsSchema>;
