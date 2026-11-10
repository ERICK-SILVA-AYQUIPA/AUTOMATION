import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Queue, type ConnectionOptions } from 'bullmq';
import { ENV, type Env } from '../config/env.js';

/** Colas BullMQ en Redis (base 2, separada de la caché). El trabajo lo hace el proceso worker. */
export const QUEUE = {
  /** Webhooks de WhatsApp ya guardados en inbound_events, pendientes de procesar */
  WA_INBOUND: 'wa-inbound',
  /** Mensajes a enviar por WhatsApp (outbound_messages) */
  WA_OUTBOUND: 'wa-outbound',
  /** Espejo de mensajes y estados en Chatwoot (FASE 5); un solo consumidor para mantener el orden */
  CHATWOOT_SYNC: 'chatwoot-sync',
} as const;

export type ChatwootJob = { kind: 'mirror' | 'status'; tenantId: string; messageId: string };

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
  readonly chatwoot: Queue<ChatwootJob>;

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
    this.chatwoot = new Queue<ChatwootJob>(QUEUE.CHATWOOT_SYNC, { connection, prefix: env.QUEUE_PREFIX, defaultJobOptions: { ...defaults, attempts: 10, backoff: { type: 'exponential', delay: 3_000 } } });
  }

  /** Encola el espejo en Chatwoot; si Redis falla no se interrumpe el flujo principal */
  async mirrorToChatwoot(tenantId: string, messageId: string, kind: ChatwootJob['kind'] = 'mirror') {
    const jobId = kind === 'mirror' ? `mirror-${messageId}` : `status-${messageId}-${Date.now()}`;
    await this.chatwoot.add(kind, { kind, tenantId, messageId }, { jobId }).catch(() => undefined);
  }

  async onModuleDestroy() {
    await Promise.all([this.inbound.close(), this.outbound.close(), this.chatwoot.close()]);
  }
}

@Global()
@Module({ providers: [Queues], exports: [Queues] })
export class QueuesModule {}
