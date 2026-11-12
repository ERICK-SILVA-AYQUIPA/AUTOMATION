// Configuración de Prisma CLI. El esquema y las migraciones viven en /database.
// Las migraciones se ejecutan con el rol PROPIETARIO (APP_DB_USER); la API usa
// roles con menos privilegios (ver src/database/database.service.ts).
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({ path: new URL('../../.env', import.meta.url).pathname, quiet: true });

const e = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Falta la variable ${k} (ejecuta infrastructure/scripts/setup.sh)`);
  return encodeURIComponent(v);
};

const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ||
  `postgresql://${e('APP_DB_USER')}:${e('APP_DB_PASSWORD')}@${process.env.APP_DB_HOST ?? '127.0.0.1'}:${process.env.APP_DB_PORT ?? process.env.POSTGRES_HOST_PORT ?? '5433'}/${e('APP_DB_NAME')}`;

export default defineConfig({
  schema: '../../database/schema/schema.prisma',
  migrations: {
    path: '../../database/migrations',
    seed: 'tsx ../../database/seeds/seed.ts',
  },
  datasource: { url: migrationUrl },
});
