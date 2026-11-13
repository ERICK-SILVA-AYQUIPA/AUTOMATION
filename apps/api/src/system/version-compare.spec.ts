import { describe, expect, it } from 'vitest';
import { compareVersions } from './version-compare.js';

describe('compareVersions', () => {
  it('ordena por número, no por texto', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('0.8.0', '0.9.0')).toBeLessThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });
  it('una versión previa va antes que la final', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
  });
  it('rechaza lo que no es una versión', () => {
    expect(() => compareVersions('latest', '1.0.0')).toThrow(/no válida/);
  });
});
