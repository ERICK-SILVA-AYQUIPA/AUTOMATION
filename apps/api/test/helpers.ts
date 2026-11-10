import { Test } from '@nestjs/testing';
import nodemailer from 'nodemailer';
import request from 'supertest';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadRootEnv } from '../src/config/load-root-env.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

/**
 * Entorno de pruebas: base de datos REAL de pruebas (ai_sales_test) con las
 * mismas migraciones y políticas RLS que producción. El correo usa el
 * transporte JSON de nodemailer (no sale a internet) y se captura en memoria.
 */
export function setTestEnv() {
  process.env.NODE_ENV = 'test';
  loadRootEnv();
  if (!process.env.APP_DB_NAME?.endsWith('_test')) process.env.APP_DB_NAME = `${process.env.APP_DB_NAME}_test`;
  process.env.LOG_LEVEL = 'warn';
}

export function ownerClient() {
  const e = process.env;
  const port = e.APP_DB_PORT ?? e.POSTGRES_HOST_PORT ?? '5433';
  const url = `postgresql://${encodeURIComponent(e.APP_DB_USER!)}:${encodeURIComponent(e.APP_DB_PASSWORD!)}@${e.APP_DB_HOST ?? '127.0.0.1'}:${port}/${e.APP_DB_NAME}`;
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

export function roleClient(kind: 'runtime' | 'system') {
  const e = process.env;
  const port = e.APP_DB_PORT ?? e.POSTGRES_HOST_PORT ?? '5433';
  const [u, p] = kind === 'runtime' ? [e.APP_DB_RUNTIME_USER!, e.APP_DB_RUNTIME_PASSWORD!] : [e.APP_DB_SYSTEM_USER!, e.APP_DB_SYSTEM_PASSWORD!];
  const url = `postgresql://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${e.APP_DB_HOST ?? '127.0.0.1'}:${port}/${e.APP_DB_NAME}`;
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

/** Vacía todas las tablas (excepto migraciones) y recrea los planes. */
export async function resetDatabase(db: PrismaClient) {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
  const base = { maxWhatsappNumbers: 1, maxConversationsPerMonth: 500, maxProducts: 300, maxBranches: 1, features: [] };
  await db.plan.createMany({
    data: [
      { code: 'BASIC', name: 'Básico', priceMonthly: '29.00', limits: { ...base, maxUsers: 3 } },
      { code: 'PROFESSIONAL', name: 'Profesional', priceMonthly: '79.00', limits: { ...base, maxUsers: 10 } },
      { code: 'ENTERPRISE', name: 'Empresarial', priceMonthly: '199.00', limits: { ...base, maxUsers: 50 } },
    ],
  });
}

export interface SentMail {
  to: string;
  subject: string;
  text: string;
}

export async function createTestApp() {
  const { AppModule } = await import('../src/app.module.js');
  const { configureApp } = await import('../src/bootstrap.js');
  const { MailService } = await import('../src/mail/mail.service.js');
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication({ logger: ['error'] });
  configureApp(app);
  const outbox: SentMail[] = [];
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const mail = app.get(MailService);
  mail.useTransport(transport);
  const origSend = transport.sendMail.bind(transport);
  // Captura cada correo realmente procesado por el transporte
  (transport as unknown as { sendMail: typeof origSend }).sendMail = (async (m: Parameters<typeof origSend>[0]) => {
    const info = await origSend(m);
    const parsed = JSON.parse((info as unknown as { message: string }).message);
    outbox.push({ to: parsed.to[0].address, subject: parsed.subject, text: parsed.text });
    return info;
  }) as typeof origSend;
  await app.init();
  return { app, outbox, http: () => request(app.getHttpServer()) };
}

export const tokenFrom = (text: string) => /token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? '';

/** Registra empresa + verifica correo + inicia sesión. Devuelve el access token. */
export async function registerAndLogin(
  ctx: Awaited<ReturnType<typeof createTestApp>>,
  data: { companyName: string; adminName?: string; email: string; password?: string },
) {
  const password = data.password ?? 'ClaveSegura123';
  const reg = await ctx.http().post('/api/v1/auth/register').send({ adminName: 'Admin', ...data, password }).expect(201);
  const mail = ctx.outbox.filter((m) => m.to === data.email).at(-1)!;
  await ctx.http().post('/api/v1/auth/verify-email').send({ token: tokenFrom(mail.text) }).expect(204);
  const login = await ctx.http().post('/api/v1/auth/login').send({ email: data.email, password }).expect(200);
  return { accessToken: login.body.accessToken as string, tenantId: reg.body.tenantId as string, userId: reg.body.userId as string, cookies: login.headers['set-cookie'] as unknown as string[] };
}
