import { z } from 'zod';

const tenantRole = z.enum(['TENANT_ADMIN', 'SUPERVISOR', 'SELLER']);

export const inviteUserSchema = z.object({
  email: z.email().max(254).transform((v) => v.trim().toLowerCase()),
  name: z.string().trim().min(2).max(120),
  role: tenantRole,
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    role: tenantRole.optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nada que actualizar');
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
