import { loadRootEnv } from './config/load-root-env.js';
loadRootEnv();

const { NestFactory } = await import('@nestjs/core');
const { AppModule } = await import('./app.module.js');
const { importDelivery } = await import('./deliveries/import.js');

/**
 * Tareas de administración por línea de comandos (dentro del contenedor de la API):
 *   node dist/cli.js importar-entrega <configuracion-cliente.json> [--hasta AAAA-MM-DD]
 */
async function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (cmd !== 'importar-entrega' || !file) {
    console.error('Uso: node dist/cli.js importar-entrega <configuracion-cliente.json> [--hasta AAAA-MM-DD]');
    process.exit(2);
  }
  const i = rest.indexOf('--hasta');
  const until = i >= 0 ? new Date(`${rest[i + 1]}T23:59:59Z`) : undefined;
  if (until && Number.isNaN(until.getTime())) throw new Error('--hasta debe ser una fecha AAAA-MM-DD');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const r = await importDelivery(app, file, { until });
    if (r.status === 'already_imported') console.log(`La configuración de ${r.tenant} ya estaba cargada: no se cambió nada.`);
    else {
      console.log(`Empresa creada: ${r.tenant} (${r.tenantId}) con su configuración.`);
      console.log(r.invitation.sent ? `Invitación enviada a ${r.admin}.` : `AVISO: no se pudo enviar la invitación a ${r.admin} (${r.invitation.error ?? 'correo'}). Reenvíala desde el panel general.`);
    }
  } finally {
    await app.close();
  }
}

await main().catch((e: unknown) => {
  console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
