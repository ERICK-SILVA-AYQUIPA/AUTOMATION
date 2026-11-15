import { createHash } from 'node:crypto';
import {
  InfraError, type ActionRef, type CreateServerInput, type FirewallRule, type InfraAdapter, type InfraCredentials, type InfraLocation, type InfraServerType,
  type MetricsResult, type PowerAction, type RemoteServer, type ServerState, type VerifyResult,
} from './types.js';

/*
 * Formatos tomados del SDK oficial de Hetzner (hetznercloud/hcloud-go, paquete
 * hcloud/schema) y de su registro de cambios: base https://api.hetzner.cloud/v1,
 * «Authorization: Bearer», errores { error: { code, message } }, paginación
 * page/per_page con meta.pagination, `location` en servidores (el campo
 * `datacenter` ya no existe) y disponibilidad por ubicación en
 * server_types[].locations[].available.
 */
interface HzPrice { net: string; gross: string }
interface HzServerType {
  name: string; description: string; cores: number; memory: number; disk: number; cpu_type?: string; architecture?: string;
  prices: { location: string; price_hourly: HzPrice; price_monthly: HzPrice; included_traffic?: number }[];
  deprecation?: unknown; locations?: { name: string; available?: boolean; deprecation?: unknown }[];
}
interface HzServer {
  id: number; name: string; status: string; created: string; labels?: Record<string, string>;
  public_net?: { ipv4?: { ip: string } | null; ipv6?: { ip: string } | null; firewalls?: { id: number }[] };
  server_type?: { name: string }; location?: { name: string }; image?: { name?: string | null; description?: string } | null;
  included_traffic?: number | null; outgoing_traffic?: number | null; ingoing_traffic?: number | null;
}
interface HzAction { id: number; status: 'running' | 'success' | 'error'; progress: number; error?: { code: string; message: string } | null }

const STATES: ServerState[] = ['initializing', 'starting', 'running', 'stopping', 'off', 'deleting', 'migrating', 'rebuilding', 'unknown'];

/** Huella MD5 de la clave pública, como la informa Hetzner (aa:bb:…) */
export function sshFingerprint(publicKey: string) {
  const blob = publicKey.trim().split(/\s+/)[1];
  if (!blob) throw new InfraError('INVALID_KEY', 'Clave pública SSH inválida');
  return createHash('md5').update(Buffer.from(blob, 'base64')).digest('hex').match(/../g)!.join(':');
}

export class HetznerAdapter implements InfraAdapter {
  readonly kind = 'HETZNER' as const;
  readonly label = 'Hetzner Cloud';
  readonly capabilities = { projects: false, billing: false, metrics: true, firewalls: true };

  constructor(private readonly baseUrl: string) {}

  validateToken(token: string) {
    return /^[A-Za-z0-9]{40,100}$/.test(token) ? null : 'El token de Hetzner Cloud tiene letras y números (64 caracteres)';
  }

