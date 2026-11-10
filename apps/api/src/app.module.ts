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
import { RedisModule } from './health/redis.provider.js';
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
            const id = (req.headers['x-request-id'] as string) || randomUUID();
            res.setHeader('x-request-id', id);
            return id;
          },
          // Nunca registrar credenciales ni tokens
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.token', '*.refreshToken', '*.accessToken'],
            censor: '[REDACTED]',
          },
          transport: env.isProd || env.NODE_ENV === 'test' ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
          autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/api/v1/health') },
        },
      }),
    }),
    // Límite general: 120 peticiones/min por IP (los endpoints de auth tienen uno más estricto)
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
      // Solo las pruebas automatizadas pueden desactivarlo (nunca en producción)
      skipIf: () => process.env.NODE_ENV === 'test' && process.env.THROTTLE_DISABLED === 'true',
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
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
