import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import { ProvisioningEngine } from '../src/orchestrator/engine.js';
import { APP_VERSION } from '../src/deliveries/version.js';
import { unzip } from '../src/deliveries/zip.js';
import { setTestEnv, createTestApp, ownerClient, resetDatabase, registerAndLogin, roleClient } from './helpers.js';
import { startFakeHetzner } from './fake-hetzner.js';
import { runAgent } from './agent-harness.js';

const PORT = 4790;

setTestEnv();
const owner = ownerClient();
const TOKEN = 'A'.repeat(60) + 'okok';
const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq1bU3nqUuU9lF2m6fKcWQ9Qm9w2iXz7m0rA3S2bKpX admin@laptop';
const SMTP_PASSWORD = 'smtp-clave-secreta-123';

// Imágenes «de la versión» servidas por la plataforma (aquí un archivo pequeño con su .sha256)
const imagesDir = mkdtempSync(join(tmpdir(), 'aisa-img-'));
const IMAGES = Buffer.from('imagenes de prueba '.repeat(100));
const IMAGES_SHA = createHash('sha256').update(IMAGES).digest('hex');
writeFileSync(join(imagesDir, `aisa-imagenes-${APP_VERSION}.tar.gz`), IMAGES);
writeFileSync(join(imagesDir, `aisa-imagenes-${APP_VERSION}.tar.gz.sha256`), `${IMAGES_SHA}  aisa-imagenes-${APP_VERSION}.tar.gz\n`);
const binary = (res: NodeJS.ReadableStream & { setEncoding?: unknown }, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

/**
 * Fase E y F (ADR 051): orquestador de una instalación administrada de punta a
 * punta contra Hetzner simulado. El agente del servidor se reproduce con sus
 * mismas llamadas HTTP (arranque de un solo uso, informes, paquete, imágenes);
 * las comprobaciones desde afuera (DNS y HTTPS) se sustituyen por respuestas fijas.
 */
describe('Orquestador de instalaciones', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let fake: Awaited<ReturnType<typeof startFakeHetzner>>;
  let engine: ProvisioningEngine;
  let root: string;
  let providerId: string;
  let installId: string;
  let tenantId: string;
  let runId: string;
  let agentToken: string;
  let bootEnv: string;
  const R = () => ({ Authorization: `Bearer ${root}` });
  const A = () => ({ Authorization: `Bearer ${agentToken}` });
  const base = '/api/v1/platform/provisioning';
  const agent = (id: string) => `/api/v1/public/provisioning/${id}`;
  const run = (id = runId) => owner.provisioningRun.findUniqueOrThrow({ where: { id } });
  const tick = async (id = runId) => {
    await owner.provisioningRun.update({ where: { id }, data: { nextRunAt: new Date() } });
    await engine.advance(id);
    return run(id);
  };
  const healthy = { resolve: async () => ['203.0.113.0'], get: async (u: string) => (u.endsWith('/ready') ? { status: 200, contentType: 'application/json', body: '{"status":"ok"}' } : { status: 200, contentType: 'text/html; charset=utf-8', body: '<html></html>' }) };
  const input = (orderId: string) => ({
    installationOrderId: orderId, providerId, serverType: 'cx23', location: 'fsn1', domain: 'ventas.distribuidora-ana.pe', adminEmail: 'ana@distribuidora-ana.pe',
    systemName: 'Ventas Distribuidora Ana', supportContact: 'soporte@plataforma.test · +51 900 000 000',
    smtp: { host: 'smtp.brevo.test', port: 587, secure: false, user: 'ana@distribuidora-ana.pe', password: SMTP_PASSWORD, from: 'Ventas Ana <no-reply@distribuidora-ana.pe>' },
  });
  async function paidOrder(name: string, email: string) {
    const lead = (await ctx.http().post('/api/v1/platform/sales/leads').set(R()).send({ name, company: name, email, source: 'REFERRAL' }).expect(201)).body.id;
    await ctx.http().post(`/api/v1/platform/sales/leads/${lead}/status`).set(R()).send({ status: 'PAYMENT_PENDING' }).expect(200);
    await ctx.http().post(`/api/v1/platform/sales/leads/${lead}/payment`).set(R()).send({ amount: '900', currency: 'PEN', method: 'BANK_TRANSFER', reference: `TR-${email}`, paidAt: new Date().toISOString(), verifiedInAccount: true }).expect(200);
    return (await owner.installationOrder.findFirstOrThrow({ where: { leadId: lead } })).id;
  }

  beforeAll(async () => {
    fake = await startFakeHetzner();
    process.env.HETZNER_API_BASE_URL = fake.url;
    process.env.PROVISIONING_IMAGES_DIR = imagesDir;
    // El agente real llama a la API por HTTP: la app de prueba escucha en un puerto
    process.env.API_PUBLIC_URL = `http://127.0.0.1:${PORT}`;
    await resetDatabase(owner);
    ctx = await createTestApp();
    await ctx.app.listen(PORT, '127.0.0.1');
    engine = ctx.app.get(ProvisioningEngine);
    await owner.user.create({ data: { email: 'root@orq.test', name: 'Root', role: 'PLATFORM_ADMIN', emailVerifiedAt: new Date(), passwordHash: await argon2.hash('RootClave123') } });
    root = (await ctx.http().post('/api/v1/auth/login').send({ email: 'root@orq.test', password: 'RootClave123' }).expect(200)).body.accessToken;
    providerId = (await ctx.http().post('/api/v1/platform/infra/providers').set(R()).send({ kind: 'HETZNER', token: TOKEN, label: 'Hetzner', monthlyBudget: '50.00', maxServers: 5, allowedLocations: [], allowedServerTypes: [], defaultImage: 'ubuntu-24.04', sshSourceCidrs: ['203.0.113.10/32'] }).expect(201)).body.id;
    await ctx.http().post('/api/v1/platform/infra/ssh-keys').set(R()).send({ name: 'Laptop', publicKey: PUB }).expect(201);
    const shop = await registerAndLogin(ctx, { companyName: 'Distribuidora Ana', email: 'admin@orq-ana.test' });
    tenantId = shop.tenantId;
    installId = await paidOrder('Ana Dedicada', 'ana@orq.test');
    await owner.installationOrder.update({ where: { id: installId }, data: { deploymentMode: 'DEDICATED' } });
  });
  afterAll(async () => {
    await ctx.app.close();
    await fake.close();
    await owner.$disconnect();
  });

  it('valida la orden y los datos; sin empresa se detiene pidiendo convertir al prospecto', async () => {
    const saas = await paidOrder('Bodega SaaS', 'saas@orq.test');
    await owner.installationOrder.update({ where: { id: saas }, data: { deploymentMode: 'SAAS' } });
    expect((await ctx.http().post(`${base}/runs`).set(R()).send(input(saas)).expect(409)).body.code).toBe('SAAS_NO_SERVER');
    await ctx.http().post(`${base}/runs`).set(R()).send({ ...input(installId), domain: 'no es dominio' }).expect(400);
    await ctx.http().post(`${base}/runs`).set(R()).send({ ...input(installId), systemName: 'Ventas $(rm -rf /)' }).expect(400);

    const r = await ctx.http().post(`${base}/runs`).set(R()).send(input(installId)).expect(201);
    runId = r.body.id;
    expect(r.body).toMatchObject({ status: 'REQUESTED', domain: 'ventas.distribuidora-ana.pe' });
    expect(JSON.stringify(r.body)).not.toContain(SMTP_PASSWORD);
    expect((await run()).secretsEnc).not.toContain(SMTP_PASSWORD);
    // Una sola instalación viva por orden: no se instala ni se cobra dos veces
    expect((await ctx.http().post(`${base}/runs`).set(R()).send(input(installId)).expect(409)).body.code).toBe('RUN_EXISTS');

    expect((await tick()).status).toBe('PAYMENT_CONFIRMED');
    expect((await tick()).status).toBe('PREPARING');
    expect((await owner.installationOrder.findUniqueOrThrow({ where: { id: installId } })).status).toBe('IN_PROGRESS');
    const stopped = await tick();
    expect(stopped).toMatchObject({ status: 'NEEDS_INTERVENTION', stoppedAt: 'PREPARING', lastError: 'La orden aún no tiene empresa' });
    expect(stopped.needs).toContain('Convierte al prospecto en cliente');
    // Detenida: el motor no la toca
    await engine.advance(runId);
    expect((await run()).status).toBe('NEEDS_INTERVENTION');
  });

  it('reintento: prepara la entrega y pide el servidor, que espera la aprobación de una persona', async () => {
    await owner.installationOrder.update({ where: { id: installId }, data: { tenantId } });
    await ctx.http().patch(`/api/v1/platform/tenants/${tenantId}`).set(R()).send({ deploymentMode: 'DEDICATED' }).expect(200);
    const r = await ctx.http().post(`${base}/runs/${runId}/retry`).set(R()).expect(200);
    expect(r.body).toMatchObject({ status: 'PREPARING', stoppedAt: null, needs: null });
    expect(r.body.settings.deliveryId).toEqual(expect.any(String));
    await ctx.http().post(`${base}/runs/${runId}/retry`).set(R()).expect(409);

    expect((await tick()).status).toBe('CREATING_INFRA');
    const prepared = await run();
    expect(prepared.bootstrapHash).toMatch(/^[0-9a-f]{64}$/);
    const asking = await tick();
    expect(asking.serverRequestId).toEqual(expect.any(String));
    const req = await owner.infraServerRequest.findUniqueOrThrow({ where: { id: asking.serverRequestId! } });
    expect(req).toMatchObject({ status: 'PENDING_APPROVAL', installationOrderId: installId, serverType: 'cx23', location: 'fsn1' });
    expect(req.name).toMatch(/^aisa-\d+-ventas-distribuidora-ana-pe$/);
    // Sin aprobación no hay llamadas de escritura al proveedor
    expect(fake.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    expect((await tick()).status).toBe('CREATING_INFRA');
  });

  it('al aprobar se crea el servidor con un cloud-init sin secretos duraderos; arranque de un solo uso', async () => {
    const { serverRequestId } = await run();
    const req = await owner.infraServerRequest.findUniqueOrThrow({ where: { id: serverRequestId! } });
    await ctx.http().post(`/api/v1/platform/infra/requests/${req.id}/approve`).set(R()).send({ confirmName: req.name, acceptCost: true }).expect(200);
    const create = fake.calls.find((c) => c.method === 'POST' && c.path === '/servers')!;
    const userData = String(create.body!.user_data);
    expect(userData).toContain(`RUN='${runId}'`);
    expect(userData).toContain('/api/v1/public/provisioning/$RUN/bootstrap');
    expect(userData).not.toContain(SMTP_PASSWORD);
    const token = /printf '\{"token":"%s"\}' '([A-Za-z0-9_-]+)'/.exec(userData)![1]!;
    expect((await run()).bootstrapExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 5 * 3_600_000);

    // El servidor pasa a «running» en la siguiente consulta
    const ready = await tick();
    expect(ready).toMatchObject({ status: 'SERVER_READY', serverId: expect.any(String) });
    expect((await tick()).status).toBe('SERVER_READY'); // espera a que el servidor se comunique

    await ctx.http().post(`${agent(runId)}/bootstrap`).send({ token: 'x'.repeat(43) }).expect(404);
    const boot = await ctx.http().post(`${agent(runId)}/bootstrap`).send({ token }).expect(200);
    expect(boot.body.script).toContain('#!/usr/bin/env bash');
    expect(boot.body.env).toContain("APP_DOMAIN='ventas.distribuidora-ana.pe'");
    expect(boot.body.env).toContain(`SMTP_PASSWORD='${SMTP_PASSWORD}'`);
    expect(boot.body.env).toContain(`IMAGES_SHA256='${IMAGES_SHA}'`);
    agentToken = /AGENT_TOKEN='([^']+)'/.exec(boot.body.env)![1]!;
    bootEnv = boot.body.env;
    expect((await ctx.http().post(`${agent(runId)}/bootstrap`).send({ token }).expect(409)).body.code).toBe('BOOTSTRAP_USED');
    expect((await tick()).status).toBe('CONFIGURING_SERVER');
  });

  it('el agente real informa en orden, verifica el paquete y las imágenes, configura e instala', async () => {
    await ctx.http().post(`${agent(runId)}/report`).send({ step: 'INSTALLING', state: 'done' }).expect(404);
    await ctx.http().post(`${agent(runId)}/report`).set({ Authorization: 'Bearer otro-token-cualquiera-1234567890' }).send({ step: 'INSTALLING', state: 'done' }).expect(404);
    await ctx.http().post(`${agent(runId)}/report`).set(A()).send({ step: 'CONFIGURING_SERVER', state: 'progress', message: 'Esperando DNS\u0007 de ventas' }).expect(200);
    let r = await ctx.http().post(`${agent(runId)}/report`).set(A()).send({ step: 'CONFIGURING_SERVER', state: 'done', message: 'Docker listo' }).expect(200);
    expect(r.body).toEqual({ status: 'INSTALLING', proceed: true });
    // Un informe repetido no retrocede ni duplica
    r = await ctx.http().post(`${agent(runId)}/report`).set(A()).send({ step: 'CONFIGURING_SERVER', state: 'done' }).expect(200);
    expect(r.body.status).toBe('INSTALLING');

    const pkg = await ctx.http().get(`${agent(runId)}/package`).set(A()).buffer(true).parse(binary).expect(200);
    expect(pkg.headers['x-package-sha256']).toBe(createHash('sha256').update(pkg.body as Buffer).digest('hex'));
    const files = unzip(pkg.body as Buffer).map((f) => f.path);
    expect(files).toEqual(expect.arrayContaining(['instalacion/instalar.sh', 'instalacion/configuracion-cliente.json', 'instalacion/.env.production.example', 'SHA256SUMS']));
    expect(unzip(pkg.body as Buffer).some((f) => f.data.toString('utf8').includes(SMTP_PASSWORD))).toBe(false);
    const img = await ctx.http().get(`${agent(runId)}/images`).set(A()).buffer(true).parse(binary).expect(200);
    expect(Buffer.compare(img.body as Buffer, IMAGES)).toBe(0);

    // El agente de verdad (agente.sh) con Docker y el sistema sustituidos
    const server = await owner.infraServer.findUniqueOrThrow({ where: { id: (await run()).serverId! } });
    const a = await runAgent({ env: bootEnv, ip: server.ipv4!, domain: 'ventas.distribuidora-ana.pe', version: APP_VERSION });
    expect(a.log).toContain('agente terminado');
    expect(a.code).toBe(0);
    expect((await run()).status).toBe('TESTING');
    expect(a.docker).toMatch(/docker load -i .*aisa-imagenes-/);
    expect(a.docker).toContain('up -d --no-build --wait');
    expect(a.docker).toContain('importar-entrega');
    expect(a.envProduction).toContain('APP_DOMAIN=ventas.distribuidora-ana.pe');
    expect(a.envProduction).toContain(`SMTP_PASSWORD=${SMTP_PASSWORD}`);
    expect(a.envProduction).toContain('MAIL_FROM="Ventas Ana <no-reply@distribuidora-ana.pe>"');
    expect(a.envProduction).toMatch(/^JWT_SECRET=[0-9a-f]{64}$/m);
    expect(a.envProduction).not.toMatch(/^[A-Z0-9_]+=__GENERATE__$/m);
    expect(a.agentEnv).toContain("SMTP_PASSWORD=''");
    expect(a.cron).toContain('respaldo.sh');
    expect(a.cron).toContain('salud.sh');
    const msgs = (await owner.provisioningEvent.findMany({ where: { runId, source: { in: ['agent', 'engine'] } }, orderBy: { createdAt: 'asc' } })).map((e) => e.message);
    expect(msgs).toEqual(expect.arrayContaining([expect.stringContaining('Paquete verificado'), expect.stringContaining('Migraciones aplicadas'), expect.stringContaining('respaldo diario')]));
    const ev = await owner.provisioningEvent.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } });
    expect(ev.find((e) => e.source === 'agent' && e.message.includes('Esperando DNS'))!.message).not.toContain('\u0007');
  });

  it('pruebas desde afuera con reintentos limitados; luego publica y entrega', async () => {
    engine.probeDeps = { resolve: async () => ['198.51.100.7'] };
    const t1 = await tick();
    expect(t1).toMatchObject({ status: 'TESTING', attempts: 1 });
    expect(t1.lastError).toMatch(/apunta a 198\.51\.100\.7 y no al servidor/);
    expect(t1.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 20_000);

    const server = await owner.infraServer.findUniqueOrThrow({ where: { id: (await run()).serverId! } });
    engine.probeDeps = { ...healthy, resolve: async () => [server.ipv4!] };
    expect((await tick()).status).toBe('PUBLISHING');
    expect((await tick()).status).toBe('DELIVERING');
    const done = await tick();
    expect(done).toMatchObject({ status: 'DELIVERED', secretsEnc: null, agentHash: null, nextRunAt: null });
    expect(done.finishedAt).not.toBeNull();
    expect((await owner.installationOrder.findUniqueOrThrow({ where: { id: installId } })).status).toBe('DONE');
    expect((await owner.infraServer.findUniqueOrThrow({ where: { id: server.id } })).tenantId).toBe(tenantId);
    // Entregada: el agente ya no tiene acceso
    await ctx.http().post(`${agent(runId)}/report`).set(A()).send({ step: 'MIGRATING', state: 'done' }).expect(404);
    const detail = await ctx.http().get(`${base}/runs/${runId}`).set(R()).expect(200);
    expect(detail.body.events.map((e: { status: string }) => e.status)).toEqual(expect.arrayContaining(['REQUESTED', 'PAYMENT_CONFIRMED', 'PREPARING', 'CREATING_INFRA', 'SERVER_READY', 'CONFIGURING_SERVER', 'INSTALLING', 'TESTING', 'PUBLISHING', 'DELIVERING', 'DELIVERED']));
    expect(JSON.stringify(detail.body)).not.toMatch(/secretsEnc|bootstrapHash|agentHash/);
    await ctx.http().post(`${base}/runs/${runId}/cancel`).set(R()).send({ reason: 'ya no' }).expect(409);
  });

  it('un fallo del agente o un plazo vencido piden intervención; cancelar exige decidir el servidor', async () => {
    const order2 = await paidOrder('Beto Dedicado', 'beto@orq.test');
    await owner.installationOrder.update({ where: { id: order2 }, data: { deploymentMode: 'DEDICATED', tenantId } });
    const id = (await ctx.http().post(`${base}/runs`).set(R()).send({ ...input(order2), domain: 'ventas.beto.pe' }).expect(201)).body.id;
    for (let i = 0; i < 4; i++) await tick(id);
    const r2 = await run(id);
    expect(r2).toMatchObject({ status: 'CREATING_INFRA', serverRequestId: expect.any(String) });
    // Plazo vencido esperando la aprobación → intervención con instrucciones
    await owner.provisioningRun.update({ where: { id }, data: { stepDeadlineAt: new Date(Date.now() - 1000) } });
    const late = await tick(id);
    expect(late).toMatchObject({ status: 'NEEDS_INTERVENTION', stoppedAt: 'CREATING_INFRA' });
    expect(late.needs).toContain('apruébala en Infraestructura');
    expect(late.alertedAt).not.toBeNull();
    // Una solicitud rechazada detiene la instalación; reintentar pide un servidor nuevo
    await ctx.http().post(`${base}/runs/${id}/retry`).set(R()).expect(200);
    await ctx.http().post(`/api/v1/platform/infra/requests/${r2.serverRequestId}/reject`).set(R()).send({ note: 'Usar otra región' }).expect(200);
    const stop2 = await tick(id);
    expect(stop2.status).toBe('NEEDS_INTERVENTION');
    expect(stop2.lastError).toContain('rechazada: Usar otra región');
    await ctx.http().post(`${base}/runs/${id}/retry`).set(R()).expect(200);
    expect((await run(id)).serverRequestId).toBeNull();
    const again = await tick(id);
    const req2 = await owner.infraServerRequest.findUniqueOrThrow({ where: { id: again.serverRequestId! } });
    await ctx.http().post(`/api/v1/platform/infra/requests/${req2.id}/approve`).set(R()).send({ confirmName: req2.name, acceptCost: true }).expect(200);
    expect((await tick(id)).status).toBe('SERVER_READY');
    const boot = (await owner.provisioningRun.findUniqueOrThrow({ where: { id } }));
    const token = /printf '\{"token":"%s"\}' '([A-Za-z0-9_-]+)'/.exec(String(fake.calls.filter((c) => c.method === 'POST' && c.path === '/servers').at(-1)!.body!.user_data))![1]!;
    expect(boot.bootstrapUsedAt).toBeNull();
    const env = (await ctx.http().post(`${agent(id)}/bootstrap`).send({ token }).expect(200)).body.env as string;
    const t2 = /AGENT_TOKEN='([^']+)'/.exec(env)![1]!;
    expect(t2).toBeTruthy();
    // El agente real con «docker compose up» fallando: se detiene y lo informa
    const srv = await owner.infraServer.findUniqueOrThrow({ where: { id: (await run(id)).serverId! } });
    const a = await runAgent({ env, ip: srv.ipv4!, domain: 'ventas.beto.pe', version: APP_VERSION, failCompose: true });
    expect(a.code).toBe(1);
    const failed = await run(id);
    expect(failed).toMatchObject({ status: 'NEEDS_INTERVENTION', stoppedAt: 'MIGRATING' });
    expect(failed.lastError).toContain('Falló «Migrando base de datos» en el servidor');
    expect(failed.needs).toContain('/opt/aisa/agente.sh');
    // Detenida: si el agente vuelve a informar, la plataforma le dice que pare
    expect((await ctx.http().post(`${agent(id)}/report`).set({ Authorization: `Bearer ${t2}` }).send({ step: 'MIGRATING', state: 'started' }).expect(200)).body).toMatchObject({ proceed: false });

    // Cancelar: sin eliminar avisa que el servidor sigue costando; para eliminarlo hay que escribir su nombre
    const server = await owner.infraServer.findUniqueOrThrow({ where: { id: failed.serverId! } });
    expect((await ctx.http().post(`${base}/runs/${id}/cancel`).set(R()).send({ reason: 'El cliente desistió', releaseServer: { confirmName: 'otro' } }).expect(400)).body.code).toBe('CONFIRM_NAME');
    const c = await ctx.http().post(`${base}/runs/${id}/cancel`).set(R()).send({ reason: 'El cliente desistió', releaseServer: { confirmName: server.name } }).expect(200);
    expect(c.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'El cliente desistió' });
    expect((await owner.infraServer.findUniqueOrThrow({ where: { id: server.id } })).deletedAt).not.toBeNull();
    expect(fake.servers.has(Number(server.externalId))).toBe(false);
    // Cancelada: se puede registrar otra para la misma orden
    await ctx.http().post(`${base}/runs`).set(R()).send({ ...input(order2), domain: 'ventas.beto.pe' }).expect(201);
  });

  it('reintentos agotados terminan en Error; historial inalterable y fuera del alcance de las empresas', async () => {
    const order3 = await paidOrder('Caro Dedicada', 'caro@orq.test');
    await owner.installationOrder.update({ where: { id: order3 }, data: { deploymentMode: 'DEDICATED', tenantId } });
    const id = (await ctx.http().post(`${base}/runs`).set(R()).send({ ...input(order3), domain: 'ventas.caro.pe' }).expect(201)).body.id;
    // Saltamos a «Ejecutando pruebas» para ver el tope de intentos
    await owner.provisioningRun.update({ where: { id }, data: { status: 'TESTING', attempts: 39, stepDeadlineAt: new Date(Date.now() + 3_600_000) } });
    engine.probeDeps = { resolve: async () => { throw new Error('ENOTFOUND'); } };
    const e = await tick(id);
    expect(e).toMatchObject({ status: 'ERROR', stoppedAt: 'TESTING', attempts: 40 });
    expect(e.lastError).toContain('no resuelve en DNS');

    const ev = await owner.provisioningEvent.findFirstOrThrow({ where: { runId: id } });
    await expect(owner.provisioningEvent.update({ where: { id: ev.id }, data: { message: 'cambiado' } })).rejects.toThrow();
    await expect(owner.provisioningRun.delete({ where: { id } })).rejects.toThrow();
    const runtime = roleClient('runtime');
    await expect(runtime.provisioningRun.findMany()).rejects.toThrow();
    await runtime.$disconnect();
    const shop = await registerAndLogin(ctx, { companyName: 'Otra', email: 'admin@orq-otra.test' });
    await ctx.http().get(`${base}/runs`).set({ Authorization: `Bearer ${shop.accessToken}` }).expect(403);
  });
});
