import { z } from 'zod';

/**
 * Variables de entorno de la API, validadas al arrancar. Si falta algo
 * obligatorio el proceso termina con un mensaje claro (fail fast).
 * Las credenciales de BD se componen a partir de las mismas variables que usa
 * docker-compose (.env raíz), para no duplicar secretos.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().default(4000),
  APP_PUBLIC_URL: z.url().default('http://localhost:3000'),
  API_PUBLIC_URL: z.url().default('http://localhost:4000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  APP_DB_HOST: z.string().default('127.0.0.1'),
  APP_DB_PORT: z.coerce.number().int().optional(),
  POSTGRES_HOST_PORT: z.coerce.number().int().default(5433),
  APP_DB_NAME: z.string().min(1),
  APP_DB_RUNTIME_USER: z.string().min(1),
  APP_DB_RUNTIME_PASSWORD: z.string().min(16),
  APP_DB_SYSTEM_USER: z.string().min(1),
  APP_DB_SYSTEM_PASSWORD: z.string().min(16),

  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_HOST_PORT: z.coerce.number().int().default(6380),
  REDIS_PASSWORD: z.string().min(16),

  /** Clave HMAC de los access tokens (>= 256 bits) */
  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** Clave maestra AES-256-GCM (64 hex) para cifrar tokens de terceros */
  DATA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'debe tener 64 caracteres hex'),

  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  MAIL_FROM: z.string().default('AI Sales Assistant <no-reply@localhost>'),

  /** Carpeta de archivos subidos (volumen persistente en despliegue) */
  STORAGE_DIR: z.string().default('./storage'),
  TRIAL_DAYS: z.coerce.number().int().nonnegative().default(14),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof schema> & {
  runtimeDatabaseUrl: string;
  systemDatabaseUrl: string;
  isProd: boolean;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida:\n${issues}`);
  }
  const e = parsed.data;
  const port = e.APP_DB_PORT ?? e.POSTGRES_HOST_PORT;
  const url = (u: string, p: string) =>
    `postgresql://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${e.APP_DB_HOST}:${port}/${encodeURIComponent(e.APP_DB_NAME)}`;
  return {
    ...e,
    runtimeDatabaseUrl: url(e.APP_DB_RUNTIME_USER, e.APP_DB_RUNTIME_PASSWORD),
    systemDatabaseUrl: url(e.APP_DB_SYSTEM_USER, e.APP_DB_SYSTEM_PASSWORD),
    isProd: e.NODE_ENV === 'production',
  };
}

export const ENV = Symbol('ENV');
