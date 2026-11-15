import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kitRoot } from '../deliveries/kit.js';

/** Comillas simples de shell: 'a'"'"'b' */
const sq = (v: string) => `'${v.replace(/'/g, `'"'"'`)}'`;

/**
 * cloud-init (user_data) del servidor nuevo. Solo lleva la URL de la API, el id
 * de la instalación y un token de arranque de un solo uso que vence en 6 h: el
 * resto (agente y configuración) se pide por HTTPS al arrancar. Hetzner guarda
 * el user_data en la metadata del servidor; por eso no contiene secretos
 * duraderos.
 */
export function cloudInit(i: { apiUrl: string; runId: string; token: string }) {
  return `#!/bin/bash
# AI Sales Assistant · arranque de la instalación ${i.runId}
set -euo pipefail
umask 077
mkdir -p /opt/aisa
exec >>/var/log/aisa-instalacion.log 2>&1
echo "== $(date -Is) arranque"
API=${sq(i.apiUrl)}
RUN=${sq(i.runId)}
BODY=$(printf '{"token":"%s"}' ${sq(i.token)})
for n in $(seq 1 40); do
  if curl -fsS --max-time 30 -H 'Content-Type: application/json' -d "$BODY" -o /opt/aisa/arranque.json "$API/api/v1/public/provisioning/$RUN/bootstrap"; then break; fi
  echo "arranque: intento $n fallido"; sleep 15
done
[ -s /opt/aisa/arranque.json ] || { echo "No se pudo contactar con la plataforma"; exit 1; }
python3 - <<'PY'
import json
d = json.load(open('/opt/aisa/arranque.json'))
open('/opt/aisa/agente.sh', 'w').write(d['script'])
open('/opt/aisa/agente.env', 'w').write(d['env'])
PY
rm -f /opt/aisa/arranque.json
chmod 700 /opt/aisa/agente.sh; chmod 600 /opt/aisa/agente.env
exec /opt/aisa/agente.sh
`;
}

/** Variables del agente en formato de shell seguro (se cargan con «source») */
export function agentEnv(vars: Record<string, string>) {
  return `${Object.entries(vars).map(([k, v]) => `${k}=${sq(v)}`).join('\n')}\n`;
}

let cached: string | null = null;
/** Script del agente: infrastructure/kit/agente.sh (va en la imagen de la API con el kit) */
export function agentScript() {
  cached ??= readFileSync(join(kitRoot(), 'infrastructure/kit/agente.sh'), 'utf8');
  return cached;
}
