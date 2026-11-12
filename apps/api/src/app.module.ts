import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { ConfigModule } from './config/config.module.js';
import { ENV, type Env } from './config/env.js';
import { DatabaseModule } from './database/database.module.js';
import { MailModule } from './mail/mail.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { TenantsModule } from './tenants/tenants.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { HealthModule } from './health/health.module.js';
import { StorageModule } from './storage/storage.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { REDIS, RedisModule } from './health/redis.provider.js';
import type { Redis } from 'ioredis';
import { RedisThrottlerStorage } from './common/throttler-redis.storage.js';
import { QueuesModule } from './queues/queues.module.js';
import { AutomationsModule } from './automations/automations.module.js';
import { ChatwootModule } from './chatwoot/chatwoot.module.js';
import { AiModule } from './ai/ai.module.js';
import { InternalModule } from './automations/internal.module.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { AuthGuard } from './common/guards/auth.guard.js';
import { AllExceptionsFilter } from './common/filters/http-exception.filter.js';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          genReqId: (req, res) => {
            // Solo se acepta un id del cliente con formato seguro (evita inyección en los logs)
            const given = req.headers['x-request-id'];
            const id = typeof given === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(given) ? given : randomUUID();
            res.setHeader('x-request-id', id);
            return id;
          },
          // Nunca registrar credenciales ni tokens
          redact: {
            paths: ['req.headers.authorization', 'req.headers["x-internal-token"]', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.token', '*.refreshToken', '*.accessToken'],
            censor: '[REDACTED]',
          },
          transport: env.isProd || env.NODE_ENV === 'test' ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
          autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/api/v1/health') },
        },
      }),
    }),
    // Límite general: 120 peticiones/min por IP (los endpoints de auth tienen uno más estricto)
    // Contadores en Redis: compartidos entre instancias y persistentes a reinicios
    ThrottlerModule.forRootAsync({
      inject: [ENV, REDIS],
      useFactory: (env: Env, redis: Redis) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
        storage: new RedisThrottlerStorage(redis, env.QUEUE_PREFIX),
        // Solo las pruebas automatizadas pueden desactivarlo (nunca en producción)
        skipIf: () => process.env.NODE_ENV === 'test' && process.env.THROTTLE_DISABLED === 'true',
      }),
    }),
    DatabaseModule,
    RedisModule,
    MailModule,
    AuditModule,
    AuthModule,
    UsersModule,
    TenantsModule,
    PlatformModule,
    HealthModule,
    StorageModule,
    InventoryModule,
    CatalogModule,
    CustomersModule,
    OrdersModule,
    DashboardModule,
    QueuesModule,
    MessagingModule,
    AutomationsModule,
    InternalModule,
    ChatwootModule,
    AiModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
