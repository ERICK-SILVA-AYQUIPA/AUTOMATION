import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { ENV, type Env } from '../config/env.js';
import { QUEUE, Queues, queueConnection } from '../queues/queues.module.js';
import { InboundService } from './inbound.service.js';
import { OutboundService, PermanentSendError } from './outbound.service.js';
import { ChatwootSyncService, ChatwootPermanentError } from '../chatwoot/chatwoot-sync.service.js';
import type { ChatwootJob } from '../queues/queues.module.js';

/**
 * Consumidores de las colas. Solo se instancian en el proceso worker (src/worker.ts),
 * nunca en la API, para que una carga alta de WhatsApp no afecte al panel.
 */
@Injectable()
export class QueueWorkers implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Worker');
  private workers: Worker[] = [];
  private sweeper?: NodeJS.Timeout;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly inbound: InboundService,
    private readonly outbound: OutboundService,
    private readonly queues: Queues,
    private readonly chatwootSync: ChatwootSyncService,
  ) {}

  onApplicationBootstrap() {
    const connection = queueConnection(this.env);
    const inbound = new Worker<{ eventId: string }>(
      QUEUE.WA_INBOUND,
      async (job) => {
        const r = await this.inbound.processEvent(job.data.eventId);
        // Espejo en Chatwoot: mensaje nuevo del cliente o cambio de estado de uno nuestro
        if (r.outcome === 'processed' && r.messageId && r.tenantId) await this.queues.mirrorToChatwoot(r.tenantId, r.messageId, r.kind === 'status' ? 'status' : 'mirror');
        return r;
      },
      { connection, prefix: this.env.QUEUE_PREFIX, concurrency: 10 },
    );
    inbound.on('failed', (job, err) => {
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        this.log.error(`Evento ${job.data.eventId} sin procesar tras ${job.attemptsMade} intentos: ${err.message}`);
        void this.inbound.markFailed(job.data.eventId, err.message).catch(() => undefined);
      }
    });

    const outbound = new Worker<{ tenantId: string; outboundId: string }>(
      QUEUE.WA_OUTBOUND,
      async (job: Job<{ tenantId: string; outboundId: string }>) => {
        try {
          return await this.outbound.send(job.data.tenantId, job.data.outboundId);
        } catch (e) {
          // Error definitivo (fuera de ventana, número bloqueado, token caducado…): no reintentar
          if (e instanceof PermanentSendError) throw new UnrecoverableError(e.message);
          throw e;
        }
      },
      { connection, prefix: this.env.QUEUE_PREFIX, concurrency: 5 },
    );
    outbound.on('failed', (job, err) => {
      if (job && !(err instanceof UnrecoverableError) && err.name !== 'UnrecoverableError' && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        void this.outbound.markExhausted(job.data.tenantId, job.data.outboundId, `Sin éxito tras ${job.attemptsMade} intentos: ${err.message}`).catch(() => undefined);
      }
    });

    // Un solo consumidor: los mensajes llegan a Chatwoot en el mismo orden que a WhatsApp
    const chatwoot = new Worker<ChatwootJob>(
      QUEUE.CHATWOOT_SYNC,
      async (job) => {
        try {
          return await this.chatwootSync.run(job.data.kind, job.data.tenantId, job.data.messageId);
        } catch (e) {
          if (e instanceof ChatwootPermanentError) throw new UnrecoverableError(e.message);
          throw e;
        }
      },
      { connection, prefix: this.env.QUEUE_PREFIX, concurrency: 1 },
    );
    chatwoot.on('failed', (job, err) => {
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) this.log.warn(`Chatwoot (${job.data.kind} ${job.data.messageId}) sin éxito: ${err.message}`);
    });

    for (const w of [inbound, outbound, chatwoot]) w.on('error', (e) => this.log.error(`Cola: ${e.message}`));
    this.workers = [inbound, outbound, chatwoot];

    // Recupera eventos guardados que no llegaron a encolarse (p. ej. Redis caído)
    this.sweeper = setInterval(() => void this.sweep().catch((e) => this.log.warn(`Barrido: ${(e as Error).message}`)), 60_000);
    this.log.log('Worker listo: colas wa-inbound, wa-outbound y chatwoot-sync');
  }

  async sweep() {
    const stale = await this.inbound.stale();
    if (!stale.length) return 0;
    await this.queues.inbound.addBulk(stale.map((e) => ({ name: 'event', data: { eventId: e.id }, opts: { jobId: `${e.id}:r${e.attempts}` } })));
    this.log.warn(`Reencolados ${stale.length} eventos pendientes`);
    return stale.length;
  }

  async onApplicationShutdown() {
    if (this.sweeper) clearInterval(this.sweeper);
    await Promise.all(this.workers.map((w) => w.close()));
  }
}
