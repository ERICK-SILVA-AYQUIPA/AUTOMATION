import { z } from 'zod';

/** Política de contraseñas: >= 10 caracteres, con letras y números. */
export const password = z
  .string()
  .min(10, 'La contraseña debe tener al menos 10 caracteres')
  .max(128)
  .regex(/[A-Za-z]/, 'La contraseña debe incluir letras')
  .regex(/\d/, 'La contraseña debe incluir números');

const email = z.email('Correo inválido').max(254).transform((v) => v.trim().toLowerCase());

export const registerCompanySchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  adminName: z.string().trim().min(2).max(120),
  email,
  password,
  currency: z.string().regex(/^[A-Z]{3}$/).default('PEN'),
  timezone: z
    .string()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('es', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Zona horaria inválida')
    .default('America/Lima'),
});
export type RegisterCompanyInput = z.infer<typeof registerCompanySchema>;

export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export type LoginInput = z.infer<typeof loginSchema>;

export const emailOnlySchema = z.object({ email });
export const tokenSchema = z.object({ token: z.string().min(20).max(200) });

export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const acceptInvitationSchema = z.object({
  token: z.string().min(20).max(200),
  password,
  name: z.string().trim().min(2).max(120).optional(),
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
