import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Servidor local que responde como la API de Hetzner Cloud (solo pruebas: en
 * producción la URL base no se puede cambiar). Formatos del SDK oficial
 * hetznercloud/hcloud-go (hcloud/schema). Nada aquí crea recursos reales.
 *
 * Token (por su contenido): «bad» → 401 unauthorized; «readonly» → lee pero
 * cualquier escritura da 403 forbidden; «down» → 503; otro → válido.
 * Un servidor nace «initializing» y pasa a «running» en la siguiente consulta.
 */
export interface FakeHzCall { method: string; path: string; token: string; body: Record<string, unknown> | null }

const readBody = (req: IncomingMessage) => new Promise<string>((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
const price = (net: string) => ({ net, gross: (Number(net) * 1.19).toFixed(4) });

export const FAKE_TYPES = [
  { id: 1, name: 'cx23', description: 'CX23', cores: 2, memory: 4, disk: 40, cpu_type: 'shared', architecture: 'x86', deprecation: null,
    prices: [{ location: 'fsn1', price_hourly: price('0.0060'), price_monthly: price('3.7900'), included_traffic: 21990232555520 }, { location: 'nbg1', price_hourly: price('0.0060'), price_monthly: price('3.7900'), included_traffic: 21990232555520 }],
    locations: [{ id: 1, name: 'fsn1', available: true, recommended: true, deprecation: null }, { id: 2, name: 'nbg1', available: false, recommended: false, deprecation: null }] },
  { id: 2, name: 'cx33', description: 'CX33', cores: 4, memory: 8, disk: 80, cpu_type: 'shared', architecture: 'x86', deprecation: null,
    prices: [{ location: 'fsn1', price_hourly: price('0.0104'), price_monthly: price('6.4900'), included_traffic: 21990232555520 }],
    locations: [{ id: 1, name: 'fsn1', available: true, recommended: true, deprecation: null }] },
  { id: 3, name: 'cx11', description: 'CX11 (retirado)', cores: 1, memory: 2, disk: 20, cpu_type: 'shared', architecture: 'x86', deprecation: { announced: '2024-01-01T00:00:00Z', unavailable_after: '2024-06-01T00:00:00Z' },
    prices: [{ location: 'fsn1', price_hourly: price('0.0050'), price_monthly: price('3.2900'), included_traffic: 21990232555520 }], locations: [] },
];
const LOCATIONS = [
  { id: 1, name: 'fsn1', description: 'Falkenstein DC Park 1', country: 'DE', city: 'Falkenstein', latitude: 50.47, longitude: 12.37, network_zone: 'eu-central' },
  { id: 2, name: 'nbg1', description: 'Nuremberg DC Park 1', country: 'DE', city: 'Nuremberg', latitude: 49.45, longitude: 11.07, network_zone: 'eu-central' },
];

export async function startFakeHetzner(port = 0) {
  const calls: FakeHzCall[] = [];
  let seq = 1000;
  const servers = new Map<number, Record<string, unknown>>();
  const keys = new Map<number, { id: number; name: string; fingerprint: string; public_key: string }>();
  const firewalls = new Map<number, Record<string, unknown>>();
  const actions = new Map<number, { id: number; command: string; status: string; progress: number; error: null }>();
  const action = (command: string) => {
    const a = { id: ++seq, command, status: 'success', progress: 100, error: null, started: new Date().toISOString(), finished: new Date().toISOString(), resources: [] };
    actions.set(a.id, a);
    return a;
  };

  const srv: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/^\/v1/, '');
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    calls.push({ method: req.method!, path: `${path}${url.search}`, token, body });
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const err = (status: number, code: string, message: string) => send(status, { error: { code, message, details: {} } });
    const page = (key: string, items: unknown[]) => {
      const per = Number(url.searchParams.get('per_page') ?? 25);
      const p = Number(url.searchParams.get('page') ?? 1);
      const slice = items.slice((p - 1) * per, p * per);
      const last = Math.max(1, Math.ceil(items.length / per));
      send(200, { [key]: slice, meta: { pagination: { page: p, per_page: per, previous_page: p > 1 ? p - 1 : null, next_page: p < last ? p + 1 : null, last_page: last, total_entries: items.length } } });
    };

    if (!token || token.includes('bad')) return err(401, 'unauthorized', 'unable to authenticate');
    if (token.includes('down')) return err(503, 'unavailable', 'service unavailable');
    if (req.method !== 'GET' && token.includes('readonly')) return err(403, 'forbidden', 'insufficient permissions');

    let m: RegExpExecArray | null;
    if (req.method === 'GET' && path === '/locations') return page('locations', LOCATIONS);
    if (req.method === 'GET' && path === '/server_types') return page('server_types', FAKE_TYPES);
    if (req.method === 'GET' && path === '/pricing') return send(200, { pricing: { currency: 'EUR', vat_rate: '19.00', server_types: FAKE_TYPES.map((t) => ({ id: t.id, name: t.name, prices: t.prices })) } });
    if (req.method === 'GET' && path === '/servers') {
      for (const s of servers.values()) if (s.status === 'initializing') s.status = 'running';
      return page('servers', [...servers.values()]);
    }
    if (req.method === 'GET' && path === '/ssh_keys') {
      const fp = url.searchParams.get('fingerprint');
      return page('ssh_keys', [...keys.values()].filter((k) => !fp || k.fingerprint === fp));
    }
    if (req.method === 'POST' && path === '/ssh_keys') {
      const pk = typeof body?.public_key === 'string' ? body.public_key : '';
      const blob = pk.split(/\s+/)[1] ?? '';
      const fingerprint = createHash('md5').update(Buffer.from(blob, 'base64')).digest('hex').match(/../g)!.join(':');
      if ([...keys.values()].some((k) => k.fingerprint === fingerprint)) return err(409, 'uniqueness_error', 'SSH key with the same fingerprint already exists');
      const k = { id: ++seq, name: String(body?.name), fingerprint, public_key: pk, labels: body?.labels ?? {}, created: new Date().toISOString() };
      keys.set(k.id, k);
      return send(201, { ssh_key: k });
    }
    if (req.method === 'POST' && path === '/firewalls') {
      const f = { id: ++seq, name: body?.name, labels: body?.labels ?? {}, rules: body?.rules ?? [], applied_to: [], created: new Date().toISOString() };
      firewalls.set(f.id, f);
      return send(201, { firewall: f, actions: [] });
    }
    if (req.method === 'POST' && path === '/servers') {
      const type = FAKE_TYPES.find((t) => t.name === body?.server_type);
      if (!type) return err(400, 'invalid_input', 'invalid server type');
      const loc = LOCATIONS.find((l) => l.name === body?.location);
      if (!loc) return err(400, 'invalid_input', 'invalid location');
      if (!type.locations.some((l) => l.name === loc.name && l.available)) return err(412, 'resource_unavailable', 'server type unavailable in location');
      const id = ++seq;
      const fw = ((body?.firewalls as { firewall: number }[] | undefined) ?? []).map((f) => ({ id: f.firewall, status: 'applied' }));
      const s = {
        id, name: body?.name, status: 'initializing', created: new Date().toISOString(), labels: body?.labels ?? {},
        public_net: { ipv4: { id: id + 1, ip: `203.0.113.${id % 250}`, blocked: false, dns_ptr: '' }, ipv6: { id: id + 2, ip: `2001:db8:${id.toString(16)}::/64`, blocked: false, dns_ptr: [] }, floating_ips: [], firewalls: fw },
        private_net: [], server_type: type, location: loc, image: { id: 1, name: body?.image, description: 'Ubuntu' },
        included_traffic: 21990232555520, outgoing_traffic: 0, ingoing_traffic: 0, locked: false, protection: { delete: false, rebuild: false }, volumes: [], load_balancers: [], primary_disk_size: type.disk,
      };
      servers.set(id, s);
      const sshKeys = (body?.ssh_keys as unknown[] | undefined) ?? [];
      return send(201, { server: s, action: action('create_server'), next_actions: [action('start_server')], root_password: sshKeys.length ? null : 'NoDeberiaGuardarse123' });
    }
    if ((m = /^\/servers\/(\d+)$/.exec(path))) {
      const s = servers.get(Number(m[1]));
      if (!s) return err(404, 'not_found', 'server not found');
      if (req.method === 'GET') {
        if (s.status === 'initializing') s.status = 'running';
        return send(200, { server: s });
      }
      if (req.method === 'DELETE') {
        servers.delete(Number(m[1]));
        return send(200, { action: action('delete_server') });
      }
    }
    if (req.method === 'POST' && (m = /^\/servers\/(\d+)\/actions\/(poweron|poweroff|shutdown|reboot)$/.exec(path))) {
      const s = servers.get(Number(m[1]));
      if (!s) return err(404, 'not_found', 'server not found');
      s.status = m[2] === 'poweron' || m[2] === 'reboot' ? 'running' : 'off';
      return send(201, { action: action(`${m[2]}`) });
    }
    if (req.method === 'GET' && (m = /^\/servers\/(\d+)\/metrics$/.exec(path))) {
      if (!servers.has(Number(m[1]))) return err(404, 'not_found', 'server not found');
      const start = url.searchParams.get('start')!;
      const end = url.searchParams.get('end')!;
      const t0 = Date.parse(start) / 1000;
      const series: Record<string, { values: [number, string][] }> = {};
      for (const t of url.searchParams.getAll('type')) {
        if (t === 'cpu') series.cpu = { values: [[t0, '12.5'], [t0 + 60, '20.0']] };
        if (t === 'network') series['network.0.bandwidth.out'] = { values: [[t0, '1024'], [t0 + 60, '2048']] };
      }
      return send(200, { metrics: { start, end, step: 60, time_series: series } });
    }
    if (req.method === 'GET' && (m = /^\/actions\/(\d+)$/.exec(path))) {
      const a = actions.get(Number(m[1]));
      return a ? send(200, { action: a }) : err(404, 'not_found', 'action not found');
    }
    err(404, 'not_found', `no route ${req.method} ${path}`);
  });
  await new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()));
  const p = (srv.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${p}/v1`, calls, servers, keys, firewalls,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

// Ejecución directa (pruebas en navegador): node test/fake-hetzner.ts [puerto]
if (process.argv[1]?.endsWith('fake-hetzner.ts')) {
  const f = await startFakeHetzner(Number(process.argv[2] ?? 4996));
  console.log(`Hetzner de prueba en ${f.url}`);
}
