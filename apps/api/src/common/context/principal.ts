import type { Role } from '../../generated/prisma/enums.js';

/** Identidad autenticada de la petición. tenantId viene SIEMPRE del token verificado. */
export interface Principal {
  userId: string;
  tenantId: string | null;
  role: Role;
  sessionId: string;
  email: string;
}

/** Principal de un usuario de empresa (tenantId garantizado). */
export interface TenantPrincipal extends Principal {
  tenantId: string;
}
