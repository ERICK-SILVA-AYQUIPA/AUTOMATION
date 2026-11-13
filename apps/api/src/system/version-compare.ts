/** Compara versiones x.y.z (sin dependencias). Negativo si a < b, 0 si iguales, positivo si a > b. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
    if (!m) throw new Error(`Versión no válida: ${v}`);
    return { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i]! - y.n[i]!;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1; // 1.0.0 > 1.0.0-rc
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}
