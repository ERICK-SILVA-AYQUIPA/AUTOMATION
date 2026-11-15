import { cidrError } from './infra.service.js';
import { sshFingerprint } from './providers/hetzner.adapter.js';

describe('infraestructura: validaciones locales', () => {
  it('CIDR: acepta redes, rechaza bits de host y formatos inválidos', () => {
    expect(cidrError('203.0.113.10/32')).toBeNull();
    expect(cidrError('10.0.1.0/24')).toBeNull();
    expect(cidrError('0.0.0.0/0')).toBeNull();
    expect(cidrError('::/0')).toBeNull();
    expect(cidrError('10.0.1.42/24')).toMatch(/bits de host/);
    expect(cidrError('300.1.1.1/32')).toMatch(/inválida/);
    expect(cidrError('10.0.0.1')).toMatch(/CIDR/);
  });

  it('huella SSH en MD5 con dos puntos (formato de Hetzner)', () => {
    const blob = Buffer.from('clave-de-prueba').toString('base64');
    expect(sshFingerprint(`ssh-ed25519 ${blob} yo@pc`)).toMatch(/^([0-9a-f]{2}:){15}[0-9a-f]{2}$/);
    expect(() => sshFingerprint('ssh-ed25519')).toThrow();
  });
});
