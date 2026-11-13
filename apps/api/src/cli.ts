import { loadRootEnv } from './config/load-root-env.js';
loadRootEnv();

const USAGE = `Uso (dentro del contenedor de la API):
  node dist/cli.js version
  node dist/cli.js importar-entrega <configuracion-cliente.json> [--hasta AAAA-MM-DD]
  node dist/cli.js registrar-actualizacion --desde X.Y.Z --hasta X.Y.Z --estado SUCCEEDED|FAILED|ROLLED_BACK --inicio <fecha ISO> [--respaldo <ruta>] [--detalle <texto>]`;

function flags(args: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) throw new Error(`Argumento inesperado: ${a}`);
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`Falta el valor de ${a}`);
    out[a.slice(2)] = v;
    i++;
  }
  return out;
}

/** Tareas de administración por línea de comandos */
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'version') {
    const { APP_VERSION } = await import('./deliveries/version.js');
    console.log(APP_VERSION);
    return;
  }
  if (cmd !== 'importar-entrega' && cmd !== 'registrar-actualizacion') {
    console.error(USAGE);
    process.exit(2);
  }
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    if (cmd === 'importar-entrega') {
      const { importDelivery } = await import('./deliveries/import.js');
      const [file, ...more] = rest;
      if (!file) throw new Error(USAGE);
      const f = flags(more);
      const until = f.hasta ? new Date(`${f.hasta}T23:59:59Z`) : undefined;
      if (until && Number.isNaN(until.getTime())) throw new Error('--hasta debe ser una fecha AAAA-MM-DD');
      const r = await importDelivery(app, file, { until });
      if (r.status === 'already_imported') console.log(`La configuración de ${r.tenant} ya estaba cargada: no se cambió nada.`);
      else {
        console.log(`Empresa creada: ${r.tenant} (${r.tenantId}) con su configuración.`);
        console.log(r.invitation.sent ? `Invitación enviada a ${r.admin}.` : `AVISO: no se pudo enviar la invitación a ${r.admin} (${r.invitation.error ?? 'correo'}). Reenvíala desde el panel general.`);
      }
    } else {
      const { SystemService, recordUpdateSchema } = await import('./system/system.service.js');
      const f = flags(rest);
      const input = recordUpdateSchema.parse({ fromVersion: f.desde, toVersion: f.hasta, status: f.estado, startedAt: f.inicio, backupPath: f.respaldo, detail: f.detalle });
      const u = await app.get(SystemService).record(input);
      console.log(`Actualización ${u.fromVersion} → ${u.toVersion} registrada: ${u.status}${(u.migrations as string[]).length ? ` · migraciones: ${(u.migrations as string[]).join(', ')}` : ''}`);
    }
  } finally {
    await app.close();
  }
}

await main().catch((e: unknown) => {
  console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
