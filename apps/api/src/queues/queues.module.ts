import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Queue, type ConnectionOptions } from 'bullmq';
import { ENV, type Env } from '../config/env.js';

/** Colas BullMQ en Redis (base 2, separada de la caché). El trabajo lo hace el proceso worker. */
export const QUEUE = {
  /** Webhooks de WhatsApp ya guardados en inbound_events, pendientes de procesar */
  WA_INBOUND: 'wa-inbound',
  /** Mensajes a enviar por WhatsApp (outbound_messages) */
  WA_OUTBOUND: 'wa-outbound',
} as const;

export const queueConnection = (env: Env): ConnectionOptions => ({
  host: env.REDIS_HOST,
  port: env.REDIS_HOST_PORT,
  password: env.REDIS_PASSWORD,
  db: 2,
  maxRetriesPerRequest: null,
});

@Injectable()
export class Queues implements OnModuleDestroy {
  readonly inbound: Queue;
  readonly outbound: Queue;

  constructor(@Inject(ENV) env: Env) {
    const connection = queueConnection(env);
    const defaults = { removeOnComplete: { age: 86_400, count: 10_000 }, removeOnFail: { age: 7 * 86_400 } };
    this.inbound = new Queue(QUEUE.WA_INBOUND, { connection, prefix: env.QUEUE_PREFIX, defaultJobOptions: { ...defaults, attempts: 5, backoff: { type: 'exponential', delay: 2_000 } } });
    this.outbound = new Queue(QUEUE.WA_OUTBOUND, {
      connection,
      prefix: env.QUEUE_PREFIX,
      // Backoff exponencial desde 4 s (4, 8, 16, 32 s…): respeta el límite por usuario de Meta (131056)
      defaultJobOptions: { ...defaults, attempts: env.WHATSAPP_SEND_MAX_ATTEMPTS, backoff: { type: 'exponential', delay: 4_000 } },
    });
  }

  async onModuleDestroy() {
    await Promise.all([this.inbound.close(), this.outbound.close()]);
  }
}

@Global()
@Module({ providers: [Queues], exports: [Queues] })
export class QueuesModule {}
