import { setTestEnv, createTestApp, ownerClient, roleClient, resetDatabase, registerAndLogin } from './helpers.js';

setTestEnv();
process.env.THROTTLE_DISABLED = 'true';

/**
 * Caso obligatorio 11: una empresa nunca accede a datos de otra.
 * Se verifica en dos capas: API (autorización) y PostgreSQL (RLS), esta
 * última conectando directamente con el rol de ejecución de la API.
 */
describe('Aislamiento entre empresas (caso 11)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const owner = ownerClient();
  const runtime = roleClient('runtime');
  let a: Awaited<ReturnType<typeof registerAndLogin>>;
  let b: Awaited<ReturnType<typeof registerAndLogin>>;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
    a = await registerAndLogin(ctx, { companyName: 'Empresa A', email: 'admin@a.test' });
    b = await registerAndLogin(ctx, { companyName: 'Empresa B', email: 'admin@b.test' });
    // Datos de negocio en A (creados con el propietario para no depender de módulos de FASE 3)
    const cat = await owner.category.create({ data: { tenantId: a.tenantId, name: 'Calzado', slug: 'calzado' } });
    const p = await owner.product.create({ data: { tenantId: a.tenantId, categoryId: cat.id, sku: 'NIKE-42', name: 'Nike Air', salePrice: '399.00' } });
    await owner.productVariant.create({ data: { tenantId: a.tenantId, productId: p.id, sku: 'NIKE-42-N', name: 'Talla 42', isDefault: true } });
    await owner.customer.create({ data: { tenantId: a.tenantId, phone: '51999888777', name: 'Cliente de A' } });
  });
  afterAll(async () => {
    await ctx.app.close();
    await Promise.all([owner.$disconnect(), runtime.$disconnect()]);
  });

  describe('capa API', () => {
    it('cada administrador solo lista los usuarios de su empresa', async () => {
      const ra = await ctx.http().get('/api/v1/users').set(auth(a.accessToken)).expect(200);
      const rb = await ctx.http().get('/api/v1/users').set(auth(b.accessToken)).expect(200);
      expect(ra.body.map((u: { email: string }) => u.email)).toEqual(['admin@a.test']);
      expect(rb.body.map((u: { email: string }) => u.email)).toEqual(['admin@b.test']);
    });

    it('B no puede leer ni modificar un usuario de A conociendo su id', async () => {
      await ctx.http().get(`/api/v1/users/${a.userId}`).set(auth(b.accessToken)).expect(404);
      await ctx.http().patch(`/api/v1/users/${a.userId}`).set(auth(b.accessToken)).send({ name: 'Hackeado' }).expect(404);
      const u = await owner.user.findUniqueOrThrow({ where: { id: a.userId } });
      expect(u.name).toBe('Admin');
    });

    it('GET /tenant devuelve siempre la empresa del token', async () => {
      const r = await ctx.http().get('/api/v1/tenant').set(auth(b.accessToken)).expect(200);
      expect(r.body.id).toBe(b.tenantId);
      expect(r.body.usage.products).toBe(0); // los productos de A no cuentan para B
    });

    it('un administrador de empresa no accede al panel de plataforma', async () => {
      await ctx.http().get('/api/v1/platform/tenants').set(auth(a.accessToken)).expect(403);
    });
  });

  describe('capa base de datos (RLS con el rol de ejecución)', () => {
    const asTenant = <T>(tenantId: string, fn: (tx: Parameters<Parameters<typeof runtime.$transaction>[0]>[0]) => Promise<T>) =>
      runtime.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return fn(tx);
      });

    it('sin tenant fijado no se ve ninguna fila de negocio', async () => {
      expect(await runtime.product.count()).toBe(0);
      expect(await runtime.customer.count()).toBe(0);
      expect(await runtime.user.count()).toBe(0);
      expect(await runtime.tenant.count()).toBe(0);
    });

    it('con el tenant B, una consulta SIN filtro por tenant no devuelve datos de A', async () => {
      const products = await asTenant(b.tenantId, (tx) => tx.product.findMany());
      const customers = await asTenant(b.tenantId, (tx) => tx.customer.findMany());
      const tenants = await asTenant(b.tenantId, (tx) => tx.tenant.findMany());
      expect(products).toHaveLength(0);
      expect(customers).toHaveLength(0);
      expect(tenants.map((t) => t.id)).toEqual([b.tenantId]);
      expect(await asTenant(a.tenantId, (tx) => tx.product.count())).toBe(1);
    });

    it('B no puede escribir filas con tenant_id de A (WITH CHECK)', async () => {
      await expect(
        asTenant(b.tenantId, (tx) => tx.customer.create({ data: { tenantId: a.tenantId, phone: '51000000000' } })),
      ).rejects.toThrow(/row-level security/i);
    });

    it('B no puede actualizar ni borrar filas de A (0 filas afectadas)', async () => {
      const upd = await asTenant(b.tenantId, (tx) => tx.product.updateMany({ data: { salePrice: '1.00' } }));
      const del = await asTenant(b.tenantId, (tx) => tx.customer.deleteMany({}));
      expect(upd.count).toBe(0);
      expect(del.count).toBe(0);
      const p = await owner.product.findFirstOrThrow({ where: { tenantId: a.tenantId } });
      expect(p.salePrice.toString()).toBe('399');
    });

    it('tablas de sistema (tokens de auth, webhooks) son inaccesibles para el rol de ejecución', async () => {
      // Además de RLS, el rol de ejecución no tiene ningún permiso sobre ellas
      await expect(asTenant(a.tenantId, (tx) => tx.authToken.count())).rejects.toThrow(/permission denied/i);
      expect(await owner.authToken.count()).toBeGreaterThan(0);
      await expect(asTenant(a.tenantId, (tx) => tx.inboundEvent.create({ data: { provider: 'x', externalId: '1', payload: {} } }))).rejects.toThrow(/permission denied/i);
    });

    it('el historial de auditoría es de solo-anexar', async () => {
      await expect(asTenant(a.tenantId, (tx) => tx.auditLog.updateMany({ data: { action: 'borrado' } }))).rejects.toThrow(/permission denied/i);
      await expect(asTenant(a.tenantId, (tx) => tx.auditLog.deleteMany({}))).rejects.toThrow(/permission denied/i);
      expect(await owner.auditLog.count({ where: { action: 'borrado' } })).toBe(0);
    });

    it('una empresa no puede cambiar su propio estado ni su plan, solo sus datos', async () => {
      await expect(asTenant(a.tenantId, (tx) => tx.tenant.update({ where: { id: a.tenantId }, data: { status: 'ACTIVE' } }))).rejects.toThrow(/permission denied/i);
      await expect(asTenant(a.tenantId, (tx) => tx.subscription.updateMany({ data: { status: 'ACTIVE' } }))).rejects.toThrow(/permission denied/i);
      await expect(asTenant(a.tenantId, (tx) => tx.plan.updateMany({ data: { name: 'x' } }))).rejects.toThrow(/permission denied/i);
      const t = await asTenant(a.tenantId, (tx) => tx.tenant.update({ where: { id: a.tenantId }, data: { name: 'Nombre nuevo' } }));
      expect(t.name).toBe('Nombre nuevo');
    });

    it('toda tabla que puede tocar el rol de ejecución tiene RLS activo con políticas (también las futuras)', async () => {
      const runtimeUser = process.env.APP_DB_RUNTIME_USER ?? 'ai_sales_app';
      const rows = await owner.$queryRawUnsafe<{ name: string; tenant: boolean; rls: boolean; policies: number; runtime: boolean }[]>(`
        SELECT c.relname AS name,
               EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = c.relname AND k.column_name = 'tenant_id') AS tenant,
               c.relrowsecurity AS rls,
               (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies,
               (has_table_privilege($1, c.oid, 'SELECT') OR has_table_privilege($1, c.oid, 'INSERT')
                 OR has_table_privilege($1, c.oid, 'UPDATE') OR has_table_privilege($1, c.oid, 'DELETE')) AS runtime
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`, runtimeUser);
      expect(rows.length).toBeGreaterThan(30);
      // Tablas de empresa: RLS siempre; si el rol de ejecución tiene permisos, debe haber políticas
      const tenantTables = rows.filter((r) => r.tenant);
      expect(tenantTables.filter((r) => !r.rls).map((r) => r.name)).toEqual([]);
      expect(rows.filter((r) => r.runtime && (!r.rls || r.policies === 0)).map((r) => r.name)).toEqual([]);
      // Sin tenant_id, el rol de ejecución solo llega a los planes y a su propia empresa (ambas con RLS)
      expect(rows.filter((r) => r.runtime && !r.tenant).map((r) => r.name).sort()).toEqual(['plans', 'tenants']);
    });

    it('ningún rol de la aplicación puede tocar el historial de migraciones', async () => {
      await expect(asTenant(a.tenantId, (tx) => tx.$queryRaw`SELECT count(*) FROM _prisma_migrations`)).rejects.toThrow(/permission denied/i);
    });
  });
});
