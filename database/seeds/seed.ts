/**
 * Datos BASE (idempotente, apto para producción): planes y administrador
 * general. NO crea datos ficticios de negocio; la demo vive en demo.ts.
 *
 * Uso: pnpm --filter @aisa/api db:seed
 */
import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';
import { PrismaClient } from '../../apps/api/src/generated/prisma/client.js';
import { loadRootEnv } from '../../apps/api/src/config/load-root-env.js';

loadRootEnv();
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Falta ${k}`);
  return v;
};
const port = process.env.APP_DB_PORT ?? process.env.POSTGRES_HOST_PORT ?? '5433';
const url = `postgresql://${encodeURIComponent(need('APP_DB_USER'))}:${encodeURIComponent(need('APP_DB_PASSWORD'))}@${process.env.APP_DB_HOST ?? '127.0.0.1'}:${port}/${need('APP_DB_NAME')}`;
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

// Precios orientativos editables desde el panel de plataforma; no hay cobros reales.
const PLANS = [
  {
    code: 'BASIC' as const, name: 'Básico', priceMonthly: '29.00',
    limits: { maxUsers: 3, maxWhatsappNumbers: 1, maxConversationsPerMonth: 500, maxProducts: 300, maxBranches: 1, features: [] },
  },
  {
    code: 'PROFESSIONAL' as const, name: 'Profesional', priceMonthly: '79.00',
    limits: { maxUsers: 10, maxWhatsappNumbers: 2, maxConversationsPerMonth: 3000, maxProducts: 3000, maxBranches: 1, features: ['human_handoff', 'reports', 'advanced_automations', 'advanced_ai'] },
  },
  {
    code: 'ENTERPRISE' as const, name: 'Empresarial', priceMonthly: '199.00',
    limits: { maxUsers: 50, maxWhatsappNumbers: 10, maxConversationsPerMonth: 20000, maxProducts: 50000, maxBranches: 20, features: ['human_handoff', 'reports', 'advanced_automations', 'advanced_ai', 'multi_branch', 'advanced_roles'] },
  },
];

async function main() {
  for (const p of PLANS) {
    // update vacío: no pisa precios/límites editados después
    await prisma.plan.upsert({ where: { code: p.code }, create: { ...p, currency: 'USD' }, update: {} });
  }
  console.log(`Planes: ${PLANS.map((p) => p.code).join(', ')}`);

  const email = need('PLATFORM_ADMIN_EMAIL').toLowerCase();
  const exists = await prisma.user.findUnique({ where: { email } });
  if (!exists) {
    await prisma.user.create({
      data: {
        email, name: 'Administrador general', role: 'PLATFORM_ADMIN', status: 'ACTIVE', emailVerifiedAt: new Date(),
        passwordHash: await argon2.hash(need('PLATFORM_ADMIN_PASSWORD'), { type: argon2.argon2id }),
      },
    });
    console.log(`Administrador general creado: ${email} (contraseña en PLATFORM_ADMIN_PASSWORD de .env)`);
  } else {
    console.log(`Administrador general ya existe: ${email}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
