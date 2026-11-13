import argon2 from 'argon2';
import { setTestEnv, createTestApp, ownerClient, resetDatabase, registerAndLogin } from './helpers.js';
import { startFakeAiProviders } from './fake-ai-providers.js';

setTestEnv();
const owner = ownerClient();

// Claves de prueba (el servidor local decide por su contenido: «bad», «noperm», «down»)
const KEYS = {
  claudeManaged: 'sk-ant-plataforma-0000000000000001',
  claudeBackup: 'sk-ant-respaldo-00000000000000002',
  claudeDown: 'sk-ant-down-caido-000000000000003',
  geminiManaged: 'AIzaPlataformaGemini_000000000001',
  openaiOwnB: 'sk-proj-empresaB-propia-00000000001',
  deepseekOwnA: 'sk-deepseek-empresaA-000000000001',
};

/**
 * Aceptación del Centro universal de APIs (ADR 046), contra un servidor local
 * que responde como Anthropic, OpenAI, DeepSeek y Gemini.
 */
describe('Centro de APIs: credenciales, modelos, asignación por empresa y consumo', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let fake: Awaited<ReturnType<typeof startFakeAiProviders>>;
  let a: Awaited<ReturnType<typeof registerAndLogin>>;
  let b: Awaited<ReturnType<typeof registerAndLogin>>;
  let root: string;
  const R = () => ({ Authorization: `Bearer ${root}` });
  const HA = () => ({ Authorization: `Bearer ${a.accessToken}` });
  const HB = () => ({ Authorization: `Bearer ${b.accessToken}` });
  let claudeId: string;
  const ask = (H: () => Record<string, string>, text: string) => ctx.http().post('/api/v1/ai/test').set(H()).send({ target: 'draft', messages: [{ role: 'customer', text }] });

  beforeAll(async () => {
    fake = await startFakeAiProviders();
    process.env.ANTHROPIC_BASE_URL = fake.urls.anthropic;
    process.env.OPENAI_BASE_URL = fake.urls.openai;
    process.env.DEEPSEEK_BASE_URL = fake.urls.deepseek;
    process.env.GEMINI_BASE_URL = fake.urls.gemini;
    // Sin clave de Gemini del servidor: todo pasa por el Centro de APIs
    process.env.GEMINI_API_KEY = '';
    await resetDatabase(owner);
    ctx = await createTestApp();
    a = await registerAndLogin(ctx, { companyName: 'Ferretería Centro', email: 'admin@centro-a.test' });
    b = await registerAndLogin(ctx, { companyName: 'Bodega Centro', email: 'admin@centro-b.test' });
    await ctx.http().post('/api/v1/products').set(HA()).send({ sku: 'GAS-500', name: 'Gaseosa Cola 500 ml', salePrice: '3.50', initialStock: 20 }).expect(201);
    await ctx.http().post('/api/v1/products').set(HB()).send({ sku: 'GAS-B', name: 'Gaseosa Cola premium', salePrice: '7.25', initialStock: 5 }).expect(201);
    await owner.user.create({ data: { email: 'root@centro.test', name: 'Root', role: 'PLATFORM_ADMIN', emailVerifiedAt: new Date(), passwordHash: await argon2.hash('RootClave123') } });
    root = (await ctx.http().post('/api/v1/auth/login').send({ email: 'root@centro.test', password: 'RootClave123' }).expect(200)).body.accessToken;
  });
  afterAll(async () => {
    await ctx.app.close();
    await owner.$disconnect();
    await fake.close();
  });

  it('sin proveedor asignado la empresa no tiene IA (y lo dice)', async () => {
    const r = await ask(HA, 'hola').expect(503);
    expect(r.body.message).toMatch(/No hay proveedor de IA/);
    const o = await ctx.http().get('/api/v1/integrations/ai').set(HA()).expect(200);
    expect(o.body.effective).toMatchObject({ label: null, code: 'NOT_CONFIGURED' });
  });

  it('1-2. registra Claude: clave rechazada con su estado; clave válida comprobada con el proveedor y nunca devuelta', async () => {
    const bad = await ctx.http().post('/api/v1/platform/api-center/credentials').set(R()).send({ provider: 'anthropic', fields: { apiKey: 'sk-ant-bad-0000000000000000000' } }).expect(400);
    expect(bad.body).toMatchObject({ code: 'CREDENTIAL_REJECTED', status: 'AUTH_ERROR' });
    expect(bad.body.message).toMatch(/Error de autenticación/);
    const noperm = await ctx.http().post('/api/v1/platform/api-center/credentials').set(R()).send({ provider: 'anthropic', fields: { apiKey: 'sk-ant-noperm-000000000000000000' } }).expect(400);
    expect(noperm.body.status).toBe('PERMISSION_DENIED');
    const missing = await ctx.http().post('/api/v1/platform/api-center/credentials').set(R()).send({ provider: 'anthropic', fields: {} }).expect(400);
    expect(missing.body).toMatchObject({ code: 'INVALID_FIELDS', message: 'Falta API Key' });
    const extra = await ctx.http().post('/api/v1/platform/api-center/credentials').set(R()).send({ provider: 'anthropic', fields: { apiKey: KEYS.claudeManaged, endpoint: 'http://169.254.169.254' } }).expect(400);
    expect(extra.body.message).toMatch(/Campo no admitido: endpoint/);

    const ok = await ctx.http().post('/api/v1/platform/api-center/credentials').set(R()).send({ provider: 'anthropic', label: 'Claude plataforma', fields: { apiKey: KEYS.claudeManaged } }).expect(201);
    claudeId = ok.body.id;
    expect(ok.body).toMatchObject({ provider: 'anthropic', status: 'CONNECTED', secretHint: '…0001', tenantId: null });
    expect(JSON.stringify(ok.body)).not.toContain(KEYS.claudeManaged);
    // La petición real llegó al proveedor con la clave, a la API de modelos
    expect(fake.calls.some((c) => c.provider === 'anthropic' && c.path === '/anthropic/v1/models' && c.key === KEYS.claudeManaged)).toBe(true);
    const row = await owner.providerCredential.findUniqueOrThrow({ where: { id: claudeId } });
    expect(row.secretsEnc).not.toContain(KEYS.claudeManaged);
    const t = await ctx.http().post(`/api/v1/platform/api-center/credentials/${claudeId}/test`).set(R()).expect(200);
    expect(t.body).toMatchObject({ status: 'CONNECTED' });
    const overview = await ctx.http().get('/api/v1/platform/api-center').set(R()).expect(200);
    expect(JSON.stringify(overview.body)).not.toContain(KEYS.claudeManaged);
    expect(overview.body.catalog.find((c: { key: string }) => c.key === 'hetzner')).toMatchObject({ managedIn: 'planned' });
  });

  it('3. lee los modelos del proveedor y no acepta uno que el proveedor no ofrece', async () => {
    const r = await ctx.http().post(`/api/v1/platform/api-center/credentials/${claudeId}/models/refresh`).set(R()).expect(200);
    expect(r.body).toMatchObject({ provider: 'anthropic', count: 2 });
    const models = await owner.aiModel.findMany({ where: { provider: 'anthropic' }, orderBy: { modelId: 'asc' } });
    expect(models.map((m) => [m.modelId, m.source, m.contextWindow])).toEqual([['claude-prueba-chica', 'PROVIDER', 200_000], ['claude-prueba-grande', 'PROVIDER', 1_000_000]]);
    const bad = await ctx.http().put(`/api/v1/platform/api-center/tenants/${a.tenantId}/ai/ASSISTANT`).set(R()).send({ credentialId: claudeId, model: 'claude-inventado' }).expect(400);
    expect(bad.body.code).toBe('UNKNOWN_MODEL');
  });

  it('4-6. asigna Claude a la empresa A; conversa con datos reales del catálogo y registra el consumo', async () => {
    await ctx.http().put(`/api/v1/platform/api-center/tenants/${a.tenantId}/ai/ASSISTANT`).set(R()).send({ credentialId: claudeId, model: 'claude-prueba-grande', profile: 'ADVANCED' }).expect(200);
    const o = await ctx.http().get('/api/v1/integrations/ai').set(HA()).expect(200);
    expect(o.body.assignment).toMatchObject({ provider: 'anthropic', mode: 'MANAGED', model: 'claude-prueba-grande', credentialId: null, managedCredential: { label: 'Claude plataforma', secretHint: '…0001' } });
    expect(o.body.effective.label).toBe('Anthropic Claude (credencial administrada) · claude-prueba-grande');
    expect(o.body.credentials).toEqual([]);

    const before = fake.calls.length;
    const r = await ask(HA, '¿qué precio tiene la gaseosa?').expect(200);
    expect(r.body).toMatchObject({ reply: 'Cuesta S/ 3.50 (Claude)', tools: ['buscar_productos'] });
    const sent = fake.calls.slice(before).filter((c) => c.path === '/anthropic/v1/messages');
    expect(sent).toHaveLength(2);
    expect(sent[0]!.key).toBe(KEYS.claudeManaged);
    expect(sent[0]!.body).toMatchObject({ model: 'claude-prueba-grande', max_tokens: 4096 });
    expect((sent[0]!.body!.tools as { name: string }[]).map((x) => x.name)).toContain('buscar_productos');
    // Segunda llamada: turno del modelo completo (con su bloque de pensamiento) y el resultado de la herramienta
    const msgs = sent[1]!.body!.messages as { role: string; content: { type: string; signature?: string; tool_use_id?: string; content?: string }[] }[];
    expect(msgs.at(-2)!.content[0]).toMatchObject({ type: 'thinking', signature: 'firma-claude' });
    expect(msgs.at(-1)!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_01' });
    expect(msgs.at(-1)!.content[0]!.content).toContain('3.5');

    const usage = await owner.aiUsageEvent.findMany({ where: { tenantId: a.tenantId } });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ provider: 'anthropic', model: 'claude-prueba-grande', mode: 'MANAGED', credentialId: claudeId, inputTokens: 240, outputTokens: 60, ok: true, cost: null });

    // Con precio en el catálogo el costo se calcula (sin precio se queda en null: no se inventa)
    const model = await owner.aiModel.findFirstOrThrow({ where: { modelId: 'claude-prueba-grande' } });
    await ctx.http().patch(`/api/v1/platform/api-center/models/${model.id}`).set(R()).send({ inputPricePerMTok: '4.00', outputPricePerMTok: '20.00' }).expect(200);
    await ask(HA, 'hola').expect(200);
    const priced = await owner.aiUsageEvent.findFirstOrThrow({ where: { tenantId: a.tenantId }, orderBy: { createdAt: 'desc' } });
    // 120 de entrada a 4 USD/M + 30 de salida a 20 USD/M
    expect(priced.cost?.toString()).toBe('0.00108');
    expect(priced.costCurrency).toBe('USD');
    const u = await ctx.http().get('/api/v1/integrations/ai').set(HA()).expect(200);
    expect(u.body.usage.unpricedCalls).toBe(1);
  });

  it('prueba real de la asignación desde el panel de la plataforma y de la empresa', async () => {
    const p = await ctx.http().post(`/api/v1/platform/api-center/tenants/${a.tenantId}/ai/ASSISTANT/test`).set(R()).expect(200);
    expect(p.body).toMatchObject({ ok: true, provider: 'anthropic', model: 'claude-prueba-grande', reply: 'OK' });
    const t = await ctx.http().post('/api/v1/integrations/ai/test').set(HA()).expect(200);
    expect(t.body.ok).toBe(true);
    const checks = await owner.integrationCheck.findMany({ where: { tenantId: a.tenantId, service: 'ai' } });
    expect(checks.length).toBe(2);
    const status = await ctx.http().get('/api/v1/integrations').set(HA()).expect(200);
    expect(status.body.find((s: { key: string }) => s.key === 'ai')).toMatchObject({ status: 'connected' });
  });

  it('7-8. cambia la empresa A a Gemini desde el panel y sigue funcionando', async () => {
    const g = await ctx.http().post('/api/v1/platform/api-center/credentials').set(R()).send({ provider: 'gemini', fields: { apiKey: KEYS.geminiManaged } }).expect(201);
    const m = await ctx.http().post(`/api/v1/platform/api-center/credentials/${g.body.id}/models/refresh`).set(R()).expect(200);
    // Solo los modelos de generación
    expect(m.body.models).toEqual(['gemini-prueba-pro']);
    await ctx.http().put(`/api/v1/platform/api-center/tenants/${a.tenantId}/ai/ASSISTANT`).set(R()).send({ credentialId: g.body.id, model: 'gemini-prueba-pro' }).expect(200);
    const before = fake.calls.length;
    const r = await ask(HA, 'precio de la gaseosa').expect(200);
    expect(r.body.reply).toBe('Cuesta S/ 3.50 (Gemini)');
    expect(fake.calls.slice(before).every((c) => c.provider === 'gemini' && c.key === KEYS.geminiManaged)).toBe(true);
    const audit = await owner.auditLog.findFirstOrThrow({ where: { tenantId: a.tenantId, action: 'api_center.assignment_set' }, orderBy: { createdAt: 'desc' } });
    expect(audit.metadata).toMatchObject({ before: { provider: 'anthropic' }, after: { provider: 'gemini', model: 'gemini-prueba-pro' } });
  });

  it('9. la empresa B usa su propia clave de OpenAI, independiente de A', async () => {
    const c = await ctx.http().post('/api/v1/integrations/ai/credentials').set(HB()).send({ provider: 'openai', fields: { apiKey: KEYS.openaiOwnB, organization: 'org-empresaB' } }).expect(201);
    expect(c.body).toMatchObject({ tenantId: b.tenantId, status: 'CONNECTED', config: { organization: 'org-empresaB' } });
    const models = await ctx.http().get(`/api/v1/integrations/ai/credentials/${c.body.id}/models`).set(HB()).expect(200);
    expect(models.body.map((x: { id: string }) => x.id)).toEqual(['gpt-prueba-1', 'gpt-prueba-mini']);
    await ctx.http().put('/api/v1/integrations/ai/assignment').set(HB()).send({ credentialId: c.body.id, model: 'gpt-prueba-mini', profile: 'CUSTOM', params: { maxOutputTokens: 800, temperature: 0.2 } }).expect(200);
    const before = fake.calls.length;
    const r = await ask(HB, 'precio de la gaseosa').expect(200);
    expect(r.body.reply).toBe('Cuesta S/ 7.25 (OpenAI)');
    const sent = fake.calls.slice(before);
    expect(sent.every((x) => x.provider === 'openai' && x.key === KEYS.openaiOwnB)).toBe(true);
    expect(sent[0]!.body).toMatchObject({ model: 'gpt-prueba-mini', max_completion_tokens: 800, temperature: 0.2 });
    const toolMsg = (sent[1]!.body!.messages as { role: string; tool_call_id?: string }[]).at(-1)!;
    expect(toolMsg).toMatchObject({ role: 'tool', tool_call_id: 'call_01' });
    const usage = await owner.aiUsageEvent.findMany({ where: { tenantId: b.tenantId } });
    expect(usage.map((u) => [u.provider, u.mode, u.credentialId])).toEqual([['openai', 'OWN', c.body.id]]);
  });

  it('DeepSeek con clave propia (formato OpenAI, reenvía el razonamiento)', async () => {
    const c = await ctx.http().post('/api/v1/integrations/ai/credentials').set(HA()).send({ provider: 'deepseek', fields: { apiKey: KEYS.deepseekOwnA } }).expect(201);
    await ctx.http().put('/api/v1/integrations/ai/assignment').set(HA()).send({ credentialId: c.body.id, model: 'deepseek-prueba' }).expect(200);
    const before = fake.calls.length;
    const r = await ask(HA, 'precio de la gaseosa').expect(200);
    expect(r.body.reply).toBe('Cuesta S/ 3.50 (DeepSeek)');
    const sent = fake.calls.slice(before).filter((x) => x.path.endsWith('/chat/completions'));
    expect(sent[0]!.body).toMatchObject({ model: 'deepseek-prueba', max_tokens: 1024 });
    const assistantTurn = (sent[1]!.body!.messages as { role: string; reasoning_content?: string }[]).find((m) => m.role === 'assistant' && m.reasoning_content);
    expect(assistantTurn?.reasoning_content).toBe('razonamiento');
    // Vuelve a la credencial administrada (la asigna la plataforma)
    const g = await owner.providerCredential.findFirstOrThrow({ where: { provider: 'gemini', tenantId: null } });
    await ctx.http().put(`/api/v1/platform/api-center/tenants/${a.tenantId}/ai/ASSISTANT`).set(R()).send({ credentialId: g.id, model: 'gemini-prueba-pro' }).expect(200);
  });

  it('10. sin fugas entre empresas: ni credenciales ajenas ni administradas, también en la base de datos', async () => {
    const bOwn = await owner.providerCredential.findFirstOrThrow({ where: { tenantId: b.tenantId } });
    const aOwn = await owner.providerCredential.findFirstOrThrow({ where: { tenantId: a.tenantId } });
    // A no ve la clave de B ni la administrada
    const oa = await ctx.http().get('/api/v1/integrations/ai').set(HA()).expect(200);
    expect(oa.body.credentials.map((c: { id: string }) => c.id)).toEqual([aOwn.id]);
    await ctx.http().post(`/api/v1/integrations/ai/credentials/${bOwn.id}/test`).set(HA()).expect(404);
    await ctx.http().get(`/api/v1/integrations/ai/credentials/${bOwn.id}/models`).set(HA()).expect(404);
    // Ni puede asignarse la clave de B ni una administrada
    await ctx.http().put('/api/v1/integrations/ai/assignment').set(HA()).send({ credentialId: bOwn.id, model: 'gpt-prueba-mini' }).expect(404);
    await ctx.http().put('/api/v1/integrations/ai/assignment').set(HA()).send({ credentialId: claudeId, model: 'claude-prueba-grande' }).expect(404);
    // La plataforma tampoco puede dar a A la clave propia de B
    await ctx.http().put(`/api/v1/platform/api-center/tenants/${a.tenantId}/ai/ASSISTANT`).set(R()).send({ credentialId: bOwn.id, model: 'gpt-prueba-mini' }).expect(404);
    // En la base: el disparador lo impide aunque se salte el código
    await expect(owner.$executeRaw`UPDATE ai_assignments SET credential_id = ${bOwn.id}::uuid, provider = 'openai' WHERE tenant_id = ${a.tenantId}::uuid`).rejects.toThrow(/otra empresa|administrada/);
    // Y con el rol de ejecución, A no puede leer credenciales administradas ni de B
    const { DatabaseService } = await import('../src/database/database.service.js');
    const db = ctx.app.get(DatabaseService);
    const visible = await db.tenant(a.tenantId, (tx) => tx.providerCredential.findMany({ select: { id: true } }));
    expect(visible.map((v) => v.id)).toEqual([aOwn.id]);
    await expect(db.tenant(a.tenantId, (tx) => tx.aiAssignment.update({ where: { tenantId_service: { tenantId: a.tenantId, service: 'ASSISTANT' } }, data: { mode: 'MANAGED' } }))).rejects.toThrow();
    // Ninguna respuesta lleva claves
    const all = JSON.stringify([oa.body, (await ctx.http().get('/api/v1/platform/api-center').set(R())).body]);
    for (const k of Object.values(KEYS)) expect(all).not.toContain(k);
  });

  it('respaldo: solo otra credencial del mismo proveedor, salvo autorización explícita; se usa si el principal cae', async () => {
    const down = await ctx.http().post('/api/v1/platform/api-center/credentials').set(R()).send({ provider: 'anthropic', label: 'Claude caído', fields: { apiKey: KEYS.claudeDown } }).expect(201);
    const backup = await ctx.http().post('/api/v1/platform/api-center/credentials').set(R()).send({ provider: 'anthropic', label: 'Claude respaldo', fields: { apiKey: KEYS.claudeBackup } }).expect(201);
    const gem = await owner.providerCredential.findFirstOrThrow({ where: { provider: 'gemini', tenantId: null } });
    const cross = await ctx.http().put(`/api/v1/platform/api-center/tenants/${a.tenantId}/ai/ASSISTANT`).set(R()).send({ credentialId: down.body.id, model: 'claude-prueba-chica', fallbackCredentialId: gem.id, fallbackModel: 'gemini-prueba-pro' }).expect(400);
    expect(cross.body.code).toBe('CROSS_PROVIDER_FALLBACK');
    await ctx.http().put(`/api/v1/platform/api-center/tenants/${a.tenantId}/ai/ASSISTANT`).set(R()).send({ credentialId: down.body.id, model: 'claude-prueba-chica', fallbackCredentialId: backup.body.id, fallbackModel: 'claude-prueba-grande' }).expect(200);
    const r = await ask(HA, 'hola').expect(200);
    expect(r.body.reply).toBe('OK');
    const last = await owner.aiUsageEvent.findFirstOrThrow({ where: { tenantId: a.tenantId }, orderBy: { createdAt: 'desc' } });
    expect(last).toMatchObject({ credentialId: backup.body.id, model: 'claude-prueba-grande', fallbackUsed: true, ok: true });
  });

  it('11-12. desconectar: la empresa deja de usarla en el acto, recibe aviso y el error se muestra claro', async () => {
    const down = await owner.providerCredential.findFirstOrThrow({ where: { label: 'Claude caído' } });
    const d = await ctx.http().post(`/api/v1/platform/api-center/credentials/${down.id}/disable`).set(R()).expect(200);
    expect(d.body).toMatchObject({ status: 'DISABLED', assignmentsDeactivated: 1 });
    const r = await ask(HA, 'hola').expect(503);
    expect(r.body.message).toMatch(/desactivada/);
    const o = await ctx.http().get('/api/v1/integrations/ai').set(HA()).expect(200);
    expect(o.body.effective).toMatchObject({ code: 'DISABLED' });
    expect(await owner.notification.count({ where: { tenantId: a.tenantId, title: 'Asistente de IA sin proveedor' } })).toBe(1);
    // No se puede reactivar con una credencial desconectada ni eliminarla mientras se use
    const en = await ctx.http().post(`/api/v1/platform/api-center/tenants/${a.tenantId}/ai/ASSISTANT/enable`).set(R()).expect(400);
    expect(en.body.code).toBe('CREDENTIAL_DISABLED');
    const rm = await ctx.http().delete(`/api/v1/platform/api-center/credentials/${down.id}`).set(R()).expect(409);
    expect(rm.body.code).toBe('CREDENTIAL_IN_USE');
    // Se asigna otra y vuelve a responder
    await ctx.http().put(`/api/v1/platform/api-center/tenants/${a.tenantId}/ai/ASSISTANT`).set(R()).send({ credentialId: claudeId, model: 'claude-prueba-grande' }).expect(200);
    await ask(HA, 'hola').expect(200);
    await ctx.http().delete(`/api/v1/platform/api-center/credentials/${down.id}`).set(R()).expect(204);
    // B quita su clave: sin proveedor, su equipo atiende
    await ctx.http().delete('/api/v1/integrations/ai/assignment').set(HB()).expect(204);
    await ask(HB, 'hola').expect(503);
    // Una asignación administrada no la puede quitar la empresa
    const del = await ctx.http().delete('/api/v1/integrations/ai/assignment').set(HA()).expect(400);
    expect(del.body.code).toBe('MANAGED_ASSIGNMENT');
  });

  it('una clave revocada en el proveedor se refleja como error de autenticación al probar', async () => {
    await owner.providerCredential.update({ where: { id: claudeId }, data: { secretsEnc: (await import('../src/common/crypto/crypto.js')).encrypt(JSON.stringify({ apiKey: 'sk-ant-bad-revocada-0000000000' }), process.env.DATA_ENCRYPTION_KEY!) } });
    const t = await ctx.http().post(`/api/v1/platform/api-center/credentials/${claudeId}/test`).set(R()).expect(200);
    expect(t.body).toMatchObject({ status: 'AUTH_ERROR' });
    expect(t.body.detail).toMatch(/invalid x-api-key/);
    const r = await ask(HA, 'hola').expect(503);
    expect(r.body.message).toMatch(/invalid x-api-key/);
    // Rotar con una clave válida la recupera sin tocar la asignación
    await ctx.http().post(`/api/v1/platform/api-center/credentials/${claudeId}/rotate`).set(R()).send({ fields: { apiKey: KEYS.claudeManaged } }).expect(200);
    await ask(HA, 'hola').expect(200);
    expect(await owner.auditLog.count({ where: { action: 'api_center.credential_rotated' } })).toBe(1);
  });

  it('las empresas no acceden al Centro de APIs de la plataforma', async () => {
    await ctx.http().get('/api/v1/platform/api-center').set(HA()).expect(403);
    await ctx.http().post('/api/v1/platform/api-center/credentials').set(HB()).send({ provider: 'anthropic', fields: { apiKey: KEYS.claudeManaged } }).expect(403);
  });
});
