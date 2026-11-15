import argon2 from 'argon2';
import { setTestEnv, createTestApp, ownerClient, resetDatabase, registerAndLogin } from './helpers.js';
import { startFakeHetzner } from './fake-hetzner.js';

setTestEnv();
process.env.THROTTLE_DISABLED = 'true';
const owner = ownerClient();

const TOKEN = 'A'.repeat(60) + 'okok';
const READONLY = 'readonly' + 'B'.repeat(56);
const BAD = 'bad' + 'C'.repeat(61);
const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq1bU3nqUuU9lF2m6fKcWQ9Qm9w2iXz7m0rA3S2bKpX admin@laptop';

/**
 * Fase D (ADR 050) contra un servidor local que responde como Hetzner Cloud:
 * token cifrado y probado antes de guardar, catálogo con precio y
 * disponibilidad, límites y presupuesto, solicitud → aprobación explícita →
 * creación con firewall y claves SSH, operaciones registradas, borrado con
 * nombre escrito, y nada de esto al alcance de una empresa.
 */
describe('Gestor de infraestructura (Hetzner)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let fake: Awaited<ReturnType<typeof startFakeHetzner>>;
  let root: string;
  let providerId: string;
  let installId: string;
  let serverId: string;
  const R = () => ({ Authorization: `Bearer ${root}` });
  const base = '/api/v1/platform/infra';
  const limits = { label: 'Hetzner principal', monthlyBudget: '10.00', maxServers: 2, allowedLocations: ['fsn1', 'nbg1'], allowedServerTypes: ['cx23', 'cx33'], defaultImage: 'ubuntu-24.04', sshSourceCidrs: ['203.0.113.10/32'] };

  beforeAll(async () => {
    fake = await startFakeHetzner();
    process.env.HETZNER_API_BASE_URL = fake.url;
    await resetDatabase(owner);
    ctx = await createTestApp();
    await owner.user.create({ data: { email: 'root@infra.test', name: 'Root', role: 'PLATFORM_ADMIN', emailVerifiedAt: new Date(), passwordHash: await argon2.hash('RootClave123') } });
    root = (await ctx.http().post('/api/v1/auth/login').send({ email: 'root@infra.test', password: 'RootClave123' }).expect(200)).body.accessToken;
    // Orden de instalación pagada (fase C)
    const lead = (await ctx.http().post('/api/v1/platform/sales/leads').set(R()).send({ name: 'Ana Dedicada', company: 'Distribuidora Ana', email: 'ana@dedicada.test', source: 'REFERRAL' }).expect(201)).body.id;
    await ctx.http().post(`/api/v1/platform/sales/leads/${lead}/status`).set(R()).send({ status: 'PAYMENT_PENDING' }).expect(200);
    await ctx.http().post(`/api/v1/platform/sales/leads/${lead}/payment`).set(R()).send({ amount: '900', currency: 'PEN', method: 'BANK_TRANSFER', reference: 'TR-1', paidAt: new Date().toISOString(), verifiedInAccount: true }).expect(200);
    installId = (await owner.installationOrder.findFirstOrThrow({ where: { leadId: lead } })).id;
  });
  afterAll(async () => {
    await ctx.app.close();
    await fake.close();
  });

  it('no guarda un token rechazado ni con formato inválido; guarda cifrado y sin mostrarlo', async () => {
    expect((await ctx.http().post(`${base}/providers`).set(R()).send({ kind: 'HETZNER', token: BAD, ...limits }).expect(400)).body.code).toBe('AUTH_ERROR');
    expect((await ctx.http().post(`${base}/providers`).set(R()).send({ kind: 'HETZNER', token: 'abc-def-ghi-123', ...limits }).expect(400)).body.code).toBe('TOKEN_FORMAT');
    expect(await owner.infraProvider.count()).toBe(0);
    const r = await ctx.http().post(`${base}/providers`).set(R()).send({ kind: 'HETZNER', token: TOKEN, ...limits }).expect(201);
    providerId = r.body.id;
    expect(r.body).toMatchObject({ status: 'CONNECTED', secretHint: '…okok', currency: 'EUR', monthlyBudget: '10.00' });
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    const row = await owner.infraProvider.findUniqueOrThrow({ where: { id: providerId } });
    expect(row.secretsEnc).not.toContain(TOKEN);
    expect(JSON.stringify((await ctx.http().get(`${base}/providers`).set(R()).expect(200)).body)).not.toContain(TOKEN);
    expect(fake.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('CIDR con bits de host se rechaza; probar conexión queda registrado', async () => {
    const bad = await ctx.http().put(`${base}/providers/${providerId}`).set(R()).send({ ...limits, sshSourceCidrs: ['10.0.1.42/24'] }).expect(400);
    expect(JSON.stringify(bad.body)).toContain('bits de host');
    const t = await ctx.http().post(`${base}/providers/${providerId}/test`).set(R()).expect(200);
    expect(t.body).toMatchObject({ ok: true, status: 'CONNECTED', details: { servers: 0 } });
    expect((await ctx.http().get(`${base}/providers/${providerId}`).set(R()).expect(200)).body.operations.some((o: { kind: string }) => o.kind === 'VERIFY')).toBe(true);
  });

  it('catálogo: regiones, tamaños con precio, disponibilidad y retirados, marcando lo permitido', async () => {
    const c = (await ctx.http().get(`${base}/providers/${providerId}/catalog`).set(R()).expect(200)).body;
    expect(c.currency).toBe('EUR');
    expect(c.locations.map((l: { name: string }) => l.name)).toEqual(['fsn1', 'nbg1']);
    const cx23 = c.serverTypes.find((t: { name: string }) => t.name === 'cx23');
    expect(cx23).toMatchObject({ cores: 2, memoryGb: 4, diskGb: 40, availableIn: ['fsn1'], deprecated: false, allowed: true });
    expect(cx23.prices[0].monthly.net).toBe('3.7900');
    expect(c.serverTypes.find((t: { name: string }) => t.name === 'cx11')).toMatchObject({ deprecated: true, allowed: false });
  });

  it('pedir un servidor: valida tamaño, región, disponibilidad y presupuesto; no crea nada', async () => {
    const ask = (over: Record<string, unknown>) => ctx.http().post(`${base}/requests`).set(R()).send({ providerId, installationOrderId: installId, purpose: 'Instancia dedicada de Distribuidora Ana', name: 'ana-prod', serverType: 'cx23', location: 'fsn1', ...over });
    expect((await ask({ serverType: 'cx11' }).expect(400)).body.code).toBe('TYPE_NOT_ALLOWED');
    expect((await ask({ location: 'nbg1' }).expect(400)).body.code).toBe('NOT_AVAILABLE');
    expect((await ask({ name: 'Ana Prod!' }).expect(400)).body.errors[0].path).toBe('name');
    const r = await ask({}).expect(201);
    expect(r.body).toMatchObject({ status: 'PENDING_APPROVAL', priceMonthly: '3.79', currency: 'EUR', image: 'ubuntu-24.04' });
    // Una sola solicitud viva por orden de instalación (índice único en la base)
    expect((await ask({ name: 'ana-prod-2' }).expect(409)).body.code).toBe('INSTALLATION_HAS_SERVER');
    expect(fake.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('aprobar exige nombre escrito, gasto aceptado y una clave SSH pública; crea firewall y servidor', async () => {
    const req = (await ctx.http().get(`${base}/requests`).set(R()).expect(200)).body[0];
    expect((await ctx.http().post(`${base}/requests/${req.id}/approve`).set(R()).send({ confirmName: 'otro', acceptCost: true }).expect(400)).body.code).toBe('CONFIRM_NAME');
    await ctx.http().post(`${base}/requests/${req.id}/approve`).set(R()).send({ confirmName: 'ana-prod' }).expect(400);
    expect((await ctx.http().post(`${base}/requests/${req.id}/approve`).set(R()).send({ confirmName: 'ana-prod', acceptCost: true }).expect(409)).body.code).toBe('NO_SSH_KEY');
    // Solo claves públicas
    await ctx.http().post(`${base}/ssh-keys`).set(R()).send({ name: 'Privada', publicKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn' }).expect(400);
    await ctx.http().post(`${base}/ssh-keys`).set(R()).send({ name: 'Laptop', publicKey: PUB }).expect(201);
    expect(fake.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);

    const s = (await ctx.http().post(`${base}/requests/${req.id}/approve`).set(R()).send({ confirmName: 'ana-prod', acceptCost: true, note: 'Aprobado por contrato firmado' }).expect(200)).body;
    serverId = s.id;
    expect(s).toMatchObject({ name: 'ana-prod', serverType: 'cx23', location: 'fsn1', ipv4: expect.stringMatching(/^203\.0\.113\./), installationOrderId: installId });
    const fw = fake.calls.find((c) => c.method === 'POST' && c.path === '/firewalls')!;
    const rules = fw.body!.rules as { port?: string; source_ips: string[] }[];
    expect(rules.find((r) => r.port === '22')!.source_ips).toEqual(['203.0.113.10/32']);
    expect(rules.find((r) => r.port === '443')!.source_ips).toEqual(['0.0.0.0/0', '::/0']);
    const create = fake.calls.find((c) => c.method === 'POST' && c.path === '/servers')!;
    expect(create.body).toMatchObject({ name: 'ana-prod', server_type: 'cx23', location: 'fsn1', image: 'ubuntu-24.04', start_after_create: true, labels: { 'managed-by': 'ai-sales-assistant' } });
    expect((create.body!.ssh_keys as number[]).length).toBe(1);
    expect((create.body!.firewalls as unknown[]).length).toBe(1);
    const reqAfter = (await ctx.http().get(`${base}/requests`).set(R()).expect(200)).body[0];
    expect(reqAfter).toMatchObject({ status: 'CREATED', decisionNote: 'Aprobado por contrato firmado' });
    // Aprobar dos veces no crea dos servidores
    expect((await ctx.http().post(`${base}/requests/${req.id}/approve`).set(R()).send({ confirmName: 'ana-prod', acceptCost: true }).expect(409)).body.code).toBe('REQUEST_CLOSED');
    expect(fake.servers.size).toBe(1);
  });

  it('presupuesto y máximo de servidores se respetan al pedir y al aprobar', async () => {
    // 3.79 comprometido + 6.49 = 10.28 > 10.00
    expect((await ctx.http().post(`${base}/requests`).set(R()).send({ providerId, purpose: 'Servidor de pruebas interno', name: 'pruebas', serverType: 'cx33', location: 'fsn1' }).expect(409)).body.code).toBe('OVER_BUDGET');
    const r = (await ctx.http().post(`${base}/requests`).set(R()).send({ providerId, purpose: 'Servidor de pruebas interno', name: 'pruebas', serverType: 'cx23', location: 'fsn1' }).expect(201)).body;
    await ctx.http().put(`${base}/providers/${providerId}`).set(R()).send({ ...limits, monthlyBudget: '5.00' }).expect(200);
    expect((await ctx.http().post(`${base}/requests/${r.id}/approve`).set(R()).send({ confirmName: 'pruebas', acceptCost: true }).expect(409)).body.code).toBe('OVER_BUDGET');
    await ctx.http().put(`${base}/providers/${providerId}`).set(R()).send({ ...limits, maxServers: 1 }).expect(200);
    expect((await ctx.http().post(`${base}/requests/${r.id}/approve`).set(R()).send({ confirmName: 'pruebas', acceptCost: true }).expect(409)).body.code).toBe('MAX_SERVERS');
    await ctx.http().post(`${base}/requests/${r.id}/reject`).set(R()).send({ note: 'No hace falta' }).expect(200);
    await ctx.http().put(`${base}/providers/${providerId}`).set(R()).send({ ...limits, monthlyBudget: null }).expect(200);
    expect((await ctx.http().post(`${base}/requests`).set(R()).send({ providerId, purpose: 'Otro servidor interno', name: 'otro', serverType: 'cx23', location: 'fsn1' }).expect(409)).body.code).toBe('NO_BUDGET');
    await ctx.http().put(`${base}/providers/${providerId}`).set(R()).send(limits).expect(200);
    expect(fake.servers.size).toBe(1);
  });

  it('estado, encendido, consumo y costo estimado del mes', async () => {
    const s = (await ctx.http().post(`${base}/servers/${serverId}/refresh`).set(R()).expect(200)).body;
    expect(s.status).toBe('running');
    expect(s.traffic.includedBytes).toBe(21990232555520);
    expect((await ctx.http().post(`${base}/servers/${serverId}/power`).set(R()).send({ action: 'shutdown' }).expect(200)).body.status).toBe('off');
    expect((await ctx.http().post(`${base}/servers/${serverId}/power`).set(R()).send({ action: 'poweron' }).expect(200)).body.status).toBe('running');
    const m = (await ctx.http().get(`${base}/servers/${serverId}/metrics`).set(R()).expect(200)).body;
    expect(m.series.cpu).toHaveLength(2);
    const p = (await ctx.http().get(`${base}/providers/${providerId}`).set(R()).expect(200)).body;
    expect(p.costs).toMatchObject({ activeServers: 1, committedMonthly: '3.79', monthToDate: '0.01' });
    const ops = (await ctx.http().get(`${base}/servers/${serverId}`).set(R()).expect(200)).body.operations.map((o: { kind: string }) => o.kind);
    expect(ops).toEqual(expect.arrayContaining(['SERVER_CREATED', 'POWER_SHUTDOWN', 'POWER_POWERON']));
  });

  it('el registro de operaciones no se altera y un servidor no se borra de la base', async () => {
    const op = await owner.infraOperation.findFirstOrThrow();
    await expect(owner.infraOperation.update({ where: { id: op.id }, data: { ok: false } })).rejects.toThrow(/no se puede modificar/);
    await expect(owner.infraServer.delete({ where: { id: serverId } })).rejects.toThrow(/no se puede modificar/);
  });

  it('eliminar exige el nombre escrito y un motivo; queda registrado', async () => {
    expect((await ctx.http().post(`${base}/servers/${serverId}/delete`).set(R()).send({ confirmName: 'ana', reason: 'Cliente canceló' }).expect(400)).body.code).toBe('CONFIRM_NAME');
    await ctx.http().post(`${base}/servers/${serverId}/delete`).set(R()).send({ confirmName: 'ana-prod', reason: '' }).expect(400);
    const s = (await ctx.http().post(`${base}/servers/${serverId}/delete`).set(R()).send({ confirmName: 'ana-prod', reason: 'Cliente canceló el servicio' }).expect(200)).body;
    expect(s).toMatchObject({ status: 'deleted', deleteReason: 'Cliente canceló el servicio' });
    expect(fake.servers.size).toBe(0);
    expect((await ctx.http().get(`${base}/servers`).set(R()).expect(200)).body).toHaveLength(0);
    expect((await ctx.http().get(`${base}/servers?deleted=true`).set(R()).expect(200)).body).toHaveLength(1);
    expect((await ctx.http().post(`${base}/servers/${serverId}/power`).set(R()).send({ action: 'poweron' }).expect(409)).body.code).toBe('SERVER_DELETED');
  });

  it('servidores existentes en la cuenta se pueden registrar para verlos y costearlos', async () => {
    await ctx.http().post(`${base}/requests`).set(R()).send({ providerId, purpose: 'Servidor de monitoreo', name: 'monitoreo', serverType: 'cx23', location: 'fsn1' }).expect(201);
    const req = (await ctx.http().get(`${base}/requests?status=PENDING_APPROVAL`).set(R()).expect(200)).body[0];
    await ctx.http().post(`${base}/requests/${req.id}/approve`).set(R()).send({ confirmName: 'monitoreo', acceptCost: true }).expect(200);
    // Uno creado fuera del sistema (directo en la consola del proveedor)
    fake.servers.set(99, { id: 99, name: 'externo', status: 'running', created: new Date().toISOString(), labels: {}, public_net: { ipv4: { ip: '198.51.100.9' }, ipv6: null, firewalls: [] }, server_type: { name: 'cx33' }, location: { name: 'fsn1' }, image: { name: 'debian-12' } });
    const remote = (await ctx.http().get(`${base}/providers/${providerId}/remote-servers`).set(R()).expect(200)).body;
    expect(remote.find((r: { name: string }) => r.name === 'externo').registeredId).toBeNull();
    expect(remote.find((r: { name: string }) => r.name === 'monitoreo').registeredId).toBeTruthy();
    const imp = (await ctx.http().post(`${base}/providers/${providerId}/import`).set(R()).send({ externalId: '99' }).expect(201)).body;
    expect(imp).toMatchObject({ imported: true, priceMonthly: '6.49', ipv4: '198.51.100.9' });
    await ctx.http().post(`${base}/providers/${providerId}/import`).set(R()).send({ externalId: '99' }).expect(409);
  });

  it('un token de solo lectura no puede crear: la solicitud queda FALLIDA con el motivo', async () => {
    await ctx.http().post(`${base}/providers/${providerId}/rotate`).set(R()).send({ token: READONLY }).expect(200);
    await ctx.http().put(`${base}/providers/${providerId}`).set(R()).send({ ...limits, monthlyBudget: '100.00', maxServers: 10 }).expect(200);
    const r = (await ctx.http().post(`${base}/requests`).set(R()).send({ providerId, purpose: 'Prueba de permisos', name: 'sinpermiso', serverType: 'cx23', location: 'fsn1' }).expect(201)).body;
    expect((await ctx.http().post(`${base}/requests/${r.id}/approve`).set(R()).send({ confirmName: 'sinpermiso', acceptCost: true }).expect(400)).body.code).toBe('PROVIDER_FORBIDDEN');
    const after = await owner.infraServerRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.status).toBe('FAILED');
    expect(after.error).toMatch(/forbidden/);
  });

  it('una empresa no ve ni toca la infraestructura; el rol de ejecución no lee las tablas', async () => {
    const t = await registerAndLogin(ctx, { companyName: 'Empresa Infra', email: 'admin@infra-empresa.test' });
    await ctx.http().get(`${base}/providers`).set({ Authorization: `Bearer ${t.accessToken}` }).expect(403);
    await ctx.http().post(`${base}/requests`).set({ Authorization: `Bearer ${t.accessToken}` }).send({}).expect(403);
    const { roleClient } = await import('./helpers.js');
    const rt = roleClient('runtime');
    await expect(rt.infraProvider.findMany()).rejects.toThrow();
    await rt.$disconnect();
  });
});
