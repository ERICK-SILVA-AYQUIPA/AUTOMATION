import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module.js';
import { ENV, type Env } from './config/env.js';
import { DatabaseModule } from './database/database.module.js';
import { AuditModule } from './audit/audit.module.js';
import { QueuesModule } from './queues/queues.module.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { QueueWorkers } from './messaging/queue-workers.js';
import { AutomationsModule } from './automations/automations.module.js';
import { ChatwootModule } from './chatwoot/chatwoot.module.js';
import { AutomationDispatcher } from './automations/automation-dispatcher.js';

/** Proceso worker: consume las colas de WhatsApp y entrega eventos a n8n. No expone HTTP. */
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          redact: { paths: ['*.password', '*.token', '*.accessToken', '*.appSecret'], censor: '[REDACTED]' },
          transport: env.isProd || env.NODE_ENV === 'test' ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
        },
      }),
    }),
    DatabaseModule,
    AuditModule,
    QueuesModule,
    MessagingModule,
    AutomationsModule,
    ChatwootModule,
  ],
  providers: [QueueWorkers, AutomationDispatcher],
})
export class WorkerModule {}
