import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';

/**
 * Desarrollo: carga el .env de la raíz del monorepo (lo genera setup.sh).
 * Busca hacia arriba desde este archivo; funciona desde src/ y desde dist/.
 * Las variables ya definidas en el entorno (producción, CI) tienen prioridad.
 */
export function loadRootEnv(): string | null {
  let dir = import.meta.dirname;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      const f = join(dir, '.env');
      if (existsSync(f)) {
        config({ path: f, quiet: true });
        return f;
      }
      return null;
    }
    dir = dirname(dir);
  }
  return null;
}
