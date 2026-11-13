import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

/**
 * Direcciones a las que nunca se envía una petición en nombre de una empresa
 * (SSRF): red local, enlace local (metadatos de la nube), CGNAT, multicast y
 * reservadas.
 */
export function isBlockedAddress(raw: string): boolean {
  const ip = raw.toLowerCase().startsWith('::ffff:') ? raw.slice(7) : raw;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff') || v.startsWith('64:ff9b:') || v.startsWith('2001:db8');
  }
  return true;
}

export class OutboundError extends Error {
  constructor(message: string, readonly permanent = false) {
    super(message);
  }
}

/** Valida la URL de destino: https y host público, salvo que se permita la red privada (desarrollo). */
export function validateTargetUrl(raw: string, allowPrivate: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OutboundError('URL no válida', true);
  }
  if (u.username || u.password) throw new OutboundError('La URL no puede llevar usuario ni contraseña', true);
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) throw new OutboundError('La URL debe empezar por https://', true);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || (isIP(host) && isBlockedAddress(host)))) {
    throw new OutboundError('La URL apunta a una dirección privada', true);
  }
  return u;
}

/** Resolución DNS que rechaza direcciones bloqueadas (se aplica en cada conexión, así no sirve el rebinding) */
export function guardLookup(allowPrivate: boolean, resolve: typeof lookup = lookup): LookupFunction {
  return (hostname, options, cb) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err, '', 4);
      const list = addresses as unknown as { address: string; family: number }[];
      const bad = !allowPrivate && list.some((a) => isBlockedAddress(a.address));
      if (bad || !list.length) return cb(new OutboundError('El dominio resuelve a una dirección privada', true) as NodeJS.ErrnoException, '', 4);
      if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: typeof list) => void)(null, list);
      cb(null, list[0]!.address, list[0]!.family);
    });
  };
}

/**
 * POST con protección SSRF también en la resolución DNS (cada dirección
 * resuelta se comprueba al conectar, sin seguir redirecciones). Devuelve el
 * código y como mucho 1 KB del cuerpo de la respuesta.
 */
export async function safePost(url: string, body: string, headers: Record<string, string>, opts: { allowPrivate: boolean; timeoutMs?: number }): Promise<{ status: number; body: string }> {
  const u = validateTargetUrl(url, opts.allowPrivate);
  const guardedLookup = guardLookup(opts.allowPrivate);
  const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      u,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body).toString(), 'User-Agent': 'AI-Sales-Assistant-Webhooks/1.0', ...headers }, lookup: guardedLookup, timeout: opts.timeoutMs ?? 10_000 },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          if (text.length < 1024) text += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text.slice(0, 1024) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new OutboundError('Tiempo de espera agotado')));
    req.on('error', (e) => reject(e instanceof OutboundError ? e : new OutboundError(e.message)));
    req.end(body);
  });
}
