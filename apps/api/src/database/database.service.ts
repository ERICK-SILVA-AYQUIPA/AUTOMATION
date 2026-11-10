import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { ENV, type Env } from '../config/env.js';

export type Tx = Prisma.TransactionClient;

/**
 * Acceso a datos con dos identidades de BD:
 *
 *  - `tenant(tenantId, fn)`: rol de EJECUCIÓN (sin BYPASSRLS). Abre una
 *    transacción, fija app.tenant_id con set_config(..., true) (solo dura la
 *    transacción) y ejecuta fn. PostgreSQL RLS garantiza que fn solo ve filas
 *    de esa empresa aunque una consulta olvide filtrar por tenant.
 *  - `system`: rol de SISTEMA (BYPASSRLS). Solo para operaciones que por
 *    definición no tienen tenant aún (login, registro, enrutado de webhooks,
 *    panel de plataforma). Su uso está acotado a servicios concretos.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly runtime: PrismaClient;
  readonly system: PrismaClient;

  constructor(@Inject(ENV) env: Env) {
    this.runtime = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.runtimeDatabaseUrl }) });
    this.system = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.systemDatabaseUrl }) });
  }

  async tenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, opts?: { timeout?: number }): Promise<T> {
    if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error('tenantId inválido');
    return this.runtime.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return fn(tx);
      },
      { timeout: opts?.timeout ?? 10_000 },
    );
  }

  async ping(): Promise<void> {
    await this.runtime.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy() {
    await Promise.all([this.runtime.$disconnect(), this.system.$disconnect()]);
  }
}
