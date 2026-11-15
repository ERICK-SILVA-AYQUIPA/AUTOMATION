import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Ejecuta el agente real (infrastructure/kit/agente.sh) en una carpeta temporal
 * contra la API de prueba. Solo se sustituyen los programas que tocarían el
 * sistema (docker, apt-get, systemctl, dpkg-reconfigure) y la resolución DNS;
 * curl, unzip, sha256sum, python3 y el instalar.sh del paquete son los reales.
 * `failCompose` simula que «docker compose up» falla (migraciones).
 */
export async function runAgent(o: { env: string; ip: string; domain: string; version: string; failCompose?: boolean; dir?: string; estado?: string }) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'aisa-agente-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, 'agente.env'), o.env, { mode: 0o600 });
  // Salida de «node dist/cli.js estado» dentro del contenedor (la calcula la prueba con el código real)
  writeFileSync(join(dir, 'estado.json'), o.estado ?? '');
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const realCurl = '/usr/bin/curl';
  stub('docker', `
S="${dir}/docker-state"; mkdir -p "$S"; echo "docker $*" >> "${dir}/docker.log"
case "$*" in
  "info --format"*) echo /var/lib/docker;;
  info*) exit 0;;
  "version --format"*) echo 27.3.1;;
  "compose version --short") echo 2.29.7;;
  "compose version") echo "Docker Compose version v2.29.7";;
  "image inspect"*) [[ -f "$S/loaded" ]];;
  "load -i"*) touch "$S/loaded"; echo "Loaded image";;
  *" up -d "*) ${o.failCompose ? 'echo "migrate exited with code 1"; exit 1' : 'echo "Container started"'};;
  *" ps -q caddy"*) ;;
  *" ps --format"*) printf 'api\\trunning\\thealthy\\nweb\\trunning\\thealthy\\n';;
  *" ps"*) echo "NAME STATUS";;
  *" exec -T api node dist/cli.js version"*) echo "${o.version}";;
  *" exec -T api node dist/cli.js estado"*) echo "docker $*" >> "${dir}/estado.log"; cat "${dir}/estado.json";;
  *" run --rm"*"importar-entrega"*) echo "Configuración de la empresa importada";;
  *) exit 0;;
esac`);
  for (const b of ['apt-get', 'systemctl', 'dpkg-reconfigure', 'logger']) stub(b, `echo "${b} $*" >> "${dir}/sistema.log"`);
  stub('getent', `[[ "$2" == "${o.domain}" ]] && echo "${o.ip} STREAM ${o.domain}" || exit 2`);
  stub('hostname', `echo "${o.ip}"`);
  // La salud de instalar.sh pasa por Caddy en el servidor (no existe aquí); el resto de curl es real
  stub('curl', `for a in "$@"; do [[ "$a" == --resolve ]] && { echo '{"status":"ok"}'; exit 0; }; [[ "$a" == *169.254.169.254* ]] && { echo "${o.ip}"; exit 0; }; done; exec ${realCurl} "$@"`);
  const script = resolve(import.meta.dirname, '../../../infrastructure/kit/agente.sh');
  const log = join(dir, 'instalacion.log');
  const code = await new Promise<number>((done) => {
    const p = spawn('bash', [script], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, AISA_DIR: dir, AISA_LOG: log, AISA_CRON_FILE: join(dir, 'cron'), INSTALAR_DISCO_MINIMO_GB: '0', LANG: 'C.UTF-8', NO_PROXY: '*' },
      stdio: 'ignore',
    });
    p.on('exit', (c) => done(c ?? 1));
  });
  const read = (f: string) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } };
  return { code, dir, log: read('instalacion.log'), docker: read('docker.log'), cron: read('cron'), envProduction: read('instalacion/.env.production'), agentEnv: read('agente.env'), monitorEnv: read('monitor.env') };
}
