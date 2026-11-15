import { lookup } from 'node:dns/promises';

/** Lo que la comprobación necesita del exterior (las pruebas lo sustituyen) */
export interface ProbeDeps {
  resolve: (domain: string) => Promise<string[]>;
  get: (url: string) => Promise<{ status: number; contentType: string; body: string }>;
}

const realDeps: ProbeDeps = {
  resolve: async (d) => (await lookup(d, { all: true })).map((a) => a.address),
  // fetch valida el certificado TLS: un certificado inválido o ausente es un error
  get: async (url) => {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    return { status: r.status, contentType: r.headers.get('content-type') ?? '', body: (await r.text()).slice(0, 2000) };
  },
};

export type ProbeResult = { ok: true; detail: string; checks: string[] } | { ok: false; error: string };

/**
 * Comprobaciones que hace la plataforma, desde afuera, sobre una instalación
 * nueva: el dominio apunta al servidor creado, la API responde sana por HTTPS
 * (certificado válido) y, al publicar, el panel carga.
 */
export async function probeInstallation(domain: string, expectedIp: string | null, deps: Partial<ProbeDeps> = {}, what: 'api' | 'panel' = 'api'): Promise<ProbeResult> {
  const d = { ...realDeps, ...deps };
  const checks: string[] = [];
  let ips: string[];
  try {
    ips = await d.resolve(domain);
  } catch {
    return { ok: false, error: `${domain} no resuelve en DNS: crea el registro A hacia ${expectedIp ?? 'el servidor'}` };
  }
  if (expectedIp && !ips.includes(expectedIp)) return { ok: false, error: `${domain} apunta a ${ips.join(', ') || 'nada'} y no al servidor (${expectedIp})` };
  checks.push(`DNS ${domain} → ${ips.join(', ')}`);
  const url = what === 'api' ? `https://${domain}/api/v1/health/ready` : `https://${domain}/login`;
  let r: Awaited<ReturnType<ProbeDeps['get']>>;
  try {
    r = await d.get(url);
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    return { ok: false, error: `${url} no responde${cause ? ` (${cause})` : ''}: ${(e as Error).message}` };
  }
  if (what === 'api') {
    if (r.status !== 200) return { ok: false, error: `${url} respondió ${r.status}` };
    let status: unknown;
    try {
      status = (JSON.parse(r.body) as { status?: unknown }).status;
    } catch {
      return { ok: false, error: `${url} no devolvió JSON` };
    }
    if (status !== 'ok') return { ok: false, error: `${url} informa estado ${String(status)}` };
    checks.push('API sana por HTTPS');
    return { ok: true, detail: `DNS correcto y API sana en https://${domain}`, checks };
  }
  if (r.status !== 200 || !r.contentType.includes('text/html')) return { ok: false, error: `${url} respondió ${r.status} (${r.contentType || 'sin tipo'})` };
  checks.push('Panel publicado por HTTPS');
  return { ok: true, detail: `Panel en https://${domain}`, checks };
}
