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
  it('en producción exige https públicos, SMTP y tokens de integración', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/APP_PUBLIC_URL[\s\S]*CORS_ORIGINS[\s\S]*SMTP_HOST/);
    const prod = {
      ...base, NODE_ENV: 'production', APP_PUBLIC_URL: 'https://app.ejemplo.pe', API_PUBLIC_URL: 'https://app.ejemplo.pe',
      CORS_ORIGINS: 'https://app.ejemplo.pe', SMTP_HOST: 'smtp.ejemplo.pe', MAIL_FROM: 'Ventas <no-reply@ejemplo.pe>',
    };
    expect(loadEnv(prod).isProd).toBe(true);
    expect(() => loadEnv({ ...prod, N8N_WEBHOOK_BASE_URL: 'http://n8n:5678/webhook' })).toThrow(/N8N_INTERNAL_TOKEN/);
    expect(() => loadEnv({ ...prod, WHATSAPP_GRAPH_BASE_URL: 'http://127.0.0.1:4999' })).toThrow(/WHATSAPP_GRAPH_BASE_URL/);
    expect(() => loadEnv({ ...prod, CHATWOOT_PLATFORM_TOKEN: 't', CHATWOOT_WEBHOOK_BASE_URL: 'http://api:4000' })).toThrow(/CHATWOOT_WEBHOOK_BASE_URL/);
  });
});
