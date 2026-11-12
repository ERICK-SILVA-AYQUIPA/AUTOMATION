import { setTestEnv, createTestApp, ownerClient, resetDatabase } from './helpers.js';

setTestEnv();
process.env.THROTTLE_DISABLED = 'false';

describe('Rate limiting', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const owner = ownerClient();

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
    // Los contadores viven en Redis: se limpian los de ejecuciones anteriores
    const { REDIS } = await import('../src/health/redis.provider.js');
    const redis = ctx.app.get<import('ioredis').Redis>(REDIS);
    const keys = await redis.keys('aisa-test:throttle:*');
    if (keys.length) await redis.del(...keys);
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
  });

  it('bloquea con 429 tras 10 intentos de login por minuto', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await ctx.http().post('/api/v1/auth/login').send({ email: 'x@y.test', password: 'Cualquiera123' });
      codes.push(r.status);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it('el contador está en Redis: otra instancia de la API comparte el límite', async () => {
    const other = await createTestApp();
    try {
      const r = await other.http().post('/api/v1/auth/login').send({ email: 'x@y.test', password: 'Cualquiera123' });
      expect(r.status).toBe(429);
    } finally {
      await other.app.close();
    }
  });

  it('un X-Request-Id con formato peligroso se sustituye por uno propio', async () => {
    const ok = await ctx.http().get('/api/v1/health/live').set('X-Request-Id', 'abc12345-ok').expect(200);
    expect(ok.headers['x-request-id']).toBe('abc12345-ok');
    const bad = await ctx.http().get('/api/v1/health/live').set('X-Request-Id', 'id falso <script> ' + 'x'.repeat(300)).expect(200);
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('la comprobación de salud no expone detalles internos', async () => {
    const r = await ctx.http().get('/api/v1/health/ready').expect(200);
    expect(JSON.stringify(r.body)).not.toMatch(/error/);
  });

  it('las cabeceras de seguridad están presentes', async () => {
    const r = await ctx.http().get('/api/v1/health/live').expect(200);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-request-id']).toBeTruthy();
  });
});
