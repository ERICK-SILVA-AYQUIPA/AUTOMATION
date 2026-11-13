import ExcelJS from 'exceljs';
import { setTestEnv, createTestApp, ownerClient, resetDatabase, registerAndLogin } from './helpers.js';

setTestEnv();
process.env.THROTTLE_DISABLED = 'true';

/** Casos obligatorios 3 (crear producto), 8 (descontar inventario) y 9 (evitar pedidos duplicados). */
describe('Catálogo, inventario y pedidos', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const owner = ownerClient();
  let admin: Awaited<ReturnType<typeof registerAndLogin>>;
  const H = () => ({ Authorization: `Bearer ${admin.accessToken}` });
  let productId: string;
  let variant42: string;
  let variant43: string;

  beforeAll(async () => {
    await resetDatabase(owner);
    ctx = await createTestApp();
    admin = await registerAndLogin(ctx, { companyName: 'Zapatería Test', email: 'admin@zap.test' });
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
  });

  it('caso 3: crea categoría y producto con variantes; registra historial', async () => {
    const cat = await ctx.http().post('/api/v1/categories').set(H()).send({ name: 'Zapatillas' }).expect(201);
    const r = await ctx.http().post('/api/v1/products').set(H()).send({
      sku: 'NIKE-AIR', barcode: '7750000000017', name: 'Nike Air Zoom', description: 'Running', categoryId: cat.body.id,
      salePrice: '399.90', costPrice: 250, minStock: 5,
      variants: [
        { sku: 'NIKE-AIR-42', barcode: '7750000000024', name: 'Talla 42', attributes: { talla: '42' } },
        { sku: 'NIKE-AIR-43', name: 'Talla 43', attributes: { talla: '43' }, salePrice: '419.90' },
      ],
    }).expect(201);
    productId = r.body.id;
    expect(r.body.variants).toHaveLength(2);
    variant42 = r.body.variants.find((v: { sku: string }) => v.sku === 'NIKE-AIR-42').id;
    variant43 = r.body.variants.find((v: { sku: string }) => v.sku === 'NIKE-AIR-43').id;
    expect(r.body.variants.find((v: { id: string }) => v.id === variant43).effectivePrice).toBe('419.9');
    expect(r.body.stock).toBe(0);

    await ctx.http().post('/api/v1/products').set(H()).send({ sku: 'NIKE-AIR', name: 'Dup', salePrice: 1 }).expect(409);
    await ctx.http().post('/api/v1/products').set(H()).send({ sku: 'X', name: 'Precio malo', salePrice: '-3' }).expect(400);

    const found = await ctx.http().get('/api/v1/products/barcode/7750000000024').set(H()).expect(200);
    expect(found.body.id).toBe(productId);
    const search = await ctx.http().get('/api/v1/products?q=zoom').set(H()).expect(200);
    expect(search.body.total).toBe(1);

    await ctx.http().patch(`/api/v1/products/${productId}`).set(H()).send({ salePrice: '389.90' }).expect(200);
    const hist = await ctx.http().get(`/api/v1/products/${productId}/history`).set(H()).expect(200);
    expect(hist.body[0]).toMatchObject({ action: 'updated', changes: { salePrice: { from: '399.9', to: '389.9' } } });
  });

  it('entrada de compra y bloqueo de stock negativo salvo autorización explícita', async () => {
    const r = await ctx.http().post('/api/v1/inventory/movements').set(H()).send({ variantId: variant42, type: 'PURCHASE_IN', quantity: 10, reason: 'Compra proveedor' }).expect(201);
    expect(r.body).toMatchObject({ stockBefore: 0, stockAfter: 10, applied: true });
    await ctx.http().post('/api/v1/inventory/movements').set(H()).send({ variantId: variant43, type: 'PURCHASE_IN', quantity: 3, reason: 'Compra proveedor' }).expect(201);

    const neg = await ctx.http().post('/api/v1/inventory/movements').set(H()).send({ variantId: variant43, type: 'ADJUSTMENT', quantity: -5, reason: 'Conteo físico' }).expect(409);
    expect(neg.body.code).toBe('INSUFFICIENT_STOCK');
    const ok = await ctx.http().post('/api/v1/inventory/movements').set(H()).send({ variantId: variant43, type: 'ADJUSTMENT', quantity: -5, reason: 'Conteo físico', allowNegative: true }).expect(201);
    expect(ok.body.stockAfter).toBe(-2);
    await ctx.http().post('/api/v1/inventory/movements').set(H()).send({ variantId: variant43, type: 'ADJUSTMENT', quantity: 5, reason: 'Corrección' }).expect(201);
    expect(await owner.auditLog.count({ where: { action: 'inventory.negative_authorized' } })).toBe(1);
  });

  it('caso 8: confirmar un pedido descuenta inventario con precio de la BD; anularlo lo devuelve una sola vez', async () => {
    const r = await ctx.http().post('/api/v1/orders').set(H()).send({
      customer: { phone: '+51 987 654 321', name: 'María' },
      items: [{ variantId: variant42, quantity: 2 }, { variantId: variant42, quantity: 1 }, { variantId: variant43, quantity: 1 }],
    }).expect(201);
    expect(r.body).toMatchObject({ number: 1, status: 'CONFIRMED', total: '1589.6' }); // 3 x 389.90 + 419.90
    expect(r.body.items).toHaveLength(2);

    const p1 = await ctx.http().get(`/api/v1/products/${productId}`).set(H()).expect(200);
    const s = (id: string) => p1.body.variants.find((v: { id: string }) => v.id === id).stock;
    expect(s(variant42)).toBe(7);
    expect(s(variant43)).toBe(2);

    // Confirmar de nuevo no descuenta otra vez (idempotente)
    await ctx.http().patch(`/api/v1/orders/${r.body.id}/status`).set(H()).send({ status: 'CONFIRMED' }).expect(200);
    await ctx.http().patch(`/api/v1/orders/${r.body.id}/status`).set(H()).send({ status: 'CANCELLED', note: 'Cliente desistió' }).expect(200);
    await ctx.http().patch(`/api/v1/orders/${r.body.id}/status`).set(H()).send({ status: 'CANCELLED' }).expect(200);
    await ctx.http().patch(`/api/v1/orders/${r.body.id}/status`).set(H()).send({ status: 'CONFIRMED' }).expect(409); // transición inválida

    const p2 = await ctx.http().get(`/api/v1/products/${productId}`).set(H()).expect(200);
    expect(p2.body.variants.find((v: { id: string }) => v.id === variant42).stock).toBe(10);
    const moves = await owner.inventoryMovement.findMany({ where: { orderId: r.body.id } });
    expect(moves.map((m) => m.type).sort()).toEqual(['SALE_OUT', 'SALE_OUT', 'SALE_VOID', 'SALE_VOID']);
  });

  it('rechaza un pedido sin stock suficiente sin dejar nada a medias', async () => {
    const before = await owner.order.count();
    const r = await ctx.http().post('/api/v1/orders').set(H()).send({ customer: { phone: '51900000001' }, items: [{ variantId: variant43, quantity: 999 }] }).expect(409);
    expect(r.body.code).toBe('INSUFFICIENT_STOCK');
    expect(await owner.order.count()).toBe(before);
  });

  it('caso 9: la misma clave de idempotencia (incluso en paralelo) crea un único pedido y descuenta una sola vez', async () => {
    const body = { customer: { phone: '51911111111' }, items: [{ variantId: variant42, quantity: 1 }], idempotencyKey: 'wa-conv-123-cart-abc' };
    const results = await Promise.all(Array.from({ length: 5 }, () => ctx.http().post('/api/v1/orders').set(H()).send(body)));
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200 && r.body.idempotentReplay)).toHaveLength(4);
    expect(await owner.order.count({ where: { idempotencyKey: 'wa-conv-123-cart-abc' } })).toBe(1);
    const sold = await owner.inventoryMovement.count({ where: { orderId: [...ids][0] as string, type: 'SALE_OUT' } });
    expect(sold).toBe(1);
  });

  it('pedidos simultáneos de un cliente nuevo: todos se crean y el cliente queda una sola vez', async () => {
    const phone = '51955500011';
    const p = await ctx.http().post('/api/v1/products').set(H()).send({ sku: 'SIMULT', name: 'Pedido simultáneo', salePrice: 10, initialStock: 20 }).expect(201);
    const vid = p.body.variants[0].id;
    const results = await Promise.all(Array.from({ length: 8 }, () => ctx.http().post('/api/v1/orders').set(H()).send({ customer: { phone }, items: [{ variantId: vid, quantity: 1 }] })));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
    expect(await owner.customer.count({ where: { phone } })).toBe(1);
  });

  it('ventas concurrentes del último stock: nunca queda negativo', async () => {
    const p = await ctx.http().post('/api/v1/products').set(H()).send({ sku: 'ULTIMO', name: 'Último par', salePrice: 100, initialStock: 3 }).expect(201);
    const vid = p.body.variants[0].id;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => ctx.http().post('/api/v1/orders').set(H()).send({ customer: { phone: `5192000000${i}` }, items: [{ variantId: vid, quantity: 1 }] })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    const level = await owner.stockLevel.findFirstOrThrow({ where: { variantId: vid } });
    expect(level.quantity).toBe(0);
  });

  it('alerta de stock mínimo al cruzar el umbral', async () => {
    // NIKE-AIR: stock total 9+5=... se fuerza a cruzar minStock (5)
    const prod = await ctx.http().get(`/api/v1/products/${productId}`).set(H()).expect(200);
    const toRemove = prod.body.stock - 4;
    await ctx.http().post('/api/v1/inventory/movements').set(H()).send({ variantId: variant42, type: 'ADJUSTMENT', quantity: -toRemove, reason: 'Merma' }).expect(201);
    const alerts = await ctx.http().get('/api/v1/inventory/alerts').set(H()).expect(200);
    expect(alerts.body.map((a: { sku: string }) => a.sku)).toContain('NIKE-AIR');
    expect(await owner.notification.count({ where: { type: 'LOW_STOCK' } })).toBe(1);
  });

  it('importación Excel todo-o-nada con validación previa, y exportación', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('P');
    ws.addRow(['sku', 'nombre', 'precio_venta', 'categoria', 'stock_inicial']);
    ws.addRow(['ADI-1', 'Adidas Run', '299.90', 'Zapatillas', 4]);
    ws.addRow(['ADI-2', 'Adidas Walk', 'gratis', 'Zapatillas', 1]);
    const bad = Buffer.from(await wb.xlsx.writeBuffer());
    const r1 = await ctx.http().post('/api/v1/products/import').set(H()).attach('file', bad, 'productos.xlsx').expect(200);
    expect(r1.body.errors).toEqual([expect.objectContaining({ row: 3 })]);
    expect(r1.body.created).toBe(0);
    expect(await owner.product.count({ where: { sku: 'ADI-1' } })).toBe(0); // nada se guardó

    ws.getRow(3).getCell(3).value = '279.90';
    const good = Buffer.from(await wb.xlsx.writeBuffer());
    const dry = await ctx.http().post('/api/v1/products/import?dryRun=true').set(H()).attach('file', good, 'productos.xlsx').expect(200);
    expect(dry.body).toMatchObject({ dryRun: true, created: 2, errors: [] });
    expect(await owner.product.count({ where: { sku: 'ADI-1' } })).toBe(0);
    const real = await ctx.http().post('/api/v1/products/import').set(H()).attach('file', good, 'productos.xlsx').expect(200);
    expect(real.body).toMatchObject({ created: 2, updated: 0, errors: [] });

    const csv = await ctx.http().get('/api/v1/products/export?format=csv').set(H()).expect(200);
    expect(csv.text).toContain('ADI-1');
    expect(csv.headers['content-disposition']).toMatch(/productos-.*\.csv/);
  });

  it('imágenes: acepta PNG real y rechaza archivos disfrazados', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
    const img = await ctx.http().post(`/api/v1/products/${productId}/images`).set(H()).attach('file', png, 'foto.png').expect(201);
    const file = await ctx.http().get(new URL(img.body.url).pathname).expect(200);
    expect(file.headers['content-type']).toBe('image/png');
    await ctx.http().post(`/api/v1/products/${productId}/images`).set(H()).attach('file', Buffer.from('<script>alert(1)</script>'), 'foto.png').expect(400);
  });

  it('dashboard con datos reales', async () => {
    const d = await ctx.http().get('/api/v1/dashboard').set(H()).expect(200);
    expect(d.body.sales.today.orders).toBeGreaterThanOrEqual(4); // 1 idempotente + 3 del último stock
    expect(d.body.sales.series).toHaveLength(30);
    expect(d.body.newCustomers).toBeGreaterThan(0);
    expect(d.body.topProducts[0]).toHaveProperty('quantity');
    expect(d.body.lowStock.map((x: { sku: string }) => x.sku)).toContain('NIKE-AIR');
    const csv = await ctx.http().get('/api/v1/reports/sales.csv').set(H()).expect(200);
    expect(csv.text.split('\n')[0]).toBe('﻿fecha,pedidos,unidades,total,moneda');
  });

  it('un vendedor puede vender pero no editar productos ni inventario', async () => {
    await ctx.http().post('/api/v1/users').set(H()).send({ email: 'v@zap.test', name: 'Vendedor', role: 'SELLER' }).expect(201);
    const mail = ctx.outbox.filter((m) => m.to === 'v@zap.test').at(-1)!;
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)![1];
    await ctx.http().post('/api/v1/auth/accept-invitation').send({ token, password: 'Vendedor1234' }).expect(204);
    const login = await ctx.http().post('/api/v1/auth/login').send({ email: 'v@zap.test', password: 'Vendedor1234' }).expect(200);
    const S = { Authorization: `Bearer ${login.body.accessToken}` };
    await ctx.http().get('/api/v1/products').set(S).expect(200);
    await ctx.http().patch(`/api/v1/products/${productId}`).set(S).send({ salePrice: 1 }).expect(403);
    await ctx.http().post('/api/v1/inventory/movements').set(S).send({ variantId: variant42, type: 'PURCHASE_IN', quantity: 1, reason: 'xxx' }).expect(403);
    await ctx.http().post('/api/v1/orders').set(S).send({ customer: { phone: '51933333333' }, items: [{ variantId: variant42, quantity: 1 }] }).expect(201);
  });
});
