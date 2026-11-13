import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { guardLookup, isBlockedAddress, safePost, validateTargetUrl } from './outbound.js';

describe('protección SSRF de las peticiones salientes', () => {
  it('bloquea red local, metadatos de la nube y reservadas', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.20.1.1', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1']) expect(isBlockedAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '200.48.225.130', '2606:4700:4700::1111']) expect(isBlockedAddress(ip)).toBe(false);
  });
  it('exige https y host público salvo en desarrollo', () => {
    expect(() => validateTargetUrl('http://example.com/hook', false)).toThrow(/https/);
    expect(() => validateTargetUrl('https://localhost/hook', false)).toThrow(/privada/);
    expect(() => validateTargetUrl('https://169.254.169.254/latest', false)).toThrow(/privada/);
    expect(() => validateTargetUrl('https://user:pw@example.com', false)).toThrow(/usuario/);
    expect(validateTargetUrl('https://example.com/hook', false).hostname).toBe('example.com');
    expect(validateTargetUrl('http://127.0.0.1:9/hook', true).port).toBe('9');
  });
  it('un dominio que resuelve a una IP privada se rechaza al conectar', async () => {
    const fakeDns = ((ip: string) => ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => cb(null, [{ address: ip, family: 4 }]))) as unknown as (ip: string) => typeof import('node:dns').lookup;
    const run = (ip: string) => new Promise<string>((resolve, reject) => guardLookup(false, fakeDns(ip))('hook.example.com', {}, (e, a) => (e ? reject(e) : resolve(a as string))));
    await expect(run('127.0.0.1')).rejects.toThrow(/privada/);
    await expect(run('169.254.169.254')).rejects.toThrow(/privada/);
    await expect(run('93.184.216.34')).resolves.toBe('93.184.216.34');
  });
  it('envía y devuelve el código y el cuerpo (red privada solo si se permite)', async () => {
    const srv = createServer((_q, r) => r.end('ok'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    await expect(safePost(`http://127.0.0.1:${port}/`, '{}', {}, { allowPrivate: false })).rejects.toThrow(/https/);
    await expect(safePost(`http://127.0.0.1:${port}/`, '{}', {}, { allowPrivate: true })).resolves.toEqual({ status: 200, body: 'ok' });
    srv.close();
  });
});
