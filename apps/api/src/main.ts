import { loadRootEnv } from './config/load-root-env.js';
loadRootEnv();

const { NestFactory } = await import('@nestjs/core');
const { AppModule } = await import('./app.module.js');
const { configureApp } = await import('./bootstrap.js');

const app = await NestFactory.create(AppModule, { bufferLogs: true });
const env = configureApp(app);
await app.listen(env.API_PORT);
