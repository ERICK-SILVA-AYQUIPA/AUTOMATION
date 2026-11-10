import { loadRootEnv } from './config/load-root-env.js';
loadRootEnv();

const { NestFactory } = await import('@nestjs/core');
const { Logger } = await import('nestjs-pino');
const { WorkerModule } = await import('./worker.module.js');

const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
app.useLogger(app.get(Logger));
app.enableShutdownHooks();