  private async call<T>(c: InfraCredentials, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: { Authorization: `Bearer ${c.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new InfraError('UNREACHABLE', `No se pudo conectar con Hetzner: ${(e as Error).message}`);
    }
    if (res.status === 204) return { status: 204, data: undefined as T };
    const json = (await res.json().catch(() => null)) as (T & { error?: { code: string; message: string } }) | null;
    if (!res.ok) {
      const code = json?.error?.code ?? `http_${res.status}`;
      throw new InfraError(code, json?.error?.message ?? `Hetzner respondió ${res.status}`, res.status);
    }
    return { status: res.status, data: json as T };
  }

  /** Recorre todas las páginas (per_page máximo 50) */
  private async all<T>(c: InfraCredentials, path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const { data } = await this.call<Record<string, unknown> & { meta?: { pagination?: { next_page: number | null } } }>(c, 'GET', `${path}${sep}page=${page}&per_page=50`);
      out.push(...((data[key] as T[] | undefined) ?? []));
      if (!data.meta?.pagination?.next_page) break;
    }
    return out;
  }

  async verify(c: InfraCredentials): Promise<VerifyResult> {
    try {
      const { data } = await this.call<{ servers: unknown[]; meta?: { pagination?: { total_entries?: number } } }>(c, 'GET', '/servers?per_page=1');
      return { ok: true, status: 'CONNECTED', message: 'Token aceptado (lectura). El permiso de escritura se comprueba al crear el primer recurso.', details: { servers: data.meta?.pagination?.total_entries ?? data.servers.length } };
    } catch (e) {
      const err = e as InfraError;
      if (err.code === 'unauthorized' || err.httpStatus === 401) return { ok: false, status: 'AUTH_ERROR', message: 'Hetzner rechazó el token (inválido o revocado)' };
      if (err.code === 'forbidden' || err.httpStatus === 403) return { ok: false, status: 'PERMISSION_DENIED', message: 'El token no tiene permiso para leer servidores' };
      return { ok: false, status: 'UNAVAILABLE', message: err.message };
    }
  }

  async currency(c: InfraCredentials) {
    const { data } = await this.call<{ pricing: { currency: string; vat_rate: string } }>(c, 'GET', '/pricing');
    return { currency: data.pricing.currency, vatRate: data.pricing.vat_rate ?? null };
  }

  async locations(c: InfraCredentials): Promise<InfraLocation[]> {
    const rows = await this.all<{ name: string; description: string; country: string; city: string; network_zone?: string }>(c, '/locations', 'locations');
    return rows.map((l) => ({ name: l.name, description: l.description, country: l.country, city: l.city, networkZone: l.network_zone ?? null }));
  }

  async serverTypes(c: InfraCredentials): Promise<InfraServerType[]> {
    const rows = await this.all<HzServerType>(c, '/server_types', 'server_types');
    return rows.map((t) => ({
      name: t.name, description: t.description, cores: t.cores, memoryGb: t.memory, diskGb: t.disk, cpuType: t.cpu_type ?? null, architecture: t.architecture ?? null,
      prices: t.prices.map((p) => ({ location: p.location, hourly: p.price_hourly, monthly: p.price_monthly, includedTrafficBytes: p.included_traffic ?? null })),
      availableIn: (t.locations ?? []).filter((l) => l.available !== false && !l.deprecation).map((l) => l.name),
      deprecated: !!t.deprecation,
    }));
  }

  private server(s: HzServer): RemoteServer {
    return {
      externalId: String(s.id), name: s.name, status: (STATES.includes(s.status as ServerState) ? s.status : 'unknown') as ServerState,
      serverType: s.server_type?.name ?? '', location: s.location?.name ?? '', image: s.image?.name ?? s.image?.description ?? null,
      ipv4: s.public_net?.ipv4?.ip ?? null, ipv6: s.public_net?.ipv6?.ip ?? null, createdAt: s.created, labels: s.labels ?? {},
      firewalls: (s.public_net?.firewalls ?? []).map((f) => String(f.id)),
      traffic: { includedBytes: s.included_traffic ?? null, outgoingBytes: s.outgoing_traffic ?? null, ingoingBytes: s.ingoing_traffic ?? null },
    };
  }

  private toAction(a: HzAction): ActionRef {
    return { id: String(a.id), status: a.status, progress: a.progress, error: a.error ? `${a.error.code}: ${a.error.message}` : null };
  }

  async listServers(c: InfraCredentials) {
    return (await this.all<HzServer>(c, '/servers', 'servers')).map((s) => this.server(s));
  }

  async getServer(c: InfraCredentials, externalId: string) {
    try {
      return this.server((await this.call<{ server: HzServer }>(c, 'GET', `/servers/${Number(externalId)}`)).data.server);
    } catch (e) {
      if ((e as InfraError).code === 'not_found') return null;
      throw e;
    }
  }

  async ensureSshKey(c: InfraCredentials, name: string, publicKey: string) {
    const fingerprint = sshFingerprint(publicKey);
    const found = (await this.call<{ ssh_keys: { id: number; fingerprint: string }[] }>(c, 'GET', `/ssh_keys?fingerprint=${encodeURIComponent(fingerprint)}`)).data.ssh_keys[0];
    if (found) return { externalId: String(found.id), fingerprint };
    const { data } = await this.call<{ ssh_key: { id: number; fingerprint: string } }>(c, 'POST', '/ssh_keys', { name, public_key: publicKey.trim(), labels: { 'managed-by': 'ai-sales-assistant' } });
    return { externalId: String(data.ssh_key.id), fingerprint: data.ssh_key.fingerprint };
  }

  async createFirewall(c: InfraCredentials, name: string, rules: FirewallRule[], labels: Record<string, string>) {
    const { data } = await this.call<{ firewall: { id: number } }>(c, 'POST', '/firewalls', {
      name, labels,
      rules: rules.map((r) => ({ direction: r.direction, protocol: r.protocol, ...(r.port ? { port: r.port } : {}), source_ips: r.sourceIps, description: r.description })),
    });
    return { externalId: String(data.firewall.id) };
  }

  async createServer(c: InfraCredentials, i: CreateServerInput) {
    const { data } = await this.call<{ server: HzServer; action: HzAction | null; root_password: string | null }>(c, 'POST', '/servers', {
      name: i.name, server_type: i.serverType, image: i.image, location: i.location,
      ssh_keys: i.sshKeyIds.map(Number), labels: i.labels, start_after_create: true,
      public_net: { enable_ipv4: true, enable_ipv6: true },
      ...(i.firewallId ? { firewalls: [{ firewall: Number(i.firewallId) }] } : {}),
      ...(i.userData ? { user_data: i.userData } : {}),
    });
    // La contraseña de root (solo si no hubo claves SSH) no se guarda ni se devuelve
    return { server: this.server(data.server), action: data.action ? this.toAction(data.action) : null, rootPasswordReturned: !!data.root_password };
  }

  async power(c: InfraCredentials, externalId: string, action: PowerAction) {
    return this.toAction((await this.call<{ action: HzAction }>(c, 'POST', `/servers/${Number(externalId)}/actions/${action}`)).data.action);
  }

  async deleteServer(c: InfraCredentials, externalId: string) {
    const r = await this.call<{ action?: HzAction }>(c, 'DELETE', `/servers/${Number(externalId)}`);
    return r.data?.action ? this.toAction(r.data.action) : null;
  }

  async action(c: InfraCredentials, actionId: string) {
    return this.toAction((await this.call<{ action: HzAction }>(c, 'GET', `/actions/${Number(actionId)}`)).data.action);
  }

  async metrics(c: InfraCredentials, externalId: string, types: ('cpu' | 'disk' | 'network')[], start: Date, end: Date): Promise<MetricsResult> {
    const q = new URLSearchParams();
    for (const t of types) q.append('type', t);
    q.set('start', start.toISOString());
    q.set('end', end.toISOString());
    const { data } = await this.call<{ metrics: { start: string; end: string; step: number; time_series: Record<string, { values: [number, string][] }> } }>(c, 'GET', `/servers/${Number(externalId)}/metrics?${q}`);
    return { start: data.metrics.start, end: data.metrics.end, step: data.metrics.step, series: Object.fromEntries(Object.entries(data.metrics.time_series).map(([k, v]) => [k, v.values])) };
  }
}
