import { AutomationKey } from '../generated/prisma/enums.js';
import type { Tx } from '../database/database.service.js';
import { randomToken } from '../common/crypto/crypto.js';

/** Identificador corto y legible a partir del nombre comercial. */
export const slugify = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'empresa';

export async function uniqueSlug(tx: Tx, base: string) {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await tx.tenant.findUnique({ where: { slug: candidate }, select: { id: true } }))) return candidate;
  }
  return `${base}-${randomToken(4).toLowerCase()}`;
}

/**
 * Lo que toda empresa necesita al nacer, venga del autorregistro o del alta
 * desde la plataforma: sucursal principal, ajustes del asistente y el
 * catálogo de automatizaciones (todas apagadas hasta que se activen).
 * Debe ejecutarse con el rol de sistema dentro de la transacción del alta.
 */
export async function bootstrapTenant(tx: Tx, tenantId: string) {
  await tx.branch.create({ data: { tenantId, name: 'Principal', isDefault: true } });
  await tx.aiSettings.create({ data: { tenantId } });
  await tx.automation.createMany({ data: Object.values(AutomationKey).map((key) => ({ tenantId, key })) });
}
