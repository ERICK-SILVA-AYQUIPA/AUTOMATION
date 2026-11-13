import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeliveryManifest } from './manifest.js';
import type { ZipEntry } from './zip.js';

/**
 * Kit de instalación independiente (ADR 044): los mismos archivos de despliegue
 * del repositorio (Docker Compose de producción, Caddy, scripts, flujos de n8n)
 * en la versión de esta aplicación. En la imagen de la API viven en /app/kit
 * (ver app.Dockerfile); en desarrollo se leen del repositorio.
 */
const here = dirname(fileURLToPath(import.meta.url));

export function kitRoot(): string {
  const candidates = [resolve(here, '../../kit'), resolve(here, '../../../..')];
  const root = candidates.find((c) => existsSync(join(c, 'docker-compose.prod.yml')) && existsSync(join(c, 'infrastructure/kit/instalar.sh')));
  if (!root) throw new Error('No se encuentra el kit de instalación (docker-compose.prod.yml)');
  return root;
}

/** [origen en el repositorio, destino en instalacion/, ejecutable] */
const FILES: [string, string, boolean][] = [
  ['docker-compose.prod.yml', 'docker-compose.prod.yml', false],
  ['infrastructure/caddy/Caddyfile', 'infrastructure/caddy/Caddyfile', false],
  ['infrastructure/caddy/extra/chatwoot.caddy.example', 'infrastructure/caddy/extra/chatwoot.caddy.example', false],
  ['infrastructure/docker/postgres/init/01-create-databases.sh', 'infrastructure/docker/postgres/init/01-create-databases.sh', true],
  ['infrastructure/scripts/backup.sh', 'infrastructure/scripts/backup.sh', true],
  ['infrastructure/scripts/restore.sh', 'infrastructure/scripts/restore.sh', true],
  ['infrastructure/kit/instalar.sh', 'instalar.sh', true],
  ['infrastructure/kit/actualizar.sh', 'actualizar.sh', true],
  ['infrastructure/kit/salud.sh', 'salud.sh', true],
  ['infrastructure/kit/respaldo.sh', 'respaldo.sh', true],
  ['infrastructure/kit/restaurar.sh', 'restaurar.sh', true],
  ['infrastructure/kit/registros.sh', 'registros.sh', true],
  ['services/n8n/setup.sh', 'services/n8n/setup.sh', true],
  ['services/chatwoot/setup-platform.sh', 'services/chatwoot/setup-platform.sh', true],
];

/** .env de ejemplo con los datos (no secretos) de esta entrega; los secretos quedan como __GENERATE__ */
export function renderEnv(example: string, m: DeliveryManifest): string {
  const set: Record<string, string> = { APP_DOMAIN: m.system.domain ?? 'ventas.tu-dominio.com', TZ: m.client.timezone, APP_VERSION: m.appVersion };
  const all = example.split('\n');
  // La cabecera del repositorio habla de deploy.sh; en el paquete manda instalar.sh
  const body = all.slice(Math.max(0, all.findIndex((l) => l.trim() === '')));
  const lines = body.map((line) => {
    const k = /^([A-Z0-9_]+)=/.exec(line)?.[1];
    if (k && k in set) return `${k}=${set[k]}`;
    return line.startsWith('#') ? line.replace('los genera deploy.sh --init', 'los genera instalar.sh') : line;
  });
  const header = [
    '# =============================================================================',
    `# ${m.system.name} · ${m.client.name} · entrega n.º ${m.number} · versión ${m.appVersion}`,
    '# Variables de la instalación independiente. No se edita este archivo:',
    '# ./instalar.sh crea .env.production a partir de él (permisos 600), sustituye',
    '# cada CLAVE=__GENERATE__ por un secreto aleatorio y se detiene para que',
    '# completes lo marcado como OBLIGATORIO. Guía: ../docs/instalacion.md',
    '# =============================================================================',
  ];
  return [...header, ...lines].join('\n');
}

export function kitEntries(m: DeliveryManifest, root = kitRoot()): ZipEntry[] {
  const read = (p: string) => readFileSync(join(root, p));
  const out: ZipEntry[] = FILES.map(([src, dest, executable]) => ({ path: `instalacion/${dest}`, data: read(src), executable }));
  const wf = 'services/n8n/workflows';
  for (const f of readdirSync(join(root, wf)).filter((x) => x.endsWith('.json')).sort()) out.push({ path: `instalacion/${wf}/${f}`, data: read(`${wf}/${f}`) });
  out.push({ path: 'instalacion/.env.production.example', data: renderEnv(read('.env.production.example').toString('utf8'), m) });
  // Huellas de los archivos del kit tal como se entregan: actualizar.sh las usa
  // para saber qué archivos personalizó el cliente y no pisarlos (ADR 045)
  const sums = out
    .map((f) => `${createHash('sha256').update(f.data).digest('hex')}  ${f.path.slice('instalacion/'.length)}`)
    .sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1))
    .join('\n');
  out.push({ path: 'instalacion/.kit-sha256', data: `${sums}\n` });
  out.push({ path: 'instalacion/configuracion-cliente.json', data: `${JSON.stringify(m, null, 2)}\n` });
  return out;
}
