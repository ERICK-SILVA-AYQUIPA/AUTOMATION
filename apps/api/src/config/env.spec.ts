import { loadEnv } from './env.js';

const base = {
  APP_DB_NAME: 'db', APP_DB_RUNTIME_USER: 'rt', APP_DB_RUNTIME_PASSWORD: 'p@ss:word/1234567',
  APP_DB_SYSTEM_USER: 'sy', APP_DB_SYSTEM_PASSWORD: 'x'.repeat(20), REDIS_PASSWORD: 'r'.repeat(20),
  JWT_SECRET: 'j'.repeat(40), DATA_ENCRYPTION_KEY: 'f'.repeat(64),
};

describe('configuración', () => {
  it('compone URLs de BD escapando credenciales', () => {
    const env = loadEnv(base);
    expect(env.runtimeDatabaseUrl).toBe('postgresql://rt:p%40ss%3Aword%2F1234567@127.0.0.1:5433/db');
    expect(env.isProd).toBe(false);
  });
  it('falla con mensaje claro si falta un secreto', () => {
    expect(() => loadEnv({ ...base, JWT_SECRET: 'corto' })).toThrow(/JWT_SECRET/);
    expect(() => loadEnv({ ...base, DATA_ENCRYPTION_KEY: undefined })).toThrow(/DATA_ENCRYPTION_KEY/);
  });
});
