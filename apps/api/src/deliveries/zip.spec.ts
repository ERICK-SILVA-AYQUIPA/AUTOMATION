import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unzip, zip } from './zip.js';

const hasUnzip = (() => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('zip reproducible', () => {
  const entries = [
    { path: 'b/datos.json', data: '{"a":1}' },
    { path: 'LEEME.md', data: '# Hola ñandú' },
    { path: 'instalacion/instalar.sh', data: '#!/bin/sh\necho ok\n', executable: true },
  ];

  it('mismas entradas, en cualquier orden, producen los mismos bytes', () => {
    const a = zip(entries);
    const b = zip([...entries].reverse());
    expect(a.equals(b)).toBe(true);
  });

  it('se lee de vuelta con contenido, orden y permisos', () => {
    const files = unzip(zip(entries));
    expect(files.map((f) => f.path)).toEqual(['LEEME.md', 'b/datos.json', 'instalacion/instalar.sh']);
    expect(files[0]!.data.toString()).toBe('# Hola ñandú');
    expect(files[2]!.mode & 0o777).toBe(0o755);
    expect(files[1]!.mode & 0o777).toBe(0o644);
  });

  it('rechaza rutas peligrosas o repetidas', () => {
    expect(() => zip([{ path: '../fuera', data: 'x' }])).toThrow();
    expect(() => zip([{ path: '/abs', data: 'x' }])).toThrow();
    expect(() => zip([{ path: 'a', data: 'x' }, { path: 'a', data: 'y' }])).toThrow();
  });

  it.skipIf(!hasUnzip)('lo abre la herramienta unzip estándar con permisos de ejecución', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    writeFileSync(join(dir, 'p.zip'), zip(entries));
    execFileSync('unzip', ['-q', 'p.zip', '-d', 'out'], { cwd: dir });
    expect(readFileSync(join(dir, 'out/LEEME.md'), 'utf8')).toBe('# Hola ñandú');
    expect(statSync(join(dir, 'out/instalacion/instalar.sh')).mode & 0o111).toBeTruthy();
  });
});
