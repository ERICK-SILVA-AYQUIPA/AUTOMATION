import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentEnv, agentScript, cloudInit } from './agent.js';
import { type InstanceReport, instanceReportSchema, reportSignature, reportSummary } from './instance-status.js';
import { probeInstallation } from './probe.js';
import { FLOW, agentReport, backoff, cleanText, nextOf, serverNameFor } from './steps.js';

describe('orquestador: pasos', () => {
  it('sigue el orden de la especificación y termina en Entregada', () => {
    expect(FLOW[0]).toBe('REQUESTED');
    expect(nextOf('CONFIGURING_INTEGRATIONS')).toBe('TESTING');
    expect(nextOf('DELIVERING')).toBe('DELIVERED');
    expect(() => nextOf('CANCELLED')).toThrow();
  });
  it('acepta informes del agente solo en sus pasos y no retrocede', () => {
    expect(agentReport('CONFIGURING_SERVER', 'INSTALLING')).toBe('advance');
    expect(agentReport('INSTALLING', 'CONFIGURING_SERVER')).toBe('ignore');
    expect(agentReport('TESTING', 'MIGRATING')).toBe('ignore');
    expect(agentReport('PREPARING', 'INSTALLING')).toBe('reject');
    expect(agentReport('CONFIGURING_SERVER', 'TESTING')).toBe('reject');
  });
  it('espera exponencial con tope, nombres válidos y texto limpio', () => {
    expect([1, 2, 3, 10].map(backoff)).toEqual([30_000, 60_000, 120_000, 300_000]);
    expect(serverNameFor('Ventas.Mi-Empresa.PE', 12)).toBe('aisa-12-ventas-mi-empresa-pe');
    expect(serverNameFor(`${'a'.repeat(80)}.pe`, 1)).toMatch(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);
    expect(cleanText('ok\u0000\u001b[31m rojo\nlínea 🙂')).toBe('ok[31m rojo\nlínea 🙂');
  });
});

describe('orquestador: comprobación desde afuera', () => {
  const ok = { resolve: async () => ['203.0.113.5'], get: async () => ({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' }) };
  it('exige que el dominio apunte al servidor y que la API esté sana por HTTPS', async () => {
    expect(await probeInstallation('v.pe', '203.0.113.5', ok)).toMatchObject({ ok: true });
    expect(await probeInstallation('v.pe', '203.0.113.9', ok)).toMatchObject({ ok: false, error: expect.stringContaining('no al servidor') });
    expect(await probeInstallation('v.pe', null, { ...ok, resolve: async () => { throw new Error('ENOTFOUND'); } })).toMatchObject({ ok: false, error: expect.stringContaining('no resuelve') });
    expect(await probeInstallation('v.pe', null, { ...ok, get: async () => ({ status: 503, contentType: 'application/json', body: '{}' }) })).toMatchObject({ ok: false, error: expect.stringContaining('503') });
    expect(await probeInstallation('v.pe', null, { ...ok, get: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }); } })).toMatchObject({ ok: false, error: expect.stringContaining('CERT_HAS_EXPIRED') });
    expect(await probeInstallation('v.pe', null, ok, 'panel')).toMatchObject({ ok: false });
    expect(await probeInstallation('v.pe', null, { ...ok, get: async () => ({ status: 200, contentType: 'text/html', body: '' }) }, 'panel')).toMatchObject({ ok: true });
  });
});

describe('orquestador: scripts del servidor', () => {
  it('cloud-init y agente son bash válido; las variables no se pueden inyectar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aisa-agente-'));
    writeFileSync(join(dir, 'ci.sh'), cloudInit({ apiUrl: 'https://api.plataforma.pe', runId: 'r1', token: "t'; rm -rf / #" }));
    writeFileSync(join(dir, 'agente.sh'), agentScript());
    execFileSync('bash', ['-n', join(dir, 'ci.sh')]);
    execFileSync('bash', ['-n', join(dir, 'agente.sh')]);
    const env = agentEnv({ A: "x'; touch /tmp/pwn; echo '", B: '$(id)', C: 'normal' });
    writeFileSync(join(dir, 'env'), env);
    const out = execFileSync('bash', ['-c', `source ${join(dir, 'env')}; printf '%s|%s|%s' "$A" "$B" "$C"`]).toString();
    expect(out).toBe("x'; touch /tmp/pwn; echo '|$(id)|normal");
  });
});

describe('monitoreo de instalaciones (ADR 052)', () => {
  const base: InstanceReport = { version: '1.2.3', at: '2026-11-15T10:00:00.000Z', healthy: true, tenants: [{ name: 'Ana', status: 'ACTIVE', integrations: [{ key: 'whatsapp', status: 'error', detail: 'token vencido' }], tasks: [{ key: 'whatsapp_verified', label: 'WhatsApp', done: false, required: true }], activeProducts: 0, enabledAutomations: 1 }] };
  it('solo acepta estados y conteos: nada de campos de más', () => {
    expect(instanceReportSchema.parse(base)).toEqual(base);
    expect(() => instanceReportSchema.parse({ ...base, logs: 'x' })).toThrow();
    expect(() => instanceReportSchema.parse({ ...base, tenants: [{ ...base.tenants[0], phone: '+51' }] })).toThrow();
    expect(() => instanceReportSchema.parse({ ...base, tenants: [{ ...base.tenants[0], integrations: [{ key: 'payments', status: 'managed', detail: '' }] }] })).toThrow();
  });
  it('resume y detecta cambios sin depender de la hora del reporte', () => {
    expect(reportSummary(base)).toBe('Versión 1.2.3 · servicios sanos · Ana: WhatsApp con error; puesta en marcha 0/1; 0 producto(s) activo(s), 1 automatización(es)');
    expect(reportSignature({ ...base, at: '2026-11-15T10:10:00.000Z' })).toBe(reportSignature(base));
    expect(reportSignature({ ...base, healthy: false })).not.toBe(reportSignature(base));
    expect(reportSummary({ ...base, healthy: false, tenants: [] })).toBe('Versión 1.2.3 · hay servicios con problemas · sin empresas cargadas');
  });
});
