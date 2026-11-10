import { decrypt, encrypt, randomToken, safeEqual, sha256 } from './crypto.js';

const KEY = 'a'.repeat(64);

describe('crypto', () => {
  it('cifra y descifra con AES-256-GCM; IV aleatorio', () => {
    const a = encrypt('token-secreto', KEY);
    const b = encrypt('token-secreto', KEY);
    expect(a).not.toBe(b);
    expect(decrypt(a, KEY)).toBe('token-secreto');
  });
  it('detecta manipulación del texto cifrado', () => {
    const parts = encrypt('dato', KEY).split('.');
    parts[3] = Buffer.from('otro').toString('base64url');
    expect(() => decrypt(parts.join('.'), KEY)).toThrow();
  });
  it('falla con otra clave', () => {
    expect(() => decrypt(encrypt('x', KEY), 'b'.repeat(64))).toThrow();
  });
  it('tokens aleatorios de 256 bits y hash determinista', () => {
    expect(randomToken()).toHaveLength(43);
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
