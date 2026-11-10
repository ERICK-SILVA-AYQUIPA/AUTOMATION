import { setTestEnv, createTestApp, ownerClient, resetDatabase } from './helpers.js';

setTestEnv();
process.env.THROTTLE_DISABLED = 'false';

describe('Rate limiting', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const owner = ownerClient();

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
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

  it('las cabeceras de seguridad están presentes', async () => {
    const r = await ctx.http().get('/api/v1/health/live').expect(200);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-request-id']).toBeTruthy();
  });
});
